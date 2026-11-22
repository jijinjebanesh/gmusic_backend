import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { ObjectId } from 'mongodb';
import {
  acknowledgePlaybackCommand,
  createPlaybackCommand,
  createPlaybackHandoff,
  createPlaybackPrewarm,
  createPlaybackRouter,
  cancelPlaybackPrewarm,
  pollPlayback,
  updatePlaybackPrewarmStatus,
} from '../src/playback.js';

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
      if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
        if ('$exists' in expected) {
          return (actual !== undefined) === expected.$exists;
        }
        if ('$gt' in expected) return actual > expected.$gt;
        if ('$gte' in expected) return actual >= expected.$gte;
        if ('$lte' in expected) return actual <= expected.$lte;
        if ('$in' in expected) return expected.$in.includes(actual);
      }
      if (actual instanceof ObjectId && expected instanceof ObjectId) {
        return actual.equals(expected);
      }
      return actual === expected;
    });
  }

  async findOne(filter) {
    return this.documents.find((document) => this.matches(document, filter)) || null;
  }

  async updateOne(filter, update, { upsert = false } = {}) {
    let document = this.documents.find((candidate) => this.matches(candidate, filter));
    const matchedCount = document ? 1 : 0;
    if (!document && upsert) {
      document = Object.fromEntries(
        Object.entries(filter).filter(([, value]) =>
          value == null || typeof value !== 'object' || value instanceof ObjectId,
        ),
      );
      this.documents.push(document);
    }
    if (!document) return { matchedCount: 0 };
    if (!matchedCount) Object.assign(document, update.$setOnInsert || {});
    for (const [key, value] of Object.entries(update.$set || {})) {
      const parts = key.split('.');
      let target = document;
      while (parts.length > 1) {
        const part = parts.shift();
        target[part] ??= {};
        target = target[part];
      }
      target[parts[0]] = value;
    }
    for (const key of Object.keys(update.$unset || {})) delete document[key];
    for (const [key, increment] of Object.entries(update.$inc || {})) {
      document[key] = (document[key] || 0) + increment;
    }
    return { matchedCount };
  }

  async insertOne(document) {
    const inserted = { ...document, _id: document._id || new ObjectId() };
    this.documents.push(inserted);
    return { insertedId: inserted._id };
  }

  async deleteOne(filter) {
    const index = this.documents.findIndex((document) => this.matches(document, filter));
    if (index < 0) return { deletedCount: 0 };
    this.documents.splice(index, 1);
    return { deletedCount: 1 };
  }

  find(filter) {
    let rows = this.documents.filter((document) => this.matches(document, filter));
    return {
      sort(spec) {
        const [key, direction] = Object.entries(spec)[0];
        rows = rows.sort((a, b) => direction * (a[key] > b[key] ? 1 : -1));
        return this;
      },
      limit(count) {
        rows = rows.slice(0, count);
        return this;
      },
      toArray: async () => rows,
    };
  }
}

class MemoryDatabase {
  constructor() {
    this.collections = new Map();
  }

  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new MemoryCollection());
    return this.collections.get(name);
  }
}

test('Connect prewarm targets one eligible device without changing playback ownership', async () => {
  const database = new MemoryDatabase();
  const now = new Date('2026-11-20T12:00:00.000Z');
  const requesterDeviceId = '0123456789abcdef0123456789abcdef';
  const destinationDeviceId = 'abcdef0123456789abcdef0123456789';
  database.collection('playback_sessions').documents.push({
    _id: 'user-a', activeDeviceId: requesterDeviceId,
    trackIds: ['track-a', 'track-b'], index: 0, positionMs: 42_000,
    durationMs: 180_000, playing: true, queueRevision: 7, revision: 11,
    stateVersion: 11, volume: 1, shuffle: false, repeat: 'none',
  });
  database.collection('playback_devices').documents.push({
    userId: 'user-a', deviceId: destinationDeviceId, lastSeenAt: now,
    capabilities: { playback: true },
  });
  const result = await createPlaybackPrewarm({
    userId: 'user-a', requesterDeviceId, deviceId: destinationDeviceId,
    prewarmId: 'warm-switch-00000001',
    collection: (name) => database.collection(name), now: () => now,
  });
  assert.equal(result.status, 'pending');
  const commands = database.collection('playback_commands').documents;
  assert.equal(commands.length, 1);
  assert.equal(commands[0].deviceId, destinationDeviceId);
  assert.equal(commands[0].action, 'prewarm');
  assert.equal(commands[0].payload.prewarmId, 'warm-switch-00000001');
  assert.equal(commands[0].payload.queueRevision, 7);
  assert.equal(commands[0].payload.trackId, 'track-a');
  assert.equal(commands[0].payload.positionMs, 42_000);
  assert.equal(commands[0].payload.playbackRate, 1);
  assert.equal(
    commands[0].deadlineAt.getTime() - commands[0].createdAt.getTime(),
    60_000,
  );
  assert.equal(commands[0].payload.session.trackIds[commands[0].payload.session.index], 'track-a');
  assert.equal(database.collection('playback_sessions').documents[0].activeDeviceId, requesterDeviceId);
  commands[0].payload.prewarmStatus = 'ready';
  const transfer = await createPlaybackHandoff({
    userId: 'user-a', deviceId: destinationDeviceId,
    prewarmId: 'warm-switch-00000001',
    collection: (name) => database.collection(name), now: () => now,
  });
  assert.equal(transfer.status, 'pending');
  const handoffCommand = database.collection('playback_commands').documents[1];
  assert.equal(handoffCommand.action, 'handoff');
  assert.equal(handoffCommand.payload.prewarmId, 'warm-switch-00000001');
});

