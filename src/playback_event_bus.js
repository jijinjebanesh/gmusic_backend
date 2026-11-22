import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';

let io;
let publisher;
let subscriber;
let redisConfigured = false;

function withTimeout(promise, timeoutMs, code) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error(code), { code })),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function verifyRedisPubSub(publisher, subscriber, timeoutMs) {
  const channel = 'socket.io#/#gmusic-permission-probe#';
  const pattern = 'socket.io#/#*';
  const requestChannels = [
    'socket.io-request#/#',
    'socket.io-response#/#',
    'socket.io-response#/#probe#',
  ];
  const message = randomUUID();
  let resolveReceived;
  const received = new Promise((resolve) => {
    resolveReceived = resolve;
  });

  await withTimeout(
    subscriber.pSubscribe(pattern, (value, receivedChannel) => {
      if (value === message && receivedChannel === channel) {
        resolveReceived();
      }
    }),
    timeoutMs,
    'redis_psubscribe_timeout',
  );
  await withTimeout(
    subscriber.subscribe(requestChannels, () => {}),
    timeoutMs,
    'redis_subscribe_timeout',
  );
  await withTimeout(
    publisher.publish(channel, message),
    timeoutMs,
    'redis_publish_timeout',
  );
  await withTimeout(received, timeoutMs, 'redis_pubsub_delivery_timeout');
  await withTimeout(
    subscriber.pUnsubscribe(pattern),
    timeoutMs,
    'redis_punsubscribe_timeout',
  );
  await withTimeout(
    subscriber.unsubscribe(requestChannels),
    timeoutMs,
    'redis_unsubscribe_timeout',
  );
}

function safeRedisErrorCode(error) {
  if (error?.code === 'NOPERM' || error?.message?.startsWith('NOPERM')) {
    return 'NOPERM';
  }
  return error?.code || error?.name || 'redis_setup_failed';
}

export async function configurePlaybackEventBus(
  socketServer,
  {
    redisUrl = process.env.REDIS_URL,
    timeoutMs = 5_000,
    createRedisClient = createClient,
    makeAdapter = createAdapter,
  } = {},
) {
  io = socketServer;
  publisher?.destroy();
  subscriber?.destroy();
  publisher = null;
  subscriber = null;
  redisConfigured = Boolean(redisUrl);
  if (!redisUrl) {
    console.warn(
      'REDIS_URL is not configured; playback sockets use local realtime with REST polling recovery.',
    );
    return false;
  }

  const nextPublisher = createRedisClient({
    url: redisUrl,
    socket: {
      reconnectStrategy: (attempt) => Math.min(attempt * 250, 5_000),
    },
  });
  const nextSubscriber = nextPublisher.duplicate();
  for (const [name, client] of [
    ['publisher', nextPublisher],
    ['subscriber', nextSubscriber],
  ]) {
    client.on('error', (error) => {
      console.error(`Playback Redis ${name} error:`, error.name);
    });
  }
  nextPublisher.on('end', () => {
    console.error('Playback Redis publisher disconnected.');
  });
  nextSubscriber.on('end', () => {
    console.error('Playback Redis subscriber disconnected.');
  });

  try {
    await withTimeout(
      Promise.all([nextPublisher.connect(), nextSubscriber.connect()]),
      timeoutMs,
      'redis_connect_timeout',
    );
    await verifyRedisPubSub(nextPublisher, nextSubscriber, timeoutMs);
    socketServer.adapter(makeAdapter(nextPublisher, nextSubscriber));
    publisher = nextPublisher;
    subscriber = nextSubscriber;
    return true;
  } catch (error) {
    console.error(
      'Playback Redis adapter unavailable; using local Socket.IO with REST polling:',
      safeRedisErrorCode(error),
    );
    nextPublisher.destroy();
    nextSubscriber.destroy();
    return false;
  }
}

export function attachPlaybackSocketServer(socketServer) {
  io = socketServer;
}

export function publishPlaybackEvent(
  userId,
  {
    deviceId = null,
    session = null,
    serverTimestamp = new Date().toISOString(),
    exceptConnectionId = null,
  } = {},
) {
  if (!io || !userId) return;
  const room = deviceId
    ? deviceRoom(userId, deviceId)
    : userRoom(userId);
  const operator = exceptConnectionId
    ? io.to(room).except(exceptConnectionId)
    : io.to(room);
  operator.emit('playback:changed', {
    deviceId,
    serverTimestamp,
    ...(session
      ? {
          session,
          positionMs: session.positionMs,
          isPlaying: session.playing === true,
          playbackEpoch: session.playbackEpoch || 0,
          stateVersion: session.stateVersion || session.revision || 0,
        }
      : {}),
  });
}

export function publishGroupEvent(sessionId, payload) {
  if (!io || !sessionId) return;
  io.to(groupRoom(sessionId)).emit('group:changed', payload);
}

export function publishAccountSyncInvite(userId, targetDeviceId, payload) {
  if (!io || !userId || !targetDeviceId) return;
  io.to(deviceRoom(userId, targetDeviceId)).emit('account:sync:invite', payload);
}

export function removeGroupDeviceFromRoom(sessionId, userId, deviceId) {
  if (!io || !sessionId || !userId || !deviceId) return;
  io.in(deviceRoom(userId, deviceId)).socketsLeave(groupRoom(sessionId));
}

export function removeGroupRoomSockets(sessionId) {
  if (!io || !sessionId) return;
  io.in(groupRoom(sessionId)).socketsLeave(groupRoom(sessionId));
}

export function playbackEventsAreShared() {
  return publisher?.isReady === true && subscriber?.isReady === true;
}

export function playbackRealtimeStatus() {
  if (playbackEventsAreShared()) return 'socketio_redis';
  return io ? 'socketio_local' : 'rest_polling';
}

export function playbackRedisStatus() {
  if (!redisConfigured) return 'not_configured';
  if (playbackEventsAreShared()) return 'ready';
  if (
    (publisher?.isOpen === true && publisher?.isReady !== true) ||
    (subscriber?.isOpen === true && subscriber?.isReady !== true)
  ) {
    return 'connecting';
  }
  return 'disconnected';
}

export function userRoom(userId) {
  return `user:${userId}`;
}

export function deviceRoom(userId, deviceId) {
  return `device:${userId}:${deviceId}`;
}

export function groupRoom(sessionId) {
  return `group:${sessionId}`;
}
