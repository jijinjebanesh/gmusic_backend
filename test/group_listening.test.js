import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { ObjectId } from 'mongodb';
import { createGroupListeningRouter } from '../src/group_listening.js';
import { claimPlaybackDeviceForGroup } from '../src/playback.js';

class MemoryCollection {
  constructor() {
    this.documents = [];
  }

  matches(document, filter) {
    return Object.entries(filter).every(([key, expected]) => {
      if (key === '$or') {
        return expected.some((condition) => this.matches(document, condition));
      }
      const actual = key.split('.').reduce((value, part) => value?.[part], document);
      if (expected?.$elemMatch) {
        return Array.isArray(actual) &&
          actual.some((item) => this.matches(item, expected.$elemMatch));
      }
      if (expected instanceof ObjectId) {
        return actual instanceof ObjectId && actual.equals(expected);
      }
      if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
        if ('$exists' in expected) return (actual !== undefined) === expected.$exists;
        if ('$gt' in expected) return actual > expected.$gt;
        if ('$gte' in expected) return actual >= expected.$gte;
        if ('$lte' in expected) return actual <= expected.$lte;
        if ('$ne' in expected) return actual !== expected.$ne;
      }
      return actual === expected;
    });
  }

  async findOne(filter) {
    return this.documents.find((document) => this.matches(document, filter)) || null;
  }

  async insertOne(document) {
    if (this.documents.some((item) => item.code && item.code === document.code)) {
      throw Object.assign(new Error('duplicate key'), { code: 11000 });
    }
    const inserted = { ...structuredClone(document), _id: document._id || new ObjectId() };
    this.documents.push(inserted);
    return { insertedId: inserted._id };
  }

  async updateOne(filter, update, { upsert = false } = {}) {
    let document = this.documents.find((item) => this.matches(item, filter));
    const matchedCount = document ? 1 : 0;
    if (!document && upsert) {
      document = Object.fromEntries(
        Object.entries(filter).filter(([, value]) =>
          value == null || typeof value !== 'object' || value instanceof ObjectId),
      );
      this.documents.push(document);
    }
    if (!document) return { matchedCount: 0 };
    Object.assign(document, structuredClone(update.$setOnInsert || {}));
    Object.assign(document, structuredClone(update.$set || {}));
    for (const key of Object.keys(update.$unset || {})) delete document[key];
    for (const [key, increment] of Object.entries(update.$inc || {})) {
      document[key] = (document[key] || 0) + increment;
    }
    return { matchedCount: matchedCount || 1 };
  }

  async deleteOne(filter) {
    const index = this.documents.findIndex((item) => this.matches(item, filter));
    if (index < 0) return { deletedCount: 0 };
    this.documents.splice(index, 1);
    return { deletedCount: 1 };
  }

  find(filter) {
    const rows = this.documents.filter((document) => this.matches(document, filter));
    return { toArray: async () => rows };
  }
}

class MemoryDatabase {
  constructor() {
    this.collections = new Map();
  }

  collection(name) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new MemoryCollection());
    }
    return this.collections.get(name);
  }
}

