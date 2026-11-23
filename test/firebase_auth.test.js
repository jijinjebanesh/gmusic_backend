import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyFirebaseIdToken } from '../src/auth.js';

test('Firebase ID token verification rejects malformed tokens', async () => {
  await assert.rejects(
    verifyFirebaseIdToken('not-a-firebase-id-token', 'gmusic-41c88'),
    (error) => error.code === 'auth/argument-error',
  );
});
