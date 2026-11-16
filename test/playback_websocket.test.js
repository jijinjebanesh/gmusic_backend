import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { attachPlaybackWebSocket } from '../src/playback_websocket.js';

function nextMessage(socket, expected) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${expected}`)),
      3_000,
    );
    socket.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
    socket.once('error', reject);
  });
}

test('playback WebSocket authenticates, syncs and accepts heartbeats', async () => {
  const server = createServer();
  const polls = [];
  const sockets = attachPlaybackWebSocket(server, {
    apiToken: 'api-token',
    authenticate: async (token) => {
      assert.equal(token, 'session-token');
      return { user: { id: 'user-a' }, ownerMode: false };
    },
    poll: async ({ userId, body }) => {
      polls.push({ userId, body });
      return {
        session: null,
        devices: [],
        commands: [],
      };
    },
    isShared: () => true,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.address().port}/api/v1/playback/socket`,
  );
  try {
    await once(socket, 'open');
    const readyMessage = nextMessage(socket, 'ready');
    socket.send(JSON.stringify({
      type: 'authenticate',
      token: 'session-token',
      device: {
        deviceId: '0123456789abcdef',
        name: 'Test device',
        platform: 'web',
      },
      snapshot: null,
      claim: false,
    }));
    const ready = await readyMessage;
    assert.equal(ready.type, 'ready');
    assert.equal(ready.crossInstance, true);
    assert.deepEqual(polls[0], {
      userId: 'user-a',
      body: {
        deviceId: '0123456789abcdef',
        name: 'Test device',
        platform: 'web',
        snapshot: null,
        claim: false,
      },
    });

    const syncMessage = nextMessage(socket, 'sync');
    socket.send(JSON.stringify({
      type: 'heartbeat',
      snapshot: null,
      claim: false,
    }));
    const sync = await syncMessage;
    assert.equal(sync.type, 'sync');
    assert.equal(polls.length, 2);
  } finally {
    socket.close();
    sockets.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('playback WebSocket rejects invalid session tokens', async () => {
  const server = createServer();
  const sockets = attachPlaybackWebSocket(server, {
    authenticate: async () => {
      throw Object.assign(new Error('session_expired'), {
        status: 401,
        code: 'session_expired',
      });
    },
    poll: async () => {
      throw new Error('must not poll');
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.address().port}/api/v1/playback/socket`,
  );
  try {
    await once(socket, 'open');
    const errorMessage = nextMessage(socket, 'authentication error');
    const closed = once(socket, 'close');
    socket.send(JSON.stringify({
      type: 'authenticate',
      token: 'expired',
      device: {
        deviceId: '0123456789abcdef',
        name: 'Test device',
        platform: 'web',
      },
    }));
    assert.deepEqual(await errorMessage, {
      type: 'error',
      error: 'session_expired',
    });
    const [code] = await closed;
    assert.equal(code, 1008);
  } finally {
    sockets.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('playback WebSocket closes when its session expires', async () => {
  const server = createServer();
  let sessionValid = true;
  const polls = [];
  const sockets = attachPlaybackWebSocket(server, {
    apiToken: 'api-token',
    authenticate: async (_token, _apiToken, { renew = true } = {}) => {
      if (!sessionValid) {
        throw Object.assign(new Error('session_expired'), {
          status: 401,
          code: 'session_expired',
        });
      }
      return { user: { id: 'user-a' }, ownerMode: false, renew };
    },
    poll: async ({ userId, body }) => {
      polls.push({ userId, body });
      return { session: null, devices: [], commands: [] };
    },
    isShared: () => true,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.address().port}/api/v1/playback/socket`,
  );
  try {
    await once(socket, 'open');
    const readyMessage = nextMessage(socket, 'ready');
    socket.send(JSON.stringify({
      type: 'authenticate',
      token: 'session-token',
      device: {
        deviceId: '0123456789abcdef',
        name: 'Test device',
        platform: 'web',
      },
    }));
    await readyMessage;
    sessionValid = false;

    const errorMessage = nextMessage(socket, 'session error');
    const closed = once(socket, 'close');
    socket.send(JSON.stringify({
      type: 'heartbeat',
      verifySession: true,
      snapshot: null,
      claim: false,
    }));
    assert.deepEqual(await errorMessage, {
      type: 'error',
      error: 'session_expired',
    });
    const [code] = await closed;
    assert.equal(code, 1008);
    assert.equal(polls.length, 1);
  } finally {
    sockets.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
