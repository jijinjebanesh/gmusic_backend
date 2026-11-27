import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ObjectId } from 'mongodb';
import { io as createClient } from 'socket.io-client';
import { attachPlaybackSocketIO } from '../src/playback_socketio.js';
import {
  publishGroupEvent,
  publishPlaybackEvent,
} from '../src/playback_event_bus.js';

const DEVICE_A = '0123456789abcdef0123456789abcdef';
const DEVICE_B = 'abcdef0123456789abcdef0123456789';
const COMMAND_ID = '0123456789abcdef01234567';

function ack(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(3_000).emit(event, payload, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

function connect(origin, token = 'token-a') {
  return createClient(origin, {
    path: '/api/v1/playback/socket',
    transports: ['websocket'],
    auth: { token },
    reconnection: false,
    timeout: 3_000,
  });
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(io) {
  await new Promise((resolve) => io.close(resolve));
}

function createPresenceDatabase() {
  const devices = [
    {
      userId: 'user-a',
      deviceId: DEVICE_A,
      name: 'Phone',
      platform: 'android',
      lastSeenAt: new Date(),
    },
    {
      userId: 'user-a',
      deviceId: DEVICE_B,
      name: 'Browser',
      platform: 'web',
      lastSeenAt: new Date(),
    },
  ];
  const sessions = [{
    _id: 'user-a',
    activeDeviceId: DEVICE_A,
    trackIds: ['track-a'],
    index: 0,
    positionMs: 1000,
    durationMs: 180_000,
    playing: true,
    shuffle: false,
    repeat: 'none',
    volume: 1,
    revision: 1,
    queueRevision: 1,
    playbackEpoch: 1,
    updatedAt: new Date(),
  }];
  const matches = (document, filter) => Object.entries(filter).every(([key, value]) => {
    const actual = document[key];
    if (value instanceof Date && actual instanceof Date) {
      return actual.getTime() === value.getTime();
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('$lte' in value) return actual <= value.$lte;
      if ('$gt' in value) return actual > value.$gt;
      return false;
    }
    return actual === value;
  });
  const collection = (name) => {
    const documents = name === 'playback_devices'
      ? devices
      : name === 'playback_sessions'
        ? sessions
        : [];
    return {
      async findOne(filter) {
        return documents.find((document) => matches(document, filter)) || null;
      },
      async updateOne(filter, update, { upsert = false } = {}) {
        let document = documents.find((item) => matches(item, filter));
        const matchedCount = document ? 1 : 0;
        if (!document && upsert) {
          document = Object.fromEntries(
            Object.entries(filter).filter(([, value]) => value == null || typeof value !== 'object'),
          );
          documents.push(document);
        }
        if (!document) return { matchedCount: 0 };
        Object.assign(document, update.$set || {});
        for (const key of Object.keys(update.$unset || {})) delete document[key];
        for (const [key, increment] of Object.entries(update.$inc || {})) {
          document[key] = (document[key] || 0) + increment;
        }
        return { matchedCount: matchedCount || 1 };
      },
    };
  };
  return { devices, sessions, collection };
}

test('Socket.IO authenticates devices and uses server-authorized account rooms', async () => {
  const server = createServer();
  const polls = [];
  const commandAcknowledgments = [];
  const authenticationOptions = [];
  let handoffCommit;
  let commandCreated = false;
  let prewarmCreated = false;
  const socketServer = attachPlaybackSocketIO(server, {
    apiToken: 'api-token',
    configureEventBus: () => false,
    authenticate: async (token, _apiToken, options) => {
      authenticationOptions.push(options);
      if (!token.startsWith('token-')) {
        throw Object.assign(new Error('session_expired'), {
          status: 401,
          code: 'session_expired',
        });
      }
      return {
        user: { id: token === 'token-b' ? 'user-b' : 'user-a' },
        ownerMode: false,
      };
    },
    poll: async ({ userId, body }) => {
      polls.push({ userId, body });
      if (body.deviceId === DEVICE_B && prewarmCreated) {
        prewarmCreated = false;
        return {
          session: null,
          devices: [],
          commands: [{
            id: 'fedcba9876543210fedcba98',
            action: 'prewarm',
            payload: { prewarmId: 'warm-switch-00000001', session: { activeDeviceId: DEVICE_A, trackIds: ['track-a'], index: 0 } },
          }],
        };
      }
      return {
        session: null,
        devices: [],
        commands: body.deviceId === DEVICE_B
          ? commandCreated ? [{ id: COMMAND_ID, action: 'seek', payload: { positionMs: 1200 } }] : []
          : [],
      };
    },
    createCommand: async (input) => {
      assert.equal(input.userId, 'user-a');
      assert.equal(input.action, 'seek');
      assert.equal(input.idempotencyKey, '0123456789abcdef');
      commandCreated = true;
      return {
        commandId: COMMAND_ID,
        deviceId: DEVICE_B,
        duplicate: false,
      };
    },
    createPrewarm: async (input) => {
      assert.equal(input.userId, 'user-a');
      assert.equal(input.requesterDeviceId, DEVICE_A);
      assert.equal(input.deviceId, DEVICE_B);
      prewarmCreated = true;
      return {
        commandId: 'fedcba9876543210fedcba98',
        prewarmId: input.prewarmId,
        status: 'pending',
      };
    },
    createHandoff: async (input) => {
      handoffCommit = input;
      return { transferId: 'handoff-transfer', status: 'pending' };
    },
    acknowledgeCommand: async (input) => {
      commandAcknowledgments.push(input);
      return {
        ok: true,
        commandId: input.commandId,
        status: input.status,
        error: input.error || null,
        ...(input.commandId === 'fedcba9876543210fedcba98'
          ? { prewarmId: 'warm-switch-00000001', requesterDeviceId: DEVICE_A }
          : {}),
      };
    },
  });
  const origin = await listen(server);
  const clientA = connect(origin);
  const clientPeer = connect(origin);
  const clientOther = connect(origin, 'token-b');
  try {
    await Promise.all([
      once(clientA, 'connect'),
      once(clientPeer, 'connect'),
      once(clientOther, 'connect'),
    ]);
    const [registeredA, registeredPeer, registeredOther] = await Promise.all([
      ack(clientA, 'device:register', {
        device: { deviceId: DEVICE_A, name: 'Phone', platform: 'android' },
        snapshot: {
          trackIds: ['track-a'],
          index: 0,
          positionMs: 1200,
          durationMs: 180_000,
          volume: 0.8,
          playing: true,
          shuffle: false,
          repeat: 'none',
          title: 'Track A',
          artist: 'Artist A',
          quality: 'medium',
          listenId: 'listen-session-0001',
          playbackEpoch: 1,
        },
      }),
      ack(clientPeer, 'device:register', {
        device: { deviceId: DEVICE_B, name: 'Browser', platform: 'web' },
      }),
      ack(clientOther, 'device:register', {
        device: { deviceId: DEVICE_B, name: 'Browser', platform: 'web' },
      }),
    ]);
    assert.equal(registeredA.ok, true);
    assert.equal(registeredA.crossInstance, false);
    assert.equal(registeredPeer.ok, true);
    assert.equal(registeredOther.ok, true);
    assert.equal(polls.length, 3);
    assert.equal(polls[0].userId, 'user-a');
    assert.equal(polls[0].body.snapshot.quality, 'medium');
    assert.equal(polls[0].body.snapshot.listenId, 'listen-session-0001');

    const prewarmAcceptedEvent = once(clientA, 'playback:prewarm:result');
    const prewarmAccepted = await ack(clientA, 'playback:prewarm', {
      deviceId: DEVICE_B,
      prewarmId: 'warm-switch-00000001',
    });
    assert.equal(prewarmAccepted.status, 'pending');
    const [acceptedStatus] = await prewarmAcceptedEvent;
    assert.equal(acceptedStatus.status, 'accepted');
    const prewarmResult = once(clientA, 'playback:prewarm:result');
    const prewarmCommands = await ack(clientPeer, 'playback:sync', {});
    assert.equal(prewarmCommands.result.commands[0].action, 'prewarm');
    await ack(clientPeer, 'playback:command:ack', {
      commandId: 'fedcba9876543210fedcba98', status: 'ok',
    });
    const [prewarmReady] = await prewarmResult;
    assert.equal(prewarmReady.prewarmId, 'warm-switch-00000001');
    assert.equal(prewarmReady.deviceId, DEVICE_B);
    assert.equal(prewarmReady.status, 'ready');

    const commit = {
      deviceId: DEVICE_B,
      requesterDeviceId: DEVICE_A,
      prewarmId: 'warm-switch-00000001',
      positionMs: 12_000,
      positionTimestamp: '2026-11-20T12:00:00.000Z',
      playbackRate: 1,
      queueRevision: 9,
      scheduledStartAt: '2026-11-20T12:00:00.350Z',
    };
    const transfer = await ack(clientA, 'playback:transfer', commit);
    assert.equal(transfer.status, 'pending');
    assert.equal(handoffCommit.requesterDeviceId, DEVICE_A);
    assert.equal(handoffCommit.positionMs, 12_000);
    assert.equal(handoffCommit.queueRevision, 9);
    assert.equal(handoffCommit.scheduledStartAt, commit.scheduledStartAt);
    const wrongRequester = await ack(clientA, 'playback:transfer', {
      ...commit,
      requesterDeviceId: DEVICE_B,
    });
    assert.equal(wrongRequester.ok, false);
    assert.equal(wrongRequester.error, 'requester_device_mismatch');

    const commandResult = once(clientA, 'playback:command:result');
    const targetNotification = once(clientPeer, 'playback:changed');
    const accepted = await ack(clientA, 'playback:command', {
      action: 'seek',
      payload: { positionMs: 1200 },
      commandId: '0123456789abcdef',
      expectedRevision: 4,
    });
    assert.deepEqual(accepted, {
      ok: true,
      status: 'accepted',
      commandId: COMMAND_ID,
      duplicate: false,
    });
    await targetNotification;
    const targetSync = await ack(clientPeer, 'playback:sync', {});
    assert.deepEqual(targetSync.result.commands, [{
      id: COMMAND_ID,
      action: 'seek',
      payload: { positionMs: 1200 },
    }]);
    const acknowledged = await ack(clientPeer, 'playback:command:ack', {
      commandId: COMMAND_ID,
      status: 'ok',
      snapshot: {
        trackIds: ['track-a'],
        index: 0,
        positionMs: 1200,
        durationMs: 180_000,
        volume: 1,
        playing: true,
        shuffle: false,
        repeat: 'none',
        title: 'Track A',
        artist: 'Artist A',
        playbackEpoch: 3,
      },
    });
    assert.equal(acknowledged.ok, true);
    assert.equal(
      commandAcknowledgments.find((item) => item.commandId === COMMAND_ID)
        .snapshot.positionMs,
      1200,
    );
    const [result] = await commandResult;
    assert.equal(result.status, 'ok');

    const changedA = once(clientA, 'playback:changed');
    const changedPeer = once(clientPeer, 'playback:changed');
    let changedB = false;
    clientOther.once('playback:changed', () => { changedB = true; });
    publishPlaybackEvent('user-a', {
      session: {
        positionMs: 1200,
        playing: true,
        playbackEpoch: 3,
        stateVersion: 8,
        revision: 8,
      },
    });
    const [[stateA], [statePeer]] = await Promise.all([changedA, changedPeer]);
    for (const state of [stateA, statePeer]) {
      assert.equal(state.positionMs, 1200);
      assert.equal(state.isPlaying, true);
      assert.equal(state.playbackEpoch, 3);
      assert.equal(state.stateVersion, 8);
      assert.ok(state.serverTimestamp);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(changedB, false);
    assert.ok(authenticationOptions.length > 3);
    assert.ok(authenticationOptions.every((options) => options?.renew !== false));
  } finally {
    clientA.disconnect();
    clientPeer.disconnect();
    clientOther.disconnect();
    await close(socketServer.io);
  }
});

test('Socket.IO rejects invalid session tokens before device registration', async () => {
  const server = createServer();
  const socketServer = attachPlaybackSocketIO(server, {
    apiToken: 'api-token',
    configureEventBus: () => false,
    authenticate: async () => {
      throw Object.assign(new Error('session_expired'), {
        status: 401,
        code: 'session_expired',
      });
    },
  });
  const origin = await listen(server);
  const client = connect(origin);
  try {
    const [error] = await once(client, 'connect_error');
    assert.equal(error.message, 'session_expired');
  } finally {
    client.disconnect();
    await close(socketServer.io);
  }
});

test('device registration waits for the playback event bus readiness result', async () => {
  const server = createServer();
  let finishEventBusSetup;
  const eventBusReady = new Promise((resolve) => {
    finishEventBusSetup = resolve;
  });
  const socketServer = attachPlaybackSocketIO(server, {
    apiToken: 'api-token',
    configureEventBus: () => eventBusReady,
    authenticate: async () => ({
      user: { id: 'user-a' },
      ownerMode: false,
    }),
    poll: async () => ({ session: null, devices: [], commands: [] }),
  });
  const origin = await listen(server);
  const client = connect(origin);
  try {
    await once(client, 'connect');
    const registration = ack(client, 'device:register', {
      device: { deviceId: DEVICE_A, name: 'Browser', platform: 'web' },
    });
    const acknowledgedEarly = await Promise.race([
      registration.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    assert.equal(acknowledgedEarly, false);
    finishEventBusSetup(false);
    const result = await registration;
    assert.equal(result.ok, true);
    assert.equal(result.crossInstance, false);
  } finally {
    finishEventBusSetup?.(false);
    client.disconnect();
    await close(socketServer.io);
  }
});

test('group Socket.IO rooms are available only to registered room members', async () => {
  const server = createServer();
  const sessionId = new ObjectId();
  const time = new Date();
  const room = {
    _id: sessionId,
    title: 'Private room',
    code: 'ABCDEFGH',
    status: 'paused',
    trackIds: ['track-a'],
    index: 0,
    positionMs: 0,
    playing: false,
    stateVersion: 1,
    queueRevision: 1,
    expiresAt: new Date(time.getTime() + 60_000),
    hostMemberId: 'member-a',
    members: [{
      memberId: 'member-a',
      userId: 'user-a',
      deviceId: DEVICE_A,
      name: 'Phone',
      platform: 'android',
      joinedAt: time,
      lastSeenAt: time,
      ready: false,
    }],
  };
  const collection = (name) => ({
    findOne: async (filter) => {
      if (name !== 'group_listening_sessions' ||
          !filter._id?.equals(sessionId) ||
          (filter.expiresAt?.$gt &&
            room.expiresAt <= filter.expiresAt.$gt)) {
        return null;
      }
      return room;
    },
  });
  const socketServer = attachPlaybackSocketIO(server, {
    apiToken: 'api-token',
    collection,
    now: () => time,
    configureEventBus: () => false,
    authenticate: async (token) => ({
      user: { id: token === 'token-b' ? 'user-b' : 'user-a' },
      ownerMode: false,
    }),
    poll: async () => ({ session: null, devices: [], commands: [] }),
  });
  const origin = await listen(server);
  const member = connect(origin);
  const outsider = connect(origin, 'token-b');
  try {
    await Promise.all([once(member, 'connect'), once(outsider, 'connect')]);
    await Promise.all([
      ack(member, 'device:register', {
        device: { deviceId: DEVICE_A, name: 'Phone', platform: 'android' },
      }),
      ack(outsider, 'device:register', {
        device: { deviceId: DEVICE_B, name: 'Browser', platform: 'web' },
      }),
    ]);

    const authorized = await ack(member, 'group:watch', {
      sessionId: String(sessionId),
    });
    const denied = await ack(outsider, 'group:watch', {
      sessionId: String(sessionId),
    });
    assert.equal(authorized.ok, true, JSON.stringify(authorized));
    assert.equal(authorized.crossInstance, false);
    assert.equal(denied.ok, false);
    assert.equal(denied.error, 'not_a_group_member');

    const groupUpdate = once(member, 'group:changed');
    let outsiderReceivedUpdate = false;
    outsider.once('group:changed', () => { outsiderReceivedUpdate = true; });
    publishGroupEvent(String(sessionId), { room: { sessionId: String(sessionId) } });
    const [update] = await groupUpdate;
    assert.equal(update.room.sessionId, String(sessionId));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(outsiderReceivedUpdate, false);
  } finally {
    member.disconnect();
    outsider.disconnect();
    await close(socketServer.io);
  }
});

test('Socket.IO disconnect marks an active device offline after the grace window', async () => {
  const server = createServer();
  const database = createPresenceDatabase();
  const socketServer = attachPlaybackSocketIO(server, {
    apiToken: 'api-token',
    collection: database.collection,
    disconnectGraceMs: 50,
    configureEventBus: () => false,
    authenticate: async () => ({
      user: { id: 'user-a' },
      ownerMode: false,
    }),
    poll: async ({ userId, body }) => {
      await database.collection('playback_devices').updateOne(
        { userId, deviceId: body.deviceId },
        {
          $set: {
            userId,
            deviceId: body.deviceId,
            name: body.name,
            platform: body.platform,
            lastSeenAt: new Date(),
          },
          $unset: { disconnectedAt: '' },
        },
        { upsert: true },
      );
      return { session: database.sessions[0], devices: [], commands: [] };
    },
  });
  const origin = await listen(server);
  const owner = connect(origin);
  const peer = connect(origin);
  try {
    await Promise.all([once(owner, 'connect'), once(peer, 'connect')]);
    await Promise.all([
      ack(owner, 'device:register', {
        device: { deviceId: DEVICE_A, name: 'Phone', platform: 'android' },
      }),
      ack(peer, 'device:register', {
        device: { deviceId: DEVICE_B, name: 'Browser', platform: 'web' },
      }),
    ]);

    const changedEvent = once(peer, 'playback:changed');
    const disconnected = once(owner, 'disconnect');
    owner.disconnect();
    await disconnected;
    const [changed] = await changedEvent;

    assert.equal(database.sessions[0].activeDeviceId, DEVICE_A);
    assert.equal(database.sessions[0].playing, false);
    assert.equal(database.sessions[0].resumeOnFailover, true);
    const device = database.devices.find(({ deviceId }) => deviceId === DEVICE_A);
    assert.equal(device.disconnectedAt, undefined);
    assert.ok(Date.now() - device.lastSeenAt.getTime() > 12_000);
    assert.equal(changed.requiresFullSync, true);
    assert.equal(changed.deviceListChanged, true);
    assert.equal(changed.session.playing, false);
  } finally {
    peer.disconnect();
    await close(socketServer.io);
  }
});

test('reconnecting within the Socket.IO disconnect grace cancels offline marking', async () => {
  const server = createServer();
  const database = createPresenceDatabase();
  const socketServer = attachPlaybackSocketIO(server, {
    apiToken: 'api-token',
    collection: database.collection,
    disconnectGraceMs: 100,
    configureEventBus: () => false,
    authenticate: async () => ({
      user: { id: 'user-a' },
      ownerMode: false,
    }),
    poll: async ({ userId, body }) => {
      await database.collection('playback_devices').updateOne(
        { userId, deviceId: body.deviceId },
        {
          $set: {
            userId,
            deviceId: body.deviceId,
            name: body.name,
            platform: body.platform,
            lastSeenAt: new Date(),
          },
          $unset: { disconnectedAt: '' },
        },
        { upsert: true },
      );
      return { session: database.sessions[0], devices: [], commands: [] };
    },
  });
  const origin = await listen(server);
  const original = connect(origin);
  let reconnected;
  try {
    await once(original, 'connect');
    await ack(original, 'device:register', {
      device: { deviceId: DEVICE_A, name: 'Phone', platform: 'android' },
    });
    const disconnected = once(original, 'disconnect');
    original.disconnect();
    await disconnected;
    await new Promise((resolve) => setTimeout(resolve, 10));

    reconnected = connect(origin);
    await once(reconnected, 'connect');
    await ack(reconnected, 'device:register', {
      device: { deviceId: DEVICE_A, name: 'Phone', platform: 'android' },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(database.sessions[0].playing, true);
    const device = database.devices.find(({ deviceId }) => deviceId === DEVICE_A);
    assert.equal(device.disconnectedAt, undefined);
    assert.ok(Date.now() - device.lastSeenAt.getTime() < 12_000);
  } finally {
    original.disconnect();
    reconnected?.disconnect();
    await close(socketServer.io);
  }
});
