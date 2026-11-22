import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { extractCoverArtFromStream } from '../src/drive.js';

function flacWithPicture(imageSize) {
  const mimeType = Buffer.from('image/jpeg');
  const image = Buffer.alloc(imageSize, 0x5a);
  image[0] = 0xff;
  image[1] = 0xd8;
  const picture = Buffer.alloc(42 + image.length);
  let offset = 0;
  picture.writeUInt32BE(3, offset); offset += 4;
  picture.writeUInt32BE(mimeType.length, offset); offset += 4;
  mimeType.copy(picture, offset); offset += mimeType.length;
  picture.writeUInt32BE(0, offset); offset += 4;
  offset += 16;
  picture.writeUInt32BE(image.length, offset); offset += 4;
  image.copy(picture, offset);

  const blockHeader = Buffer.alloc(4);
  blockHeader[0] = 0x86;
  blockHeader.writeUIntBE(picture.length, 1, 3);
  return { file: Buffer.concat([Buffer.from('fLaC'), blockHeader, picture]), image };
}

test('cover art extraction reads a FLAC picture block larger than one megabyte', async () => {
  const { file, image } = flacWithPicture(4_173_000);
  const art = await extractCoverArtFromStream(Readable.from([file]));

  assert.equal(art.contentType, 'image/jpeg');
  assert.equal(art.data.length, image.length);
  assert.deepEqual(art.data.subarray(0, 2), Buffer.from([0xff, 0xd8]));
  assert.deepEqual(art.data.subarray(-16), image.subarray(-16));
});
