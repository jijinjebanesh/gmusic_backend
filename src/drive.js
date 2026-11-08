import { google } from 'googleapis';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { col, mongoEnabled } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tokenFile = process.env.GDRIVE_TOKEN_PATH || path.resolve(here, '../data/token.json');
const scopes = ['https://www.googleapis.com/auth/drive.readonly'];

// Precedence: inline JSON (GDRIVE_CREDENTIALS) -> client id/secret env
// parts -> the credentials.json file next to this repo. Serverless platforms
// have no credentials.json and no D:/ paths, so the env paths matter there;
// a missing or bad value must degrade, never crash the boot.
export async function readInstalledCredentials(file = process.env.GDRIVE_CREDENTIALS || defaultCredentialsFile()) {
  if (file) {
    const raw = file.trimStart().startsWith('{') ? JSON.parse(file) : JSON.parse(await fs.readFile(file, 'utf8'));
    const cfg = raw.installed || raw.web;
    if (cfg?.client_id && cfg?.client_secret) return { ...cfg, redirect_uris: cfg.redirect_uris || [] };
    throw new Error('GDRIVE_CREDENTIALS must contain an installed or web OAuth client');
  }
  const { GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET } = process.env;
  if (GDRIVE_CLIENT_ID && GDRIVE_CLIENT_SECRET) {
    return { client_id: GDRIVE_CLIENT_ID, client_secret: GDRIVE_CLIENT_SECRET, redirect_uris: [] };
  }
  throw new Error('drive_not_configured');
}

function defaultCredentialsFile() {
  return process.env.GDRIVE_CREDENTIALS_PATH || path.resolve(here, '../credentials.json');
}

// Same surface as a live session, but every Drive call fails with 428. Lets
// /health, register/login and per-user routes stay up when the OAuth client
// (or its token) is missing on a deployment.
export function createDisabledDrive(reason = 'drive_not_configured') {
  const notConfigured = () => {
    const error = new Error(reason);
    error.status = 428;
    throw error;
  };
  return {
    configured: false,
    get authorized() { return false; },
    authorizationUrl: notConfigured,
    complete: notConfigured,
    listTracks: notConfigured,
    openFile: notConfigured,
    coverArt: notConfigured,
  };
}

// Token persistence. Vercel's filesystem is read-only except /tmp and resets
// every cold start, so tokens live in Atlas when Mongo is on; the file stays
// the local-bridge store. GDRIVE_TOKEN_JSON pre-seeds an already-authorized
// token without any OAuth round-trip (paste the local data/token.json once).
async function loadTokens() {
  if (process.env.GDRIVE_TOKEN_JSON) {
    try { return JSON.parse(process.env.GDRIVE_TOKEN_JSON); } catch { /* fall through */ }
  }
  try {
    if (mongoEnabled()) {
      const doc = await col('gdrive_tokens').findOne({ _id: 'primary' });
      if (doc?.tokens) return doc.tokens;
    }
  } catch { /* mongo optional */ }
  try { return JSON.parse(await fs.readFile(tokenFile, 'utf8')); } catch { return null; }
}

