import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';

let io;
let publisher;
let subscriber;
let redisConfigured = false;

export async function configurePlaybackEventBus(
  socketServer,
  { redisUrl = process.env.REDIS_URL, timeoutMs = 5_000 } = {},
) {
  io = socketServer;
  redisConfigured = Boolean(redisUrl);
  if (!redisUrl) {
    console.warn(
      'REDIS_URL is not configured; playback sockets use local realtime with REST polling recovery.',
    );
    return false;
  }

  publisher = createClient({
    url: redisUrl,
    socket: {
      reconnectStrategy: (attempt) => Math.min(attempt * 250, 5_000),
    },
  });
  subscriber = publisher.duplicate();
  for (const [name, client] of [
    ['publisher', publisher],
    ['subscriber', subscriber],
  ]) {
    client.on('error', (error) => {
      console.error(`Playback Redis ${name} error:`, error.name);
    });
  }
  publisher.on('end', () => {
    console.error('Playback Redis publisher disconnected.');
  });
  subscriber.on('end', () => {
    console.error('Playback Redis subscriber disconnected.');
  });

  socketServer.adapter(createAdapter(publisher, subscriber));
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    Promise.all([publisher.connect(), subscriber.connect()]).then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      (error) => {
        clearTimeout(timer);
        console.error('Playback Redis adapter connection failed:', error.name);
        resolve(false);
      },
    );
  });
}

export function attachPlaybackSocketServer(socketServer) {
  io = socketServer;
}

export function publishPlaybackEvent(userId, { deviceId = null } = {}) {
  if (!io || !userId) return;
  const room = deviceId
    ? deviceRoom(userId, deviceId)
    : userRoom(userId);
  io.to(room).emit('playback:changed', {
    deviceId,
    serverTimestamp: new Date().toISOString(),
  });
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
