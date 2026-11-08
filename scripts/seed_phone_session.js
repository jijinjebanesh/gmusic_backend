// Creates (or resets) the user account for the phone, issues a fresh 30-day
// session, and writes the SharedPreferences XML that boots the phone app
// straight into the authenticated shell. Writes the prefs file to scratch.
import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';

const email = process.env.LOGIN_EMAIL || 'jijinjebanesh@gmail.com';
const password = process.env.LOGIN_PASSWORD || 'gmusic2026best';
const name = process.env.LOGIN_NAME || 'jijin';

const client = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
await client.connect();
const db = client.db(process.env.MONGO_DB || 'Gmusic');
const users = db.collection('Users');

// Insert-or-reset: password update keeps an existing account's email stable.
// Username is derived from the email local part and de-duplicated so two
// accounts can never collide on the unique index.
const hash = await bcrypt.hash(password, 10);
const now = new Date();
const existing = await users.findOne({ email });
const userId = existing?._id ?? new (await import('mongodb')).ObjectId();
let username = email.split('@')[0];
if (!existing) {
  for (let n = 1; await users.findOne({ username, _id: { $ne: userId } }); n++) {
    username = `${email.split('@')[0]}${n}`;
  }
}
const displayName = process.env.LOGIN_NAME || username;
await users.updateOne(
  { _id: userId },
  {
    $set: {
      email,
      username,
      displayName,
      passwordHash: hash,
      role: 'user',
      updatedAt: now,
    },
    $setOnInsert: { createdAt: now },
  },
  { upsert: true },
);

// Fresh session token, stored hashed
const token = crypto.randomBytes(32).toString('base64url');
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
await db.collection('sessions').deleteMany({ userId });
await db.collection('sessions').insertOne({
  tokenHash,
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
    <string name="bridge_url">http://127.0.0.1:43821</string>
    <string name="session_token">${token}</string>
    <string name="user_json">${userJson.replace(/'/g, "&apos;")}</string>
</map>
`;
const out = process.env.PREFS_OUT || 'C:/Users/jijin/AppData/Local/hermes/cache/scratch/FlutterSharedPreferences.xml';
fs.writeFileSync(out, prefs);
console.log(`account ready: ${email} (${existing ? 'reset' : 'created'})`);
console.log(`prefs written: ${out} (${prefs.length} bytes) — open the phone app to boot into the library`);
await client.close();