test('group device claims clear legacy references to ended rooms but preserve active ownership', async () => {
  const database = new MemoryDatabase();
  const time = new Date('2026-11-17T00:00:00.000Z');
  const deviceId = '0123456789abcdef0123456789abcdef';
  const oldRoomId = new ObjectId();
  const activeRoomId = new ObjectId();
  await database.collection('playback_devices').insertOne({
    userId: 'host',
    deviceId,
    lastSeenAt: time,
    groupSessionId: String(oldRoomId),
  });
  await database.collection('group_listening_sessions').insertOne({
    _id: oldRoomId,
    status: 'ended',
    expiresAt: new Date(time.getTime() + 60_000),
  });

  await claimPlaybackDeviceForGroup({
    userId: 'host',
    deviceId,
    groupSessionId: String(new ObjectId()),
    groupSessionExpiresAt: new Date(time.getTime() + 86_400_000),
    collection: (name) => database.collection(name),
    now: () => time,
  });
  const claimed = await database.collection('playback_devices').findOne({
    userId: 'host',
    deviceId,
  });
  assert.notEqual(claimed.groupSessionId, String(oldRoomId));
  assert.ok(claimed.groupSessionExpiresAt);

  await database.collection('group_listening_sessions').insertOne({
    _id: activeRoomId,
    status: 'paused',
    expiresAt: new Date(time.getTime() + 60_000),
    members: [{ userId: 'host', deviceId }],
  });
  await database.collection('playback_devices').updateOne(
    { userId: 'host', deviceId },
    {
      $set: { groupSessionId: String(activeRoomId) },
      $unset: { groupSessionExpiresAt: '' },
    },
  );
  await assert.rejects(
    claimPlaybackDeviceForGroup({
      userId: 'host',
      deviceId,
      groupSessionId: String(new ObjectId()),
      groupSessionExpiresAt: new Date(time.getTime() + 86_400_000),
      collection: (name) => database.collection(name),
      now: () => time,
    }),
    (error) => error.code === 'device_in_group_session',
  );

  await database.collection('group_listening_sessions').updateOne(
    { _id: activeRoomId },
    { $set: { members: [] } },
  );
  await database.collection('playback_devices').updateOne(
    { userId: 'host', deviceId },
    { $set: { groupSessionId: String(activeRoomId) }, $unset: { groupSessionExpiresAt: '' } },
  );
  await claimPlaybackDeviceForGroup({
    userId: 'host',
    deviceId,
    groupSessionId: String(new ObjectId()),
    groupSessionExpiresAt: new Date(time.getTime() + 86_400_000),
    collection: (name) => database.collection(name),
    now: () => time,
  });
  const stillClaimed = await database.collection('playback_devices').findOne({
    userId: 'host',
    deviceId,
  });
  assert.notEqual(stillClaimed.groupSessionId, String(activeRoomId));
});

