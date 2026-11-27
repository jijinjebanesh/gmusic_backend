import crypto from 'node:crypto';
import { col } from './db.js';

const AUDIO_EXTENSIONS = new Set([
  'aac', 'alac', 'flac', 'm4a', 'mp3', 'ogg', 'opus', 'wav',
]);

const AUDIO_MIME_TYPES = new Set([
  'audio/aac',
  'audio/flac',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/opus',
  'audio/wav',
  'audio/x-aac',
  'audio/x-flac',
  'audio/x-m4a',
  'audio/x-wav',
]);
const SHARED_OWNER_ID = 'shared';

function ownerQuery(filter = {}, ownerId = SHARED_OWNER_ID) {
  if (ownerId === SHARED_OWNER_ID) {
    return {
      $and: [
        { $or: [{ ownerId: SHARED_OWNER_ID }, { ownerId: { $exists: false } }] },
        filter,
      ],
    };
  }
  return { ...filter, ownerId };
}

export function fileExtension(name = '') {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).trim().toLowerCase();
}

export function isSupportedAudioFile(file) {
  const extension = fileExtension(file.name);
  const mimeType = String(file.mimeType || '').toLowerCase().split(';')[0].trim();
  if (mimeType.startsWith('application/vnd.google-apps.')) return false;
  return AUDIO_EXTENSIONS.has(extension) ||
    (AUDIO_MIME_TYPES.has(mimeType) && (!extension || AUDIO_EXTENSIONS.has(extension)));
}