test('Connect prewarm status is correlated to the preparing destination', async () => {
  const database = new MemoryDatabase();
  const now = new Date('2026-11-20T12:00:00.000Z');
  const requesterDeviceId = '0123456789abcdef0123456789abcdef';
  const destinationDeviceId = 'abcdef0123456789abcdef0123456789';
  database.collection('playback_commands').documents.push({
    _id: new ObjectId(),
    userId: 'user-a',
    deviceId: destinationDeviceId,
    action: 'prewarm',
    payload: {
      prewarmId: 'warm-switch-00000001',
      requesterDeviceId,
    },
    status: 'pending',
    createdAt: now,
    deadlineAt: new Date(now.getTime() + 60_000),
  });
  const result = await updatePlaybackPrewarmStatus({
    userId: 'user-a',
    deviceId: destinationDeviceId,
    prewarmId: 'warm-switch-00000001',
    status: 'ready',
    collection: (name) => database.collection(name),
    now: () => now,
  });
  assert.equal(result.stale, false);
  assert.equal(result.requesterDeviceId, requesterDeviceId);
  assert.equal(result.status, 'ready');
  assert.equal(
    database.collection('playback_commands').documents[0].payload.prewarmStatus,
    'ready',
  );
});

test('Connect prewarm cancellation is requester scoped and rejects stale status', async () => {
  const database = new MemoryDatabase();
  const now = new Date('2026-11-20T12:00:00.000Z');
  const requesterDeviceId = '0123456789abcdef0123456789abcdef';
  const destinationDeviceId = 'abcdef0123456789abcdef0123456789';
  database.collection('playback_commands').documents.push({
    _id: new ObjectId(),
    userId: 'user-a',
    deviceId: destinationDeviceId,
    action: 'prewarm',
    payload: {
      prewarmId: 'warm-switch-00000001',
      requesterDeviceId,
    },
    status: 'pending',
    createdAt: now,
    deadlineAt: new Date(now.getTime() + 60_000),
  });
  const denied = await cancelPlaybackPrewarm({
    userId: 'user-a',
    requesterDeviceId: 'ffffffffffffffffffffffffffffffff',
    deviceId: destinationDeviceId,
    prewarmId: 'warm-switch-00000001',
    collection: (name) => database.collection(name),
    now: () => now,
  });
  assert.equal(denied.cancelled, false);
  const cancelled = await cancelPlaybackPrewarm({
    userId: 'user-a',
    requesterDeviceId,
    deviceId: destinationDeviceId,
    prewarmId: 'warm-switch-00000001',
    collection: (name) => database.collection(name),
    now: () => now,
  });
  assert.equal(cancelled.cancelled, true);
  const stale = await updatePlaybackPrewarmStatus({
    userId: 'user-a',
    deviceId: destinationDeviceId,
    prewarmId: 'warm-switch-00000001',
    status: 'ready',
    collection: (name) => database.collection(name),
    now: () => now,
  });
  assert.equal(stale.stale, true);
});

test('Connect prewarm cancellation releases a recently ready destination', async () => {
  const database = new MemoryDatabase();
  const now = new Date('2026-11-20T12:00:00.000Z');
  const requesterDeviceId = '0123456789abcdef0123456789abcdef';
  const destinationDeviceId = 'abcdef0123456789abcdef0123456789';
  database.collection('playback_commands').documents.push({
    _id: new ObjectId(),
    userId: 'user-a',
    deviceId: destinationDeviceId,
    action: 'prewarm',
    payload: {
      prewarmId: 'warm-switch-00000001',
      requesterDeviceId,
      prewarmStatus: 'ready',
    },
    status: 'ok',
    acknowledgedAt: now,
  });

  const cancelled = await cancelPlaybackPrewarm({
    userId: 'user-a',
    requesterDeviceId,
    deviceId: destinationDeviceId,
    prewarmId: 'warm-switch-00000001',
    collection: (name) => database.collection(name),
    now: () => now,
  });

  assert.equal(cancelled.cancelled, true);
  assert.equal(
    database.collection('playback_commands').documents[0].payload.prewarmStatus,
    'cancelled',
  );
  const stale = await updatePlaybackPrewarmStatus({
    userId: 'user-a',
    deviceId: destinationDeviceId,
    prewarmId: 'warm-switch-00000001',
    status: 'ready',
    collection: (name) => database.collection(name),
    now: () => now,
  });
  assert.equal(stale.stale, true);
});

