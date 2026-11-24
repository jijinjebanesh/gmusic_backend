import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { getDriveIndexStatus, syncDriveBatch } from '../src/indexer.js';

class MemoryCollection {
  constructor() {
    this.documents = new Map();
  }

  matches(document, filter) {
    return Object.entries(filter).every(([key, value]) => {
      if (key === '$and') return value.every((part) => this.matches(document, part));
      if (key === '$or') return value.some((part) => this.matches(document, part));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if ('$exists' in value) return (document[key] !== undefined) === value.$exists;
        if ('$ne' in value) return document[key] !== value.$ne;
      }
      return document[key] === value;
    });
  }

  async findOne(filter) {
    if (filter._id) return this.documents.get(filter._id) || null;
    return [...this.documents.values()].find((document) => this.matches(document, filter)) || null;
  }

  find(filter) {
    let rows = [...this.documents.values()].filter((document) => this.matches(document, filter));
    return {
      sort() { return this; },
      limit(count) { rows = rows.slice(0, count); return this; },
      toArray: async () => rows,
    };
  }

  async updateOne(filter, update) {
    const existing = this.documents.get(filter._id);
    const document = { ...(existing || {}), ...(update.$set || {}) };
    if (!existing) Object.assign(document, update.$setOnInsert || {});
    this.documents.set(filter._id, document);
    return { matchedCount: existing ? 1 : 0 };
  }

  async updateMany(filter, update) {
    for (const [id, document] of this.documents) {
      if (this.matches(document, filter)) {
        this.documents.set(id, { ...document, ...update.$set });
      }
    }
  }
}

class MemoryDatabase {
  constructor() {
    this.collections = new Map();
  }

  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new MemoryCollection());
    return this.collections.get(name);
  }
}

function trackStream(title, lyrics = '') {
  const text = Buffer.from(title);
  const data = Buffer.concat([Buffer.from([0]), text]);
  const frame = Buffer.alloc(10);
  frame.write('TIT2', 0, 'ascii');
  frame.writeUInt32BE(data.length, 4);
  const artist = Buffer.from([0, ...Buffer.from('Test artist')]);
  const artistFrame = Buffer.alloc(10);
  artistFrame.write('TPE1', 0, 'ascii');
  artistFrame.writeUInt32BE(artist.length, 4);
  const lyricsText = Buffer.from(lyrics);
  const lyricsData = Buffer.concat([
    Buffer.from([0]),
    Buffer.from('eng'),
    Buffer.from([0]),
    lyricsText,
  ]);
  const lyricsFrame = Buffer.alloc(10);
  lyricsFrame.write('USLT', 0, 'ascii');
  lyricsFrame.writeUInt32BE(lyricsData.length, 4);
  const body = Buffer.concat([
    frame,
    data,
    artistFrame,
    artist,
    ...(lyrics ? [lyricsFrame, lyricsData] : []),
  ]);
  const size = Buffer.from([
    (body.length >> 21) & 0x7f,
    (body.length >> 14) & 0x7f,
    (body.length >> 7) & 0x7f,
    body.length & 0x7f,
  ]);
  const header = Buffer.concat([Buffer.from('ID3\x03\x00\x00', 'binary'), size]);
  const audio = Buffer.alloc(1024 * 1024);
  audio.set([0xff, 0xfb, 0x90, 0x64]);
  const stream = new PassThrough({ highWaterMark: 4096 });
  stream.end(Buffer.concat([header, body, audio]));
  return stream;
}

test('indexing stores embedded lyrics and upgrades older metadata records', async () => {
  const database = new MemoryDatabase();
  const collection = (name) => database.collection(name);
  const file = {
    id: 'drive-lyrics',
    name: 'Lyrics.mp3',
    mimeType: 'audio/mpeg',
    size: '1048576',
    modifiedTime: '1',
    md5Checksum: 'lyrics',
  };
  const tracks = collection('drive_tracks');
  tracks.documents.set(file.id, {
    _id: file.id,
    modifiedTime: file.modifiedTime,
    md5Checksum: file.md5Checksum,
    metadataStatus: 'indexed',
    metadataVersion: 1,
  });
  let opened = false;
  const drive = {
    async getStartPageToken() { return 'change-1'; },
    async listAudioCandidates() { return { files: [file], nextPageToken: null }; },
    async openFile() {
      opened = true;
      return { stream: trackStream('Lyrics', 'First line\nSecond line') };
    },
  };

  await syncDriveBatch(drive, { collection, isMongoEnabled: () => true });
  const indexed = tracks.documents.get(file.id);
  assert.equal(opened, true);
  assert.equal(indexed.lyrics, 'First line\nSecond line');
  assert.equal(indexed.metadataVersion, 2);
});

