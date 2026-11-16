import crypto from 'node:crypto';
import Redis from 'ioredis';

const CHANNEL = 'gmusic:playback:events:v1';
const instanceId = crypto.randomUUID();
const eventSalt = process.env.MORNYE_API_TOKEN || 'gmusic-playback-events-v1';
const listenersByUser = new Map();
const redisUrl = process.env.REDIS_URL;
const publisher = redisUrl
  ? new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt) => Math.min(attempt * 250, 5_000),
    })
  : null;
const subscriber = publisher?.duplicate();
let subscribed = false;

function keyFor(value) {
  return crypto.createHmac('sha256', eventSalt).update(String(value)).digest('base64url');
}

function dispatch(event) {
  for (const listener of listenersByUser.get(event.userKey) || []) {
    if (event.exceptConnectionId === listener.connectionId) continue;
    if (event.deviceKey && event.deviceKey !== listener.deviceKey) continue;
    listener.onEvent(event);
  }
}

if (subscriber) {
  subscriber.on('message', (channel, raw) => {
    if (channel !== CHANNEL) return;
    try {
      const event = JSON.parse(raw);
      if (event.instanceId !== instanceId) dispatch(event);
    } catch (error) {
      console.error('Invalid playback event received from Redis:', error.name);
    }
  });
  subscriber.on('ready', () => {
    void subscriber.subscribe(CHANNEL).then(() => {
      subscribed = true;
    }).catch((error) => {
      subscribed = false;
      console.error('Could not subscribe to playback Redis events:', error.name);
    });
  });
  subscriber.on('close', () => {
    subscribed = false;
  });
  subscriber.on('error', (error) => {
    subscribed = false;
    console.error('Playback Redis subscriber error:', error.name);
  });
  publisher.on('error', (error) => {
    console.error('Playback Redis publisher error:', error.name);
  });
}

export function subscribePlaybackEvents({
  userId,
  deviceId,
  connectionId,
  onEvent,
}) {
  const userKey = keyFor(userId);
  const listeners = listenersByUser.get(userKey) || new Set();
  const listener = {
    deviceKey: keyFor(deviceId),
    connectionId,
    onEvent,
  };
  listeners.add(listener);
  listenersByUser.set(userKey, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByUser.delete(userKey);
  };
}

export function publishPlaybackEvent(
  userId,
  { deviceId = null, exceptConnectionId = null } = {},
) {
  const event = {
    userKey: keyFor(userId),
    deviceKey: deviceId ? keyFor(deviceId) : null,
    exceptConnectionId,
    instanceId,
  };
  dispatch(event);
  if (publisher?.status === 'ready' && subscribed) {
    void publisher.publish(CHANNEL, JSON.stringify({
      ...event,
      exceptConnectionId: null,
    })).catch((error) => {
      console.error('Could not publish playback Redis event:', error.name);
    });
  }
}

export function playbackEventsAreShared() {
  return publisher?.status === 'ready' && subscribed;
}
