import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { logoutSession } from '../src/auth.js';

class MemoryCollection {
  constructor(documents = []) {
    this.documents = documents;
  }

  async findOne(filter) {
    return this.documents.find((document) =>
      Object.entries(filter).every(([key, value]) => document[key] === value),
    ) || null;
  }

  async updateOne(filter, update) {
    const document = await this.findOne(filter);
    if (!document) return { matchedCount: 0 };
    Object.assign(document, update.$set || {});
    for (const [key, increment] of Object.entries(update.$inc || {})) {
      document[key] = (document[key] || 0) + increment;
    }
    return { matchedCount: 1 };
  }

  async deleteOne(filter) {
    const index = this.documents.findIndex((document) =>
      Object.entries(filter).every(([key, value]) => document[key] === value),
    );
    if (index < 0) return { deletedCount: 0 };
    this.documents.splice(index, 1);
    return { deletedCount: 1 };
  }
}

function createDatabase(token, { groupClaim = false } = {}) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const collections = new Map([
    ['sessions', new MemoryCollection([{ tokenHash, userId: 'user-a' }])],
    ['playback_devices', new MemoryCollection([{
      userId: 'user-a',
      deviceId: 'device-a',
      ...(groupClaim
        ? {
            groupSessionId: 'group-a',
            groupSessionExpiresAt: new Date('2026-11-26T13:00:00.000Z'),
          }
        : {}),
    }])],
    ['playback_sessions', new MemoryCollection([{
      _id: 'user-a',
      activeDeviceId: 'device-a',
      trackIds: ['track-a'],
      index: 0,
      positionMs: 1200,
      durationMs: 180_000,
      playing: true,
      shuffle: false,
      repeat: 'none',
      volume: 1,
      revision: 3,
      queueRevision: 1,
      playbackEpoch: 2,
    }])],
  ]);
  return {
    collection: (name) => collections.get(name),
    collections,
  };
}

test('logout clears active playback ownership before revoking the session', async () => {
  const token = 'session-token';
  const database = createDatabase(token);

  await logoutSession({
    bearer: token,
    deviceId: 'device-a',
    collection: database.collection,
    now: () => new Date('2026-11-26T12:00:00.000Z'),
  });

  assert.equal(database.collections.get('sessions').documents.length, 0);
  assert.equal(database.collections.get('playback_devices').documents.length, 0);
  const playback = database.collections.get('playback_sessions').documents[0];
  assert.equal(playback.activeDeviceId, null);
  assert.equal(playback.playing, false);
  assert.equal(playback.revision, 4);
  assert.equal(playback.playbackEpoch, 3);
});

test('logout preserves a device with a live Group Listening claim', async () => {
  const token = 'session-token';
  const database = createDatabase(token, { groupClaim: true });

  await logoutSession({
    bearer: token,
    deviceId: 'device-a',
    collection: database.collection,
    now: () => new Date('2026-11-26T12:00:00.000Z'),
  });

  assert.equal(database.collections.get('sessions').documents.length, 0);
  assert.equal(database.collections.get('playback_devices').documents.length, 1);
  const playback = database.collections.get('playback_sessions').documents[0];
  assert.equal(playback.activeDeviceId, null);
  assert.equal(playback.playing, false);
});

test('logout without a deviceId remains backward compatible', async () => {
  const database = createDatabase('session-token');

  await logoutSession({
    bearer: 'session-token',
    collection: database.collection,
  });

  assert.equal(database.collections.get('sessions').documents.length, 0);
  assert.equal(database.collections.get('playback_devices').documents.length, 1);
  assert.equal(
    database.collections.get('playback_sessions').documents[0].activeDeviceId,
    'device-a',
  );
});