test('Connect handoff commit uses a recent source position and server bounded schedule', async () => {
  const database = new MemoryDatabase();
  const now = new Date('2026-11-20T12:00:00.000Z');
  const requesterDeviceId = '0123456789abcdef0123456789abcdef';
  const destinationDeviceId = 'abcdef0123456789abcdef0123456789';
  database.collection('playback_sessions').documents.push({
    _id: 'user-a',
    activeDeviceId: requesterDeviceId,
    trackIds: ['track-a', 'track-b'],
    index: 0,
    positionMs: 1_000,
    durationMs: 180_000,
    volume: 1,
    playing: true,
    shuffle: false,
    repeat: 'none',
    queueRevision: 7,
    revision: 11,
    updatedAt: new Date(now.getTime() - 2_000),
  });
  database.collection('playback_devices').documents.push({
    userId: 'user-a',
    deviceId: destinationDeviceId,
    lastSeenAt: now,
    capabilities: { playback: true },
  });
  const result = await createPlaybackHandoff({
    userId: 'user-a',
    requesterDeviceId,
    deviceId: destinationDeviceId,
    positionMs: 2_000,
    positionTimestamp: new Date(now.getTime() - 500).toISOString(),
    playbackRate: 1.5,
    queueRevision: 7,
    scheduledStartAt: new Date(now.getTime() + 600).toISOString(),
    collection: (name) => database.collection(name),
    now: () => now,
  });
  assert.equal(result.status, 'pending');
  const command = database.collection('playback_commands').documents[0];
  assert.equal(command.payload.sourceDeviceId, requesterDeviceId);
  assert.equal(command.payload.destinationDeviceId, destinationDeviceId);
  assert.equal(command.payload.positionMs, 2_750);
  assert.equal(command.payload.playbackRate, 1.5);
  assert.equal(command.payload.queueRevision, 7);
  assert.equal(command.payload.scheduledStartAt.getTime(), now.getTime() + 600);
  assert.equal(command.payload.session.positionMs, 2_750);
  assert.equal(command.deadlineAt.getTime(), now.getTime() + 60_000);
});

test('a non-owner device can request a handoff without overriding the owner checkpoint', async () => {
  const database = new MemoryDatabase();
  const now = new Date('2026-11-20T12:00:00.000Z');
  const activeDeviceId = '0123456789abcdef0123456789abcdef';
  const requesterDeviceId = 'fedcba9876543210fedcba9876543210';
  const destinationDeviceId = 'abcdef0123456789abcdef0123456789';
  database.collection('playback_sessions').documents.push({
    _id: 'user-a',
    activeDeviceId,
    trackIds: ['track-a', 'track-b'],
    index: 0,
    positionMs: 42_000,
    durationMs: 180_000,
    volume: 1,
    playing: true,
    shuffle: false,
    repeat: 'none',
    queueRevision: 7,
    revision: 11,
    updatedAt: new Date(now.getTime() - 2_000),
  });
  database.collection('playback_devices').documents.push(
    {
      userId: 'user-a',
      deviceId: activeDeviceId,
      lastSeenAt: now,
      capabilities: { playback: true },
    },
    {
      userId: 'user-a',
      deviceId: destinationDeviceId,
      lastSeenAt: now,
      capabilities: { playback: true },
    },
  );

  await assert.rejects(
    createPlaybackHandoff({
      userId: 'user-a',
      requesterDeviceId: activeDeviceId,
      deviceId: destinationDeviceId,
      queueRevision: 6,
      collection: (name) => database.collection(name),
      now: () => now,
    }),
    { code: 'playback_changed' },
  );

  const result = await createPlaybackHandoff({
    userId: 'user-a',
    requesterDeviceId,
    deviceId: destinationDeviceId,
    positionMs: 2_000,
    positionTimestamp: new Date(now.getTime() - 500).toISOString(),
    playbackRate: 1.5,
    queueRevision: 6,
    collection: (name) => database.collection(name),
    now: () => now,
  });

  assert.equal(result.status, 'pending');
  const command = database.collection('playback_commands').documents[0];
  assert.equal(command.payload.sourceDeviceId, activeDeviceId);
  assert.equal(command.payload.destinationDeviceId, destinationDeviceId);
  assert.equal(command.payload.positionMs, 44_000);
  assert.equal(command.payload.playbackRate, 1);
  assert.equal(command.payload.session.queueRevision, 7);
  assert.equal(command.payload.session.playing, true);
  assert.equal(
    (
      await database.collection('playback_sessions').findOne({ _id: 'user-a' })
    ).activeDeviceId,
    activeDeviceId,
  );
});

