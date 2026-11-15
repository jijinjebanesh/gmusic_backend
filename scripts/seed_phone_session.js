// Create a user session and write Android SharedPreferences for local testing.
// This script changes live account state; use only with an explicitly chosen DB.
import { MongoClient, ObjectId } from 'mongodb';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';

const { MONGO_URI, LOGIN_EMAIL, LOGIN_PASSWORD, PREFS_OUT } = process.env;
if (!MONGO_URI || !LOGIN_EMAIL || !LOGIN_PASSWORD || !PREFS_OUT) {
  throw new Error(
    'Set MONGO_URI, LOGIN_EMAIL, LOGIN_PASSWORD, and PREFS_OUT explicitly.',
  );
}

const email = LOGIN_EMAIL.trim().toLowerCase();
const displayName = (process.env.LOGIN_NAME || email.split('@')[0]).trim();
const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });

try {
  await client.connect();
  const db = client.db(process.env.MONGO_DB || 'Gmusic');
  const users = db.collection('Users');
  const existing = await users.findOne({ email });
  const userId = existing?._id ?? new ObjectId();
  const username = existing?.username ?? displayName;
  const now = new Date();

  await users.updateOne(
    { _id: userId },
    {
      $set: {
        email,
        username,
        displayName,
        passwordHash: await bcrypt.hash(LOGIN_PASSWORD, 10),
        role: 'user',
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );

  const token = crypto.randomBytes(32).toString('base64url');
  await db.collection('sessions').insertOne({
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    userId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + 30 * 86_400_000),
  });

  const userJson = JSON.stringify({
    id: String(userId),
    email,
    username,
    displayName,
    role: 'user',
  });
  const prefs = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="bridge_url">${process.env.BRIDGE_URL || 'http://127.0.0.1:43821'}</string>
    <string name="session_token">${token}</string>
    <string name="user_json">${userJson.replace(/'/g, '&apos;')}</string>
</map>
`;
  fs.writeFileSync(PREFS_OUT, prefs, { mode: 0o600, flag: 'wx' });
  console.log('Test session created; SharedPreferences written to the requested path.');
} finally {
  await client.close();
}
