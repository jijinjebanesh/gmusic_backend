import crypto from 'node:crypto';

function encryptionKey(value = process.env.GDRIVE_TOKEN_ENCRYPTION_KEY) {
  if (!value) {
    const error = new Error('drive_token_encryption_key_missing');
    error.status = 503;
    error.code = 'drive_token_encryption_key_missing';
    throw error;
  }
  const key = /^[a-f\d]{64}$/i.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');
  if (key.length !== 32) {
    const error = new Error('drive_token_encryption_key_invalid');
    error.status = 503;
    error.code = 'drive_token_encryption_key_invalid';
    throw error;
  }
  return key;
}

export function encryptTokens(tokens, keyValue, associatedData = '') {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(keyValue), iv);
  cipher.setAAD(Buffer.from(associatedData));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(tokens), 'utf8'),
    cipher.final(),
  ]);
  return {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptTokens(envelope, keyValue, associatedData = '') {
  if (envelope?.version !== 1 || !envelope.iv || !envelope.tag || !envelope.ciphertext) {
    const error = new Error('drive_token_envelope_invalid');
    error.status = 500;
    error.code = 'drive_token_envelope_invalid';
    throw error;
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(keyValue),
    Buffer.from(envelope.iv, 'base64'),
  );
  decipher.setAAD(Buffer.from(associatedData));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext);
}
