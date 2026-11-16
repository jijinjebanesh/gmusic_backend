import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publishPlaybackEvent,
  subscribePlaybackEvents,
} from '../src/playback_event_bus.js';

test('playback notifications target only the matching account and device', () => {
  const received = { first: 0, second: 0, otherAccount: 0 };
  const unsubscribe = [
    subscribePlaybackEvents({
      userId: 'user-a',
      deviceId: 'device-a',
      connectionId: 'connection-a',
      onEvent: () => { received.first += 1; },
    }),
    subscribePlaybackEvents({
      userId: 'user-a',
      deviceId: 'device-b',
      connectionId: 'connection-b',
      onEvent: () => { received.second += 1; },
    }),
    subscribePlaybackEvents({
      userId: 'user-b',
      deviceId: 'device-a',
      connectionId: 'connection-c',
      onEvent: () => { received.otherAccount += 1; },
    }),
  ];

  try {
    publishPlaybackEvent('user-a', { deviceId: 'device-b' });
    publishPlaybackEvent('user-a', {
      deviceId: 'device-a',
      exceptConnectionId: 'connection-a',
    });
    assert.deepEqual(received, {
      first: 0,
      second: 1,
      otherAccount: 0,
    });
  } finally {
    for (const remove of unsubscribe) remove();
  }
});
