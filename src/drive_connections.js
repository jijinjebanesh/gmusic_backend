import crypto from 'node:crypto';
import { google } from 'googleapis';
import { col, mongoEnabled } from './db.js';
import { createDriveSession } from './drive.js';
import { decryptTokens, encryptTokens } from './token_crypto.js';

const STATE_TTL_MS = 10 * 60_000;
const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

function serviceError(code, status = 503) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function oauthClient(credentials, redirectUri) {
  if (!credentials?.client_id || !credentials?.client_secret || !redirectUri) {
    throw serviceError('drive_oauth_not_configured');
  }
  return new google.auth.OAuth2(
    credentials.client_id,
    credentials.client_secret,
    redirectUri,
  );
}

export function createDriveConnectionService({
  credentials,
  redirectUri,
  encryptionKey,
  collection = col,
  isMongoEnabled = mongoEnabled,
  makeOAuthClient = oauthClient,
  makeDriveSession = createDriveSession,
  now = () => Date.now(),
}) {
  function requireMongo() {
    if (!isMongoEnabled()) throw serviceError('mongo_unavailable');
  }

  function requireCredentials() {
    if (!credentials?.client_id || !credentials?.client_secret || !redirectUri) {
      throw serviceError('drive_oauth_not_configured');
    }
  }

  async function saveTokens(userId, tokens, { newConnection = false } = {}) {
    const nowDate = new Date(now());
    const update = {
      $set: {
        encryptedTokens: encryptTokens(tokens, encryptionKey, `drive:${userId}`),
        updatedAt: nowDate,
      },
    };
    if (newConnection) update.$set.connectedAt = nowDate;
    else update.$setOnInsert = { connectedAt: nowDate };
    await collection('drive_connections').updateOne(
      { userId },
      update,
      { upsert: true },
    );
  }

  return {
    async startOAuth(userId) {
      requireMongo();
      requireCredentials();
      const state = crypto.randomBytes(32).toString('base64url');
      const codeVerifier = crypto.randomBytes(32).toString('base64url');
      const codeChallenge = crypto.createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');
      const createdAt = new Date(now());
      await collection('drive_oauth_states').insertOne({
        stateHash: crypto.createHash('sha256').update(state).digest('hex'),
        userId: String(userId),
        encryptedCodeVerifier: encryptTokens(
          { codeVerifier },
          encryptionKey,
          `oauth:${crypto.createHash('sha256').update(state).digest('hex')}`,
        ),
        createdAt,
        expiresAt: new Date(createdAt.getTime() + STATE_TTL_MS),
      });
      const oauth = makeOAuthClient(credentials, redirectUri);
      return {
        url: oauth.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          scope: DRIVE_SCOPES,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
        }),
      };
    },

    async completeOAuth(state, code) {
      requireMongo();
      requireCredentials();
      if (!state || !code) throw serviceError('oauth_callback_invalid', 400);
      const stateHash = crypto.createHash('sha256').update(String(state)).digest('hex');
      const result = await collection('drive_oauth_states').findOneAndDelete({
        stateHash,
        expiresAt: { $gt: new Date(now()) },
      });
      const stateDoc = result?.value ?? result;
      if (!stateDoc) throw serviceError('oauth_state_invalid_or_expired', 400);

      const oauth = makeOAuthClient(credentials, redirectUri);
      const tokenResult = await oauth.getToken({
        code: String(code),
        codeVerifier: decryptTokens(
          stateDoc.encryptedCodeVerifier,
          encryptionKey,
          `oauth:${stateHash}`,
        ).codeVerifier,
      });
      if (!tokenResult.tokens?.refresh_token && !tokenResult.tokens?.access_token) {
        throw serviceError('oauth_tokens_missing', 502);
      }
      const previous = await collection('drive_connections').findOne({ userId: stateDoc.userId });
      const previousTokens = previous?.encryptedTokens
        ? decryptTokens(previous.encryptedTokens, encryptionKey, `drive:${stateDoc.userId}`)
        : {};
      await saveTokens(
        stateDoc.userId,
        { ...previousTokens, ...tokenResult.tokens },
        { newConnection: true },
      );
      return { userId: stateDoc.userId };
    },

    async status(userId) {
      requireMongo();
      const connection = await collection('drive_connections').findOne(
        { userId: String(userId) },
        { projection: { connectedAt: 1, updatedAt: 1 } },
      );
      if (connection?.encryptedTokens) {
        decryptTokens(
          connection.encryptedTokens,
          encryptionKey,
          `drive:${userId}`,
        );
      }
      return {
        connected: Boolean(connection?.encryptedTokens),
        connectedAt: connection?.connectedAt || null,
        updatedAt: connection?.updatedAt || null,
      };
    },

    async getDrive(userId) {
      requireMongo();
      requireCredentials();
      const connection = await collection('drive_connections').findOne({
        userId: String(userId),
      });
      if (!connection?.encryptedTokens) {
        throw serviceError('google_drive_not_connected', 428);
      }
      const tokens = decryptTokens(connection.encryptedTokens, encryptionKey, `drive:${userId}`);
      return makeDriveSession({
        credentials,
        redirectUri,
        initialTokens: tokens,
        persistTokens: (nextTokens) => saveTokens(String(userId), nextTokens),
      });
    },

    async disconnect(userId) {
      requireMongo();
      const userKey = String(userId);
      const connection = await collection('drive_connections').findOne({ userId: userKey });
      if (!connection) return { disconnected: true };
      let revoked = false;
      try {
        const tokens = decryptTokens(
          connection.encryptedTokens,
          encryptionKey,
          `drive:${userKey}`,
        );
        requireCredentials();
        const oauth = makeOAuthClient(credentials, redirectUri);
        const revokeToken = tokens.refresh_token || tokens.access_token;
        if (revokeToken) {
          await oauth.revokeToken(revokeToken);
          revoked = true;
        }
      } catch (error) {
        console.warn(
          `Google Drive token revocation failed (${error.code || error.name || 'revoke_error'})`,
        );
      }
      await collection('drive_connections').deleteOne({ userId: userKey });
      await collection('drive_oauth_states').deleteMany({ userId: userKey });
      return { disconnected: true, revoked };
    },
  };
}