test('playback polling releases an expired group claim before personal playback claims the device', async () => {
  const database = new MemoryDatabase();
  const time = new Date('2026-11-18T00:00:00.000Z');
  const deviceId = '0123456789abcdef0123456789abcdef';
  await database.collection('playback_devices').insertOne({
    userId: 'user-a',
    deviceId,
    name: 'Phone',
    platform: 'android',
    lastSeenAt: time,
    groupSessionId: 'expired-room',
    groupSessionExpiresAt: new Date(time.getTime() - 1),
  });

  const result = await pollPlayback({
    userId: 'user-a',
    collection: (name) => database.collection(name),
    now: () => time,
    body: {
      deviceId,
      name: 'Phone',
      platform: 'android',
      claim: true,
      snapshot: {
        trackIds: ['track-a'],
        index: 0,
        positionMs: 0,
        durationMs: 60_000,
        volume: 1,
        playing: true,
        shuffle: false,
        repeat: 'none',
      },
    },
  });

  assert.equal(result.session.activeDeviceId, deviceId);
  const device = await database.collection('playback_devices').findOne({
    userId: 'user-a',
    deviceId,
  });
  assert.equal(device.groupSessionId, undefined);
  assert.equal(device.groupSessionExpiresAt, undefined);
});

test('the first online device prepares failover without a local playback snapshot', async () => {
  const database = new MemoryDatabase();
  const time = new Date('2026-11-18T00:00:00.000Z');
  const localDeviceId = '0123456789abcdef0123456789abcdef';
  const secondDeviceId = 'fedcba9876543210fedcba9876543210';
  const offlineDeviceId = 'abcdef0123456789abcdef0123456789';
  await database.collection('playback_devices').insertOne({
    userId: 'user-a',
    deviceId: offlineDeviceId,
    name: 'Offline Web player',
    platform: 'web',
    lastSeenAt: new Date(time.getTime() - 13_000),
  });
  await database.collection('playback_sessions').insertOne({
    _id: 'user-a',
    userId: 'user-a',
    activeDeviceId: offlineDeviceId,
    trackIds: ['stale-track'],
    index: 0,
    positionMs: 21_000,
    durationMs: 180_000,
    playing: true,
    shuffle: false,
    repeat: 'none',
    title: 'Stale track',
    artist: 'Old artist',
    queueRevision: 1,
    revision: 1,
    playbackEpoch: 1,
    resumeOnFailover: false,
  });

  const result = await pollPlayback({
    userId: 'user-a',
    collection: (name) => database.collection(name),
    now: () => time,
    body: {
      deviceId: localDeviceId,
      name: 'Android device',
      platform: 'android',
    },
  });

  assert.equal(result.session.activeDeviceId, offlineDeviceId);
  assert.deepEqual(result.session.trackIds, ['stale-track']);
  assert.equal(result.session.title, 'Stale track');
  assert.equal(result.session.playing, false);
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].action, 'handoff');
  assert.deepEqual(result.commands[0].payload.session.trackIds, ['stale-track']);
  assert.equal(result.commands[0].payload.session.playing, true);
  assert.equal(
    (
      await database.collection('playback_sessions').findOne({ _id: 'user-a' })
    ).resumeOnFailover,
    true,
  );

  const secondResult = await pollPlayback({
    userId: 'user-a',
    collection: (name) => database.collection(name),
    now: () => time,
    body: {
      deviceId: secondDeviceId,
      name: 'Second Android device',
      platform: 'android',
    },
  });
  assert.equal(secondResult.commands.length, 0);
  assert.equal(
    (
      await database.collection('playback_sessions').findOne({ _id: 'user-a' })
    ).failoverCandidateDeviceId,
    localDeviceId,
  );

  const acknowledgement = await acknowledgePlaybackCommand({
    userId: 'user-a',
    commandId: result.commands[0].id,
    deviceId: localDeviceId,
    status: 'ok',
    collection: (name) => database.collection(name),
    now: () => time,
  });
  assert.equal(acknowledgement.transferStatus, 'completed');
  const resumedSession = await database
    .collection('playback_sessions')
    .findOne({ _id: 'user-a' });
  assert.equal(resumedSession.activeDeviceId, localDeviceId);
  assert.equal(resumedSession.playing, true);
  assert.deepEqual(resumedSession.trackIds, ['stale-track']);
  assert.equal(resumedSession.resumeOnFailover, false);
  assert.equal(resumedSession.failoverCandidateDeviceId, null);
  assert.equal(
    resumedSession.failoverCandidateExpiresAt,
    null,
  );
});

test('a live paused remote owner cannot be claimed by another device', async () => {
  const database = new MemoryDatabase();
  const time = new Date('2026-11-18T00:00:00.000Z');
  const activeDeviceId = '0123456789abcdef0123456789abcdef';
  const otherDeviceId = 'abcdef0123456789abcdef0123456789';
  await database.collection('playback_devices').insertOne({
    userId: 'user-a',
    deviceId: activeDeviceId,
    name: 'Online Web player',
    platform: 'web',
    lastSeenAt: time,
  });
  await database.collection('playback_sessions').insertOne({
    _id: 'user-a',
    userId: 'user-a',
    activeDeviceId,
    trackIds: ['active-track'],
    index: 0,
    positionMs: 21_000,
    durationMs: 180_000,
    playing: false,
    shuffle: false,
    repeat: 'none',
    title: 'Active track',
    artist: 'Current artist',
    queueRevision: 1,
    revision: 1,
    playbackEpoch: 1,
    resumeOnFailover: false,
  });

  const result = await pollPlayback({
    userId: 'user-a',
    collection: (name) => database.collection(name),
    now: () => time,
    body: {
      deviceId: otherDeviceId,
      name: 'Android device',
      platform: 'android',
      claim: true,
      snapshot: {
        trackIds: ['other-track'],
        index: 0,
        positionMs: 4_000,
        durationMs: 200_000,
        volume: 1,
        playing: true,
        shuffle: false,
        repeat: 'none',
        title: 'Other track',
        artist: 'Other artist',
      },
    },
  });

  assert.equal(result.session.activeDeviceId, activeDeviceId);
  assert.deepEqual(result.session.trackIds, ['active-track']);
  assert.equal(result.session.playing, false);
});

