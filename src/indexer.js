import crypto from 'node:crypto';
import { parseStream } from 'music-metadata';
import { col, mongoEnabled } from './db.js';
import { isSupportedAudioFile, normalizeTrackMetadata } from './catalog.js';

const TRACKS_COLLECTION = 'drive_tracks';
const SHARED_OWNER_ID = 'shared';
const PAGE_SIZE = 8;
const MAX_METADATA_ALLOCATION = 4 * 1024 * 1024;
const METADATA_VERSION = 2;
const QUALITY_FOLDER_IDS = new Set([
  '1mOAB3J3GZq8pjEfuIRdH4UnTcMdJiPWp', // Low
  '1DVWzPZvJP4HKTih31UzgwuBGCMZhf-aV', // Medium
  '1iLjc9NoHF8JEiwKb79W1iNdItGfoap4y', // High
]);

function stateId(ownerId) {
  return ownerId === SHARED_OWNER_ID ? 'primary' : String(ownerId);
}

function trackId(ownerId, fileId) {
  return ownerId === SHARED_OWNER_ID ? fileId : `${ownerId}:${fileId}`;
}

function ownerScope(ownerId, filter = {}) {
  if (ownerId === SHARED_OWNER_ID) {
    return {
      ...filter,
      $or: [{ ownerId: SHARED_OWNER_ID }, { ownerId: { $exists: false } }],
    };
  }
  return { ...filter, ownerId };
}

function isGeneratedQualityRendition(file) {
  const properties = file.appProperties || {};
  if (properties.gmusicOriginalId && ['low', 'medium', 'high'].includes(properties.gmusicQuality)) return true;
  if ((file.parentIds || []).some((parentId) => QUALITY_FOLDER_IDS.has(parentId))) return true;
  return /^[A-Za-z0-9_-]{20,}_(64|128|256)k\.mp3$/i.test(file.name || '');
}

export async function extractAudioMetadata(stream, file) {
  return parseStream(
    stream,
    { mimeType: file.mimeType, size: Number(file.size) || undefined },
    {
      duration: false,
      skipCovers: true,
      skipPostHeaders: true,
      maxMemoryAllocation: MAX_METADATA_ALLOCATION,
    },
  );
}

function safeError(error) {
  return String(error?.code || error?.name || 'metadata_error').slice(0, 80);
}

function publicStatus(state) {
  if (!state) return {
    status: 'not_started',
    scannedCount: 0,
    indexedCount: 0,
    failedCount: 0,
  };
  return {
    status: state.status,
    mode: state.mode || null,
    scannedCount: state.scannedCount || 0,
    indexedCount: state.indexedCount || 0,
    failedCount: state.failedCount || 0,
    startedAt: state.startedAt || null,
    updatedAt: state.updatedAt || null,
    completedAt: state.completedAt || null,
    lastError: state.lastError || null,
  };
}

export async function getDriveIndexStatus({
  collection = col,
  isMongoEnabled = mongoEnabled,
  ownerId = SHARED_OWNER_ID,
} = {}) {
  if (!isMongoEnabled()) {
    const error = new Error('mongo_unavailable');
    error.status = 503;
    error.code = 'mongo_unavailable';
    throw error;
  }
  return publicStatus(await collection('drive_sync_state').findOne({ _id: stateId(ownerId) }));
}

async function writeState(state, changes, collection = col) {
  const updated = { ...state, ...changes, updatedAt: new Date() };
  const { _id, ...fields } = updated;
  await collection('drive_sync_state').updateOne(
    { _id: state._id || stateId(SHARED_OWNER_ID) },
    { $set: fields, $setOnInsert: { _id: state._id || stateId(SHARED_OWNER_ID) } },
    { upsert: true },
  );
  return updated;
}

async function beginFullScan(drive, previous = {}, collection = col, ownerId = SHARED_OWNER_ID) {
  const start = await drive.getStartPageToken();
  return writeState(
    { _id: stateId(ownerId), ...previous },
    {
      status: 'scanning',
      mode: 'full',
      pageToken: null,
      changeToken: start,
      scanId: crypto.randomUUID(),
      scannedCount: 0,
      indexedCount: 0,
      failedCount: 0,
      startedAt: new Date(),
      completedAt: null,
      lastError: null,
    },
    collection,
  );
}

