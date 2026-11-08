// Try credential/authSource variants against Atlas and report what works.
import { MongoClient } from 'mongodb';

const hosts = 'fertioptimizer-shard-00-00.gjsww.mongodb.net:27017,fertioptimizer-shard-00-01.gjsww.mongodb.net:27017,fertioptimizer-shard-00-02.gjsww.mongodb.net:27017';
const passes = ['jijin2005', 'jijin2005.'];
const authSources = ['admin', 'Gmusic'];

for (const pass of passes) {
  for (const authSource of authSources) {
    const uri = `mongodb://jijin:${encodeURIComponent(pass)}@${hosts}/Gmusic?ssl=true&replicaSet=atlas-p5607u-shard-0&authSource=${authSource}&retryWrites=true&w=majority`;
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 6000 });
    try {
      await client.connect();
      const db = client.db('Gmusic');
      const count = await db.collection('Users').countDocuments();
      const sample = await db.collection('Users').findOne({});
      console.log(`OK | authSource=${authSource} | passLen=${pass.length} | users=${count}`);
      console.log('sample:', JSON.stringify(sample));
      await client.close();
      process.exit(0);
    } catch (err) {
      console.log(`FAIL | authSource=${authSource} | passLen=${pass.length} | ${err.message.slice(0, 60)}`);
      await client.close().catch(() => {});
    }
  }
}