async function saveTokens(tokens) {
  try {
    if (mongoEnabled()) {
      await col('gdrive_tokens').updateOne({ _id: 'primary' }, { $set: { tokens, updatedAt: new Date() } }, { upsert: true });
    }
  } catch { /* mongo optional */ }
  try {
    await fs.mkdir(path.dirname(tokenFile), { recursive: true });
    await fs.writeFile(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  } catch { /* read-only filesystem (Vercel) — Mongo copy is authoritative */ }
}

export async function createDriveSession({ credentials, redirectUri }) {
  const oauth = new google.auth.OAuth2(credentials.client_id, credentials.client_secret, redirectUri);
  let tokens = await loadTokens();
  if (tokens) oauth.setCredentials(tokens);
  oauth.on('tokens', async (update) => {
    tokens = { ...tokens, ...update };
    await saveTokens(tokens);
  });
  const drive = google.drive({ version: 'v3', auth: oauth });
  return {
    oauth,
    configured: true,
    get authorized() { return Boolean(tokens?.refresh_token || tokens?.access_token); },
    authorizationUrl(state) {
      return oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: scopes, state });
    },
    async complete(code) {
      const result = await oauth.getToken(code);
      tokens = result.tokens;
      oauth.setCredentials(tokens);
      await saveTokens(tokens);
    },
    async listTracks({ query = '', pageToken, pageSize = 50 } = {}) {
      const parts = ["trashed = false", "mimeType contains 'audio/'"];
      if (query.trim()) {
        const escaped = query.trim().replaceAll("'", "\\'");
        parts.push(`name contains '${escaped}'`);
      }
      const result = await drive.files.list({
        q: parts.join(' and '), pageSize: Math.min(Math.max(Number(pageSize) || 50, 1), 100),
        pageToken, orderBy: 'name', fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,thumbnailLink,webViewLink,description)',
      });
      return { files: (result.data.files || []).map((f) => ({
        id: f.id, name: f.name, mimeType: f.mimeType, size: f.size || null,
        modifiedTime: f.modifiedTime || null, artworkUrl: f.thumbnailLink || null,
      })), nextPageToken: result.data.nextPageToken || null };
    },
    async openFile(id, range) {
      const params = { fileId: id, alt: 'media' };
      const response = await drive.files.get(params, {
        responseType: 'stream',
        ...(range ? { headers: { Range: range } } : {}),
      });
      const h = response.headers || {};
      const readHeader = (name) =>
        typeof h.get === 'function' ? h.get(name) : h[name] ?? h[name.toLowerCase()];
      const contentRange = readHeader('content-range');
      const contentLength = readHeader('content-length');
      const contentType = readHeader('content-type');
      return {
        stream: response.data,
        status: response.status || (range && contentRange ? 206 : 200),
        headers: {
          'content-type': contentType || 'application/octet-stream',
          ...(contentLength ? { 'content-length': contentLength } : {}),
          ...(contentRange ? { 'content-range': contentRange } : {}),
          'accept-ranges': 'bytes',
        },
      };
    },
    // Drive returns no thumbnailLink for audio files, so artwork comes from the
    // tags embedded in the file itself. Only the first megabyte is fetched:
    // ID3v2 and FLAC metadata blocks live at the head of the file.
    async coverArt(id) {
      const response = await drive.files.get({ fileId: id, alt: 'media' }, {
        responseType: 'stream',
        headers: { Range: 'bytes=0-1048575' },
      });
      const chunks = [];
      for await (const chunk of response.data) {
        chunks.push(chunk);
        const total = chunks.reduce((n, c) => n + c.length, 0);
        if (total >= 1024 * 1024) break;
      }
      return extractCoverArt(Buffer.concat(chunks));
    },
  };
}

// --- embedded artwork extraction (ID3v2 / FLAC) ------------------------------

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];

function extractCoverArt(buf) {
  if (buf.length > 3 && buf.toString('latin1', 0, 3) === 'ID3') {
    const art = id3v2Cover(buf);
    if (art) return art;
  }
  if (buf.length > 4 && buf.toString('latin1', 0, 4) === 'fLaC') {
    const art = flacCover(buf);
    if (art) return art;
  }
  // MP4/M4A: the cover atom sits inside moov/udta/meta/ilst/covr.
  const atom = findAtomCover(buf, 0, buf.length);
  if (atom) return atom;
  return null;
}

// Reads an ID3v2 picture frame and returns { contentType, data }.
function id3v2Cover(buf) {
  const major = buf[3];
  const flags = buf[5];
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) |
    ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  let body = buf.subarray(10, Math.min(buf.length, 10 + size));
  if (flags & 0x80) body = unsynchronise(body, major); // global unsynchronisation
  let offset = major === 2 ? 0 : (flags & 0x40 ? findExtendedHeaderEnd(body, major) : 0);
  if (offset === -1) return null;
  while (offset + (major === 2 ? 6 : 10) <= body.length) {
    let id, frameLength;
    if (major === 2) {
      id = body.toString('latin1', offset, offset + 3);
      if (!/^[A-Z0-9]{3}$/.test(id)) return null;
      frameLength = (body[offset + 3] << 16) | (body[offset + 4] << 8) | body[offset + 5];
      offset += 6;
    } else {
      id = body.toString('latin1', offset, offset + 4);
      if (!/^[A-Z0-9]{4}$/.test(id)) return null;
      if (major === 4) {
        frameLength = ((body[offset + 4] & 0x7f) << 21) | ((body[offset + 5] & 0x7f) << 14) |
          ((body[offset + 6] & 0x7f) << 7) | (body[offset + 7] & 0x7f);
      } else {
        frameLength = (body[offset + 4] << 24) | (body[offset + 5] << 16) |
          (body[offset + 6] << 8) | body[offset + 7];
      }
      offset += 10; // id + size (4) + flags (2)
    }
    if (offset + frameLength > body.length) return null;
    const frame = body.subarray(offset, offset + frameLength);
    if (major >= 3 && id === 'APIC' && frame.length > 11) {
      const encoding = frame[0];
      const mimeEnd = frame.indexOf(0, 1);
      const contentType = frame.toString('latin1', 1, mimeEnd);
      // After the MIME: picture type (1 byte), then the description in the
      // frame's text encoding, then the picture data.
      const data = stripTextDescription(frame.subarray(mimeEnd + 1 + 1), encoding);
      if (data.length > 1024 && IMAGE_TYPES.includes(contentType)) {
        return { contentType, data: Buffer.from(data) };
      }
    } else if (major === 2 && id === 'PIC' && frame.length > 7) {
      // v2.2 PIC: encoding (1), image format (3), picture type (1), description, data.
      const contentType = frame.toString('latin1', 1, 4) === 'PNG'
        ? 'image/png' : 'image/jpeg';
      const data = stripTextDescription(frame.subarray(4 + 1), frame[0]);
      if (data.length > 1024) return { contentType, data: Buffer.from(data) };
    }
    offset += frameLength;
  }
  return null;
}

