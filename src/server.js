import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { readInstalledCredentials, createDriveSession, createDisabledDrive } from './drive.js';
import { col, initDb, mongoEnabled } from './db.js';
import { authRoutes, userDataRoutes, attachUser } from './auth.js';
import { createDriveConnectionService } from './drive_connections.js';
import {
  albumTracks,
  artistAlbums,
  artistTracks,
  getAlbum,
  getArtist,
  getTrack,
  genreTracks,
  listAlbums,
  listArtists,
  listGenres,
  listTracks,
} from './catalog.js';
import { getDriveIndexStatus, syncDriveBatch } from './indexer.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
// Local development bridge: the GMusic web build runs in a browser tab whose
// origin differs from this loopback service, so respond with permissive CORS.
app.use((req, res, next) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization,content-type,range');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
app.use(helmet({ contentSecurityPolicy: false }));
function allowCrossOriginMedia(_req, res, next) {
  res.setHeader('cross-origin-resource-policy', 'cross-origin');
  next();
}
app.use(express.json({ limit: '32kb' }));
app.use(pinoHttp({
  redact: ['req.headers.authorization'],
  autoLogging: {
    ignore: (req) =>
      req.url.startsWith('/api/v1/drive/oauth/callback') ||
      req.url === '/' ||
      req.url.startsWith('/?') ||
      req.url.startsWith('/stream/') ||
      req.url.startsWith('/art/'),
  },
}));
const apiToken = process.env.MORNYE_API_TOKEN;
if (!apiToken || apiToken.length < 32) throw new Error('Set MORNYE_API_TOKEN to a random value of at least 32 characters');
const port = Number(process.env.PORT || 43821);
const onVercel = Boolean(process.env.VERCEL);
const driveMode = process.env.GMUSIC_DRIVE_MODE === 'per_user' ? 'per_user' : 'shared';
// On Vercel the OAuth callback must be the public deployment URL (add it to
// the Google client's authorized redirect URIs); locally it stays loopback.
const redirectUri = process.env.GDRIVE_REDIRECT_URI
  || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}/` : `http://localhost:${port}/`);
const userRedirectUri = process.env.GDRIVE_USER_REDIRECT_URI
  || (process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}/api/v1/drive/oauth/callback`
    : `http://localhost:${port}/api/v1/drive/oauth/callback`);
// Stream/art tickets are stateless: the file id and expiry are signed with
// the API token. In-memory tickets break on serverless — one instance mints
// the ticket, a different (or recycled) instance serves /stream, and the
// player then hangs on a ticket that will never resolve.
function signTicket(fileId, ownerId, expiresAt) {
  const payload = Buffer.from(JSON.stringify({ id: fileId, ownerId, exp: expiresAt })).toString('base64url');
  const mac = crypto.createHmac('sha256', apiToken).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}
