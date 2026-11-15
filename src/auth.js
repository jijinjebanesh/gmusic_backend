// User login with persistent sessions + per-user features (favorites, recent
// plays, playlists). Sessions are bearer tokens stored hashed in MongoDB; the
// app keeps the token and reuses it until it expires (30 days, sliding).
import crypto from 'node:crypto';
import express from 'express';
import bcrypt from 'bcryptjs';
import { ObjectId } from 'mongodb';
import { col, mongoEnabled } from './db.js';

const SESSION_DAYS = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const userIdOf = (user) => String(user._id);
const publicUser = (user) => ({
  id: userIdOf(user),
  email: user.email ?? null,
  username: user.username ?? null,
  displayName: user.displayName ?? user.username ?? user.email ?? null,
  role: user.role ?? 'user',
});

async function createSession(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  await col('sessions').insertOne({
    tokenHash: tokenHash(token),
    userId: user._id, // stored as ObjectId so the user lookup matches _id
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_DAYS * 86_400_000),
  });
  return token;
}

function branch(res, value) {
  if (!value && !mongoEnabled()) return res.status(503).json({ error: 'mongo_unavailable' });
  return res.status(value?.status || 500).json({ error: value?.error || 'internal_error' });
}

// ---- auth routes (public) -------------------------------------------------

export const authRoutes = express.Router();

authRoutes.post('/register', express.json(), async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const username = String(req.body?.username || '').trim() || email.split('@')[0];
    const password = String(req.body?.password || '');
    if (!EMAIL_RE.test(email)) return branch(res, { status: 400, error: 'invalid_email' });
    if (password.length < 8) return branch(res, { status: 400, error: 'password_too_short' });
    const users = col('Users');
    if (await users.findOne({ $or: [{ email }, { username }] })) {
      return branch(res, { status: 409, error: 'account_exists' });
    }
    const now = new Date();
    const doc = {
      email, username,
      displayName: username,
      passwordHash: bcrypt.hashSync(password, 10),
      role: 'user',
      createdAt: now, updatedAt: now,
    };
    const inserted = await users.insertOne(doc);
    const user = { ...doc, _id: inserted.insertedId };
    res.status(201).json({ token: await createSession(user), user: publicUser(user) });
  } catch (err) { req.log?.error({ err }, 'register failed'); branch(res); }
});

authRoutes.post('/login', express.json(), async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = await col('Users').findOne({ email });
    if (!user || !bcrypt.compareSync(password, user.passwordHash || '')) {
      return branch(res, { status: 401, error: 'invalid_credentials' });
    }
    res.json({ token: await createSession(user), user: publicUser(user) });
  } catch (err) { req.log?.error({ err }, 'login failed'); branch(res); }
});

// ---- session middleware ---------------------------------------------------

// Mount under /api/v1 AFTER authRoutes. Accepts a session token, or (owner
// mode) the MORNYE_API_TOKEN so single-user tooling keeps working.
export function attachUser(apiToken) {
  return async (req, res, next) => {
    const bearer = String(req.get('authorization') || '').replace(/^Bearer /i, '');
    if (!bearer) return res.status(401).json({ error: 'unauthorized' });
    if (apiToken && bearer === apiToken) {
      req.user = { id: 'owner', email: 'owner@local', displayName: 'Owner', role: 'owner' };
      req.ownerMode = true;
      return next();
    }
    if (!mongoEnabled()) return res.status(503).json({ error: 'mongo_unavailable' });
    try {
      const session = await col('sessions').findOne({ tokenHash: tokenHash(bearer) });
      if (!session || session.expiresAt < new Date()) return res.status(401).json({ error: 'session_expired' });
      const user = await col('Users').findOne({ _id: session.userId });
      if (!user) return res.status(401).json({ error: 'session_user_missing' });
      // Sliding renewal: keep the token alive while it is used.
      await col('sessions').updateOne({ _id: session._id }, { $set: { expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) } });
      req.user = publicUser(user);
      req.ownerMode = false;
      next();
    } catch (err) { next(err); }
  };
}

