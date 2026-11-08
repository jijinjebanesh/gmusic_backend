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
    console.error(`MongoDB unavailable (${err.message}) — running in token-only mode; user login endpoints return 503`);
    client = null;
    db = null;
    return null;
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
}

export async function closeDb() {
  if (client) await client.close();
}
