import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { io as createClient } from 'socket.io-client';
import { attachPlaybackSocketIO } from '../src/playback_socketio.js';
import { userRoom } from '../src/playback_event_bus.js';

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

test('Socket.IO authenticates devices and uses server-authorized account rooms', async () => {
  const server = createServer();
  const polls = [];
  let commandCreated = false;
  const socketServer = attachPlaybackSocketIO(server, {
    apiToken: 'api-token',
    configureEventBus: () => false,
    authenticate: async (token) => {
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
      return {
        session: null,
        devices: [],
        commands: commandCreated && body.deviceId === DEVICE_B
          ? [{ id: COMMAND_ID, action: 'seek', payload: { positionMs: 1200 } }]
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
    acknowledgeCommand: async (input) => ({
      ok: true,
      commandId: input.commandId,
      status: input.status,
      error: input.error || null,
    }),
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
    });
    assert.equal(acknowledged.ok, true);
    const [result] = await commandResult;
    assert.equal(result.status, 'ok');

    const changedA = once(clientA, 'playback:changed');
    const changedPeer = once(clientPeer, 'playback:changed');
    let changedB = false;
    clientOther.once('playback:changed', () => { changedB = true; });
    socketServer.io.to(userRoom('user-a')).emit('playback:changed', {
      deviceId: null,
    });
    await Promise.all([changedA, changedPeer]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(changedB, false);
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