authRoutes.post('/logout', async (req, res) => {
  try {
    const bearer = String(req.get('authorization') || '').replace(/^Bearer /i, '');
    if (bearer) await col('sessions').deleteOne({ tokenHash: tokenHash(bearer) });
    res.json({ ok: true });
  } catch (err) { branch(res); }
});

// ---- per-user data routes (mounted after attachUser) ----------------------

export const userDataRoutes = express.Router();

userDataRoutes.get('/auth/me', (req, res) => res.json({ user: req.user }));

userDataRoutes.get('/favorites', async (req, res) => {
  try {
    if (req.ownerMode) return res.json({ favorites: [] });
    const rows = await col('favorites').find({ userId: req.user.id }).sort({ addedAt: -1 }).toArray();
    res.json({ favorites: rows.map(({ trackId, title, artist, addedAt }) => ({ trackId, title, artist, addedAt })) });
  } catch (err) { branch(res); }
});

userDataRoutes.put('/favorites/:trackId', express.json(), async (req, res) => {
  try {
    if (req.ownerMode) return res.json({ favorite: { trackId: req.params.trackId } });
    const now = new Date();
    const doc = {
      userId: req.user.id,
      trackId: req.params.trackId,
      title: String(req.body?.title ?? ''),
      artist: String(req.body?.artist ?? ''),
      addedAt: now,
    };
    await col('favorites').updateOne({ userId: doc.userId, trackId: doc.trackId }, { $set: doc }, { upsert: true });
    res.json({ favorite: doc });
  } catch (err) { branch(res); }
});

userDataRoutes.delete('/favorites/:trackId', async (req, res) => {
  try {
    if (!req.ownerMode) await col('favorites').deleteOne({ userId: req.user.id, trackId: req.params.trackId });
    res.json({ ok: true });
  } catch (err) { branch(res); }
});

const RECENT_CAP = 200;