function readTicket(ticket) {
  const [payload, mac] = String(ticket || '').split('.');
  if (!payload || !mac) return null;
  const expected = Buffer.from(crypto.createHmac('sha256', apiToken).update(payload).digest('base64url'));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data?.id && data.ownerId && data.exp >= Date.now() ? data : null;
  } catch {
    return null;
  }
}
// Local token-only development stays available, but production and explicitly
// configured deployments must never silently downgrade when Atlas is missing.
const mongoRequired = process.env.REQUIRE_MONGO === 'true' || onVercel;
if (!process.env.MONGO_URI && mongoRequired) {
  throw new Error('MONGO_URI is required (set it in the deployment environment)');
}
if (process.env.MONGO_URI) await initDb();
else console.warn('MONGO_URI is not configured; running local token-only mode');
// Drive is optional at boot: with no OAuth client configured the service
// still serves /health, account login and per-user data; Drive routes answer
// 428 until credentials exist. A Windows path like D:/jaip/credentials.json
// only resolves on the PC, never on a serverless host.
let drive;
let credentials = null;
let driveReason = null;
try {
  credentials = await readInstalledCredentials();
  drive = driveMode === 'shared'
    ? await createDriveSession({ credentials, redirectUri })
    : createDisabledDrive('per_user_drive_mode');
} catch (err) {
  driveReason = String(
    err.code ||
      (String(err.message || '').startsWith('drive_')
        ? err.message
        : err.name || 'credentials_unavailable'),
  );
  console.error(`Drive credentials unavailable (${driveReason}) — Drive routes return 428 until configured`);
  drive = createDisabledDrive(driveReason);
}
const driveConnections = createDriveConnectionService({
  credentials,
  redirectUri: userRedirectUri,
});
function driveOwner(req) {
  return driveMode === 'shared' ? 'shared' : String(req.user.id);
}
async function driveForOwner(ownerId) {
  if (ownerId === 'shared') {
    if (driveMode !== 'shared') {
      const error = new Error('shared_drive_mode_disabled');
      error.status = 403;
      error.code = 'shared_drive_mode_disabled';
      throw error;
    }
    return drive;
  }
  if (driveMode === 'shared') {
    const error = new Error('per_user_drive_mode_disabled');
    error.status = 403;
    error.code = 'per_user_drive_mode_disabled';
    throw error;
  }
  return driveConnections.getDrive(ownerId);
}
const requestDrive = (req) => driveForOwner(driveOwner(req));
// Absolute stream/art URLs: trust Vercel's forwarding headers, else loopback.
function publicOrigin(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host') || `127.0.0.1:${port}`;
  return `${proto}://${host}`;
}
// Stateless OAuth state: HMAC over the issue time, signed with the API token.
// Serverless cold starts land on different instances, so an in-memory nonce
// map would reject the callback half of the flow.
function signState(at) {
  const payload = at.toString(36);
  const mac = crypto.createHmac('sha256', apiToken).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}
function verifyState(state) {
  const [payload, mac] = String(state || '').split('.');
  if (!payload || !mac) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', apiToken).update(payload).digest('base64url'));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
  return Date.now() - Number.parseInt(payload, 36) < 10 * 60_000;
}

