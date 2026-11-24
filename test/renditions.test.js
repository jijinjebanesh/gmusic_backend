import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  createRenditionService,
  parseByteRange,
  renditionId,
  sourceVersion,
} from '../src/renditions.js';

class MemoryCollection {
  documents = new Map();
  async findOne(query) {
    return [...this.documents.values()].find((document) =>
      Object.entries(query).every(([key, value]) => document[key] === value),
    ) || null;
  }
}

test('rendition source versions are stable and change when Drive versions change', () => {
  const first = sourceVersion({ md5Checksum: 'abc', modifiedTime: 'one', size: '10' });
  assert.equal(first, sourceVersion({ md5Checksum: 'abc', modifiedTime: 'two', size: '20' }));
  assert.notEqual(first, sourceVersion({ md5Checksum: 'def', modifiedTime: 'one', size: '10' }));
  assert.notEqual(
    sourceVersion({ modifiedTime: 'one', size: '10' }),
    sourceVersion({ modifiedTime: 'two', size: '10' }),
  );
});

test('single and suffix byte ranges are bounded and invalid ranges return 416 state', () => {
  assert.deepEqual(parseByteRange('bytes=4-8', 10), { start: 4, end: 8 });
  assert.deepEqual(parseByteRange('bytes=7-', 10), { start: 7, end: 9 });
  assert.deepEqual(parseByteRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseByteRange('bytes=0-99', 10), { start: 0, end: 9 });
  assert.deepEqual(parseByteRange('bytes=10-', 10), { invalid: true });
  assert.deepEqual(parseByteRange('bytes=0-1,4-5', 10), { invalid: true });
});

test('quality resolution serves only pre-generated Drive files scoped to owner and source version', async () => {
  const docs = new MemoryCollection();
  const collection = (name) => {
    assert.equal(name, 'quality_renditions');
    return docs;
  };
  const file = {
    id: 'source-id', name: 'song.flac', mimeType: 'audio/flac',
    size: '4096', modifiedTime: '2026-01-01T00:00:00Z', md5Checksum: 'source-checksum',
    canDownload: true,
  };
  const version = sourceVersion(file);
  const id = renditionId('shared', file.id, version, 'low');
  docs.documents.set(id, {
    _id: id, ownerId: 'shared', driveFileId: file.id, sourceVersion: version,
    quality: 'low', targetBitrateKbps: 64, actualBitrateKbps: 64,
    status: 'ready', renditionDriveFileId: 'variant-id', fileSize: 1000,
  });
  const service = createRenditionService({ collection, isMongoEnabled: () => true });
  const drive = {
    getFileMetadata: async () => file,
    openFile: async (fileId, range) => {
      assert.equal(fileId, 'variant-id');
      assert.equal(range, 'bytes=10-19');
      return { stream: Readable.from([Buffer.alloc(10)]) };
    },
  };

  const result = await service.prepare({
    ownerId: 'shared', track: { id: file.id }, drive, quality: 'low',
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.renditionDriveFileId, 'variant-id');
  assert.equal((await service.status(id, 'shared')).status, 'ready');
  assert.equal(await service.status(id, 'another-owner'), null);

  const head = await service.head({
    drive: { getFileMetadata: async () => ({ size: '1000', canDownload: true }) },
    renditionDriveFileId: 'variant-id', fileSize: 1000, range: 'bytes=10-19',
  });
  assert.equal(head.status, 206);
  assert.equal(head.headers['content-length'], '10');
  const opened = await service.open({
    drive, renditionDriveFileId: 'variant-id', fileSize: 1000, range: 'bytes=10-19',
  });
  assert.equal(opened.status, 206);
  assert.equal(opened.headers['content-length'], '10');
  assert.equal((await new Response(opened.body).arrayBuffer()).byteLength, 10);
  assert.equal((await service.head({
    drive: { getFileMetadata: async () => ({ size: '1000', canDownload: true }) },
    renditionDriveFileId: 'variant-id', fileSize: 1000, range: 'bytes=1000-',
  })).status, 416);

  const changed = await service.prepare({
    ownerId: 'shared', track: { id: file.id },
    drive: { getFileMetadata: async () => ({ ...file, md5Checksum: 'new-checksum' }) },
    quality: 'low',
  });
  assert.equal(changed.status, 'missing');
  assert.equal(changed.error, 'rendition_not_prepared');
});

test('missing and no-upscale variants have explicit non-ready states', async () => {
  const docs = new MemoryCollection();
  const collection = () => docs;
  const file = { id: 'source-id', md5Checksum: 'md5', size: '99', modifiedTime: 'now' };
  const version = sourceVersion(file);
  const id = renditionId('shared', file.id, version, 'high');
  docs.documents.set(id, {
    _id: id, ownerId: 'shared', driveFileId: file.id, sourceVersion: version,
    quality: 'high', status: 'skipped_no_upscale',
  });
  const service = createRenditionService({ collection, isMongoEnabled: () => true });
  const result = await service.prepare({
    ownerId: 'shared', track: { id: file.id },
    drive: { getFileMetadata: async () => file }, quality: 'high',
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'quality_unavailable_for_source');
});