function stripTextDescription(data, encoding) {
  // Picture type byte precedes the description (for ID3v2.3/2.4 APIC we already
  // skipped it above; for v2.2 PIC the layout is type, encoding, description).
  let start = 0;
  if (encoding === 1 || encoding === 2) {
    // UTF-16: description ends at 00 00
    for (let i = 0; i + 1 < data.length - 1; i += 2) {
      if (data[i] === 0 && data[i + 1] === 0) { start = i + 2; break; }
    }
  } else {
    // Latin1 / UTF-8: single null terminator
    const zero = data.indexOf(0, 1);
    if (zero === -1) return data.subarray(0, 0);
    start = zero + 1;
  }
  return data.subarray(start);
}

function unsynchronise(buf, major) {
  const headerBytes = major === 2 ? 6 : 10;
  const out = Buffer.allocUnsafe(buf.length + 64);
  let n = 0;
  out[n++] = buf[0]; // frame type; unsync header bytes are copied as-is below
  // Simplicity over exactness: de-unsynchronise from the frame header on.
  let i = headerBytes;
  let prev = buf[i - 1];
  while (i < buf.length) {
    const byte = buf[i];
    if (prev === 0xff && byte === 0x00) { prev = byte; i++; continue; }
    out[n++] = byte;
    prev = byte;
    i++;
  }
  // Rebuild as: original header bytes + cleaned frame bytes.
  const result = Buffer.concat([buf.subarray(0, headerBytes), out.subarray(0, n)]);
  return result.subarray(0, result.length);
}

function findExtendedHeaderEnd(body, major) {
  const size = body.readUInt32BE(1) & 0x0fffffff;
  // v2.3: size includes its own 4 bytes. v2.4: size excludes them.
  return major === 4 ? 4 + 4 + size : 4 + size;
}

function flacCover(buf) {
  let offset = 4;
  while (offset + 4 <= buf.length) {
    const type = buf[offset] & 0x7f;
    const last = (buf[offset] & 0x80) !== 0;
    const length = buf.readUIntBE(++offset, 3);
    offset += 3;
    if (offset + length > buf.length) return null;
    if (type === 6) { // PICTURE
      let p = offset + 4; // picture type (4 bytes)
      const mimeLen = buf.readUInt32BE(p); p += 4;
      const contentType = buf.toString('latin1', p, p + mimeLen); p += mimeLen;
      const descLen = buf.readUInt32BE(p); p += 4 + descLen;
      p += 16; // width, height, depth, colors
      const dataLen = buf.readUInt32BE(p); p += 4;
      if (p + dataLen <= buf.length && dataLen > 1024) {
        return { contentType, data: Buffer.from(buf.subarray(p, p + dataLen)) };
      }
      return null;
    }
    offset += length;
    if (last) return null;
  }
  return null;
}

// Minimal MP4 atom walker: searches for a 'covr' box inside moov/udta/meta/ilst.
function findAtomCover(buf, start, end, depth = 0) {
  if (depth > 6) return null;
  let p = start;
  while (p + 8 <= end) {
    const size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (size < 8 || p + size > end) return null;
    if (type === 'covr') {
      const data = buf.subarray(p + 8, p + size);
      const magic = data.subarray(0, 12);
      if (magic[0] === 0x89 && magic[1] === 0x50) return { contentType: 'image/png', data: Buffer.from(data) };
      if (magic[0] === 0xff && magic[1] === 0xd8) return { contentType: 'image/jpeg', data: Buffer.from(data) };
    } else if (['moov', 'udta', 'meta', 'ilst', 'trak', 'mdia'].includes(type)) {
      const inner = type === 'meta' ? p + 12 : p + 8; // meta has a 4-byte version/flags child
      const art = findAtomCover(buf, inner, p + size, depth + 1);
      if (art) return art;
    }
    p += size;
  }
  return null;
}
