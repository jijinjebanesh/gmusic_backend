import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSharedTokens, persistSharedTokens } from '../src/drive.js';

test('MongoDB token read failures are surfaced instead of falling back to a file', async () => {
  let fileReadAttempted = false;
  await assert.rejects(loadSharedTokens({
    isMongoEnabled: () => true,
    getCollection: () => ({
      findOne: async () => { throw new Error('database unavailable'); },
    }),
    fileSystem: {
      readFile: async () => {
        fileReadAttempted = true;
        return '{"refresh_token":"stale"}';
      },
    },
  }), /database unavailable/);
  assert.equal(fileReadAttempted, false);
});

test('MongoDB tokens take precedence over a stale inline token seed', async () => {
  const tokens = await loadSharedTokens({
    inlineJson: '{"refresh_token":"stale"}',
    isMongoEnabled: () => true,
    getCollection: () => ({
      findOne: async () => ({ tokens: { refresh_token: 'fresh' } }),
    }),
  });
  assert.deepEqual(tokens, { refresh_token: 'fresh' });
});

test('inline tokens seed MongoDB only when no shared token is stored', async () => {
  const tokens = await loadSharedTokens({
    inlineJson: '{"refresh_token":"seed"}',
    isMongoEnabled: () => true,
    getCollection: () => ({
      findOne: async () => null,
    }),
  });
  assert.deepEqual(tokens, { refresh_token: 'seed' });
});

test('MongoDB token write failures are surfaced without a filesystem fallback', async () => {
  let fileWriteAttempted = false;
  await assert.rejects(persistSharedTokens({ refresh_token: 'fresh' }, {
    isMongoEnabled: () => true,
    getCollection: () => ({
      updateOne: async () => { throw new Error('database unavailable'); },
    }),
    fileSystem: {
      mkdir: async () => { fileWriteAttempted = true; },
      writeFile: async () => { fileWriteAttempted = true; },
    },
  }), /database unavailable/);
  assert.equal(fileWriteAttempted, false);
});

test('local token-file persistence remains available without MongoDB', async () => {
  let written;
  await persistSharedTokens({ refresh_token: 'local' }, {
    isMongoEnabled: () => false,
    tokenFilePath: 'C:\\temp\\drive-token.json',
    fileSystem: {
      mkdir: async () => {},
      writeFile: async (_path, content, options) => { written = { content, options }; },
    },
  });
  assert.equal(JSON.parse(written.content).refresh_token, 'local');
  assert.equal(written.options.mode, 0o600);
});