export function normalizeKey(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function uniqueNames(values) {
  const names = [];
  const seen = new Set();
  for (const value of values) {
    const name = String(value || '').trim();
    const key = normalizeKey(name);
    if (name && key && !seen.has(key)) {
      names.push(name);
      seen.add(key);
    }
  }
  return names;
}

function splitArtists(value) {
  return String(value || '')
    .split(/\s+(?:feat(?:uring)?\.?|ft\.?)\s+|\s*;\s*/i)
    .map((name) => name.trim())
    .filter(Boolean);
}

function fallbackFromFilename(name) {
  const dot = name.lastIndexOf('.');
  const stem = (dot > 0 ? name.slice(0, dot) : name).trim();
  const separator = stem.indexOf(' - ');
  if (separator <= 0) return { title: stem || name, artists: [] };
  const title = stem.slice(0, separator).trim();
  const artist = stem.slice(separator + 3).trim();
  return { title: title || stem, artists: artist ? [artist] : [] };
}

function integer(value) {
  const number = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function normalizeTrackMetadata(file, common = {}, format = {}) {
  const fallback = fallbackFromFilename(file.name || '');
  const artists = uniqueNames(
    Array.isArray(common.artists) && common.artists.length
      ? common.artists
      : (common.artist ? splitArtists(common.artist) : fallback.artists),
  );
  const album = String(common.album || '').trim() || null;
  const albumArtist = String(common.albumartist || '').trim() || artists[0] || null;
  const genres = uniqueNames(Array.isArray(common.genre) ? common.genre : []);
  const title = String(common.title || '').trim() || fallback.title || file.name;
  const artistEntries = artists.map((name) => ({ key: normalizeKey(name), name }));
  const genreEntries = genres.map((name) => ({ key: normalizeKey(name), name }));
  const albumKey = normalizeKey(album || '');
  const albumArtistKey = normalizeKey(albumArtist || '');
  const albumId = albumKey && albumArtistKey
    ? crypto.createHash('sha256').update(`${albumArtistKey}\0${albumKey}`).digest('hex')
    : null;
  const year = integer(common.year || common.originalyear || common.date?.slice?.(0, 4));
  const durationMs = Number.isFinite(format.duration) && format.duration >= 0
    ? Math.round(format.duration * 1000)
    : null;
  const trackNumber = integer(common.track?.no);
  const discNumber = integer(common.disk?.no);

  return {
    title,
    artists,
    artistEntries,
    album,
    albumArtist,
    albumKey,
    albumArtistKey,
    albumId,
    composer: uniqueNames(Array.isArray(common.composer) ? common.composer : []),
    genres,
    genreEntries,
    year,
    releaseDate: common.releasedate || common.date || null,
    trackNumber,
    trackTotal: integer(common.track?.of),
    discNumber,
    discTotal: integer(common.disk?.of),
    durationMs,
    bitrate: integer(format.bitrate),
    sampleRate: integer(format.sampleRate),
    bitDepth: integer(format.bitsPerSample),
    format: String(format.codec || fileExtension(file.name) || '').toLowerCase() || null,
  };
}

export function encodePageToken(offset) {
  return Buffer.from(String(offset)).toString('base64url');
}

export function decodePageToken(token) {
  if (!token) return 0;
  const decoded = Buffer.from(String(token), 'base64url').toString('ascii');
  if (!/^\d+$/.test(decoded)) {
    const error = new Error('Invalid page token');
    error.status = 400;
    error.code = 'invalid_page_token';
    throw error;
  }
  const offset = Number(decoded);
  if (!Number.isSafeInteger(offset)) {
    const error = new Error('Invalid page token');
    error.status = 400;
    error.code = 'invalid_page_token';
    throw error;
  }
  return offset;
}

function pageSizeOf(value) {
  const size = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(size) ? Math.min(Math.max(size, 1), 100) : 50;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trackSearchQuery(query) {
  const trimmed = String(query || '').trim().slice(0, 120);
  if (!trimmed) return { availability: 'available' };
  const regex = new RegExp(escapeRegex(trimmed), 'i');
  return {
    availability: 'available',
    $or: [
      { title: regex },
      { name: regex },
      { artists: regex },
      { album: regex },
      { albumArtist: regex },
      { genres: regex },
    ],
  };
}

export async function listTracks({ query = '', pageSize, pageToken, ownerId = SHARED_OWNER_ID } = {}) {
  const size = pageSizeOf(pageSize);
  const offset = decodePageToken(pageToken);
  const rows = await col('drive_tracks')
    .find(ownerQuery(trackSearchQuery(query), ownerId))
    .sort({ title: 1, _id: 1 })
    .skip(offset)
    .limit(size + 1)
    .toArray();
  const hasMore = rows.length > size;
  if (hasMore) rows.pop();
  return {
    files: rows.map(trackForApi),
    nextPageToken: hasMore ? encodePageToken(offset + rows.length) : null,
  };
}

export async function recentlyAddedTracks(ownerId = SHARED_OWNER_ID, limit = 24) {
  const rows = await col('drive_tracks')
    .find(ownerQuery({ availability: 'available' }, ownerId))
    .sort({ createdTime: -1, _id: 1 })
    .limit(Math.min(Math.max(Number(limit) || 24, 1), 100))
    .toArray();
  return rows.map(trackForApi);
}

export async function getTrack(id, ownerId = SHARED_OWNER_ID) {
  const documentId = ownerId === SHARED_OWNER_ID ? id : `${ownerId}:${id}`;
  const doc = await col('drive_tracks').findOne(
    ownerQuery({ _id: documentId, availability: 'available' }, ownerId),
  );
  return doc ? trackForApi(doc) : null;
}

export async function getTracksByIds(ids, ownerId = SHARED_OWNER_ID) {
  const documentIds = [...new Set(ids)].map((id) =>
    ownerId === SHARED_OWNER_ID ? id : `${ownerId}:${id}`,
  );
  if (!documentIds.length) return [];
  const rows = await col('drive_tracks')
    .find(ownerQuery({
      _id: { $in: documentIds },
      availability: 'available',
    }, ownerId))
    .toArray();
  return rows.map(trackForApi);
}

function trackForApi(doc) {
  return {
    id: doc.driveFileId,
    name: doc.name,
    mimeType: doc.mimeType,
    size: doc.size,
    modifiedTime: doc.modifiedTime,
    createdTime: doc.createdTime,
    title: doc.title,
    artists: doc.artists || [],
    artist: (doc.artists || []).join(', ') || null,
    album: doc.album,
    albumArtist: doc.albumArtist,
    albumId: doc.albumId,
    albumArtistId: doc.albumArtistKey,
    genres: doc.genres || [],
    artistIds: doc.artistKeys || [],
    genreIds: (doc.genreEntries || []).map((entry) => entry.key),
    year: doc.year,
    trackNumber: doc.trackNumber,
    discNumber: doc.discNumber,
    durationMs: doc.durationMs,
    bitrate: doc.bitrate || null,
    metadataStatus: doc.metadataStatus,
    availability: doc.availability,
  };
}

export async function listArtists({ query = '', pageSize, pageToken, ownerId = SHARED_OWNER_ID } = {}) {
  const size = pageSizeOf(pageSize);
  const offset = decodePageToken(pageToken);
  const match = String(query || '').trim().slice(0, 120);
  const pipeline = [
    { $match: ownerQuery({ availability: 'available' }, ownerId) },
    { $unwind: '$artistEntries' },
    ...(match ? [{ $match: { 'artistEntries.name': { $regex: escapeRegex(match), $options: 'i' } } }] : []),
    {
      $group: {
        _id: '$artistEntries.key',
        name: { $min: '$artistEntries.name' },
        trackCount: { $sum: 1 },
      },
    },
    { $sort: { name: 1, _id: 1 } },
    { $skip: offset },
    { $limit: size + 1 },
  ];
  const rows = await col('drive_tracks').aggregate(pipeline).toArray();
  const hasMore = rows.length > size;
  if (hasMore) rows.pop();
  return {
    artists: rows.map((row) => ({ id: row._id, name: row.name, trackCount: row.trackCount })),
    nextPageToken: hasMore ? encodePageToken(offset + rows.length) : null,
  };
}

export async function getArtist(key, ownerId = SHARED_OWNER_ID) {
  const rows = await col('drive_tracks').aggregate([
    { $match: ownerQuery({ availability: 'available', artistKeys: key }, ownerId) },
    { $unwind: '$artistEntries' },
    { $match: { 'artistEntries.key': key } },
    {
      $group: {
        _id: '$artistEntries.key',
        name: { $min: '$artistEntries.name' },
        trackCount: { $sum: 1 },
      },
    },
  ]).toArray();
  return rows.length ? { id: rows[0]._id, name: rows[0].name, trackCount: rows[0].trackCount } : null;
}

export async function artistTracks(key, options = {}) {
  const size = pageSizeOf(options.pageSize);
  const offset = decodePageToken(options.pageToken);
  const rows = await col('drive_tracks')
    .find(ownerQuery({ availability: 'available', artistKeys: key }, options.ownerId))
    .sort({ albumId: 1, discNumber: 1, trackNumber: 1, title: 1, _id: 1 })
    .skip(offset)
    .limit(size + 1)
    .toArray();
  const hasMore = rows.length > size;
  if (hasMore) rows.pop();
  return {
    files: rows.map(trackForApi),
    nextPageToken: hasMore ? encodePageToken(offset + rows.length) : null,
  };
}

export async function listAlbums({ query = '', pageSize, pageToken, ownerId = SHARED_OWNER_ID } = {}) {
  const size = pageSizeOf(pageSize);
  const offset = decodePageToken(pageToken);
  const match = String(query || '').trim().slice(0, 120);
  const pipeline = [
    { $match: ownerQuery({ availability: 'available', albumId: { $ne: null } }, ownerId) },
    ...(match ? [{
      $match: {
        $or: [
          { album: { $regex: escapeRegex(match), $options: 'i' } },
          { albumArtist: { $regex: escapeRegex(match), $options: 'i' } },
        ],
      },
    }] : []),
    {
      $group: {
        _id: '$albumId',
        name: { $first: '$album' },
        artist: { $first: '$albumArtist' },
        artistKey: { $first: '$albumArtistKey' },
        year: { $min: '$year' },
        trackCount: { $sum: 1 },
      },
    },
    { $sort: { name: 1, artist: 1, _id: 1 } },
    { $skip: offset },
    { $limit: size + 1 },
  ];
  const rows = await col('drive_tracks').aggregate(pipeline).toArray();
  const hasMore = rows.length > size;
  if (hasMore) rows.pop();
  return {
    albums: rows.map((row) => ({
      id: row._id,
      name: row.name,
      artist: row.artist,
      artistId: row.artistKey,
      year: row.year,
      trackCount: row.trackCount,
    })),
    nextPageToken: hasMore ? encodePageToken(offset + rows.length) : null,
  };
}

export async function artistAlbums(key, options = {}) {
  const size = pageSizeOf(options.pageSize);
  const offset = decodePageToken(options.pageToken);
  const rows = await col('drive_tracks').aggregate([
    { $match: ownerQuery(
      { availability: 'available', albumId: { $ne: null }, artistKeys: key },
      options.ownerId,
    ) },
    {
      $group: {
        _id: '$albumId',
        name: { $first: '$album' },
        artist: { $first: '$albumArtist' },
        artistKey: { $first: '$albumArtistKey' },
        year: { $min: '$year' },
        trackCount: { $sum: 1 },
      },
    },
    { $sort: { name: 1, artist: 1, _id: 1 } },
    { $skip: offset },
    { $limit: size + 1 },
  ]).toArray();
  const hasMore = rows.length > size;
  if (hasMore) rows.pop();
  return {
    albums: rows.map((row) => ({
      id: row._id,
      name: row.name,
      artist: row.artist,
      artistId: row.artistKey,
      year: row.year,
      trackCount: row.trackCount,
    })),
    nextPageToken: hasMore ? encodePageToken(offset + rows.length) : null,
  };
}

export async function albumTracks(id, options = {}) {
  const size = pageSizeOf(options.pageSize);
  const offset = decodePageToken(options.pageToken);
  const rows = await col('drive_tracks')
    .find(ownerQuery({ availability: 'available', albumId: id }, options.ownerId))
    .sort({ discNumber: 1, trackNumber: 1, title: 1, _id: 1 })
    .skip(offset)
    .limit(size + 1)
    .toArray();
  const hasMore = rows.length > size;
  if (hasMore) rows.pop();
  return {
    files: rows.map(trackForApi),
    nextPageToken: hasMore ? encodePageToken(offset + rows.length) : null,
  };
}

export async function getAlbum(id, ownerId = SHARED_OWNER_ID) {
  const scoped = (filter) => ownerQuery(filter, ownerId);
  const tracks = await albumTracks(id, { pageSize: 1, ownerId });
  if (!tracks.files.length) return null;
  const first = await col('drive_tracks').findOne(scoped({ albumId: id, availability: 'available' }));
  if (!first) return null;
  const count = await col('drive_tracks').countDocuments(scoped({ albumId: id, availability: 'available' }));
  return {
    id,
    name: first.album,
    artist: first.albumArtist,
    artistId: first.albumArtistKey,
    year: first.year,
    trackCount: count,
  };
}

export async function listGenres(ownerId = SHARED_OWNER_ID) {
  return col('drive_tracks').aggregate([
    { $match: ownerQuery({ availability: 'available' }, ownerId) },
    { $unwind: '$genreEntries' },
    {
      $group: {
        _id: '$genreEntries.key',
        name: { $min: '$genreEntries.name' },
        trackCount: { $sum: 1 },
      },
    },
    { $sort: { name: 1, _id: 1 } },
  ]).toArray().then((rows) =>
    rows.map((row) => ({ id: row._id, name: row.name, trackCount: row.trackCount })),
  );
}

export async function genreTracks(key, options = {}) {
  const size = pageSizeOf(options.pageSize);
  const offset = decodePageToken(options.pageToken);
  const rows = await col('drive_tracks')
    .find(ownerQuery({ availability: 'available', 'genreEntries.key': key }, options.ownerId))
    .sort({ title: 1, _id: 1 })
    .skip(offset)
    .limit(size + 1)
    .toArray();
  const hasMore = rows.length > size;
  if (hasMore) rows.pop();
  return {
    files: rows.map(trackForApi),
    nextPageToken: hasMore ? encodePageToken(offset + rows.length) : null,
  };
}
