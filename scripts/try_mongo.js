// Read-only connectivity probe. Configure MONGO_URI outside source control.
import { MongoClient } from 'mongodb';

if (!process.env.MONGO_URI) {
  throw new Error('Set MONGO_URI in the environment before running this probe.');
}

const client = new MongoClient(process.env.MONGO_URI, {
  serverSelectionTimeoutMS: 8000,
});

try {
  await client.connect();
  const db = client.db(process.env.MONGO_DB || 'Gmusic');
  const names = await db.listCollections({}, { nameOnly: true }).toArray();
  console.log(`MongoDB connection successful; ${names.length} collections found.`);
} catch (error) {
  console.error(`MongoDB connection failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
