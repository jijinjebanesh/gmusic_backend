import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { readInstalledCredentials, createDriveSession, createDisabledDrive } from './drive.js';
import { initDb, mongoEnabled, closeDb } from './db.js';
import { authRoutes, userDataRoutes, attachUser } from './auth.js';

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
app.use(express.json({ limit: '32kb' }));
app.use(pinoHttp({ redact: ['req.headers.authorization'] }));
const apiToken = process.env.MORNYE_API_TOKEN;
if (!apiToken || apiToken.length < 32) throw new Error('Set MORNYE_API_TOKEN to a random value of at least 32 characters');
const port = Number(process.env.PORT || 43821);
const onVercel = Boolean(process.env.VERCEL);
// On Vercel the OAuth callback must be the public deployment URL (add it to
// the Google client's authorized redirect URIs); locally it stays loopback.
const redirectUri = process.env.GDRIVE_REDIRECT_URI
  || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}/` : `http://localhost:${port}/`);
// Stream/art tickets are stateless: the file id and expiry are signed with
// the API token. In-memory tickets break on serverless — one instance mints
// the ticket, a different (or recycled) instance serves /stream, and the
// player then hangs on a ticket that will never resolve.
function signTicket(fileId, expiresAt) {
  const payload = Buffer.from(JSON.stringify({ id: fileId, exp: expiresAt })).toString('base64url');
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
    return data?.id && data.exp >= Date.now() ? data.id : null;
  } catch {
    return null;
  }
}
// MongoDB is optional: with MONGO_URI set the bridge runs user login +
// per-user features; without it, the single-owner MORNYE_API_TOKEN path.
if (process.env.MONGO_URI) await initDb();
// Drive is optional at boot: with no OAuth client configured the service
// still serves /health, account login and per-user data; Drive routes answer
// 428 until credentials exist. A Windows path like D:/jaip/credentials.json
// only resolves on the PC, never on a serverless host.
let drive;
let driveReason = null;
try {
  const credentials = await readInstalledCredentials();
  drive = await createDriveSession({ credentials, redirectUri });
} catch (err) {
  driveReason = String(err.message);
  console.error(`Drive credentials unavailable (${driveReason}) — Drive routes return 428 until configured`);
  drive = createDisabledDrive(driveReason);
}
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
  drive: drive.configured === false ? 'not_configured' : drive.authorized ? 'authorized' : 'not_authorized',
  ...(driveReason ? { driveReason } : {}),
}));
// Public: account registration and login live here.
app.use('/api/v1/auth', authRoutes);
// Everything else under /api/v1 requires a session token (or the owner token).
app.use('/api/v1', attachUser(apiToken));
app.use('/api/v1', userDataRoutes);
app.get('/api/v1/status', (_req, res) => res.json({ enabled: true, authorized: drive.authorized, provider: 'google_drive', beta: true, user: req_user(_req) }));
function req_user(req) { return req.user ? { email: req.user.email, displayName: req.user.displayName, role: req.user.role } : null; }
app.post('/api/v1/auth/url', (_req, res) => {
  res.json({ url: drive.authorizationUrl(signState(Date.now())) });
});
app.get('/', async (req, res) => {
  if (!req.query.code) return res.type('text').send('Mornye Google Drive bridge is running.');
  if (!verifyState(req.query.state)) return res.status(400).type('text').send('Invalid or expired OAuth state. Return to Mornye and try again.');
  try {
    await drive.complete(String(req.query.code));
    res.type('text').send('Google Drive connected. Return to Mornye.');
  } catch (error) {
    req.log.error({ err: error }, 'OAuth completion failed');
    res.status(500).type('text').send('Google authorization failed. Check backend logs.');
  }
});
app.get('/api/v1/tracks', async (req, res, next) => {
  try {
    if (!drive.authorized) return res.status(428).json({ error: 'google_drive_not_connected' });
    const page = await drive.listTracks({ query: String(req.query.q || ''), pageToken: req.query.pageToken ? String(req.query.pageToken) : undefined, pageSize: req.query.pageSize });
    const expiresAt = Date.now() + 8 * 60 * 60_000;
    const files = page.files.map((file) => ({
      ...file,
      streamUrl: `${publicOrigin(req)}/stream/${signTicket(file.id, expiresAt)}`,
    }));
    res.json({ ...page, files });
  } catch (err) { next(err); }
});
// Embedded cover art from the head of the file (ID3v2/FLAC/MP4). The
// ticket-gated form needs no Authorization header, so it works in a browser
// <img> (which cannot carry one). Returns 404 when no artwork is embedded.
function artHandler(driveSession) {
  return async (req, res, next) => {
    try {
      const fileId = readTicket(req.params.ticket);
      if (!fileId) return res.status(401).end();
      const art = await driveSession.coverArt(fileId);
      if (!art) return res.status(404).end();
      res.setHeader('content-type', art.contentType);
      res.setHeader('cache-control', 'private, max-age=86400');
      res.send(art.data);
    } catch (err) { next(err); }
  };
}
app.get('/art/:ticket', artHandler(drive));
app.get('/api/v1/art/:id', async (req, res, next) => {
  try {
    if (!drive.authorized) return res.status(428).json({ error: 'google_drive_not_connected' });
    const art = await drive.coverArt(req.params.id);
    if (!art) return res.status(404).end();
    res.setHeader('content-type', art.contentType);
    res.setHeader('cache-control', 'private, max-age=86400');
    res.send(art.data);
  } catch (err) { next(err); }
});
// A ticket grants short-lived access to one file and is safe to pass to the
// audio engine; it never exposes the Google OAuth token or backend API token.
app.get('/stream/:ticket', async (req, res, next) => {
  const fileId = readTicket(req.params.ticket);
  if (!fileId) return res.status(401).end();
  try {
    const result = await drive.openFile(fileId, req.get('range'));
    res.status(result.status);
    for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value);
    result.stream.on('error', next);
    result.stream.pipe(res);
  } catch (err) { next(err); }
});
app.get('/api/v1/tracks/:id/stream', async (req, res, next) => {
  try {
    if (!drive.authorized) return res.status(428).json({ error: 'google_drive_not_connected' });
    const result = await drive.openFile(req.params.id, req.get('range'));
    res.status(result.status);
    for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value);
    result.stream.on('error', next);
    result.stream.pipe(res);
  } catch (err) { next(err); }
});
app.use((err, _req, res, _next) => {
  const upstream = err?.response?.status;
  const status = err?.status || (upstream === 404 ? 404 : upstream === 401 ? 401 : 502);
  const error = status === 404 ? 'drive_file_not_found' : status === 428 ? 'google_drive_not_connected' : 'drive_request_failed';
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