function requirePersonalAccount(req, res) {
  if (req.ownerMode) {
    branch(res, { status: 403, error: 'personal_account_required' });
    return false;
  }
  return true;
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

// Account-owned search history, de-duplicated by normalized query and capped
// at thirty entries per user.
userDataRoutes.get('/search-history', async (req, res) => {
  try {
    if (!requirePersonalAccount(req, res)) return;
    const limit = Math.max(1, Math.min(50, Number.parseInt(req.query.limit, 10) || 20));
    const rows = await col('search_history').find({ userId: req.user.id }).sort({ searchedAt: -1 }).limit(limit).toArray();
    res.json({ searches: rows.map(({ _id, query, searchedAt }) => ({ id: String(_id), query, searchedAt })) });
  } catch (err) { branch(res); }
});

userDataRoutes.post('/search-history', express.json(), async (req, res) => {
  try {
    if (!requirePersonalAccount(req, res)) return;
    const query = String(req.body?.query ?? '').trim().slice(0, 120);
    if (!query) return branch(res, { status: 400, error: 'query_required' });
    const queryKey = query.normalize('NFKC').toLocaleLowerCase();
    const searchedAt = new Date();
    await col('search_history').updateOne({ userId: req.user.id, queryKey }, { $set: { userId: req.user.id, query, queryKey, searchedAt } }, { upsert: true });
    const stale = await col('search_history').find({ userId: req.user.id }).sort({ searchedAt: -1 }).skip(30).project({ _id: 1 }).toArray();
    if (stale.length) await col('search_history').deleteMany({ _id: { $in: stale.map((row) => row._id) } });
    res.status(201).json({ query, searchedAt });
  } catch (err) { branch(res); }
});

userDataRoutes.delete('/search-history', async (req, res) => {
  try {
    if (!requirePersonalAccount(req, res)) return;
    await col('search_history').deleteMany({ userId: req.user.id });
    res.json({ ok: true });
  } catch (err) { branch(res); }
});

userDataRoutes.delete('/search-history/:query', async (req, res) => {
  try {
    if (!requirePersonalAccount(req, res)) return;
    const queryKey = String(req.params.query).normalize('NFKC').toLocaleLowerCase();
    await col('search_history').deleteOne({ userId: req.user.id, queryKey });
    res.json({ ok: true });
  } catch (err) { branch(res); }
});

userDataRoutes.get('/followed-artists', async (req, res) => {
  try {
    if (!requirePersonalAccount(req, res)) return;
    const rows = await col('followed_artists').find({ userId: req.user.id }).sort({ followedAt: -1 }).toArray();
    res.json({ artists: rows.map(({ artistId, name, followedAt }) => ({ id: artistId, name, followedAt })) });
  } catch (err) { branch(res); }
});

userDataRoutes.put('/followed-artists/:artistId', express.json(), async (req, res) => {
  try {
    if (!requirePersonalAccount(req, res)) return;
    const artistId = req.params.artistId;
    const name = String(req.body?.name ?? '').trim().slice(0, 200);
    if (!validId(artistId) || !name) return branch(res, { status: 400, error: 'invalid_artist' });
    const followedAt = new Date();
    await col('followed_artists').updateOne({ userId: req.user.id, artistId }, { $setOnInsert: { userId: req.user.id, artistId, name, followedAt } }, { upsert: true });
    res.json({ artist: { id: artistId, name, followedAt } });
  } catch (err) { branch(res); }
});

userDataRoutes.delete('/followed-artists/:artistId', async (req, res) => {
  try {
    if (!requirePersonalAccount(req, res)) return;
    await col('followed_artists').deleteOne({ userId: req.user.id, artistId: req.params.artistId });
    res.json({ ok: true });
  } catch (err) { branch(res); }
});

userDataRoutes.get('/saved-albums', async (req, res) => {
  try {
    if (!requirePersonalAccount(req, res)) return;
    const rows = await col('saved_albums').find({ userId: req.user.id }).sort({ savedAt: -1 }).toArray();
    res.json({ albums: rows.map(({ albumId, name, artist, savedAt }) => ({ id: albumId, name, artist, savedAt })) });
  } catch (err) { branch(res); }
});

userDataRoutes.put('/saved-albums/:albumId', express.json(), async (req, res) => {
  try {
    if (!requirePersonalAccount(req, res)) return;
    const albumId = req.params.albumId;
    const name = String(req.body?.name ?? '').trim().slice(0, 200);
    const artist = String(req.body?.artist ?? '').trim().slice(0, 200);
    if (!validId(albumId) || !name) return branch(res, { status: 400, error: 'invalid_album' });
    const savedAt = new Date();
    await col('saved_albums').updateOne({ userId: req.user.id, albumId }, { $setOnInsert: { userId: req.user.id, albumId, name, artist, savedAt } }, { upsert: true });
    res.json({ album: { id: albumId, name, artist, savedAt } });
  } catch (err) { branch(res); }
});

userDataRoutes.delete('/saved-albums/:albumId', async (req, res) => {
  try {
    if (!requirePersonalAccount(req, res)) return;
    await col('saved_albums').deleteOne({ userId: req.user.id, albumId: req.params.albumId });
    res.json({ ok: true });
  } catch (err) { branch(res); }
});

userDataRoutes.get('/recent', async (req, res) => {
  try {
    if (req.ownerMode) return res.json({ recent: [] });
    const rows = await col('recent_plays').find({ userId: req.user.id }).sort({ playedAt: -1 }).limit(Number(req.query.limit) || 50).toArray();
    res.json({ recent: rows.map(({ trackId, title, artist, playedAt }) => ({ trackId, title, artist, playedAt })) });
  } catch (err) { branch(res); }
});

userDataRoutes.post('/recent', express.json(), async (req, res) => {
  try {
    if (req.ownerMode) return res.json({ ok: true });
    const now = new Date();
    await col('recent_plays').updateOne(
      { userId: req.user.id, trackId: String(req.body?.trackId ?? '') },
      { $set: { userId: req.user.id, trackId: String(req.body?.trackId ?? ''), title: String(req.body?.title ?? ''), artist: String(req.body?.artist ?? ''), playedAt: now } },
      { upsert: true },
    );
    const stale = await col('recent_plays').find({ userId: req.user.id }).sort({ playedAt: -1 }).skip(RECENT_CAP).project({ _id: 1 }).toArray();
    if (stale.length) await col('recent_plays').deleteMany({ _id: { $in: stale.map((d) => d._id) } });
    res.json({ ok: true });
  } catch (err) { branch(res); }
});

const playlist = (doc) => ({ id: String(doc._id), name: doc.name, description: doc.description ?? '', trackIds: doc.trackIds ?? [], createdAt: doc.createdAt, updatedAt: doc.updatedAt });

userDataRoutes.get('/playlists', async (req, res) => {
  try {
    if (req.ownerMode) return res.json({ playlists: [] });
    const rows = await col('playlists').find({ userId: req.user.id }).sort({ updatedAt: -1 }).toArray();
    res.json({ playlists: rows.map(playlist) });
  } catch (err) { branch(res); }
});

userDataRoutes.post('/playlists', express.json(), async (req, res) => {
  try {
    if (req.ownerMode) return branch(res, { status: 403, error: 'owner_mode' });
    const name = String(req.body?.name ?? '').trim();
    if (!name) return branch(res, { status: 400, error: 'name_required' });
    if (name.length > 80) return branch(res, { status: 400, error: 'name_too_long' });
    const now = new Date();
    const doc = { userId: req.user.id, name, description: '', trackIds: [], createdAt: now, updatedAt: now };
    const inserted = await col('playlists').insertOne(doc);
    res.status(201).json({ playlist: playlist({ ...doc, _id: inserted.insertedId }) });
  } catch (err) {
    branch(res, err?.code === 11000 ? { status: 409, error: 'playlist_exists' } : undefined);
  }
});

userDataRoutes.put('/playlists/:id', express.json(), async (req, res) => {
  try {
    if (req.ownerMode) return branch(res, { status: 403, error: 'owner_mode' });
    const set = { updatedAt: new Date() };
    if (!ObjectId.isValid(req.params.id)) return branch(res, { status: 404, error: 'playlist_not_found' });
    if (req.body?.name != null) {
      const name = String(req.body.name).trim();
      if (!name) return branch(res, { status: 400, error: 'name_required' });
      if (name.length > 80) return branch(res, { status: 400, error: 'name_too_long' });
      set.name = name;
    }
    if (req.body?.description != null) set.description = String(req.body.description).trim().slice(0, 300);
    if (Array.isArray(req.body?.trackIds)) {
      if (req.body.trackIds.length > 5000 || req.body.trackIds.some((id) => !validId(String(id)))) return branch(res, { status: 400, error: 'invalid_track_ids' });
      set.trackIds = [...new Set(req.body.trackIds.map(String))];
    }
    const result = await col('playlists').updateOne({ _id: new ObjectId(req.params.id), userId: req.user.id }, { $set: set });
    if (!result.matchedCount) return branch(res, { status: 404, error: 'playlist_not_found' });
    res.json({ ok: true });
  } catch (err) {
    branch(res, err?.code === 11000 ? { status: 409, error: 'playlist_exists' } : undefined);
  }
});

userDataRoutes.delete('/playlists/:id', async (req, res) => {
  try {
    if (req.ownerMode) return branch(res, { status: 403, error: 'owner_mode' });
    if (!ObjectId.isValid(req.params.id)) return branch(res, { status: 404, error: 'playlist_not_found' });
    await col('playlists').deleteOne({ _id: new ObjectId(req.params.id), userId: req.user.id });
    res.json({ ok: true });
  } catch (err) { branch(res); }
});
