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

test('required MongoDB configuration fails startup instead of downgrading auth', async () => {
  const env = { ...process.env, REQUIRE_MONGO: 'true', MORNYE_API_TOKEN: token };
  delete env.MONGO_URI;
  delete env.VERCEL;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /MONGO_URI is required/);
});

test('health is public and API requires bearer authentication', async () => {
  await fs.writeFile(fixture, JSON.stringify({ installed: {
    client_id: 'test.apps.googleusercontent.com', client_secret: 'test-secret',
    redirect_uris: ['http://localhost'],
  } }));
  const childEnv = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    MORNYE_API_TOKEN: token,
    GDRIVE_CREDENTIALS: fixture,
    GDRIVE_TOKEN_PATH: path.join(os.tmpdir(), 'mornye-no-token.json'),
  };
  delete childEnv.MONGO_URI;
  delete childEnv.VERCEL;
  delete childEnv.REQUIRE_MONGO;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: childEnv,
    stdio: 'ignore',
  });
  try {
    let health;
    for (let attempt = 0; attempt < 150; attempt++) {
      try { health = await fetch(`http://127.0.0.1:${port}/health`); break; }
      catch { if (child.exitCode !== null) throw new Error(`backend exited ${child.exitCode}`); await delay(100); }
    }
    assert.equal(health?.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.database, 'not_configured');
    for (const path of ['/stream/invalid-ticket', '/art/invalid-ticket']) {
      const media = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(media.status, 401);
      assert.equal(media.headers.get('cross-origin-resource-policy'), 'cross-origin');
    }
    const invalidJson = await fetch(`http://127.0.0.1:${port}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"email":"invalid@example.com","password":"password123" "displayName":"Test"}',
    });
    assert.equal(invalidJson.status, 400);
    assert.deepEqual(await invalidJson.json(), { error: 'invalid_json' });
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/status`)).status, 401);
    const status = await fetch(`http://127.0.0.1:${port}/api/v1/status`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.equal(statusBody.authorized, false);
    assert.equal(statusBody.driveMode, 'shared');
    for (const route of ['/api/v1/search-history', '/api/v1/followed-artists', '/api/v1/saved-albums']) {
      const personal = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(personal.status, 403);
      assert.equal((await personal.json()).error, 'personal_account_required');
    }
    const ownerPlaylist = await fetch(`http://127.0.0.1:${port}/api/v1/playlists`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Not a user playlist' }),
    });
    assert.equal(ownerPlaylist.status, 403);
    const auth = await fetch(`http://127.0.0.1:${port}/api/v1/auth/url`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    assert.equal(auth.status, 200);
    const authorizationUrl = new URL((await auth.json()).url);
    assert.equal(authorizationUrl.hostname, 'accounts.google.com');
    assert.ok(authorizationUrl.searchParams.get('state'));
    assert.ok(authorizationUrl.searchParams.get('scope').includes('drive.readonly'));
    const compatibleStart = await fetch(`http://127.0.0.1:${port}/api/v1/drive/oauth/start`, {
      method: 'POST',
      headers: { authorization: token },
    });
    assert.equal(compatibleStart.status, 200);
    assert.equal(
      new URL((await compatibleStart.json()).url).hostname,
      'accounts.google.com',
    );
  } finally {
    child.kill();
    await fs.rm(fixture, { force: true });
  }
});

test('shared library is the default and exposes shared OAuth to authenticated users', async () => {
  const perUserPort = 43824;
  await fs.writeFile(fixture, JSON.stringify({ installed: {
    client_id: 'test.apps.googleusercontent.com',
    client_secret: 'test-secret',
    redirect_uris: ['http://localhost'],
  } }));
  const childEnv = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(perUserPort),
    MORNYE_API_TOKEN: token,
    GDRIVE_CREDENTIALS: fixture,
  };
  delete childEnv.MONGO_URI;
  delete childEnv.VERCEL;
  delete childEnv.REQUIRE_MONGO;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: childEnv,
    stdio: 'ignore',
  });
  try {
    let health;
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        health = await fetch(`http://127.0.0.1:${perUserPort}/health`);
        break;
      } catch {
        if (child.exitCode !== null) throw new Error(`backend exited ${child.exitCode}`);
        await delay(100);
      }
    }
    assert.equal(health?.status, 200);
    assert.equal((await health.json()).driveMode, 'shared');

    const headers = { authorization: token };
    const legacyOAuth = await fetch(`http://127.0.0.1:${perUserPort}/api/v1/auth/url`, {
      method: 'POST',
      headers,
    });
    assert.equal(legacyOAuth.status, 200);

    const sharedStart = await fetch(`http://127.0.0.1:${perUserPort}/api/v1/drive/oauth/start`, {
      method: 'POST',
      headers,
    });
    assert.equal(sharedStart.status, 200);
    assert.equal(
      new URL((await sharedStart.json()).url).hostname,
      'accounts.google.com',
    );
  } finally {
    child.kill();
    await fs.rm(fixture, { force: true });
  }
});
