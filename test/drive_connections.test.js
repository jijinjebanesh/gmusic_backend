import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDriveConnectionService } from '../src/drive_connections.js';
import { decryptTokens, encryptTokens } from '../src/token_crypto.js';

class MemoryDatabase {
  constructor() {
    this.collections = new Map();
  }

  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new Map());
    const rows = this.collections.get(name);
    return {
      async insertOne(document) {
        const id = document.stateHash || document.userId;
        rows.set(id, { ...document });
      },
      async updateOne(filter, update) {
        const existing = [...rows.values()].find((row) =>
          Object.entries(filter).every(([key, value]) => row[key] === value),
        );
        const document = { ...filter, ...(existing || {}), ...update.$set };
        rows.set(document.stateHash || document.userId, document);
      },
      async findOne(filter) {
        return [...rows.values()].find((row) =>
          Object.entries(filter).every(([key, value]) => row[key] === value),
        ) || null;
      },
      async findOneAndDelete(filter) {
        const entry = [...rows.entries()].find(([, row]) =>
          Object.entries(filter).every(([key, value]) => {
            if (value && typeof value === 'object' && '$gt' in value) {
              return row[key] > value.$gt;
            }
            return row[key] === value;
          }),
        );
        if (!entry) return null;
        rows.delete(entry[0]);
        return entry[1];
      },
      async deleteOne(filter) {
        const entry = [...rows.entries()].find(([, row]) =>
          Object.entries(filter).every(([key, value]) => row[key] === value),
        );
        if (entry) rows.delete(entry[0]);
      },
      async deleteMany(filter) {
        for (const [id, row] of rows) {
          if (Object.entries(filter).every(([key, value]) => row[key] === value)) rows.delete(id);
        }
      },
    };
  }
}

test('AES-GCM token envelopes are authenticated and owner-bound', () => {
  const key = crypto.randomBytes(32).toString('base64');
  const encrypted = encryptTokens({ refresh_token: 'refresh-secret' }, key, 'drive:user-a');
  assert.equal(JSON.stringify(encrypted).includes('refresh-secret'), false);
  assert.deepEqual(decryptTokens(encrypted, key, 'drive:user-a'), {
    refresh_token: 'refresh-secret',
  });
  assert.throws(() => decryptTokens(encrypted, key, 'drive:user-b'));
  assert.throws(() => decryptTokens({ ...encrypted, ciphertext: 'invalid' }, key));
});

test('OAuth state is one-use, PKCE-bound, and stores tokens per user encrypted', async () => {
  const database = new MemoryDatabase();
  const key = crypto.randomBytes(32).toString('base64');
  const authOptions = [];
  const exchangedVerifiers = [];
  const revokedTokens = [];
  const oauth = {
    generateAuthUrl(options) {
      authOptions.push(options);
      return `https://accounts.google.com/o/oauth2/auth?state=${options.state}&challenge=${options.code_challenge}`;
    },
    async getToken({ code, codeVerifier }) {
      exchangedVerifiers.push(codeVerifier);
      return { tokens: { access_token: `access-${code}`, refresh_token: `refresh-${code}` } };
    },
    async revokeToken(token) {
      revokedTokens.push(token);
      return {};
    },
  };
  const service = createDriveConnectionService({
    credentials: { client_id: 'client', client_secret: 'secret' },
    redirectUri: 'https://gmusic.example/api/v1/drive/oauth/callback',
    encryptionKey: key,
    collection: (name) => database.collection(name),
    isMongoEnabled: () => true,
    makeOAuthClient: () => oauth,
    makeDriveSession: async (options) => {
      return { tokens: options.initialTokens };
    },
  });

  const firstUrl = new URL((await service.startOAuth('user-a')).url);
  const secondUrl = new URL((await service.startOAuth('user-b')).url);
  const firstState = firstUrl.searchParams.get('state');
  const stateHash = crypto.createHash('sha256').update(firstState).digest('hex');
  const storedState = await database.collection('drive_oauth_states').findOne({ stateHash });
  assert.ok(storedState.encryptedCodeVerifier);
  assert.equal(storedState.codeVerifier, undefined);
  assert.equal(authOptions[0].code_challenge_method, 'S256');

  await service.completeOAuth(firstState, 'user-a-code');
  const verifier = exchangedVerifiers[0];
  assert.equal(
    crypto.createHash('sha256').update(verifier).digest('base64url'),
    authOptions[0].code_challenge,
  );
  await assert.rejects(
    service.completeOAuth(firstState, 'replay'),
    { code: 'oauth_state_invalid_or_expired' },
  );

  const storedConnection = await database.collection('drive_connections').findOne({ userId: 'user-a' });
  assert.equal(JSON.stringify(storedConnection).includes('refresh-user-a-code'), false);
  assert.equal((await service.status('user-a')).connected, true);
  assert.equal((await service.status('user-b')).connected, false);
  assert.deepEqual((await service.getDrive('user-a')).tokens, {
    access_token: 'access-user-a-code',
    refresh_token: 'refresh-user-a-code',
  });
  await assert.rejects(service.getDrive('user-b'), { code: 'google_drive_not_connected' });

  const disconnected = await service.disconnect('user-a');
  assert.deepEqual(disconnected, { disconnected: true, revoked: true });
  assert.deepEqual(revokedTokens, ['refresh-user-a-code']);
  assert.equal((await service.status('user-a')).connected, false);
  assert.notEqual(secondUrl.searchParams.get('state'), firstState);
});

test('disconnect removes the local connection even when Google revocation fails', async () => {
  const database = new MemoryDatabase();
  const key = crypto.randomBytes(32).toString('base64');
  const oauth = {
    generateAuthUrl: (options) => `https://accounts.google.com/?state=${options.state}`,
    async getToken() {
      return { tokens: { refresh_token: 'refresh-token' } };
    },
    async revokeToken() {
      throw Object.assign(new Error('revocation unavailable'), { code: 'ECONNRESET' });
    },
  };
  const service = createDriveConnectionService({
    credentials: { client_id: 'client', client_secret: 'secret' },
    redirectUri: 'https://gmusic.example/api/v1/drive/oauth/callback',
    encryptionKey: key,
    collection: (name) => database.collection(name),
    isMongoEnabled: () => true,
    makeOAuthClient: () => oauth,
  });
  const authorization = new URL((await service.startOAuth('user-c')).url);
  await service.completeOAuth(authorization.searchParams.get('state'), 'code');

  assert.deepEqual(await service.disconnect('user-c'), {
    disconnected: true,
    revoked: false,
  });
  assert.equal((await service.status('user-c')).connected, false);
});