async function indexFile(drive, file, scanId, collection = col, ownerId = SHARED_OWNER_ID) {
  const tracks = collection(TRACKS_COLLECTION);
  const documentId = trackId(ownerId, file.id);
  if (isGeneratedQualityRendition(file)) {
    await tracks.updateOne({ _id: documentId }, {
      $set: { availability: 'unavailable', isQualityRendition: true, updatedAt: new Date() },
    });
    return { supported: false, failed: false, qualityRendition: true };
  }
  if (!isSupportedAudioFile(file)) {
    return { supported: false, failed: false };
  }

  const existing = await tracks.findOne(
    { _id: documentId },
    { projection: { modifiedTime: 1, md5Checksum: 1, availability: 1, metadataStatus: 1, metadataVersion: 1, lyrics: 1 } },
  );
  const unchanged = existing && existing.metadataStatus !== 'partial' &&
    existing.metadataVersion === METADATA_VERSION &&
    existing.modifiedTime === (file.modifiedTime || null) &&
    existing.md5Checksum === (file.md5Checksum || null);
  if (unchanged) {
    await tracks.updateOne(
      { _id: documentId },
      {
        $set: {
          availability: 'available',
          lastSeenScanId: scanId || existing.lastSeenScanId,
        },
        $unset: { lyrics: '' },
      },
    );
    return { supported: true, failed: false, unchanged: true };
  }

  let metadataStatus = 'indexed';
  let tags = {};
  let format = {};
  let metadataError = null;
  try {
    const source = await drive.openFile(file.id);
    const parsed = await extractAudioMetadata(source.stream, file);
    tags = parsed.common;
    format = parsed.format;
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    metadataStatus = 'partial';
    metadataError = safeError(error);
    console.warn(`Drive metadata extraction failed: ${metadataError}`);
  }

  const metadata = normalizeTrackMetadata(file, tags, format);
  const now = new Date();
  const record = {
    ownerId,
    driveFileId: file.id,
    name: file.name,
    mimeType: file.mimeType || null,
    extension: file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '',
    size: Number(file.size) || null,
    modifiedTime: file.modifiedTime || null,
    createdTime: file.createdTime || null,
    md5Checksum: file.md5Checksum || null,
    parentIds: file.parentIds || [],
    owners: file.owners || [],
    artistKeys: metadata.artistEntries.map((artist) => artist.key),
    ...metadata,
    metadataVersion: METADATA_VERSION,
    metadataStatus,
    metadataError,
    availability: 'available',
    lastIndexedAt: now,
    lastSeenScanId: scanId || null,
    updatedAt: now,
  };
  await tracks.updateOne(
    { _id: documentId },
    { $set: record, $unset: { lyrics: '' } },
    { upsert: true },
  );
  return { supported: true, failed: metadataStatus !== 'indexed', unchanged: false };
}

function driveErrorCode(error) {
  return Number(error?.code || error?.response?.status || error?.status);
}

async function runFullScanPage(drive, state, collection = col, ownerId = SHARED_OWNER_ID) {
  const page = await drive.listAudioCandidates({
    pageToken: state.pageToken || undefined,
    pageSize: PAGE_SIZE,
  });
  let indexedCount = 0;
  let failedCount = 0;
  for (const file of page.files) {
    const result = await indexFile(drive, file, state.scanId, collection, ownerId);
    if (!result.supported) continue;
    indexedCount += result.unchanged ? 0 : 1;
    if (result.failed) failedCount += 1;
  }
  const scannedCount = (state.scannedCount || 0) + page.files.length;
  if (page.nextPageToken) {
    return writeState(state, {
      status: 'scanning',
      pageToken: page.nextPageToken,
      scannedCount,
      indexedCount: (state.indexedCount || 0) + indexedCount,
      failedCount: (state.failedCount || 0) + failedCount,
      lastError: failedCount ? 'some_metadata_unavailable' : null,
    }, collection);
  }

  await collection(TRACKS_COLLECTION).updateMany(
    ownerScope(ownerId, {
      availability: 'available',
      lastSeenScanId: { $ne: state.scanId },
    }),
    { $set: { availability: 'unavailable', updatedAt: new Date() } },
  );
  return writeState(state, {
    status: 'completed',
    pageToken: null,
    scannedCount,
    indexedCount: (state.indexedCount || 0) + indexedCount,
    failedCount: (state.failedCount || 0) + failedCount,
    completedAt: new Date(),
    mode: null,
    lastError: failedCount ? 'some_metadata_unavailable' : null,
  }, collection);
}

async function applyDriveChange(drive, change, collection = col, ownerId = SHARED_OWNER_ID) {
  const fileId = change.fileId || change.file?.id;
  if (!fileId) return { indexed: false, failed: false };
  if (change.removed || change.file?.trashed) {
    await collection(TRACKS_COLLECTION).updateOne(
      { _id: trackId(ownerId, fileId) },
      { $set: { availability: 'unavailable', updatedAt: new Date() } },
    );
    return { indexed: false, failed: false };
  }
  if (!change.file || !isSupportedAudioFile(change.file)) {
    await collection(TRACKS_COLLECTION).updateOne(
      { _id: trackId(ownerId, fileId) },
      { $set: { availability: 'unavailable', updatedAt: new Date() } },
    );
    return { indexed: false, failed: false };
  }
  const result = await indexFile(drive, change.file, undefined, collection, ownerId);
  return { indexed: result.supported && !result.unchanged, failed: result.failed };
}

