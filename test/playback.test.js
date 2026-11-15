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
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: req.get('x-user-id') || 'user-a' };
    next();
  });
  app.use(createPlaybackRouter({
    collection: (name) => database.collection(name),
    now: () => new Date('2026-11-16T00:00:00.000Z'),
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

    const handoff = await request('/playback/handoff', {
      method: 'POST',
      body: { deviceId: deviceB },
    });
    assert.equal(handoff.response.status, 200);
    assert.equal(handoff.body.session.activeDeviceId, deviceB);
    assert.deepEqual(handoff.body.session.trackIds, snapshot.trackIds);

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
    assert.deepEqual(
      targetPoll.body.commands.map(({ action, payload }) => [action, payload]),
      [['seek', { positionMs: 9000 }]],
    );

    const ack = await request(`/playback/commands/${targetPoll.body.commands[0].id}/ack`, {
      method: 'POST',
      body: { deviceId: deviceB, status: 'ok' },
    });
    assert.equal(ack.response.status, 200);

    const otherAccount = await request('/playback/state', { user: 'user-b' });
    assert.equal(otherAccount.response.status, 200);
    assert.equal(otherAccount.body.session, null);
    assert.deepEqual(otherAccount.body.devices, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
