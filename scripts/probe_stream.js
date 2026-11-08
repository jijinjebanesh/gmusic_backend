import fs from 'node:fs';

const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((line) => line && !line.startsWith('#') && line.includes('=')).map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
const headers = { authorization: `Bearer ${env.MORNYE_API_TOKEN}` };
const pageResponse = await fetch('http://127.0.0.1:43821/api/v1/tracks?pageSize=1', { headers });
if (!pageResponse.ok) throw new Error(`Track listing failed: HTTP ${pageResponse.status}`);
const page = await pageResponse.json();
const track = page.files?.[0];
if (!track) throw new Error('Drive returned no audio files');
const response = await fetch(track.streamUrl, { headers: { range: 'bytes=0-4095' } });
const bytes = new Uint8Array(await response.arrayBuffer());
const signature = new TextDecoder().decode(bytes.slice(0, 4));
console.log(JSON.stringify({
  trackName: track.name,
  mimeType: track.mimeType,
  rangeStatus: response.status,
  contentType: response.headers.get('content-type'),
  contentRange: response.headers.get('content-range'),
  bytesReceived: bytes.length,
  flacSignature: signature === 'fLaC',
  playable: response.status === 206 && bytes.length > 0 && (track.mimeType !== 'audio/flac' || signature === 'fLaC'),
}));
