import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  decodePageToken,
  encodePageToken,
  fileExtension,
  isSupportedAudioFile,
  normalizeKey,
  normalizeTrackMetadata,
} from '../src/catalog.js';
import { extractAudioMetadata } from '../src/indexer.js';

function id3Frame(id, value) {
  const data = Buffer.concat([Buffer.from([0]), Buffer.from(value)]);
  const header = Buffer.alloc(10);
  header.write(id, 0, 'ascii');
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

function id3Track() {
  const body = Buffer.concat([
    id3Frame('TIT2', 'Tagged title'),
    id3Frame('TPE1', 'Tagged artist'),
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
  return Buffer.concat([header, body, audio]);
}

test('audio detection uses supported extensions and rejects unrelated documents', () => {
  assert.equal(fileExtension('track.FLAC'), 'flac');
  assert.equal(isSupportedAudioFile({ name: 'track.FLAC', mimeType: 'application/octet-stream' }), true);
  assert.equal(isSupportedAudioFile({ name: 'notes.pdf', mimeType: 'application/pdf' }), false);
  assert.equal(isSupportedAudioFile({ name: 'notes.pdf', mimeType: 'audio/mpeg' }), false);
  assert.equal(isSupportedAudioFile({ name: 'document.mp3', mimeType: 'application/vnd.google-apps.document' }), false);
});

test('metadata fallback and normalization retain Drive filename and stable identities', () => {
  const file = { id: 'drive-id', name: 'Track Name - Artist One.flac' };
  const parsed = normalizeTrackMetadata(file, {
    title: ' Tagged Title ',
    artists: ['Artist One', 'Artist Two'],
    album: 'Album',
    albumartist: 'Album Artist',
    genre: ['Rock', 'Rock'],
    year: 2024,
    track: { no: 2, of: 12 },
    disk: { no: 1, of: 2 },
  }, { duration: 123.45, bitrate: 320000, sampleRate: 44100, bitsPerSample: 16, codec: 'FLAC' });

  assert.equal(parsed.title, 'Tagged Title');
  assert.deepEqual(parsed.artists, ['Artist One', 'Artist Two']);
  assert.deepEqual(parsed.genres, ['Rock']);
  assert.equal(parsed.albumArtist, 'Album Artist');
  assert.equal(parsed.trackNumber, 2);
  assert.equal(parsed.trackTotal, 12);
  assert.equal(parsed.discNumber, 1);
  assert.equal(parsed.discTotal, 2);
  assert.equal(parsed.durationMs, 123450);
  assert.equal(parsed.format, 'flac');
  assert.equal(parsed.albumId.length, 64);
  assert.notEqual(parsed.albumId, normalizeTrackMetadata(file, { album: 'Album', albumartist: 'Different Artist' }).albumId);
  assert.equal(normalizeTrackMetadata(file).title, 'Track Name');
  assert.deepEqual(normalizeTrackMetadata(file).artists, ['Artist One']);
  assert.equal(normalizeKey('  Björk & Sigur Rós  '), 'bjork sigur ros');
  assert.equal(normalizeKey('தமிழ் இசை'), 'தமிழ் இசை');
});

test('indexed metadata parser extracts ID3 tags from a bounded stream', async () => {
  const stream = new PassThrough({ highWaterMark: 4096 });
  const resultPromise = extractAudioMetadata(stream, {
    name: 'tagged.mp3',
    mimeType: 'audio/mpeg',
    size: id3Track().length,
  });
  stream.end(id3Track());
  const result = await resultPromise;
  assert.equal(result.common.title, 'Tagged title');
  assert.equal(result.common.artist, 'Tagged artist');
});

test('catalog page tokens round-trip offsets and reject malformed input', () => {
  assert.equal(decodePageToken(encodePageToken(250)), 250);
  assert.throws(() => decodePageToken('not-a-page'), { code: 'invalid_page_token' });
  assert.throws(() => decodePageToken(encodePageToken(Number.MAX_SAFE_INTEGER + 1)), { code: 'invalid_page_token' });
});