async function runChangesPage(drive, state, collection = col, ownerId = SHARED_OWNER_ID) {
  try {
    const page = await drive.listChanges({
      pageToken: state.pageToken || state.changeToken,
      pageSize: PAGE_SIZE,
    });
    let indexedCount = 0;
    let failedCount = 0;
    for (const change of page.changes) {
      const result = await applyDriveChange(drive, change, collection, ownerId);
      if (result.indexed) indexedCount += 1;
      if (result.failed) failedCount += 1;
    }
    if (page.nextPageToken) {
      return writeState(state, {
        status: 'synchronizing',
        mode: 'changes',
        pageToken: page.nextPageToken,
        scannedCount: (state.scannedCount || 0) + page.changes.length,
        indexedCount: (state.indexedCount || 0) + indexedCount,
        failedCount: (state.failedCount || 0) + failedCount,
        lastError: failedCount ? 'some_metadata_unavailable' : null,
      }, collection);
    }
    return writeState(state, {
      status: 'completed',
      mode: null,
      pageToken: null,
      changeToken: page.newStartPageToken || state.changeToken,
      scannedCount: (state.scannedCount || 0) + page.changes.length,
      indexedCount: (state.indexedCount || 0) + indexedCount,
      failedCount: (state.failedCount || 0) + failedCount,
      completedAt: new Date(),
      lastError: failedCount ? 'some_metadata_unavailable' : null,
    }, collection);
  } catch (error) {
    if (driveErrorCode(error) === 410) {
      const full = await beginFullScan(drive, state, collection, ownerId);
      return runFullScanPage(drive, full, collection, ownerId);
    }
    throw error;
  }
}

async function retryPartialMetadata(drive, collection = col, ownerId = SHARED_OWNER_ID) {
  const files = await collection(TRACKS_COLLECTION)
    .find(ownerScope(ownerId, { availability: 'available', metadataStatus: 'partial' }))
    .sort({ updatedAt: 1, _id: 1 })
    .limit(PAGE_SIZE)
    .toArray();
  let indexedCount = 0;
  let failedCount = 0;
  for (const record of files) {
    const result = await indexFile(drive, {
      id: record.driveFileId,
      name: record.name,
      mimeType: record.mimeType,
      size: record.size,
      modifiedTime: record.modifiedTime,
      createdTime: record.createdTime,
      md5Checksum: record.md5Checksum,
      parentIds: record.parentIds,
      owners: record.owners,
    }, undefined, collection, ownerId);
    if (!result.unchanged) indexedCount += 1;
    if (result.failed) failedCount += 1;
  }
  return { indexedCount, failedCount };
}

export async function syncDriveBatch(drive, {
  collection = col,
  isMongoEnabled = mongoEnabled,
  ownerId = SHARED_OWNER_ID,
} = {}) {
  if (!isMongoEnabled()) {
    const error = new Error('mongo_unavailable');
    error.status = 503;
    error.code = 'mongo_unavailable';
    throw error;
  }

  try {
    let state = await collection('drive_sync_state').findOne({ _id: stateId(ownerId) });
    if (!state || state.status === 'not_started' || (!state.changeToken && state.status === 'completed')) {
      state = await beginFullScan(drive, state || {}, collection, ownerId);
    } else if (state.status === 'completed' || state.status === 'failed') {
      if (state.mode === 'full') {
        state = await writeState(state, { status: 'scanning', lastError: null }, collection);
      } else {
        state = await writeState(state, {
          status: 'synchronizing',
          mode: 'changes',
          pageToken: null,
          scannedCount: 0,
          indexedCount: 0,
          failedCount: 0,
          startedAt: new Date(),
          completedAt: null,
          lastError: null,
        }, collection);
      }
    }

    if (state.mode !== 'full') {
      const retries = await retryPartialMetadata(drive, collection, ownerId);
      if (retries.indexedCount || retries.failedCount) {
        state = await writeState(state, {
          indexedCount: (state.indexedCount || 0) + retries.indexedCount,
          failedCount: (state.failedCount || 0) + retries.failedCount,
          lastError: retries.failedCount ? 'some_metadata_unavailable' : null,
        }, collection);
      }
    }

    if (state.mode === 'full') {
      state = await runFullScanPage(drive, state, collection, ownerId);
    } else {
      state = await runChangesPage(drive, state, collection, ownerId);
    }
    return publicStatus(state);
  } catch (error) {
    const state = await collection('drive_sync_state').findOne({ _id: stateId(ownerId) });
    if (state) await writeState(state, { status: 'failed', lastError: safeError(error) }, collection);
    throw error;
  }
}