app.get('/health', (_req, res) => res.json({
  ok: true,
  service: 'mornye-gdrive-bridge',
  version: '0.3.1',
  runtime: onVercel ? 'vercel' : 'local',
  authMode: mongoEnabled() ? 'user_login' : 'token',
  database: mongoEnabled() ? 'connected' : 'not_configured',
  driveMode,
  drive: drive.configured === false ? 'not_configured' : drive.authorized ? 'authorized' : 'not_authorized',
  ...(driveReason ? { driveReason } : {}),
}));
// Public: account registration and login live here.
app.use('/api/v1/auth', authRoutes);
app.get('/api/v1/drive/oauth/callback', async (req, res) => {
  if (driveMode !== 'per_user') {
    return res.status(404).type('text').send('Per-user Drive authorization is disabled.');
  }
  if (req.query.error) {
    return res.status(400).type('text').send('Google authorization was not completed. Return to GMusic and try again.');
  }
  try {
    await driveConnections.completeOAuth(String(req.query.state || ''), String(req.query.code || ''));
    res.type('text').send('Google Drive connected. Return to GMusic.');
  } catch (error) {
    req.log.error(
      { code: error.code || error.name || 'oauth_error' },
      'Per-user Google OAuth completion failed',
    );
    res.status(error.status || 500).type('text').send('Google authorization failed. Return to GMusic and retry.');
  }
});
// Everything else under /api/v1 requires a session token (or the owner token).
app.use('/api/v1', attachUser(apiToken));
app.use('/api/v1', userDataRoutes);
app.get('/api/v1/status', async (req, res, next) => {
  try {
    const connection = driveMode === 'shared'
      ? { connected: Boolean(drive.authorized) }
      : mongoEnabled()
        ? await driveConnections.status(req.user.id)
        : { connected: false };
    res.json({
      enabled: true,
      authorized: connection.connected,
      driveMode,
      provider: 'google_drive',
      beta: true,
      user: req.user ? { email: req.user.email, displayName: req.user.displayName, role: req.user.role } : null,
    });
  } catch (error) { next(error); }
});
app.get('/api/v1/drive/status', async (req, res, next) => {
  try {
    const ownerId = driveOwner(req);
    const connection = driveMode === 'shared'
      ? { connected: Boolean(drive.authorized) }
      : await driveConnections.status(ownerId);
    const index = mongoEnabled()
      ? await getDriveIndexStatus({ ownerId })
      : { status: 'unavailable', scannedCount: 0, indexedCount: 0, failedCount: 0 };
    res.json({
      authorized: connection.connected,
      connected: connection.connected,
      connectedAt: connection.connectedAt || null,
      provider: 'google_drive',
      catalogAvailable: mongoEnabled(),
      index,
    });
  } catch (error) { next(error); }
});
app.get('/api/v1/drive/sync/status', async (req, res, next) => {
  try { res.json(await getDriveIndexStatus({ ownerId: driveOwner(req) })); } catch (error) { next(error); }
});
app.post('/api/v1/drive/sync', async (req, res, next) => {
  try {
    const ownerId = driveOwner(req);
    const userDrive = await requestDrive(req);
    res.json(await syncDriveBatch(userDrive, { ownerId }));
  } catch (error) { next(error); }
});
app.post('/api/v1/drive/oauth/start', async (req, res, next) => {
  try {
    if (driveMode === 'shared') {
      return res.json({ url: drive.authorizationUrl(signState(Date.now())) });
    }
    res.json(await driveConnections.startOAuth(req.user.id));
  } catch (error) { next(error); }
});
app.post('/api/v1/drive/oauth/disconnect', async (req, res, next) => {
  try {
    if (driveMode !== 'per_user') {
      return res.status(409).json({ error: 'shared_drive_mode_enabled' });
    }
    res.json(await driveConnections.disconnect(req.user.id));
  } catch (error) { next(error); }
});
app.post('/api/v1/auth/url', (_req, res) => {
  if (driveMode !== 'shared') return res.status(409).json({ error: 'shared_drive_mode_disabled' });
  res.json({ url: drive.authorizationUrl(signState(Date.now())) });
});
app.get('/', async (req, res) => {
  if (driveMode !== 'shared') return res.type('text').send('Mornye Google Drive bridge is running.');
  if (!req.query.code) return res.type('text').send('Mornye Google Drive bridge is running.');
  if (!verifyState(req.query.state)) return res.status(400).type('text').send('Invalid or expired OAuth state. Return to Mornye and try again.');
  try {
    await drive.complete(String(req.query.code));
    res.type('text').send('Google Drive connected. Return to Mornye.');
  } catch (error) {
    req.log.error(
      { code: error.code || error.name || 'oauth_error' },
      'Shared Drive OAuth completion failed',
    );
    res.status(500).type('text').send('Google authorization failed. Check backend logs.');
  }
});
app.get('/api/v1/tracks', async (req, res, next) => {
  try {
    const userDrive = await requestDrive(req);
    const ownerId = driveOwner(req);
    const page = await userDrive.listTracks({ query: String(req.query.q || ''), pageToken: req.query.pageToken ? String(req.query.pageToken) : undefined, pageSize: req.query.pageSize });
    const expiresAt = Date.now() + 8 * 60 * 60_000;
    const files = page.files.map((file) => ({
      ...file,
      streamUrl: `${publicOrigin(req)}/stream/${signTicket(file.id, ownerId, expiresAt)}`,
    }));
    res.json({ ...page, files });
  } catch (err) { next(err); }
});
function withStreamUrl(req, track) {
  const expiresAt = Date.now() + 8 * 60 * 60_000;
  const ownerId = driveOwner(req);
  return {
    ...track,
    streamUrl: `${publicOrigin(req)}/stream/${signTicket(track.id, ownerId, expiresAt)}`,
  };
}
app.get('/api/v1/catalog/tracks', async (req, res, next) => {
  try {
    const page = await listTracks({
      query: req.query.q,
      pageSize: req.query.pageSize,
      pageToken: req.query.pageToken,
      ownerId: driveOwner(req),
    });
    res.json({ ...page, files: page.files.map((track) => withStreamUrl(req, track)) });
  } catch (error) { next(error); }
});
app.get('/api/v1/catalog/tracks/:id', async (req, res, next) => {
  try {
    const track = await getTrack(req.params.id, driveOwner(req));
    if (!track) return res.status(404).json({ error: 'track_not_found' });
    res.json({ track: withStreamUrl(req, track) });
  } catch (error) { next(error); }
});
app.get('/api/v1/artists', async (req, res, next) => {
  try { res.json(await listArtists({ ...req.query, ownerId: driveOwner(req) })); } catch (error) { next(error); }
});
app.get('/api/v1/artists/:id/tracks', async (req, res, next) => {
  try {
    const page = await artistTracks(req.params.id, { ...req.query, ownerId: driveOwner(req) });
    res.json({ ...page, files: page.files.map((track) => withStreamUrl(req, track)) });
  } catch (error) { next(error); }
});
app.get('/api/v1/artists/:id/albums', async (req, res, next) => {
  try { res.json(await artistAlbums(req.params.id, { ...req.query, ownerId: driveOwner(req) })); } catch (error) { next(error); }
});
app.get('/api/v1/artists/:id', async (req, res, next) => {
  try {
    const artist = await getArtist(req.params.id, driveOwner(req));
    if (!artist) return res.status(404).json({ error: 'artist_not_found' });
    res.json({ artist });
  } catch (error) { next(error); }
});
app.get('/api/v1/albums', async (req, res, next) => {
  try { res.json(await listAlbums({ ...req.query, ownerId: driveOwner(req) })); } catch (error) { next(error); }
});
app.get('/api/v1/albums/:id/tracks', async (req, res, next) => {
  try {
    const page = await albumTracks(req.params.id, { ...req.query, ownerId: driveOwner(req) });
    res.json({ ...page, files: page.files.map((track) => withStreamUrl(req, track)) });
  } catch (error) { next(error); }
});
app.get('/api/v1/albums/:id', async (req, res, next) => {
  try {
    const album = await getAlbum(req.params.id, driveOwner(req));
    if (!album) return res.status(404).json({ error: 'album_not_found' });
    res.json({ album });
  } catch (error) { next(error); }
});
app.get('/api/v1/genres', async (req, res, next) => {
  try { res.json({ genres: await listGenres(driveOwner(req)) }); } catch (error) { next(error); }
});
app.get('/api/v1/genres/:id/tracks', async (req, res, next) => {
  try {
    const page = await genreTracks(req.params.id, { ...req.query, ownerId: driveOwner(req) });
    res.json({ ...page, files: page.files.map((track) => withStreamUrl(req, track)) });
  } catch (error) { next(error); }
});
app.get('/api/v1/search', async (req, res, next) => {
  try {
    const query = String(req.query.q || '').trim();
    const ownerId = driveOwner(req);
    const [tracks, artists, albums] = await Promise.all([
      listTracks({ query, pageSize: req.query.pageSize, pageToken: req.query.pageToken, ownerId }),
      listArtists({ query, pageSize: req.query.pageSize, ownerId }),
      listAlbums({ query, pageSize: req.query.pageSize, ownerId }),
    ]);
    res.json({
      tracks: tracks.files.map((track) => withStreamUrl(req, track)),
      nextPageToken: tracks.nextPageToken,
      artists: artists.artists,
      albums: albums.albums,
    });
  } catch (error) { next(error); }
});
// Embedded cover art from the head of the file (ID3v2/FLAC/MP4). The
// ticket-gated form needs no Authorization header, so it works in a browser
// <img> (which cannot carry one). Returns 404 when no artwork is embedded.
function artHandler() {
  return async (req, res, next) => {
    try {
      const ticket = readTicket(req.params.ticket);
      if (!ticket) return res.status(401).end();
      const userDrive = await driveForOwner(ticket.ownerId);
      const art = await cachedCoverArt(userDrive, ticket.id, ticket.ownerId);
      if (!art) return res.status(404).end();
      res.setHeader('content-type', art.contentType);
      res.setHeader('cache-control', 'private, max-age=86400');
      res.send(art.data);
    } catch (err) { next(err); }
  };
}
async function cachedCoverArt(driveSession, fileId, ownerId) {
  const cacheId = ownerId === 'shared' ? fileId : `${ownerId}:${fileId}`;
  if (mongoEnabled()) {
    const cached = await col('artwork_cache').findOne({
      _id: cacheId,
      expiresAt: { $gt: new Date() },
    });
    if (cached) {
      const data = Buffer.isBuffer(cached.data) ? cached.data : cached.data?.buffer;
      if (data) return { contentType: cached.contentType, data };
    }
  }
  const art = await driveSession.coverArt(fileId);
  if (art && mongoEnabled() && art.data.length <= 2 * 1024 * 1024) {
    await col('artwork_cache').updateOne(
      { _id: cacheId },
      {
        $set: {
          ownerId,
          contentType: art.contentType,
          data: art.data,
          expiresAt: new Date(Date.now() + 30 * 86_400_000),
        },
      },
      { upsert: true },
    );
  }
  return art;
}
app.get('/art/:ticket', allowCrossOriginMedia, artHandler());
app.get('/api/v1/art/:id', allowCrossOriginMedia, async (req, res, next) => {
  try {
    const ownerId = driveOwner(req);
    const userDrive = await requestDrive(req);
    const art = await cachedCoverArt(userDrive, req.params.id, ownerId);
    if (!art) return res.status(404).end();
    res.setHeader('content-type', art.contentType);
    res.setHeader('cache-control', 'private, max-age=86400');
    res.send(art.data);
  } catch (err) { next(err); }
});
// A ticket grants short-lived access to one file and is safe to pass to the
// audio engine; it never exposes the Google OAuth token or backend API token.
app.get('/stream/:ticket', allowCrossOriginMedia, async (req, res, next) => {
  const ticket = readTicket(req.params.ticket);
  if (!ticket) return res.status(401).end();
  try {
    const userDrive = await driveForOwner(ticket.ownerId);
    const result = await userDrive.openFile(ticket.id, req.get('range'));
    res.status(result.status);
    for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value);
    result.stream.on('error', next);
    result.stream.pipe(res);
  } catch (err) { next(err); }
});
app.get('/api/v1/tracks/:id/stream', allowCrossOriginMedia, async (req, res, next) => {
  try {
    const userDrive = await requestDrive(req);
    const result = await userDrive.openFile(req.params.id, req.get('range'));
    res.status(result.status);
    for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value);
    result.stream.on('error', next);
    result.stream.pipe(res);
  } catch (err) { next(err); }
});
app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json' });
  }
  const upstream = err?.response?.status;
  const status = err?.status || (upstream === 404 ? 404 : upstream === 401 ? 401 : 502);
  const error = err?.code || (
    status === 404 ? 'drive_file_not_found' :
      status === 428 ? 'google_drive_not_connected' :
        status === 503 ? 'mongo_unavailable' :
          status === 400 ? 'invalid_request' :
            'drive_request_failed'
  );
  res.status(status).json({ error });
});
// Local run: this process owns the port. Under Vercel the exported app below
// is the request handler instead (a listening server would fail to boot).
if (!onVercel) {
  app.listen(port, process.env.HOST || '127.0.0.1', () => {
    console.log(`Mornye Drive bridge listening on ${process.env.HOST || '127.0.0.1'}:${port}`);
    console.log(`OAuth redirect URI: ${redirectUri}`);
  });
}

export default app;
