import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStreamHeaders } from '../src/stream_headers.js';

test('normalizes FLAC MIME to a type supported by Chrome audio playback', () => {
  assert.deepEqual(
    normalizeStreamHeaders({ 'content-type': 'audio/x-flac' }),
    { 'content-type': 'audio/flac' },
  );
});

test('preserves content type parameters and unrelated stream headers', () => {
  assert.deepEqual(
    normalizeStreamHeaders({
      'Content-Type': 'audio/x-wav; charset=binary',
      'Content-Length': '42',
      'Accept-Ranges': 'bytes',
    }),
    {
      'Content-Type': 'audio/wav; charset=binary',
      'Content-Length': '42',
      'Accept-Ranges': 'bytes',
    },
  );
});

test('leaves standard audio and non-audio content types unchanged', () => {
  const headers = {
    'content-type': 'audio/mpeg',
    'content-length': '10',
  };
  assert.deepEqual(normalizeStreamHeaders(headers), headers);
});
