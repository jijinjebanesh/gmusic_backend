import express from 'express';
import { col } from './db.js';
import {
  albumTracks,
  artistTracks,
  genreTracks,
  getTracksByIds,
  recentlyAddedTracks,
} from './catalog.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EVENT_MS = 24 * 60 * 60 * 1000;

function apiError(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

export function qualifiesListen({ listenedMs, durationMs, skipped }) {
  return skipped === true ||
    listenedMs >= 30_000 ||
    (durationMs > 0 && listenedMs * 2 >= durationMs);
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

export async function recordListeningEvent({
  userId,
  deviceId,
  event,
  events,
  playbackSessions,
  recentPlays,
  now = () => new Date(),
}) {
  const { eventId, trackId, listenedMs, durationMs, skipped } = event || {};
  if (
    !userId ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(String(deviceId || '')) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(String(eventId || '')) ||
    !validId(trackId) ||
    !Number.isSafeInteger(listenedMs) ||
    listenedMs < 0 ||
    listenedMs > MAX_EVENT_MS ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 0 ||
    durationMs > MAX_EVENT_MS ||
    typeof skipped !== 'boolean' ||
    !qualifiesListen({ listenedMs, durationMs, skipped })
  ) {
    throw apiError(400, 'invalid_listening_event');
  }

  const duplicate = await events.findOne({ userId, eventId });
  if (duplicate) return { created: false };

  const session = await playbackSessions.findOne({ _id: userId });
  if (session?.activeDeviceId !== deviceId) {
    throw apiError(409, 'device_not_active');
  }

  const playedAt = now();
  const document = {
    userId,
    deviceId,
    eventId,
    trackId,
    playedAt,
    listenedMs,
    durationMs,
    skipped,
  };
  try {
    await events.insertOne(document);
  } catch (error) {
    if (error?.code === 11000) return { created: false };
    throw error;
  }

  await recentPlays.updateOne(
    { userId, trackId },
    { $set: { userId, trackId, playedAt } },
    { upsert: true },
  );
  return { created: true, playedAt };
}

function rotateDaily(ids, dateKey) {
  if (ids.length < 2) return ids;
  const dayNumber = Math.floor(Date.parse(`${dateKey}T00:00:00.000Z`) / DAY_MS);
  const offset = dayNumber % ids.length;
  return [...ids.slice(offset), ...ids.slice(0, offset)];
}

export function buildHomeFeed({
  userId,
  recentEvents = [],
  recentTrackIds = [],
  repeatCounts = [],
  monthlyCounts = [],
  forgottenCounts = [],
  favorites = [],
  playlists = [],
  tracks = [],
  recentlyAdded = [],
  entityTracks = new Map(),
  artistMixTracks = new Map(),
  genreMixTracks = new Map(),
  date = new Date(),
}) {
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const recentIds = [...new Set(recentEvents.map((event) => event.trackId))]
    .filter((id) => trackById.has(id));
  const favoriteIds = favorites.map((item) => item.trackId).filter(validId);
  const recentlyTouched = new Set(recentTrackIds);
  const playlistPicks = playlists.slice(0, 3).map((playlist) => ({
    type: 'playlist',
    id: String(playlist._id),
    title: playlist.name,
    trackIds: (playlist.trackIds || []).filter(validId),
    artworkTrackId: playlist.trackIds?.find((id) => trackById.has(id)) || null,
  }));
  const quickPicks = [{
    type: 'likedSongs',
    id: 'liked-songs',
    title: 'Liked Songs',
    trackIds: favoriteIds,
    artworkTrackId: favoriteIds.find((id) => trackById.has(id)) || null,
  }, ...playlistPicks];
  const seenAlbums = new Set();
  const seenArtists = new Set();
  const quickPickTrackIds = recentIds.length
    ? recentIds
    : recentlyAdded.map((track) => track.id);
  for (const id of quickPickTrackIds) {
    const track = trackById.get(id);
    if (track?.albumId && !seenAlbums.has(track.albumId)) {
      seenAlbums.add(track.albumId);
      quickPicks.push({
        type: 'album',
        id: track.albumId,
        title: track.album || 'Album',
        artistId: track.albumArtistId || null,
        trackIds: (entityTracks.get(`album:${track.albumId}`) || []).map((item) => item.id),
        artworkTrackId: track.id,
      });
    }
    const artistId = track?.artistIds?.[0];
    if (artistId && !seenArtists.has(artistId)) {
      seenArtists.add(artistId);
      quickPicks.push({
        type: 'artist',
        id: artistId,
        title: track.artists?.[0] || 'Artist',
        trackIds: (entityTracks.get(`artist:${artistId}`) || []).map((item) => item.id),
        artworkTrackId: track.id,
      });
    }
    if (quickPicks.length >= 8) break;
  }
  if (quickPicks.length < 8) {
    for (const id of quickPickTrackIds) {
      if (quickPicks.some((pick) => pick.type === 'track' && pick.id === id)) continue;
      const track = trackById.get(id);
      if (!track) continue;
      quickPicks.push({
        type: 'track',
        id,
        title: track.title,
        trackIds: [id],
        artworkTrackId: id,
      });
      if (quickPicks.length >= 8) break;
    }
  }

  const shelves = [
    { id: 'jump-back-in', title: 'Jump Back In', trackIds: recentIds.slice(0, 20) },
    {
      id: 'on-repeat',
      title: 'On Repeat',
      trackIds: repeatCounts.map((row) => row._id).filter((id) => trackById.has(id)).slice(0, 20),
    },
    {
      id: 'forgotten-favorites',
      title: 'Forgotten Favorites',
      trackIds: forgottenCounts
        .map((row) => row._id)
        .filter((id) =>
          trackById.has(id) &&
          favoriteIds.includes(id) &&
          !recentlyTouched.has(id),
        )
        .slice(0, 20),
    },
    {
      id: 'recently-added',
      title: 'Recently Added',
      trackIds: recentlyAdded.map((track) => track.id),
    },
  ];

  const monthlyTracks = monthlyCounts
    .map((row) => ({ row, track: trackById.get(row._id) }))
    .filter((item) => item.track && item.row.plays > 0);
  const artistPlays = new Map();
  for (const { row, track } of monthlyTracks) {
    (track.artistIds || []).forEach((artistId, index) => {
      const current = artistPlays.get(artistId) || {
        id: artistId,
        name: track.artists?.[index] || track.artists?.[0] || 'Artist',
        plays: 0,
      };
      current.plays += row.plays;
      artistPlays.set(artistId, current);
    });
  }
  const monthlyStats = {
    month: date.toISOString().slice(0, 7),
    minutesListened: Math.floor(monthlyCounts.reduce((sum, row) => sum + row.listenedMs, 0) / 60_000),
    topTracks: monthlyTracks.slice(0, 5).map(({ row, track }) => ({
      trackId: track.id,
      title: track.title,
      artist: track.artist || '',
      plays: row.plays,
    })),
    topArtists: [...artistPlays.values()]
      .sort((a, b) => b.plays - a.plays || a.id.localeCompare(b.id))
      .slice(0, 5),
  };

  const dailyMixes = [];
  const dateKey = date.toISOString().slice(0, 10);
  const recentCandidates = recentIds.map((id) => trackById.get(id)).filter(Boolean);
  const artistCandidates = new Set();
  const genreCandidates = new Set();
  for (const track of recentCandidates) {
    track.artistIds?.forEach((id) => artistCandidates.add(id));
    track.genreIds?.forEach((id) => genreCandidates.add(id));
  }
  for (const artistId of artistCandidates) {
    const mixTracks = artistMixTracks.get(artistId) || [];
    if (mixTracks.length >= 5) {
      const seedTrack = recentCandidates.find((item) =>
        item.artistIds?.includes(artistId));
      dailyMixes.push({
        id: `daily-${dateKey}-artist-${artistId}`,
        title: `Daily Mix · ${seedTrack?.artists?.[0] || 'Artist'}`,
        strategy: 'artist',
        entityId: artistId,
        trackIds: rotateDaily(mixTracks.map((track) => track.id), dateKey),
      });
    }
    if (dailyMixes.length >= 2) break;
  }
  for (const genreId of genreCandidates) {
    if (dailyMixes.length >= 4) break;
    const mixTracks = genreMixTracks.get(genreId) || [];
    if (mixTracks.length >= 5) {
      const seedTrack = recentCandidates.find((item) =>
        item.genreIds?.includes(genreId));
      const genreName = seedTrack?.genres?.[
        seedTrack.genreIds?.indexOf(genreId) ?? -1
      ];
      dailyMixes.push({
        id: `daily-${dateKey}-genre-${genreId}`,
        title: `Daily Mix · ${genreName || 'Genre'}`,
        strategy: 'genre',
        entityId: genreId,
        trackIds: rotateDaily(mixTracks.map((track) => track.id), dateKey),
      });
    }
  }
  if (dailyMixes.length < 2 && recentlyAdded.length >= 5) {
    const ids = recentlyAdded.map((track) => track.id);
    while (dailyMixes.length < 2) {
      const index = dailyMixes.length;
      dailyMixes.push({
        id: `daily-${dateKey}-library-${index + 1}`,
        title: index === 0 ? 'Daily Mix · Your Library' : 'Daily Mix · Recently Added',
        strategy: 'library',
        entityId: userId || 'library',
        trackIds: rotateDaily(index === 0 ? ids : [...ids].reverse(), dateKey),
      });
    }
  }

  return {
    quickPicks: quickPicks.slice(0, 8),
    shelves,
    dailyMixes: dailyMixes.slice(0, 4),
    monthlyStats,
  };
}

export async function loadListeningHome({ userId, ownerId, now = new Date() }) {
  if (!ownerId) throw apiError(400, 'drive_owner_required');

  const recentCutoff = new Date(now.getTime() - 30 * DAY_MS);
  const forgottenCutoff = new Date(now.getTime() - 90 * DAY_MS);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const emptyPersonal = { recent: [], recentTrackIds: [], repeats: [], monthly: [], forgotten: [], favorites: [], playlists: [] };
  const personal = userId
    ? await Promise.all([
      col('listening_events').find({ userId }).sort({ playedAt: -1 }).limit(200).toArray(),
      col('listening_events').aggregate([
        { $match: { userId, playedAt: { $gte: forgottenCutoff } } },
        { $group: { _id: '$trackId' } },
      ]).toArray(),
      col('listening_events').aggregate([
        { $match: { userId, playedAt: { $gte: recentCutoff }, skipped: { $ne: true } } },
        { $group: { _id: '$trackId', plays: { $sum: 1 } } },
        { $match: { plays: { $gte: 2 } } },
        { $sort: { plays: -1, _id: 1 } },
        { $limit: 100 },
      ]).toArray(),
      col('listening_events').aggregate([
        { $match: { userId, playedAt: { $gte: monthStart } } },
        {
          $group: {
            _id: '$trackId',
            plays: {
              $sum: { $cond: [{ $eq: ['$skipped', true] }, 0, 1] },
            },
            listenedMs: { $sum: '$listenedMs' },
          },
        },
        { $sort: { plays: -1, _id: 1 } },
      ]).toArray(),
      col('listening_events').aggregate([
        { $match: { userId, playedAt: { $lt: forgottenCutoff }, skipped: { $ne: true } } },
        { $group: { _id: '$trackId', plays: { $sum: 1 }, lastPlayedAt: { $max: '$playedAt' } } },
        { $match: { plays: { $gte: 3 }, lastPlayedAt: { $lt: forgottenCutoff } } },
        { $sort: { plays: -1, lastPlayedAt: -1 } },
        { $limit: 100 },
      ]).toArray(),
      col('favorites').find({ userId }).sort({ addedAt: -1 }).limit(100).toArray(),
      col('playlists').find({ userId }).sort({ updatedAt: -1 }).limit(10).toArray(),
    ])
    : [
      emptyPersonal.recent,
      emptyPersonal.recentTrackIds,
      emptyPersonal.repeats,
      emptyPersonal.monthly,
      emptyPersonal.forgotten,
      emptyPersonal.favorites,
      emptyPersonal.playlists,
    ];

  const [recent, touchedRows, repeats, monthly, forgotten, favorites, playlists, recentlyAdded] = [
    ...personal,
    await recentlyAddedTracks(ownerId, 24),
  ];
  const ids = [
    ...recent.slice(0, 150).map((event) => event.trackId),
    ...repeats.slice(0, 80).map((row) => row._id),
    ...monthly.slice(0, 80).map((row) => row._id),
    ...forgotten.slice(0, 50).map((row) => row._id),
    ...favorites.slice(0, 80).map((item) => item.trackId),
    ...playlists.flatMap((item) => (item.trackIds || []).slice(0, 5)),
    ...recentlyAdded.map((track) => track.id),
  ];
  const tracks = await getTracksByIds([...new Set(ids)].slice(0, 500), ownerId);
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const recentTracks = recent
    .map((event) => trackById.get(event.trackId))
    .filter(Boolean);
  const artistIds = [...new Set(
    recentTracks.slice(0, 100)
      .flatMap((track) => track.artistIds || []),
  )].slice(0, 4);
  const genreIds = [...new Set(
    recentTracks.slice(0, 100)
      .flatMap((track) => track.genreIds || []),
  )].slice(0, 4);
  const recentAlbumIds = [...new Set(recentTracks.map((track) => track.albumId).filter(Boolean))].slice(0, 3);
  const quickArtistIds = [...new Set(recentTracks.flatMap((track) => track.artistIds || []))].slice(0, 3);
  const [artistPages, genrePages] = await Promise.all([
    Promise.all(artistIds.map((id) => artistTracks(id, { ownerId, pageSize: 50 }))),
    Promise.all(genreIds.map((id) => genreTracks(id, { ownerId, pageSize: 50 }))),
  ]);
  const [albumPages, quickArtistPages] = await Promise.all([
    Promise.all(recentAlbumIds.map((id) => albumTracks(id, { ownerId, pageSize: 50 }))),
    Promise.all(quickArtistIds.map((id) => artistTracks(id, { ownerId, pageSize: 50 }))),
  ]);
  const artistMixTracks = new Map(artistIds.map((id, index) => [id, artistPages[index].files]));
  const genreMixTracks = new Map(genreIds.map((id, index) => [id, genrePages[index].files]));
  const entityTracks = new Map([
    ...recentAlbumIds.map((id, index) => [`album:${id}`, albumPages[index].files]),
    ...quickArtistIds.map((id, index) => [`artist:${id}`, quickArtistPages[index].files]),
  ]);
  return buildHomeFeed({
    userId,
    recentEvents: recent,
    recentTrackIds: touchedRows.map((row) => row._id),
    repeatCounts: repeats,
    monthlyCounts: monthly,
    forgottenCounts: forgotten,
    favorites,
    playlists,
    tracks,
    recentlyAdded,
    entityTracks,
    artistMixTracks,
    genreMixTracks,
    date: now,
  });
}

export function createListeningRouter({ loadHome, saveEvent }) {
  const router = express.Router();
  router.get('/home', async (req, res, next) => {
    try {
      const feed = await loadHome(req);
      res.json(feed);
    } catch (error) {
      next(error);
    }
  });
  router.post('/listening-events', async (req, res, next) => {
    try {
      if (req.ownerMode || !req.user?.id || req.user.id === 'owner') {
        return res.status(403).json({ error: 'personal_account_required' });
      }
      const result = await saveEvent(req);
      res.status(result.created ? 201 : 200).json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
