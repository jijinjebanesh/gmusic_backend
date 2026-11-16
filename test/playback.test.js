import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { ObjectId } from 'mongodb';
import { createPlaybackRouter } from '../src/playback.js';

class MemoryCollection {
  constructor() {
    this.documents = [];
  }

  matches(document, filter) {
    return Object.entries(filter).every(([key, expected]) => {
      const actual = document[key];
      if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
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
    Object.assign(document, update.$set || {});
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

    const secondPoll = await request('/playback/poll', {
      method: 'POST',
      body: {
        deviceId: deviceB,
        name: 'Android • B',
        platform: 'android',
      },
    });
    assert.equal(secondPoll.response.status, 200);

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
    const handoffAck = await request(`/playback/commands/${handoffCommand.id}/ack`, {
      method: 'POST',
      body: { deviceId: deviceB, status: 'ok' },
    });
    assert.equal(handoffAck.response.status, 200);
    assert.equal(handoffAck.body.transferStatus, 'completed');
    const transfer = await request(`/playback/transfers/${retry.body.transferId}`);
    assert.equal(transfer.body.status, 'completed');
    const handedOffState = await request('/playback/state');
    assert.equal(handedOffState.body.session.activeDeviceId, deviceB);
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
    assert.deepEqual(targetPoll.body.commands.map(({ action, payload }) => [action, payload]), [
      ['seek', { positionMs: 9000 }],
    ]);

    const ack = await request(`/playback/commands/${targetPoll.body.commands[0].id}/ack`, {
      method: 'POST',
      body: { deviceId: deviceB, status: 'ok' },
    });
    assert.equal(ack.response.status, 200);
    const commandStatus = await request(
      `/playback/commands/${queuedCommand.body.commandId}`,
    );
    assert.equal(commandStatus.body.status, 'ok');

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

    await request('/playback/poll', {
      method: 'POST',
      body: { deviceId: deviceA, name: 'Android • A', platform: 'android' },
    });
    const failover = await request('/playback/handoff', {
      method: 'POST',
      body: { deviceId: deviceA },
    });
    const failoverCommandPoll = await request('/playback/poll', {
      method: 'POST',
      body: { deviceId: deviceA, name: 'Android • A', platform: 'android' },
    });
    const failoverCommand = failoverCommandPoll.body.commands.find(
      ({ action, payload }) =>
        action === 'handoff' && payload.transferId === failover.body.transferId,
    );
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
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
