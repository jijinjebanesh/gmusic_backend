import test from 'node:test';
import assert from 'node:assert/strict';
import { apiErrorCode } from '../src/api_error_code.js';

test('preserves safe OAuth error codes from upstream responses', () => {
  assert.equal(apiErrorCode({
    response: { data: { error: 'invalid_grant' } },
  }), 'invalid_grant');
});

test('extracts Drive API status or reason without exposing its message', () => {
  assert.equal(apiErrorCode({
    response: {
      data: {
        error: {
          status: 'INVALID_ARGUMENT',
          message: 'Sensitive request details',
          errors: [{ reason: 'invalid' }],
        },
      },
    },
  }), 'INVALID_ARGUMENT');
  assert.equal(apiErrorCode({
    response: {
      data: {
        error: {
          message: 'Sensitive request details',
          errors: [{ reason: 'invalid' }],
        },
      },
    },
  }), 'invalid');
});

test('ignores numeric and unsafe error values', () => {
  assert.equal(apiErrorCode({
    code: 400,
    response: { data: { error: 'secret value' } },
  }), null);
});