test('group sessions authorize each account and schedule after every online player is ready', async () => {
  const database = new MemoryDatabase();
  let time = new Date('2026-11-17T00:00:00.000Z');
  const hostDeviceId = '0123456789abcdef0123456789abcdef';
  const guestDeviceId = 'abcdef0123456789abcdef0123456789';
  const allowedTracks = new Map([
    ['host', new Set(['track-a', 'track-b'])],
    ['guest', new Set(['track-a'])],
  ]);
  for (const [userId, deviceId] of [
    ['host', hostDeviceId],
    ['guest', guestDeviceId],
  ]) {
    await database.collection('playback_devices').insertOne({
      userId,
      deviceId,
      name: `${userId} device`,
      platform: 'web',
      lastSeenAt: time,
    });
  }
  await database.collection('playback_sessions').insertOne({
    _id: 'host',
    activeDeviceId: hostDeviceId,
    trackIds: ['track-a', 'track-b'],
    playing: true,
    revision: 1,
  });
  const pendingCommandId = new ObjectId();
  const pendingTransferId = new ObjectId();
  await database.collection('playback_commands').insertOne({
    _id: pendingCommandId,
    userId: 'host',
    deviceId: hostDeviceId,
    action: 'play',
    status: 'pending',
  });
  await database.collection('playback_transfers').insertOne({
    _id: pendingTransferId,
    userId: 'host',
    targetDeviceId: hostDeviceId,
    status: 'pending',
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: req.get('x-user-id') || 'host',
      displayName: req.get('x-user-id') || 'host',
    };
    next();
  });
  app.use(createGroupListeningRouter({
    collection: (name) => database.collection(name),
    now: () => time,
    getAccessibleTracks: async (req, ids) =>
      ids.filter((id) => allowedTracks.get(req.user.id)?.has(id))
        .map((id) => ({ id })),
  }));
  app.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({ error: error.code || 'internal_error' });
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { user = 'host', method = 'GET', body } = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        'x-user-id': user,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { response, body: await response.json() };
  };

  try {
    const created = await request('/group-listening', {
      method: 'POST',
      body: {
        title: 'Friday Night Listening',
        deviceId: hostDeviceId,
        trackIds: ['track-a', 'track-b'],
        index: 0,
        positionMs: 2_000,
        durationMs: 240_000,
      },
    });
    assert.equal(created.response.status, 201);
    const sessionId = created.body.room.sessionId;
    const invitationCode = created.body.room.invitationCode;
    assert.equal(created.body.room.status, 'paused');
    const recovered = await request('/group-listening', {
      method: 'POST',
      body: {
        title: 'Retry after lost response',
        deviceId: hostDeviceId,
        trackIds: ['track-a', 'track-b'],
        index: 0,
        positionMs: 0,
        durationMs: 240_000,
      },
    });
    assert.equal(recovered.response.status, 200);
    assert.equal(recovered.body.recovered, true);
    assert.equal(recovered.body.room.sessionId, sessionId);
    assert.equal(
      database.collection('group_listening_sessions').documents.length,
      1,
    );
    assert.equal(
      (await database.collection('playback_devices').findOne({
        userId: 'host',
        deviceId: hostDeviceId,
      })).groupSessionId,
      sessionId,
    );
    assert.equal(
      (await database.collection('playback_sessions').findOne({ _id: 'host' }))
        .activeDeviceId,
      null,
    );
    assert.equal(
      (await database.collection('playback_commands').findOne({
        _id: pendingCommandId,
      })).status,
      'cancelled',
    );
    assert.equal(
      (await database.collection('playback_transfers').findOne({
        _id: pendingTransferId,
      })).error,
      'device_in_group_session',
    );

    const unauthorizedJoin = await request('/group-listening/join', {
      user: 'guest',
      method: 'POST',
      body: { invitationCode, deviceId: guestDeviceId },
    });
    assert.equal(unauthorizedJoin.response.status, 403);
    assert.equal(unauthorizedJoin.body.error, 'group_track_unavailable');
    assert.equal(
      (await database.collection('playback_devices').findOne({
        userId: 'guest',
        deviceId: guestDeviceId,
      })).groupSessionId,
      undefined,
    );
    allowedTracks.get('guest').add('track-b');

    const joined = await request('/group-listening/join', {
      user: 'guest',
      method: 'POST',
      body: { invitationCode, deviceId: guestDeviceId },
    });
    assert.equal(joined.response.status, 201);
    const guestMemberId = joined.body.room.members.find(
      (member) => member.name === 'guest',
    ).memberId;
    allowedTracks.get('guest').delete('track-b');
    allowedTracks.get('host').add('track-c');

    const inaccessibleQueueAdd = await request(
      `/group-listening/${sessionId}/control`,
      {
        method: 'POST',
        body: {
          deviceId: hostDeviceId,
          action: 'queueAdd',
          trackId: 'track-c',
          placement: 'last',
        },
      },
    );
    assert.equal(inaccessibleQueueAdd.response.status, 403);
    assert.equal(inaccessibleQueueAdd.body.error, 'group_track_unavailable');

    for (const [user, deviceId] of [
      ['host', hostDeviceId],
      ['guest', guestDeviceId],
    ]) {
      const ready = await request(`/group-listening/${sessionId}/heartbeat`, {
        user,
        method: 'POST',
        body: {
          deviceId,
          ready: true,
          trackId: 'track-a',
          positionMs: 2_000,
          durationMs: 240_000,
          bufferedMs: 2_000,
          clockOffsetMs: 125,
          latencyCompensationMs: 45,
        },
      });
      assert.equal(ready.response.status, 200);
    }

    const insufficientBuffer = await request(
      `/group-listening/${sessionId}/heartbeat`,
      {
        user: 'guest',
        method: 'POST',
        body: {
          deviceId: guestDeviceId,
          ready: true,
          trackId: 'track-a',
          positionMs: 2_000,
          durationMs: 240_000,
          bufferedMs: 1_000,
        },
      },
    );
    assert.equal(insufficientBuffer.body.room.members[1].ready, false);

    const prematureStart = await request(
      `/group-listening/${sessionId}/control`,
      {
        method: 'POST',
        body: { deviceId: hostDeviceId, action: 'play' },
      },
    );
    assert.equal(prematureStart.body.room.status, 'preparing');
    assert.equal(prematureStart.body.room.startAtServerTime, null);

    const bufferAvailable = await request(
      `/group-listening/${sessionId}/heartbeat`,
      {
        user: 'guest',
        method: 'POST',
        body: {
          deviceId: guestDeviceId,
          ready: true,
          trackId: 'track-a',
          bufferedMs: 2_000,
        },
      },
    );
    assert.equal(bufferAvailable.body.room.status, 'scheduled');

    time = new Date(time.getTime() + 7_000);
    const staleReady = await request(`/group-listening/${sessionId}/control`, {
      method: 'POST',
      body: { deviceId: hostDeviceId, action: 'play' },
    });
    assert.equal(staleReady.body.room.status, 'preparing');
    assert.equal(staleReady.body.room.startAtServerTime, null);

    for (const [user, deviceId] of [
      ['host', hostDeviceId],
      ['guest', guestDeviceId],
    ]) {
      await request(`/group-listening/${sessionId}/heartbeat`, {
        user,
        method: 'POST',
        body: {
          deviceId,
          ready: true,
          trackId: 'track-a',
          bufferedMs: 2_000,
        },
      });
    }

    const started = await request(`/group-listening/${sessionId}/control`, {
      method: 'POST',
      body: { deviceId: hostDeviceId, action: 'play' },
    });
    assert.equal(started.body.room.status, 'scheduled');
    assert.equal(started.body.room.playing, true);
    assert.equal(
      new Date(started.body.room.startAtServerTime).getTime() - time.getTime(),
      3_000,
    );

    const streamLost = await request(
      `/group-listening/${sessionId}/heartbeat`,
      {
        user: 'guest',
        method: 'POST',
        body: { deviceId: guestDeviceId, ready: false },
      },
    );
    assert.equal(streamLost.response.status, 200);
    assert.equal(streamLost.body.room.status, 'preparing');
    assert.equal(streamLost.body.room.startAtServerTime, null);

    const streamRecovered = await request(
      `/group-listening/${sessionId}/heartbeat`,
      {
        user: 'guest',
        method: 'POST',
        body: {
          deviceId: guestDeviceId,
          ready: true,
          trackId: 'track-a',
          bufferedMs: 2_000,
        },
      },
    );
    assert.equal(streamRecovered.response.status, 200);
    assert.equal(streamRecovered.body.room.status, 'scheduled');

    time = new Date(time.getTime() + 13_000);
    const guestHeartbeat = await request(
      `/group-listening/${sessionId}/heartbeat`,
      {
        user: 'guest',
        method: 'POST',
        body: {
          deviceId: guestDeviceId,
          ready: true,
          trackId: 'track-a',
          positionMs: 19_000,
          durationMs: 240_000,
          bufferedMs: 2_000,
        },
      },
    );
    assert.equal(guestHeartbeat.response.status, 200);
    assert.equal(guestHeartbeat.body.room.hostMemberId, guestMemberId);
    assert.equal(guestHeartbeat.body.driftMs, 3_000);

    const paused = await request(`/group-listening/${sessionId}/control`, {
      user: 'guest',
      method: 'POST',
      body: { deviceId: guestDeviceId, action: 'pause' },
    });
    assert.equal(paused.response.status, 200);
    assert.equal(paused.body.room.playing, false);
    assert.equal(paused.body.room.status, 'paused');
    assert.equal(
      new Date(paused.body.room.startAtServerTime).getTime() - time.getTime(),
      1_500,
    );
    const repeatedPause = await request(
      `/group-listening/${sessionId}/control`,
      {
        user: 'guest',
        method: 'POST',
        body: { deviceId: guestDeviceId, action: 'pause' },
      },
    );
    assert.equal(
      repeatedPause.body.room.startAtServerTime,
      paused.body.room.startAtServerTime,
    );

    const left = await request(`/group-listening/${sessionId}/leave`, {
      user: 'guest',
      method: 'POST',
      body: { deviceId: guestDeviceId },
    });
    assert.equal(left.response.status, 200);
    assert.equal(left.body.room.status, 'ended');
    assert.equal(
      (await database.collection('playback_devices').findOne({
        userId: 'guest',
        deviceId: guestDeviceId,
      })).groupSessionId,
      undefined,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