test('generated quality MP3 files are excluded from the playable catalog', async () => {
  const database = new MemoryDatabase();
  const collection = (name) => database.collection(name);
  const variant = {
    id: 'rendition-drive-id',
    name: '1YJlj86lrs3NS_9gkvs4tJs2YyWBsMa-1_128k.mp3',
    mimeType: 'audio/mpeg',
    size: '1200',
    appProperties: {
      gmusicOriginalId: '1YJlj86lrs3NS_9gkvs4tJs2YyWBsMa-1',
      gmusicQuality: 'medium',
    },
  };
  const variantWithoutVisibleAppProperties = {
    id: 'second-rendition-drive-id',
    name: '1YJlj86lrs3NS_9gkvs4tJs2YyWBsMa-1_64k.mp3',
    mimeType: 'audio/mpeg',
    size: '800',
  };
  const variantLocatedInQualityFolder = {
    id: 'third-rendition-drive-id',
    name: '1 XvrA9Zf-uAl-GBQpmUpNPg4DfDg1 BOro-256k.mp3',
    mimeType: 'audio/mpeg',
    size: '900',
    parentIds: ['1iLjc9NoHF8JEiwKb79W1iNdItGfoap4y'],
  };
  const tracks = collection('drive_tracks');
  for (const file of [variant, variantWithoutVisibleAppProperties, variantLocatedInQualityFolder]) {
    tracks.documents.set(file.id, {
      _id: file.id,
      ownerId: 'shared',
      driveFileId: file.id,
      name: file.name,
      availability: 'available',
    });
  }
  const drive = {
    async getStartPageToken() { return 'change-1'; },
    async listAudioCandidates() { return { files: [variant, variantWithoutVisibleAppProperties, variantLocatedInQualityFolder], nextPageToken: null }; },
    async openFile() { throw new Error('quality variants must never be parsed as catalog tracks'); },
    async listChanges() { return { changes: [], newStartPageToken: 'change-2' }; },
  };

  await syncDriveBatch(drive, { collection, isMongoEnabled: () => true });
  const hidden = tracks.documents.get(variant.id);
  assert.equal(hidden.availability, 'unavailable');
  assert.equal(hidden.isQualityRendition, true);
  assert.equal(tracks.documents.get(variantWithoutVisibleAppProperties.id).availability, 'unavailable');
  assert.equal(tracks.documents.get(variantLocatedInQualityFolder.id).availability, 'unavailable');
});

test('full indexing resumes between pages, then incremental changes update and remove tracks', async () => {
  const database = new MemoryDatabase();
  const collection = (name) => database.collection(name);
  const firstFile = {
    id: 'drive-one', name: 'First.mp3', mimeType: 'audio/mpeg',
    size: '1048576', modifiedTime: '1', md5Checksum: 'one',
  };
  const secondFile = {
    id: 'drive-two', name: 'Second.mp3', mimeType: 'audio/mpeg',
    size: '1048576', modifiedTime: '1', md5Checksum: 'two',
  };
  let changes;
  let useUpdatedTitle = false;
  const drive = {
    authorized: true,
    async getStartPageToken() { return 'change-1'; },
    async listAudioCandidates({ pageToken }) {
      return pageToken
        ? { files: [], nextPageToken: null }
        : { files: [firstFile, secondFile], nextPageToken: 'full-page-2' };
    },
    async listChanges() { useUpdatedTitle = true; return { changes, newStartPageToken: 'change-2' }; },
    async openFile(id) {
      return { stream: trackStream(id === firstFile.id ? (useUpdatedTitle ? 'Updated title' : 'First') : 'Second title') };
    },
  };

  const firstBatch = await syncDriveBatch(drive, { collection, isMongoEnabled: () => true });
  assert.equal(firstBatch.status, 'scanning');
  assert.equal(firstBatch.scannedCount, 2);

  const completedScan = await syncDriveBatch(drive, { collection, isMongoEnabled: () => true });
  assert.equal(completedScan.status, 'completed');
  assert.equal(completedScan.indexedCount, 2);
  assert.equal(database.collection('drive_tracks').documents.get('drive-one').title, 'First');

  changes = [
    { fileId: 'drive-one', file: { ...firstFile, name: 'First.mp3', modifiedTime: '2', md5Checksum: 'updated' } },
    { fileId: 'drive-two', removed: true },
  ];
  const incremental = await syncDriveBatch(drive, { collection, isMongoEnabled: () => true });
  const tracks = database.collection('drive_tracks').documents;
  assert.equal(incremental.status, 'completed');
  assert.equal(incremental.indexedCount, 1);
  assert.equal(tracks.get('drive-one').title, 'Updated title');
  assert.equal(tracks.get('drive-two').availability, 'unavailable');
  assert.equal((await getDriveIndexStatus({ collection, isMongoEnabled: () => true })).status, 'completed');
});

