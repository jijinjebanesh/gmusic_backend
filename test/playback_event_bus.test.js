import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachPlaybackSocketServer,
  playbackEventsAreShared,
  playbackRealtimeStatus,
  publishPlaybackEvent,
} from '../src/playback_event_bus.js';

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
