// Drop sessions created with the old string-userId bug, and show the Users
// collection shape so the login code stays compatible with existing data.
import { MongoClient } from 'mongodb';

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
await client.connect();
const db = client.db(process.env.MONGO_DB || 'Gmusic');

const before = await db.collection('sessions').countDocuments();
const dropped = await db.collection('sessions').deleteMany({ userId: { $type: 'string' } });
console.log(`sessions: ${before} -> ${before - dropped.deletedCount} (dropped ${dropped.deletedCount} stale)`);

const users = db.collection('Users');
console.log('users:', await users.countDocuments());
const sample = await users.findOne({}, { sort: { _id: -1 } });
const fields = sample ? Object.keys(sample).join(',') : '(none)';
console.log('latest user fields:', fields);
console.log('latest user (redacted):', JSON.stringify({ ...sample, passwordHash: '[set]', _id: String(sample._id) }));
await client.close();
