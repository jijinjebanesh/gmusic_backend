// One-off inspection of the Gmusic Users collection (schema discovery).
import { MongoClient } from 'mongodb';

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
try {
  await client.connect();
  const db = client.db(process.env.MONGO_DB || 'Gmusic');
  const cols = await db.listCollections().toArray();
  console.log('collections:', cols.map((c) => c.name).join(', '));
  const users = db.collection('Users');
  const count = await users.countDocuments();
  console.log('Users count:', count);
  const sample = await users.findOne({});
  console.log('first doc:', JSON.stringify(sample, null, 2));
  const idx = await users.indexes().catch(() => []);
  console.log('indexes:', JSON.stringify(idx.map((i) => i.name)));
} catch (err) {
  console.error('FAILED:', err.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
