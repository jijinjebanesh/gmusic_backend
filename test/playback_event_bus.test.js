import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachPlaybackSocketServer,
  configurePlaybackEventBus,
  playbackEventsAreShared,
  playbackRedisStatus,
  playbackRealtimeStatus,
  publishPlaybackEvent,
} from '../src/playback_event_bus.js';

function createRedisPair({ denyPublish = false } = {}) {
  const subscriber = {
    isOpen: false,
    isReady: false,
    patternListener: null,
    async connect() {
      this.isOpen = true;
      this.isReady = true;
    },
    async pSubscribe(_pattern, listener) {
      this.patternListener = listener;
    },
    async subscribe() {},
    async pUnsubscribe() {},
    async unsubscribe() {},
    destroy() {
      this.isOpen = false;
      this.isReady = false;
      this.destroyed = true;
    },
    on() {},
  };
  const publisher = {
    isOpen: false,
    isReady: false,
    duplicate: () => subscriber,
    async connect() {
      this.isOpen = true;
      this.isReady = true;
    },
    async publish(channel, message) {
      if (denyPublish) {
        throw Object.assign(new Error('NOPERM publish'), { code: 'NOPERM' });
      }
      subscriber.patternListener?.(message, channel);
      return 1;
    },
    destroy() {
      this.isOpen = false;
      this.isReady = false;
      this.destroyed = true;
    },
    on() {},
  };
  return { publisher, subscriber };
}

test('playback notifications use account-scoped Socket.IO rooms', () => {
  const emitted = [];
  const io = {
    to(room) {
      return {
        emit(event, payload) {
          emitted.push({ room, event, payload });
        },
      };
    },
  };
  attachPlaybackSocketServer(io);

  publishPlaybackEvent('user-a');
  publishPlaybackEvent('user-a', { deviceId: 'device-b' });
  assert.deepEqual(emitted.map(({ room, event }) => [room, event]), [
    ['user:user-a', 'playback:changed'],
    ['device:user-a:device-b', 'playback:changed'],
  ]);
  assert.equal(playbackEventsAreShared(), false);
  assert.equal(playbackRealtimeStatus(), 'socketio_local');
});

test('Redis Pub/Sub permissions are verified before attaching the adapter', async () => {
  const clients = createRedisPair();
  let attachedAdapter;
  const io = { adapter: (adapter) => { attachedAdapter = adapter; } };

  const ready = await configurePlaybackEventBus(io, {
    redisUrl: 'redis://local-test',
    timeoutMs: 100,
    createRedisClient: () => clients.publisher,
    makeAdapter: () => 'redis-adapter',
  });

  assert.equal(ready, true);
  assert.equal(attachedAdapter, 'redis-adapter');
  assert.equal(playbackEventsAreShared(), true);
  assert.equal(playbackRedisStatus(), 'ready');
  assert.equal(playbackRealtimeStatus(), 'socketio_redis');

  await configurePlaybackEventBus(io, { redisUrl: null });
});

test('a Redis NOPERM publish failure leaves Socket.IO on the safe local adapter', async () => {
  const clients = createRedisPair({ denyPublish: true });
  let adapterAttached = false;
  const io = { adapter: () => { adapterAttached = true; } };

  const ready = await configurePlaybackEventBus(io, {
    redisUrl: 'redis://local-test',
    timeoutMs: 100,
    createRedisClient: () => clients.publisher,
    makeAdapter: () => 'redis-adapter',
  });

  assert.equal(ready, false);
  assert.equal(adapterAttached, false);
  assert.equal(clients.publisher.destroyed, true);
  assert.equal(clients.subscriber.destroyed, true);
  assert.equal(playbackEventsAreShared(), false);
  assert.equal(playbackRedisStatus(), 'disconnected');
  assert.equal(playbackRealtimeStatus(), 'socketio_local');

  await configurePlaybackEventBus(io, { redisUrl: null });
});
