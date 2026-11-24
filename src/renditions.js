import crypto from 'node:crypto';
import { col, mongoEnabled } from './db.js';

export const RENDITION_QUALITIES = Object.freeze({ low: 64, medium: 128, high: 256 });

export function sourceVersion(file) {
  const source = file.md5Checksum
    ? `md5:${file.md5Checksum}`
    : `mtime:${file.modifiedTime || 'unknown'}:size:${file.size || 'unknown'}`;
  return crypto.createHash('sha256').update(source).digest('hex');
}

export function renditionId(ownerId, fileId, version, quality) {
  return crypto.createHash('sha256')
    .update(`${ownerId}\0${fileId}\0${version}\0${quality}`)
    .digest('hex');
}

function requireMongo(isMongoEnabled) {
  if (isMongoEnabled()) return;
  const error = new Error('rendition_catalog_unavailable');
  error.code = 'rendition_catalog_unavailable';
  error.status = 503;
  throw error;
}

function publicRendition(doc, id = doc?._id) {
  if (!doc) return null;
  const status = doc.status === 'skipped_no_upscale' ? 'failed' : doc.status;
  return {
    id,
    status,
    quality: doc.quality,
    targetBitrateKbps: doc.targetBitrateKbps,
    actualBitrateKbps: doc.actualBitrateKbps || null,
    durationMs: doc.durationMs || null,
    fileSize: doc.fileSize || null,
    trackId: doc.driveFileId,
    sourceVersion: doc.sourceVersion,
    ...(doc.renditionDriveFileId ? { renditionDriveFileId: doc.renditionDriveFileId } : {}),
    ...(doc.status === 'skipped_no_upscale'
      ? { error: 'quality_unavailable_for_source' }
      : doc.status === 'failed'
        ? { error: 'rendition_generation_failed' }
        : {}),
  };
}

export function parseByteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(size) || size <= 0) {
    return { invalid: true };
  }
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    return { invalid: true };
  }
  return { start, end: Math.min(end, size - 1) };
}

export function createRenditionService({
  collection = col,
  isMongoEnabled = mongoEnabled,
} = {}) {
  async function prepare({ ownerId, track, drive, quality }) {
    requireMongo(isMongoEnabled);
    if (!RENDITION_QUALITIES[quality]) {
      const error = new Error('invalid_quality');
      error.code = 'invalid_quality';
      error.status = 400;
      throw error;
    }
    const source = await drive.getFileMetadata(track.id);
    const version = sourceVersion(source);
    const id = renditionId(ownerId, track.id, version, quality);
    const doc = await collection('quality_renditions').findOne({
      _id: id,
      ownerId,
      driveFileId: track.id,
      sourceVersion: version,
      quality,
    });
    if (!doc) {
      return {
        id,
        status: 'missing',
        quality,
        targetBitrateKbps: RENDITION_QUALITIES[quality],
        trackId: track.id,
        sourceVersion: version,
        error: 'rendition_not_prepared',
      };
    }
    if (doc.status === 'ready' && !doc.renditionDriveFileId) {
      return { ...publicRendition(doc, id), status: 'failed', error: 'rendition_metadata_invalid' };
    }
    return publicRendition(doc, id);
  }

  async function status(jobId, ownerId) {
    requireMongo(isMongoEnabled);
    const doc = await collection('quality_renditions').findOne({ _id: jobId, ownerId });
    return doc ? publicRendition(doc, jobId) : null;
  }

  async function open({ drive, renditionDriveFileId, fileSize, range }) {
    const selected = parseByteRange(range, fileSize);
    if (selected?.invalid) {
      return { status: 416, headers: { 'content-range': `bytes */${fileSize}`, 'accept-ranges': 'bytes' } };
    }
    try {
      const stored = await drive.openFile(
        renditionDriveFileId,
        selected ? `bytes=${selected.start}-${selected.end}` : undefined,
      );
      const start = selected?.start ?? 0;
      const end = selected?.end ?? fileSize - 1;
      return {
        status: selected ? 206 : 200,
        body: stored.stream,
        headers: {
          'content-type': 'audio/mpeg',
          'content-length': String(end - start + 1),
          ...(selected ? { 'content-range': `bytes ${start}-${end}/${fileSize}` } : {}),
          'accept-ranges': 'bytes',
        },
      };
    } catch (error) {
      if (error.code === 404 || error.response?.status === 404) return null;
      throw error;
    }
  }

  async function head({ drive, renditionDriveFileId, fileSize, range }) {
    try {
      const file = await drive.getFileMetadata(renditionDriveFileId);
      if (!file.canDownload) return null;
      fileSize = Number(file.size) || fileSize;
    } catch (error) {
      if (error.code === 404 || error.response?.status === 404) return null;
      throw error;
    }
    const selected = parseByteRange(range, fileSize);
    if (selected?.invalid) {
      return { status: 416, headers: { 'content-range': `bytes */${fileSize}`, 'accept-ranges': 'bytes' } };
    }
    const start = selected?.start ?? 0;
    const end = selected?.end ?? fileSize - 1;
    return {
      status: selected ? 206 : 200,
      headers: {
        'content-type': 'audio/mpeg',
        'content-length': String(end - start + 1),
        ...(selected ? { 'content-range': `bytes ${start}-${end}/${fileSize}` } : {}),
        'accept-ranges': 'bytes',
      },
    };
  }

  return { prepare, status, open, head };
}