test('expired Drive change token restarts a full scan with a fresh token', async () => {
  const database = new MemoryDatabase();
  const collection = (name) => database.collection(name);
  let tokenNumber = 0;
  const drive = {
    async getStartPageToken() { tokenNumber += 1; return `change-${tokenNumber}`; },
    async listAudioCandidates() { return { files: [], nextPageToken: null }; },
    async listChanges() {
      const error = new Error('expired');
      error.code = 410;
      throw error;
    },
  };

  await syncDriveBatch(drive, { collection, isMongoEnabled: () => true });
  const recovered = await syncDriveBatch(drive, {
    collection,
    isMongoEnabled: () => true,
  });
  assert.equal(tokenNumber, 2);
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.mode, null);
});

test('partial metadata extraction is retried during the next Drive sync', async () => {
  const database = new MemoryDatabase();
  const collection = (name) => database.collection(name);
  const file = {
    id: 'drive-retry',
    name: 'Retry.mp3',
    mimeType: 'audio/mpeg',
    size: '1048576',
    modifiedTime: '1',
    md5Checksum: 'retry',
  };
  let shouldFail = true;
  const drive = {
    async getStartPageToken() { return 'change-1'; },
    async listAudioCandidates() { return { files: [file], nextPageToken: null }; },
    async listChanges() { return { changes: [], newStartPageToken: 'change-2' }; },
    async openFile() {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('temporary stream failure');
      }
      return { stream: trackStream('Recovered title') };
    },
  };

  const initial = await syncDriveBatch(drive, {
    collection,
    isMongoEnabled: () => true,
  });
  assert.equal(initial.failedCount, 1);
  assert.equal(
    database.collection('drive_tracks').documents.get(file.id).metadataStatus,
    'partial',
  );

  await syncDriveBatch(drive, { collection, isMongoEnabled: () => true });
  const recovered = database.collection('drive_tracks').documents.get(file.id);
  assert.equal(recovered.metadataStatus, 'indexed');
  assert.equal(recovered.title, 'Recovered title');
});

test('per-user indexing keeps same Drive file IDs in isolated records and cursors', async () => {
  const database = new MemoryDatabase();
  const collection = (name) => database.collection(name);
  const file = {
    id: 'same-drive-id',
    name: 'Same.mp3',
    mimeType: 'audio/mpeg',
    size: '1048576',
    modifiedTime: '1',
    md5Checksum: 'same',
  };
  const makeDrive = (title) => ({
    async getStartPageToken() { return `changes-${title}`; },
    async listAudioCandidates() { return { files: [file], nextPageToken: null }; },
    async openFile() { return { stream: trackStream(title) }; },
  });

  await syncDriveBatch(makeDrive('Account A'), {
    collection,
    isMongoEnabled: () => true,
    ownerId: 'user-a',
  });
  await syncDriveBatch(makeDrive('Account B'), {
    collection,
    isMongoEnabled: () => true,
    ownerId: 'user-b',
  });

  const tracks = database.collection('drive_tracks').documents;
  assert.equal(tracks.get('user-a:same-drive-id').ownerId, 'user-a');
  assert.equal(tracks.get('user-a:same-drive-id').title, 'Account A');
  assert.equal(tracks.get('user-b:same-drive-id').ownerId, 'user-b');
  assert.equal(tracks.get('user-b:same-drive-id').title, 'Account B');
  assert.equal(
    (await getDriveIndexStatus({ collection, isMongoEnabled: () => true, ownerId: 'user-a' })).status,
    'completed',
  );
  assert.equal(
    (await getDriveIndexStatus({ collection, isMongoEnabled: () => true, ownerId: 'user-b' })).status,
    'completed',
  );
});
