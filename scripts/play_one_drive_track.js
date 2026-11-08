import fs from 'node:fs';
import { spawn } from 'node:child_process';

const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((line) => line && !line.startsWith('#') && line.includes('=')).map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
const headers = { authorization: `Bearer ${env.MORNYE_API_TOKEN}` };
const statusResponse = await fetch('http://127.0.0.1:43821/api/v1/status', { headers });
const status = await statusResponse.json();
if (!status.authorized) throw new Error('Google Drive is not authorized');
const pageResponse = await fetch('http://127.0.0.1:43821/api/v1/tracks?pageSize=1', { headers });
if (!pageResponse.ok) throw new Error(`Track listing failed: HTTP ${pageResponse.status}`);
const track = (await pageResponse.json()).files?.[0];
if (!track?.streamUrl) throw new Error('Drive returned no playable file');
console.log(`Playing through the Mornye Drive backend: ${track.name}`);
const player = spawn('D:/ffmpeg-7.1-essentials_build/bin/ffplay.exe', ['-hide_banner', '-nodisp', '-autoexit', '-loglevel', 'info', track.streamUrl], { stdio: 'inherit' });
const code = await new Promise((resolve, reject) => {
  player.once('error', reject);
  player.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
});
console.log(`Player finished: ${JSON.stringify(code)}`);
if (code.exitCode !== 0) process.exitCode = 1;
