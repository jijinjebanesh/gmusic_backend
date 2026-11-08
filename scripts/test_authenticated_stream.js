import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((line) => line && !line.startsWith('#') && line.includes('=')).map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
const port = '43822';
const child = spawn(process.execPath, ['src/server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, ...env, HOST: '127.0.0.1', PORT: port }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
try {
  let health;
  for (let i = 0; i < 60; i++) {
    try { health = await fetch(`${base}/health`); if (health.ok) break; } catch {}
    if (child.exitCode !== null) throw new Error(`bridge exited with ${child.exitCode}`);
    await delay(100);
  }
  if (!health?.ok) throw new Error('bridge did not start');
  const headers = { authorization: `Bearer ${env.MORNYE_API_TOKEN}` };
  const statusResponse = await fetch(`${base}/api/v1/status`, { headers });
  const status = await statusResponse.json();
  if (!status.authorized) throw new Error('Drive OAuth is not authorized');
  const pageResponse = await fetch(`${base}/api/v1/tracks?pageSize=1`, { headers });
  if (!pageResponse.ok) throw new Error(`listing failed with ${pageResponse.status}`);
  const track = (await pageResponse.json()).files?.[0];
  if (!track) throw new Error('Drive returned no audio files');
  const response = await fetch(track.streamUrl, { headers: { range: 'bytes=0-4095' } });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const signature = new TextDecoder().decode(bytes.slice(0, 4));
  console.log(JSON.stringify({
    trackName: track.name,
    mimeType: track.mimeType,
    size: track.size,
    rangeStatus: response.status,
    contentType: response.headers.get('content-type'),
    contentLength: response.headers.get('content-length'),
    contentRange: response.headers.get('content-range'),
    bytesReceived: bytes.length,
    flacSignature: signature === 'fLaC',
    playable: response.status === 206 && bytes.length === 4096 && (track.mimeType !== 'audio/flac' || signature === 'fLaC'),
  }));
} finally {
  child.kill();
}