test('clearing an offline remote queue clears its owner and cached track', async () => {
  const database = new MemoryDatabase();
  const time = new Date('2026-11-18T00:00:00.000Z');
  const offlineDeviceId = '0123456789abcdef0123456789abcdef';
  await database.collection('playback_devices').insertOne({
    userId: 'user-a',
    deviceId: offlineDeviceId,
    name: 'Offline Web player',
    platform: 'web',
    lastSeenAt: new Date(time.getTime() - 13_000),
  });
  await database.collection('playback_sessions').insertOne({
    _id: 'user-a',
    userId: 'user-a',
    activeDeviceId: offlineDeviceId,
    trackIds: ['stale-track'],
    index: 0,
    positionMs: 21_000,
    durationMs: 180_000,
    playing: false,
    shuffle: false,
    repeat: 'none',
    title: 'Stale track',
    artist: 'Old artist',
    queueRevision: 1,
    revision: 1,
    playbackEpoch: 1,
    resumeOnFailover: false,
  });

  const command = await createPlaybackCommand({
    userId: 'user-a',
    action: 'queueClear',
    payload: {},
    collection: (name) => database.collection(name),
    now: () => time,
  });
  const session = await database.collection('playback_sessions').findOne({
    _id: 'user-a',
  });
  const storedCommand = await database.collection('playback_commands').findOne({
    _id: new ObjectId(command.commandId),
  });

  assert.equal(session.activeDeviceId, null);
  assert.deepEqual(session.trackIds, []);
  assert.equal(session.playing, false);
  assert.equal(storedCommand.status, 'ok');
});

test('an active device releases remote ownership when its queue is cleared', async () => {
  const database = new MemoryDatabase();
  const time = new Date('2026-11-18T00:00:00.000Z');
  const deviceId = '0123456789abcdef0123456789abcdef';
  await database.collection('playback_devices').insertOne({
    userId: 'user-a',
    deviceId,
    name: 'Web player',
    platform: 'web',
    lastSeenAt: time,
  });
  await database.collection('playback_sessions').insertOne({
    _id: 'user-a',
    userId: 'user-a',
    activeDeviceId: deviceId,
    trackIds: ['current-track'],
    index: 0,
    positionMs: 21_000,
    durationMs: 180_000,
    playing: false,
    shuffle: false,
    repeat: 'none',
    title: 'Current track',
    artist: 'Current artist',
    queueRevision: 1,
    revision: 1,
    playbackEpoch: 1,
    resumeOnFailover: false,
  });

  const result = await pollPlayback({
    userId: 'user-a',
    collection: (name) => database.collection(name),
    now: () => time,
    body: {
      deviceId,
      name: 'Web player',
      platform: 'web',
      snapshot: {
        trackIds: [],
        index: 0,
        positionMs: 0,
        durationMs: 0,
        volume: 1,
        playing: false,
        shuffle: false,
        repeat: 'none',
        title: '',
        artist: '',
      },
    },
  });

  assert.equal(result.session.activeDeviceId, null);
  assert.deepEqual(result.session.trackIds, []);
  assert.equal(result.session.playing, false);
});

