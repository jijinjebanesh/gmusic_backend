// MongoDB (Atlas) access for the Gmusic database: user accounts, sessions and
// per-user state (favorites, recent plays, playlists).
import { MongoClient } from 'mongodb';

let client = null;
let db = null;

export async function initDb() {
  const uri = process.env.MONGO_URI;
  if (!uri) return null; // bridge runs in single-owner token mode
  try {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    db = client.db(process.env.MONGO_DB || 'Gmusic');
    await ensureIndexes();
    console.log(`MongoDB connected: ${db.databaseName}`);
    return db;
  } catch (err) {
    console.error(`MongoDB initialization failed (${err.name || 'connection error'}); refusing to start with an invalid configured database`);
    client = null;
    db = null;
    throw new Error('MongoDB initialization failed; verify MONGO_URI, credentials, and Atlas network access', { cause: err });
  }
}

export function col(name) {
  if (!db) throw new Error('MongoDB is not configured (set MONGO_URI)');
  return db.collection(name);
}

export function mongoEnabled() {
  return db !== null;
}

async function ensureIndexes() {
  // Users already exists in Atlas; indexes are partial so documents without
  // those fields (legacy rows) never violate uniqueness.
  const users = db.collection('Users');
  for (const spec of [{ email: 1 }, { username: 1 }]) {
    await users.createIndex(spec, {
      unique: true,
      partialFilterExpression: { [Object.keys(spec)[0]]: { $exists: true } },
    }).catch((err) => console.warn(`Users index ${Object.keys(spec)[0]}:`, err.message));
  }
  const sessions = db.collection('sessions');
  await sessions.createIndex({ tokenHash: 1 }, { unique: true }).catch((e) => console.warn('sessions idx:', e.message));
  await sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch((e) => console.warn('sessions ttl:', e.message));
  await sessions.createIndex({ userId: 1, createdAt: -1 }).catch((e) => console.warn('sessions user idx:', e.message));
  const favorites = db.collection('favorites');
  await favorites.createIndex({ userId: 1, trackId: 1 }, { unique: true }).catch((e) => console.warn('fav idx:', e.message));
  const recent = db.collection('recent_plays');
  await recent.createIndex({ userId: 1, playedAt: -1 }).catch((e) => console.warn('recent idx:', e.message));
  const playlists = db.collection('playlists');
  await playlists.createIndex({ userId: 1, name: 1 }, { unique: true, partialFilterExpression: { name: { $exists: true } } }).catch((e) => console.warn('pl idx:', e.message));
  await db.collection('search_history').createIndex({ userId: 1, queryKey: 1 }, { unique: true });
  await db.collection('search_history').createIndex({ userId: 1, searchedAt: -1 });
  await db.collection('followed_artists').createIndex({ userId: 1, artistId: 1 }, { unique: true });
  await db.collection('saved_albums').createIndex({ userId: 1, albumId: 1 }, { unique: true });
  const tracks = db.collection('drive_tracks');
  try {
    await tracks.dropIndex('driveFileId_1');
  } catch (error) {
    if (error.code !== 27 && error.code !== 26) throw error;
  }
  await tracks.createIndex({ ownerId: 1, driveFileId: 1 }, { unique: true });
  await tracks.createIndex({ ownerId: 1, availability: 1, title: 1, _id: 1 });
  await tracks.createIndex({ ownerId: 1, artistKeys: 1, availability: 1 });
  await tracks.createIndex({ ownerId: 1, albumId: 1, discNumber: 1, trackNumber: 1 });
  await tracks.createIndex({ ownerId: 1, 'genreEntries.key': 1, availability: 1 });
  await db.collection('artwork_cache').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('drive_connections').createIndex({ userId: 1 }, { unique: true });
  await db.collection('drive_oauth_states').createIndex({ stateHash: 1 }, { unique: true });
  await db.collection('drive_oauth_states').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('drive_oauth_states').createIndex({ userId: 1 });
  await db.collection('playback_devices').createIndex(
    { userId: 1, deviceId: 1 },
    { unique: true },
  );
  await db.collection('playback_devices').createIndex({ userId: 1, lastSeenAt: -1 });
  await db.collection('playback_sessions').createIndex({ userId: 1 }, { unique: true });
  const playbackCommands = db.collection('playback_commands');
  await playbackCommands.createIndex({ userId: 1, deviceId: 1, status: 1, createdAt: 1 });
  await playbackCommands.createIndex(
    { userId: 1, idempotencyKey: 1 },
    {
      unique: true,
      partialFilterExpression: { idempotencyKey: { $exists: true } },
    },
  );
  await playbackCommands.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  const playbackTransfers = db.collection('playback_transfers');
  await playbackTransfers.createIndex({ userId: 1, createdAt: -1 });
  await playbackTransfers.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  const groupSessions = db.collection('group_listening_sessions');
  await groupSessions.createIndex({ code: 1 }, { unique: true });
  await groupSessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await groupSessions.createIndex({ 'members.userId': 1, 'members.deviceId': 1 });
}

export async function closeDb() {
  if (client) await client.close();
}
