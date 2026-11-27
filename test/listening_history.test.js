import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHomeFeed,
  qualifiesListen,
  recordListeningEvent,
} from '../src/listening_history.js';

test('listen qualification accepts 30 seconds, half-duration listens, and skips', () => {
  assert.equal(qualifiesListen({ listenedMs: 30_000, durationMs: 100_000 }), true);
  assert.equal(qualifiesListen({ listenedMs: 15_000, durationMs: 30_000 }), true);
  assert.equal(qualifiesListen({ listenedMs: 29_999, durationMs: 100_000 }), false);
  assert.equal(qualifiesListen({ listenedMs: 0, durationMs: 100_000, skipped: true }), true);
});

test('listening events are active-device scoped and idempotent by event id', async () => {
  const saved = [];
  const events = {
    findOne: async (query) => saved.find((event) =>
      event.userId === query.userId && event.eventId === query.eventId) || null,
    insertOne: async (event) => saved.push(event),
  };
  let activeDeviceId = 'device-abcdefghijklmnop';
  const sessions = { findOne: async () => ({ activeDeviceId }) };
  const recents = { updateOne: async () => {} };
  const input = {
    userId: 'user',
    deviceId: 'device-abcdefghijklmnop',
    event: {
      eventId: 'listen-abcdefghijklmnop',
      trackId: 'track-id',
      listenedMs: 30_000,
      durationMs: 120_000,
      skipped: false,
    },
    events,
    playbackSessions: sessions,
    recentPlays: recents,
    now: () => new Date('2026-04-04T12:00:00Z'),
  };

  assert.equal((await recordListeningEvent(input)).created, true);
  assert.equal((await recordListeningEvent(input)).created, false);
  activeDeviceId = 'device-qrstuvwxyzabcdef';
  assert.equal((await recordListeningEvent({
    ...input,
    deviceId: activeDeviceId,
  })).created, false);
  assert.equal(saved.length, 1);
  await assert.rejects(
    recordListeningEvent({
      ...input,
      deviceId: 'device-abcdefghijklmnop',
      event: { ...input.event, eventId: 'listen-qrstuvwxyzabcdef' },
    }),
    { code: 'device_not_active' },
  );
});

test('home feed returns stable IDs, cold-start shelves, and monthly stats', () => {
  const tracks = [
    {
      id: 'song-a',
      title: 'Song A',
      artist: 'Artist A',
      artists: ['Artist A'],
      artistIds: ['artist-a'],
      genreIds: ['genre-a'],
      albumId: 'album-a',
      albumArtistId: 'artist-a',
      album: 'Album A',
    },
    {
      id: 'song-b',
      title: 'Song B',
      artist: 'Artist A',
      artists: ['Artist A'],
      artistIds: ['artist-a'],
      genreIds: ['genre-a'],
      albumId: 'album-a',
      albumArtistId: 'artist-a',
      album: 'Album A',
    },
    ...['song-c', 'song-d', 'song-e'].map((id) => ({
      id,
      title: id,
      artist: 'Artist A',
      artists: ['Artist A'],
      artistIds: ['artist-a'],
      genreIds: ['genre-a'],
      albumId: 'album-a',
      albumArtistId: 'artist-a',
      album: 'Album A',
    })),
  ];
  const home = buildHomeFeed({
    userId: 'user',
    tracks,
    recentEvents: [{ trackId: 'song-a' }, { trackId: 'song-b' }],
    recentTrackIds: ['song-a', 'song-b'],
    repeatCounts: [{ _id: 'song-a', plays: 4 }],
    forgottenCounts: [{ _id: 'song-a', plays: 5 }, { _id: 'song-c', plays: 4 }],
    monthlyCounts: [
      { _id: 'song-a', plays: 3, listenedMs: 120_000 },
      { _id: 'song-b', plays: 2, listenedMs: 90_000 },
    ],
    favorites: [{ trackId: 'song-a' }, { trackId: 'song-c' }],
    playlists: [{ _id: 'playlist-id', name: 'Road songs', trackIds: ['song-a'] }],
    recentlyAdded: tracks.map((track) => ({ id: track.id })),
    entityTracks: new Map([
      ['album:album-a', tracks],
      ['artist:artist-a', tracks],
    ]),
    artistMixTracks: new Map([['artist-a', tracks]]),
    genreMixTracks: new Map([['genre-a', tracks]]),
    date: new Date('2026-04-04T12:00:00Z'),
  });

  assert.equal(home.quickPicks[0].id, 'liked-songs');
  assert.equal(home.quickPicks.some((pick) => pick.id === 'playlist-id'), true);
  assert.deepEqual(home.shelves[0].trackIds, ['song-a', 'song-b']);
  assert.deepEqual(home.shelves[2].trackIds, ['song-c']);
  assert.equal(home.monthlyStats.minutesListened, 3);
  assert.equal(home.monthlyStats.topTracks[0].trackId, 'song-a');
  assert.equal(home.dailyMixes.length, 2);
  assert.ok(home.dailyMixes.every((mix) => mix.trackIds.every((id) => typeof id === 'string')));
});

test('cold-start Home uses recently added tracks without personal history', () => {
  const tracks = Array.from({ length: 7 }, (_, index) => ({
    id: `new-${index}`,
    title: `New ${index}`,
    artists: [],
    artistIds: [],
    genreIds: [],
  }));
  const home = buildHomeFeed({
    tracks,
    recentlyAdded: tracks,
    date: new Date('2026-04-04T12:00:00Z'),
  });

  assert.equal(home.shelves[0].trackIds.length, 0);
  assert.deepEqual(home.shelves[3].trackIds, tracks.map((track) => track.id));
  assert.equal(home.quickPicks.length, 8);
  assert.equal(home.dailyMixes.length, 2);
  assert.ok(home.dailyMixes.every((mix) => mix.trackIds.length === 7));
  const tomorrow = buildHomeFeed({
    tracks,
    recentlyAdded: tracks,
    date: new Date('2026-04-05T12:00:00Z'),
  });
  assert.notDeepEqual(home.dailyMixes[0].trackIds, tomorrow.dailyMixes[0].trackIds);
});