test('playback polling, handoff, commands, and device visibility are account-scoped', async () => {
  const database = new MemoryDatabase();
  const app = express();
  let testTime = new Date('2026-11-16T00:00:00.000Z');
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: req.get('x-user-id') || 'user-a' };
    next();
  });
  app.use(createPlaybackRouter({
    collection: (name) => database.collection(name),
    now: () => testTime,
  }));
  app.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({ error: error.code || 'internal_error' });
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const deviceA = '0123456789abcdef0123456789abcdef';
  const deviceB = 'abcdef0123456789abcdef0123456789';
  const snapshot = {
    trackIds: ['drive-track-1', 'drive-track-2'],
    index: 0,
    positionMs: 1200,
    durationMs: 240_000,
    playing: true,
    shuffle: false,
    repeat: 'none',
    title: 'Track one',
    artist: 'Artist',
  };
  const request = async (path, { user = 'user-a', method = 'GET', body } = {}) => {
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
    const firstPoll = await request('/playback/poll', {
      method: 'POST',
      body: {
        deviceId: deviceA,
        name: 'Android • A',
        platform: 'android',
        claim: true,
        snapshot,
      },
    });
    assert.equal(firstPoll.response.status, 200);
    assert.equal(firstPoll.body.session.activeDeviceId, deviceA);
    assert.equal(firstPoll.body.session.playbackEpoch, 1);
    assert.equal(firstPoll.body.session.stateVersion, 1);

    const discontinuityPoll = await request('/playback/poll', {
      method: 'POST',
      body: {
        deviceId: deviceA,
        name: 'Android • A',
        platform: 'android',
        snapshot: {
          ...snapshot,
          playbackEpoch: firstPoll.body.session.playbackEpoch,
          advancePlaybackEpoch: true,
        },
      },
    });
    assert.equal(discontinuityPoll.body.session.playbackEpoch, 2);
    assert.equal(discontinuityPoll.body.session.stateVersion, 2);

    const staleEpochPoll = await request('/playback/poll', {
      method: 'POST',
      body: {
        deviceId: deviceA,
        name: 'Android • A',
        platform: 'android',
        snapshot: {
          ...snapshot,
          trackIds: ['stale-track'],
          playbackEpoch: firstPoll.body.session.playbackEpoch,
        },
      },
    });
    assert.deepEqual(staleEpochPoll.body.session.trackIds, snapshot.trackIds);
    assert.equal(staleEpochPoll.body.session.playbackEpoch, 2);
    assert.equal(staleEpochPoll.body.session.stateVersion, 2);

    const secondPoll = await request('/playback/poll', {
      method: 'POST',
      body: {
        deviceId: deviceB,
        name: 'Android • B',
        platform: 'android',
      },
    });
    assert.equal(secondPoll.response.status, 200);

    const competingClaim = await request('/playback/poll', {
      method: 'POST',
      body: {
        deviceId: deviceB,
        name: 'Android • B',
        platform: 'android',
        claim: true,
        snapshot: { ...snapshot, playbackEpoch: 0 },
      },
    });
    assert.equal(competingClaim.body.session.activeDeviceId, deviceA);
    assert.equal(competingClaim.body.session.playbackEpoch, 2);

    const failedTransfer = await request('/playback/handoff', {
      method: 'POST',
      body: { deviceId: deviceB },
    });
    assert.equal(failedTransfer.response.status, 202);
    assert.equal(failedTransfer.body.status, 'pending');
    assert.equal(
      (await request('/playback/state')).body.session.activeDeviceId,
      deviceA,
    );
    const failedHandoffPoll = await request('/playback/poll', {
      method: 'POST',
      body: { deviceId: deviceB, name: 'Android • B', platform: 'android' },
    });
    const failedHandoffCommand = failedHandoffPoll.body.commands.find(
      ({ action, payload }) =>
        action === 'handoff' &&
        payload.transferId === failedTransfer.body.transferId,
    );
    const failedAck = await request(
      `/playback/commands/${failedHandoffCommand.id}/ack`,
      {
        method: 'POST',
        body: {
          deviceId: deviceB,
          status: 'failed',
          error: 'track_unavailable',
        },
      },
    );
    assert.equal(failedAck.body.transferStatus, 'failed');
    assert.equal(
      (await request(`/playback/transfers/${failedTransfer.body.transferId}`))
        .body.status,
      'failed',
    );
    assert.equal(
      (await request('/playback/state')).body.session.activeDeviceId,
      deviceA,
    );

    const staleTransfer = await request('/playback/handoff', {
      method: 'POST',
      body: { deviceId: deviceB },
    });
    const changedSnapshot = { ...snapshot, index: 1 };
    const changedPoll = await request('/playback/poll', {
      method: 'POST',
      body: {
        deviceId: deviceA,
        name: 'Android • A',
        platform: 'android',
        snapshot: changedSnapshot,
      },
    });
    assert.equal(changedPoll.response.status, 200);
    assert.equal(changedPoll.body.session.index, 1);
    assert.equal(changedPoll.body.session.playbackEpoch, 3);
    assert.ok(changedPoll.body.session.stateVersion > 2);
    const staleHandoffPoll = await request('/playback/poll', {
      method: 'POST',
      body: { deviceId: deviceB, name: 'Android • B', platform: 'android' },
    });
    const staleHandoffCommand = staleHandoffPoll.body.commands.find(
      ({ action, payload }) =>
        action === 'handoff' &&
        payload.transferId === staleTransfer.body.transferId,
    );
    assert.equal(
      changedPoll.body.session.queueRevision,
      staleHandoffCommand.payload.session.queueRevision + 1,
    );
    const staleAck = await request(
      `/playback/commands/${staleHandoffCommand.id}/ack`,
      {
        method: 'POST',
        body: { deviceId: deviceB, status: 'ok' },
      },
    );
    assert.equal(staleAck.body.transferStatus, 'failed');
    assert.equal(
      (await request(`/playback/transfers/${staleTransfer.body.transferId}`))
        .body.error,
      'playback_changed',
    );
    const unchangedOwner = (await request('/playback/state')).body.session;
    assert.equal(unchangedOwner.activeDeviceId, deviceA);
    assert.equal(unchangedOwner.index, 1);

    const retry = await request('/playback/handoff', {
      method: 'POST',
      body: { deviceId: deviceB },
    });
    const handoffPoll = await request('/playback/poll', {
      method: 'POST',
      body: { deviceId: deviceB, name: 'Android • B', platform: 'android' },
    });
    const handoffCommand = handoffPoll.body.commands.find(
      ({ action, payload }) =>
        action === 'handoff' && payload.transferId === retry.body.transferId,
    );
    assert.ok(handoffCommand);
    assert.deepEqual(handoffCommand.payload.session.trackIds, snapshot.trackIds);
    // The source can briefly report another queue position while the target
    // prebuffers, then return to the exact track the transfer captured. A
    // monotonic queue revision alone must not reject this still-valid handoff.
    await request('/playback/poll', {
      method: 'POST',
      body: {
        deviceId: deviceA,
        name: 'Android â€¢ A',
        platform: 'android',
        snapshot: { ...changedSnapshot, index: 0 },
      },
    });
    const returnedToTransferTrack = await request('/playback/poll', {
      method: 'POST',
      body: {
        deviceId: deviceA,
        name: 'Android â€¢ A',
        platform: 'android',
        snapshot: changedSnapshot,
      },
    });
    assert.equal(returnedToTransferTrack.body.session.index, 1);
    assert.ok(
      returnedToTransferTrack.body.session.queueRevision >
        handoffCommand.payload.session.queueRevision,
    );
    const handoffAck = await request(`/playback/commands/${handoffCommand.id}/ack`, {
      method: 'POST',
      body: { deviceId: deviceB, status: 'ok' },
    });
    assert.equal(handoffAck.response.status, 200);
    assert.equal(handoffAck.body.transferStatus, 'pending');
    assert.equal(
      (await request('/playback/state')).body.session.activeDeviceId,
      deviceA,
    );

    const sourcePausePoll = await request('/playback/poll', {
      method: 'POST',
      body: {
        deviceId: deviceA,
        name: 'Android • A',
        platform: 'android',
        snapshot: {
          ...changedSnapshot,
          positionMs: 45_000,
          playing: false,
        },
      },
    });
    const sourcePauseCommand = sourcePausePoll.body.commands.find(
      ({ action, payload }) =>
        action === 'pause' &&
        payload.handoffTransferId === retry.body.transferId,
    );
    assert.ok(sourcePauseCommand);
    assert.equal(sourcePausePoll.body.session.positionMs, 45_000);
    const sourcePauseAck = await request(
      `/playback/commands/${sourcePauseCommand.id}/ack`,
      {
        method: 'POST',
        body: { deviceId: deviceA, status: 'ok' },
      },
    );
    assert.equal(sourcePauseAck.body.transferStatus, 'completed');
    const transfer = await request(`/playback/transfers/${retry.body.transferId}`);
    assert.equal(transfer.body.status, 'completed');
    const handedOffState = await request('/playback/state');
    assert.equal(handedOffState.body.session.activeDeviceId, deviceB);
    assert.equal(handedOffState.body.session.positionMs, 45_000);
    assert.equal(handedOffState.body.session.playing, true);
    assert.deepEqual(handedOffState.body.session.trackIds, snapshot.trackIds);

    const invalidQueueCommand = await request('/playback/commands', {
      method: 'POST',
      body: { action: 'queuePlay', payload: { index: 2 } },
    });
    assert.equal(invalidQueueCommand.response.status, 400);
    assert.equal(invalidQueueCommand.body.error, 'invalid_command');

    const queuedCommand = await request('/playback/commands', {
      method: 'POST',
      body: { action: 'seek', payload: { positionMs: 9000 } },
    });
    assert.equal(queuedCommand.response.status, 202);

    const targetPoll = await request('/playback/poll', {
      method: 'POST',
      body: { deviceId: deviceB, name: 'Android • B', platform: 'android' },
    });
    assert.equal(targetPoll.body.serverRequestTimestamp, testTime.toISOString());
    assert.equal(targetPoll.body.serverTimestamp, testTime.toISOString());
    assert.equal(targetPoll.body.session.serverTimestamp, testTime.toISOString());
    assert.deepEqual(targetPoll.body.commands.map(({ action, payload }) => [action, payload]), [
      ['seek', { positionMs: 9000 }],
    ]);

    const acknowledgedSnapshot = {
      ...snapshot,
      index: targetPoll.body.session.index,
      positionMs: 9000,
      playbackEpoch: targetPoll.body.session.playbackEpoch,
    };
    const ack = await request(`/playback/commands/${targetPoll.body.commands[0].id}/ack`, {
      method: 'POST',
      body: {
        deviceId: deviceB,
        status: 'ok',
        snapshot: acknowledgedSnapshot,
      },
    });
    assert.equal(ack.response.status, 200);
    const acknowledgedState = (await request('/playback/state')).body.session;
    assert.equal(acknowledgedState.positionMs, 9000);
    assert.equal(acknowledgedState.index, targetPoll.body.session.index);
    assert.equal(acknowledgedState.playing, true);
    assert.ok(acknowledgedState.revision > targetPoll.body.session.revision);
    const duplicateAck = await request(
      `/playback/commands/${targetPoll.body.commands[0].id}/ack`,
      {
        method: 'POST',
        body: { deviceId: deviceB, status: 'ok' },
      },
    );
    assert.equal(duplicateAck.response.status, 200);
    assert.equal(duplicateAck.body.status, 'ok');
    const commandStatus = await request(
      `/playback/commands/${queuedCommand.body.commandId}`,
    );
    assert.equal(commandStatus.body.status, 'ok');
    const storedCommand = database.collection('playback_commands').documents
      .find((command) => String(command._id) === queuedCommand.body.commandId);
    assert.ok(storedCommand.deadlineAt);
    assert.equal(
      storedCommand.expiresAt.getTime() - storedCommand.deadlineAt.getTime(),
      24 * 60 * 60 * 1000,
    );

    const pendingCommand = await request('/playback/commands', {
      method: 'POST',
      body: { action: 'pause' },
    });
    const cancellation = await request(
      `/playback/commands/${pendingCommand.body.commandId}`,
      { method: 'DELETE' },
    );
    assert.equal(cancellation.response.status, 200);
    assert.equal(
      (
        await request(`/playback/commands/${pendingCommand.body.commandId}`)
      ).body.status,
      'cancelled',
    );

    const expiringCommand = await request('/playback/commands', {
      method: 'POST',
      body: { action: 'pause' },
    });
    testTime = new Date(testTime.getTime() + 61_000);
    const lateAck = await request(
      `/playback/commands/${expiringCommand.body.commandId}/ack`,
      {
        method: 'POST',
        body: { deviceId: deviceB, status: 'ok' },
      },
    );
    assert.equal(lateAck.response.status, 409);
    assert.equal(lateAck.body.error, 'command_expired');
    const expiredStatus = await request(
      `/playback/commands/${expiringCommand.body.commandId}`,
    );
    assert.equal(expiredStatus.body.status, 'failed');
    assert.equal(expiredStatus.body.error, 'command_timeout');

    const otherAccount = await request('/playback/state', { user: 'user-b' });
    assert.equal(otherAccount.response.status, 200);
    assert.equal(otherAccount.body.session, null);
    assert.deepEqual(otherAccount.body.devices, []);

    const rename = await request(`/playback/devices/${deviceB}`, {
      method: 'PATCH',
      body: { name: 'Office PC', visible: false },
    });
    assert.equal(rename.response.status, 200);
    assert.equal(rename.body.name, 'Office PC');
    assert.equal(rename.body.visible, false);
    assert.equal(
      (await request('/playback/state')).body.devices.some(
        ({ deviceId }) => deviceId === deviceB,
      ),
      false,
    );
    testTime = new Date(testTime.getTime() + 21_000);
    const stalePlayback = await request('/playback/state');
    assert.equal(stalePlayback.body.session.playing, false);
    assert.equal(
      stalePlayback.body.devices.find(({ deviceId }) => deviceId === deviceA)
        ?.online,
      false,
    );
    assert.equal(
      database.collection('playback_sessions').documents[0].resumeOnFailover,
      true,
    );

    const failoverCommandPoll = await request('/playback/poll', {
      method: 'POST',
      body: { deviceId: deviceA, name: 'Android • A', platform: 'android' },
    });
    const failoverCommand = failoverCommandPoll.body.commands.find(
      ({ action }) => action === 'handoff',
    );
    assert.ok(failoverCommand);
    assert.equal(failoverCommand.payload.session.playing, true);
    const failoverAck = await request(
      `/playback/commands/${failoverCommand.id}/ack`,
      {
        method: 'POST',
        body: { deviceId: deviceA, status: 'ok' },
      },
    );
    assert.equal(failoverAck.body.transferStatus, 'completed');
    const resumedSession = (await request('/playback/state')).body.session;
    assert.equal(resumedSession.activeDeviceId, deviceA);
    assert.equal(resumedSession.playing, true);
    assert.equal(
      database.collection('playback_sessions').documents[0].resumeOnFailover,
      false,
    );
    const idempotent = await request('/playback/commands', {
      method: 'POST',
      body: {
        action: 'pause',
        idempotencyKey: '0123456789abcdef',
        expectedRevision: resumedSession.revision,
      },
    });
    const duplicate = await request('/playback/commands', {
      method: 'POST',
      body: {
        action: 'pause',
        idempotencyKey: '0123456789abcdef',
        expectedRevision: resumedSession.revision,
      },
    });
    assert.equal(idempotent.response.status, 202);
    assert.equal(idempotent.body.duplicate, false);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.body.commandId, idempotent.body.commandId);

    const reusedKey = await request('/playback/commands', {
      method: 'POST',
      body: {
        action: 'next',
        idempotencyKey: '0123456789abcdef',
        expectedRevision: resumedSession.revision,
      },
    });
    assert.equal(reusedKey.response.status, 409);
    assert.equal(reusedKey.body.error, 'idempotency_key_reused');

    const staleCommand = await request('/playback/commands', {
      method: 'POST',
      body: {
        action: 'next',
        idempotencyKey: 'abcdef0123456789',
        expectedRevision: resumedSession.revision - 1,
      },
    });
    assert.equal(staleCommand.response.status, 409);
    assert.equal(staleCommand.body.error, 'stale_playback_state');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
