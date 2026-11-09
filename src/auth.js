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

const playlist = (doc) => ({ id: String(doc._id), name: doc.name, trackIds: doc.trackIds ?? [], createdAt: doc.createdAt, updatedAt: doc.updatedAt });

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
    const now = new Date();
    const doc = { userId: req.user.id, name, trackIds: [], createdAt: now, updatedAt: now };
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
    if (req.body?.name != null) set.name = String(req.body.name);
    if (Array.isArray(req.body?.trackIds)) set.trackIds = req.body.trackIds.map(String);
    const result = await col('playlists').updateOne({ _id: new ObjectId(req.params.id), userId: req.user.id }, { $set: set });
    if (!result.matchedCount) return branch(res, { status: 404, error: 'playlist_not_found' });
    res.json({ ok: true });
  } catch (err) { branch(res); }
});

userDataRoutes.delete('/playlists/:id', async (req, res) => {
  try {
    if (req.ownerMode) return branch(res, { status: 403, error: 'owner_mode' });
    await col('playlists').deleteOne({ _id: new ObjectId(req.params.id), userId: req.user.id });
    res.json({ ok: true });
  } catch (err) { branch(res); }
});
