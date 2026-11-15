import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveOAuthRedirectUri } from '../src/oauth_redirect_uri.js';

const localUrl = 'http://localhost:43821/';

test('OAuth redirects use the stable Vercel production domain', () => {
  const redirectUri = resolveOAuthRedirectUri({
    projectProductionUrl: 'gmusicbackend.vercel.app',
    deploymentUrl: 'gmusicbackend-preview.vercel.app',
    localUrl,
    path: '/',
  });

  assert.equal(redirectUri, 'https://gmusicbackend.vercel.app/');
});

test('explicit OAuth redirect overrides the Vercel production domain', () => {
  const redirectUri = resolveOAuthRedirectUri({
    override: 'https://oauth.example.test/callback',
    projectProductionUrl: 'gmusicbackend.vercel.app',
    localUrl,
    path: '/',
  });

  assert.equal(redirectUri, 'https://oauth.example.test/callback');
});

test('local OAuth redirects use the configured local URL', () => {
  const redirectUri = resolveOAuthRedirectUri({
    localUrl,
    path: '/api/v1/drive/oauth/callback',
  });

  assert.equal(
    redirectUri,
    'http://localhost:43821/api/v1/drive/oauth/callback',
  );
});
