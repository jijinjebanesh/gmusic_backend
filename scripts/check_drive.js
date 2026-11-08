import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);
const base = 'http://127.0.0.1:43821';
const headers = { authorization: `Bearer ${env.MORNYE_API_TOKEN}` };
const health = await fetch(`${base}/health`);
const statusResponse = await fetch(`${base}/api/v1/status`, { headers });
const status = await statusResponse.json();
const result = {
  health: health.status,
  status: statusResponse.status,
  authorized: status.authorized,
};
if (status.authorized) {
  const response = await fetch(`${base}/api/v1/tracks?pageSize=50`, { headers });
  result.tracksStatus = response.status;
  if (response.ok) {
    const page = await response.json();
    result.trackCount = page.files.length;
    result.sampleTracks = page.files.slice(0, 10).map(({ id, name, mimeType, streamUrl }) => ({ id, name, mimeType, streamUrl }));
  }
}
console.log(JSON.stringify(result));
