import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const port = 43823;
const token = 'test-token-0123456789abcdef0123456789abcdef';
const fixture = path.join(os.tmpdir(), 'mornye-gdrive-test-credentials.json');

test('health is public and API requires bearer authentication', async () => {
  await fs.writeFile(fixture, JSON.stringify({ installed: {
    client_id: 'test.apps.googleusercontent.com', client_secret: 'test-secret',
    redirect_uris: ['http://localhost'],
  } }));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), MORNYE_API_TOKEN: token, GDRIVE_CREDENTIALS: fixture, GDRIVE_TOKEN_PATH: path.join(os.tmpdir(), 'mornye-no-token.json') },
    stdio: 'ignore',
  });
  try {
    let health;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { health = await fetch(`http://127.0.0.1:${port}/health`); break; }
      catch { if (child.exitCode !== null) throw new Error(`backend exited ${child.exitCode}`); await delay(100); }
    }
    assert.equal(health?.status, 200);
    assert.equal((await health.json()).ok, true);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/status`)).status, 401);
    const status = await fetch(`http://127.0.0.1:${port}/api/v1/status`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).authorized, false);
    const auth = await fetch(`http://127.0.0.1:${port}/api/v1/auth/url`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    assert.equal(auth.status, 200);
    const authorizationUrl = new URL((await auth.json()).url);
    assert.equal(authorizationUrl.hostname, 'accounts.google.com');
    assert.ok(authorizationUrl.searchParams.get('state'));
    assert.ok(authorizationUrl.searchParams.get('scope').includes('drive.readonly'));
  } finally {
    child.kill();
    await fs.rm(fixture, { force: true });
  }
});
