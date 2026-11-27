import express from 'express';
import { ObjectId } from 'mongodb';
import { isDeepStrictEqual } from 'node:util';
import { col } from './db.js';
import { publishPlaybackEvent } from './playback_event_bus.js';

const DEVICE_ONLINE_MS = 12_000;
const COMMAND_TTL_MS = 60_000;
const PREWARM_TTL_MS = 60_000;
const COMMAND_RETENTION_MS = 24 * 60 * 60 * 1000;
const TRANSFER_TTL_MS = 30_000;
const HANDOFF_TTL_MS = 60_000;
const MAX_QUEUE_SIZE = 500;
const MAX_POSITION_MS = 86_400_000;
const PLATFORM_VALUES = new Set([
  'android',
  'ios',
  'linux',
  'macos',
  'web',
  'windows',
  'unknown',
]);
const COMMANDS = new Set([
  'next',
  'pause',
  'play',
  'playQueue',
  'previous',
  'queueAdd',
  'queueClear',
  'queuePlay',
  'queueRemove',
  'queueReorder',
  'repeat',
  'seek',
  'setQuality',
  'shuffle',
  'stop',
  'volume',
]);

function handoffPlaybackChanged(transfer, session) {
  if (!Array.isArray(transfer.trackIds)) {
    // Preserve compatibility with handoffs created before queue identity was
    // stored alongside the transfer.
    return (session.queueRevision || 0) !== transfer.queueRevision;
  }
  return !isDeepStrictEqual(session.trackIds || [], transfer.trackIds) ||
    (session.index || 0) !== (transfer.index || 0);
}

function apiError(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

function groupClaimExpired(device, time) {
  return Boolean(
    device?.groupSessionId &&
    device.groupSessionExpiresAt &&
    new Date(device.groupSessionExpiresAt).getTime() <= time.getTime(),
  );
}

function deviceInGroupSession(device, time) {
  return Boolean(device?.groupSessionId && !groupClaimExpired(device, time));
}

function commandDeadline(command) {
  return command.deadlineAt || command.expiresAt;
}

function commandDeadlineFilter(operator, time) {
  return {
    $or: [
      { deadlineAt: { [operator]: time } },
      {
        deadlineAt: { $exists: false },
        expiresAt: { [operator]: time },
      },
    ],
  };
}

function requirePersonalAccount(req, res) {
  if (req.ownerMode || !req.user?.id || req.user.id === 'owner') {
    res.status(403).json({ error: 'personal_account_required' });
    return false;
  }
  return true;
}

function deviceFrom(body) {
  const deviceId = String(body?.deviceId || '');
  const name = String(body?.name || '').trim();
  const platform = String(body?.platform || 'unknown');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(deviceId) || !name || name.length > 80 ||
      !PLATFORM_VALUES.has(platform)) {
    throw apiError(400, 'invalid_device');
  }
  const rawCapabilities = body?.capabilities;
  const capabilities = rawCapabilities && typeof rawCapabilities === 'object'
    ? Object.fromEntries(
      ['playback', 'pause', 'seek', 'volume', 'queue'].map((capability) => {
        if (typeof rawCapabilities[capability] !== 'boolean') {
          throw apiError(400, 'invalid_device');
        }
        return [capability, rawCapabilities[capability]];
      }),
    )
    : { playback: true, pause: true, seek: true, volume: true, queue: true };
  return {
    deviceId,
    name,
    platform,
    capabilities,
    visible: body?.visible !== false,
  };
}

function integer(value, max = MAX_POSITION_MS) {
  return Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function queueIds(value) {
  if (!Array.isArray(value) || value.length > MAX_QUEUE_SIZE ||
      value.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 256)) {
    throw apiError(400, 'invalid_queue');
  }
  return value;
}

function snapshotFrom(value) {
  if (value == null) return null;
  const trackIds = queueIds(value.trackIds);
  const index = value.index;
  const positionMs = value.positionMs;
  const durationMs = value.durationMs ?? 0;
  const volume = value.volume ?? 1;
  const playbackEpoch = value.playbackEpoch;
  const advancePlaybackEpoch = value.advancePlaybackEpoch ?? false;
  const quality = value.quality;
  const listenId = value.listenId;
  if (!Number.isSafeInteger(index) || index < 0 ||
      (trackIds.length === 0 ? index !== 0 : index >= trackIds.length) ||
      !integer(positionMs) || !integer(durationMs) ||
      typeof volume !== 'number' || !Number.isFinite(volume) ||
      volume < 0 || volume > 1 ||
      typeof value.playing !== 'boolean' ||
      typeof value.shuffle !== 'boolean' ||
      (playbackEpoch !== undefined &&
        (!Number.isSafeInteger(playbackEpoch) || playbackEpoch < 0)) ||
      typeof advancePlaybackEpoch !== 'boolean' ||
      (quality !== undefined &&
        !['low', 'medium', 'high', 'original'].includes(quality)) ||
      (listenId !== undefined &&
        (typeof listenId !== 'string' ||
         !/^[A-Za-z0-9_-]{16,128}$/.test(listenId))) ||
      !['none', 'one', 'all'].includes(value.repeat)) {
    throw apiError(400, 'invalid_playback_state');
  }
  return {
    trackIds,
    index,
    positionMs,
    durationMs,
    volume,
    playing: value.playing,
    shuffle: value.shuffle,
    repeat: value.repeat,
    playbackEpoch,
    advancePlaybackEpoch,
    title: String(value.title || '').slice(0, 200),
    artist: String(value.artist || '').slice(0, 200),
    ...(quality === undefined ? {} : { quality }),
    ...(listenId === undefined ? {} : { listenId }),
  };
}

function sessionFields(snapshot) {
  return {
    trackIds: snapshot.trackIds,
    index: snapshot.index,
    positionMs: snapshot.positionMs,
    durationMs: snapshot.durationMs,
    volume: snapshot.volume,
    playing: snapshot.playing,
    shuffle: snapshot.shuffle,
    repeat: snapshot.repeat,
    title: snapshot.title,
    artist: snapshot.artist,
    resumeOnFailover: false,
    ...(snapshot.quality === undefined ? {} : { quality: snapshot.quality }),
    ...(snapshot.listenId === undefined ? {} : { listenId: snapshot.listenId }),
  };
}

function activeSnapshotUnchanged(session, deviceId, snapshot, time) {
  if (
    session.activeDeviceId !== deviceId ||
    !isDeepStrictEqual(session.trackIds || [], snapshot.trackIds) ||
    session.index !== snapshot.index ||
    session.playing !== snapshot.playing ||
    session.shuffle !== snapshot.shuffle ||
    session.repeat !== snapshot.repeat ||
    session.volume !== snapshot.volume ||
    session.title !== snapshot.title ||
    session.artist !== snapshot.artist ||
    (snapshot.listenId !== undefined &&
      snapshot.listenId !== session.listenId) ||
    snapshot.advancePlaybackEpoch
  ) {
    return false;
  }
  if (
    snapshot.quality !== undefined &&
    snapshot.quality !== session.quality
  ) {
    return false;
  }

  const updatedAtMs = new Date(session.updatedAt || time).getTime();
  const elapsedMs = session.playing
    ? Math.max(0, time.getTime() - updatedAtMs)
    : 0;
  const estimatedPositionMs = Math.min(
    session.durationMs || MAX_POSITION_MS,
    Math.max(0, (session.positionMs || 0) + elapsedMs),
  );
  return Math.abs(snapshot.positionMs - estimatedPositionMs) < 500;
}

function publicSession(session, serverTimestamp = new Date()) {
  if (!session) return null;
  return {
    activeDeviceId: session.activeDeviceId || null,
    trackIds: session.trackIds || [],
    index: session.index || 0,
    positionMs: session.positionMs || 0,
    durationMs: session.durationMs || 0,
    volume: typeof session.volume === 'number' ? session.volume : 1,
    playing: session.playing === true,
    shuffle: session.shuffle === true,
    repeat: session.repeat || 'none',
    title: session.title || '',
    artist: session.artist || '',
    ...(session.quality === undefined ? {} : { quality: session.quality }),
    ...(session.listenId === undefined ? {} : { listenId: session.listenId }),
    queueRevision: session.queueRevision || 0,
    revision: session.revision || 0,
    stateVersion: session.revision || 0,
    playbackEpoch: session.playbackEpoch || 0,
    isPlaying: session.playing === true,
    transferId: session.lastTransferId || null,
    updatedAt: session.updatedAt || null,
    serverTimestamp: serverTimestamp.toISOString(),
  };
}

function publicDevice(device, time, activeDeviceId) {
  const type = ['android', 'ios'].includes(device.platform)
    ? 'phone'
    : ['windows', 'macos', 'linux', 'web'].includes(device.platform)
    ? 'computer'
    : 'unknown';
  return {
    deviceId: device.deviceId,
    name: device.name,
    platform: device.platform,
    type,
    isActive: device.deviceId === activeDeviceId,
    isRestricted: false,
    capabilities: device.capabilities || {
      playback: true,
      pause: true,
      seek: true,
      volume: true,
      queue: true,
    },
    visible: device.visible !== false,
    lastSeenAt: device.lastSeenAt,
    online: time.getTime() - new Date(device.lastSeenAt).getTime() <= DEVICE_ONLINE_MS,
  };
}

async function ensureSession(sessions, userId, now) {
  await sessions.updateOne(
    { _id: userId },
    {
      $setOnInsert: {
        userId,
        activeDeviceId: null,
        trackIds: [],
        index: 0,
        positionMs: 0,
        durationMs: 0,
        volume: 1,
        playing: false,
        shuffle: false,
        repeat: 'none',
        title: '',
        artist: '',
        queueRevision: 0,
        revision: 0,
        playbackEpoch: 0,
        lastTransferId: null,
        resumeOnFailover: false,
        createdAt: now,
        updatedAt: now,
      },
    },
    { upsert: true },
  );
  return sessions.findOne({ _id: userId });
}

async function updateSession(
  sessions,
  userId,
  fieldsOrMutator,
  {
    queueChanged = false,
    advancePlaybackEpoch = false,
    updatedAt = new Date(),
    expectedRevision = null,
  } = {},
) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await sessions.findOne({ _id: userId });
    if (!current) throw apiError(409, 'playback_session_missing');
    const currentRevision = current.revision || 0;
    const currentPlaybackEpoch = current.playbackEpoch || 0;
    const currentQueueRevision = current.queueRevision || 0;
    if (
      expectedRevision !== null &&
      currentRevision !== expectedRevision
    ) {
      throw apiError(409, 'playback_conflict');
    }
    // Re-compute fields from current state on each retry when a mutator
    // function is provided, so retries never apply stale caller-computed data.
    const fields = typeof fieldsOrMutator === 'function'
      ? fieldsOrMutator(current)
      : fieldsOrMutator;
    const epochChanged =
      advancePlaybackEpoch ||
      (Object.hasOwn(fields, 'activeDeviceId') &&
        fields.activeDeviceId !== current.activeDeviceId) ||
      (Object.hasOwn(fields, 'playing') &&
        fields.playing !== current.playing) ||
      (Object.hasOwn(fields, 'trackIds') &&
        !isDeepStrictEqual(fields.trackIds, current.trackIds || [])) ||
      (Object.hasOwn(fields, 'index') && fields.index !== current.index);
    const update = {
      $set: { ...fields, updatedAt },
      $inc: {
        revision: 1,
        ...(epochChanged ? { playbackEpoch: 1 } : {}),
        ...(queueChanged ? { queueRevision: 1 } : {}),
      },
    };
    const result = await sessions.updateOne(
      { _id: userId, revision: currentRevision },
      update,
    );
    if (result.matchedCount) {
      return {
        ...current,
        ...fields,
        updatedAt,
        revision: currentRevision + 1,
        playbackEpoch: currentPlaybackEpoch + (epochChanged ? 1 : 0),
        queueRevision: currentQueueRevision + (queueChanged ? 1 : 0),
      };
    }
  }
  throw apiError(409, 'playback_conflict');
}

async function pauseExpiredPlayback(collection, userId, session, time) {
  if (!session?.activeDeviceId || session.resumeOnFailover === true) {
    return session;
  }
  const active = await collection('playback_devices').findOne({
    userId,
    deviceId: session.activeDeviceId,
  });
  if (
    active &&
    time.getTime() - new Date(active.lastSeenAt).getTime() <= DEVICE_ONLINE_MS
  ) {
    return session;
  }
  try {
    return await updateSession(
      collection('playback_sessions'),
      userId,
      {
        ...(session.playing ? { playing: false } : {}),
        resumeOnFailover: true,
      },
      {
        updatedAt: time,
        expectedRevision: session.revision || 0,
      },
    );
  } catch (error) {
    if (error.code !== 'playback_conflict') throw error;
    return collection('playback_sessions').findOne({ _id: userId });
  }
}

export async function markPlaybackDeviceOffline({
  userId,
  deviceId,
  disconnectedAt,
  collection = col,
  now = () => new Date(),
}) {
  const marker = new Date(disconnectedAt);
  const devices = collection('playback_devices');
  const device = await devices.findOne({ userId, deviceId });
  if (
    !device?.disconnectedAt ||
    new Date(device.disconnectedAt).getTime() !== marker.getTime() ||
    new Date(device.lastSeenAt).getTime() > marker.getTime()
  ) {
    return false;
  }
  const result = await devices.updateOne(
    {
      userId,
      deviceId,
      disconnectedAt: device.disconnectedAt,
      lastSeenAt: device.lastSeenAt,
    },
    {
      $set: { lastSeenAt: new Date(marker.getTime() - DEVICE_ONLINE_MS - 1) },
      $unset: { disconnectedAt: '' },
    },
  );
  if (!result.matchedCount) return false;

  const time = now();
  const sessions = collection('playback_sessions');
  const session = await sessions.findOne({ _id: userId });
  await pauseExpiredPlayback(collection, userId, session, time);
  const updatedSession = await sessions.findOne({ _id: userId });
  publishPlaybackEvent(userId, {
    ...(updatedSession
      ? { session: publicSession(updatedSession, time) }
      : {}),
    serverTimestamp: time.toISOString(),
    requiresFullSync: true,
    deviceListChanged: true,
  });
  return true;
}

async function reserveFailoverCandidate({
  collection,
  userId,
  session,
  deviceId,
  time,
}) {
  const reservationExpiresAt = new Date(
    time.getTime() + TRANSFER_TTL_MS,
  );
  const currentExpiry = new Date(
    session.failoverCandidateExpiresAt || 0,
  ).getTime();
  if (
    session.failoverCandidateDeviceId &&
    currentExpiry > time.getTime()
  ) {
    return session;
  }
  try {
    return await updateSession(
      collection('playback_sessions'),
      userId,
      {
        failoverCandidateDeviceId: deviceId,
        failoverCandidateExpiresAt: reservationExpiresAt,
      },
      {
        updatedAt: time,
        expectedRevision: session.revision || 0,
      },
    );
  } catch (error) {
    if (error.code !== 'playback_conflict') throw error;
    return collection('playback_sessions').findOne({ _id: userId });
  }
}

async function releaseFailoverCandidate({
  collection,
  userId,
  deviceId,
  time,
}) {
  const sessions = collection('playback_sessions');
  const session = await sessions.findOne({ _id: userId });
  if (
    session?.resumeOnFailover !== true ||
    session.failoverCandidateDeviceId !== deviceId
  ) {
    return;
  }
  try {
    await updateSession(
      sessions,
      userId,
      {
        failoverCandidateDeviceId: null,
        failoverCandidateExpiresAt: null,
      },
      {
        updatedAt: time,
        expectedRevision: session.revision || 0,
      },
    );
  } catch (error) {
    if (error.code !== 'playback_conflict') throw error;
  }
}

function commandPayload(action, payload = {}) {
  if (!COMMANDS.has(action)) throw apiError(400, 'invalid_command');
  switch (action) {
    case 'seek':
      if (!integer(payload.positionMs)) throw apiError(400, 'invalid_command');
      return { positionMs: payload.positionMs };
    case 'shuffle':
      if (typeof payload.enabled !== 'boolean') throw apiError(400, 'invalid_command');
      return { enabled: payload.enabled };
    case 'repeat':
      if (!['none', 'one', 'all'].includes(payload.mode)) throw apiError(400, 'invalid_command');
      return { mode: payload.mode };
    case 'volume':
      if (typeof payload.volume !== 'number' || payload.volume < 0 || payload.volume > 1) {
        throw apiError(400, 'invalid_command');
      }
      return { volume: payload.volume };
    case 'setQuality':
      if (!['low', 'medium', 'high', 'original'].includes(payload.quality)) {
        throw apiError(400, 'invalid_command');
      }
      return { quality: payload.quality };
    case 'playQueue': {
      const trackIds = queueIds(payload.trackIds);
      if (!trackIds.length || !Number.isSafeInteger(payload.index) ||
          payload.index < 0 || payload.index >= trackIds.length) {
        throw apiError(400, 'invalid_command');
      }
      return {
        trackIds,
        index: payload.index,
        positionMs: payload.positionMs == null
          ? 0
          : integer(payload.positionMs) ? payload.positionMs : (() => {
            throw apiError(400, 'invalid_command');
          })(),
        shuffle: payload.shuffle === true,
        repeat: ['none', 'one', 'all'].includes(payload.repeat) ? payload.repeat : 'none',
      };
    }
    case 'queueAdd':
      if (typeof payload.trackId !== 'string' || payload.trackId.length === 0 ||
          payload.trackId.length > 256 || !['next', 'last'].includes(payload.placement)) {
        throw apiError(400, 'invalid_command');
      }
      return { trackId: payload.trackId, placement: payload.placement };
    case 'queueRemove':
      if (!Number.isSafeInteger(payload.index) || payload.index < 0 ||
          payload.index >= MAX_QUEUE_SIZE) throw apiError(400, 'invalid_command');
      return { index: payload.index };
    case 'queueReorder':
      if (!Number.isSafeInteger(payload.from) || !Number.isSafeInteger(payload.to) ||
          payload.from < 0 || payload.to < 0 ||
          payload.from >= MAX_QUEUE_SIZE || payload.to >= MAX_QUEUE_SIZE) {
        throw apiError(400, 'invalid_command');
      }
      return { from: payload.from, to: payload.to };
    case 'queuePlay':
      if (!Number.isSafeInteger(payload.index) || payload.index < 0 ||
          payload.index >= MAX_QUEUE_SIZE) throw apiError(400, 'invalid_command');
      return { index: payload.index };
    case 'queueClear':
      return {};
    default:
      return {};
  }
}

export async function pollPlayback({
  userId,
  body,
  collection = col,
  now = () => new Date(),
  exceptConnectionId = null,
}) {
  const { deviceId, name, platform, capabilities, visible } = deviceFrom(body);
  const snapshot = snapshotFrom(body?.snapshot);
  const claim = body?.claim === true;
  const time = now();
  const devices = collection('playback_devices');
  const sessions = collection('playback_sessions');
  const commands = collection('playback_commands');
  let existingDevice = await devices.findOne({ userId, deviceId });
  if (groupClaimExpired(existingDevice, time)) {
    await devices.updateOne(
      { userId, deviceId, groupSessionId: existingDevice.groupSessionId },
      { $unset: { groupSessionId: '', groupSessionExpiresAt: '' } },
    );
    existingDevice = { ...existingDevice, groupSessionId: null };
  }
  await devices.updateOne(
    { userId, deviceId },
    {
      $set: {
        userId,
        deviceId,
        platform,
        capabilities,
        visible,
        lastSeenAt: time,
      },
      $setOnInsert: { name, createdAt: time },
      $unset: { disconnectedAt: '' },
    },
    { upsert: true },
  );
  let session = await sessions.findOne({ _id: userId });
  const initialRevision = session?.revision || 0;
  session = await pauseExpiredPlayback(collection, userId, session, time);
  if (
    !existingDevice?.groupSessionId &&
    session?.resumeOnFailover === true &&
    session.trackIds?.length &&
    capabilities.playback !== false
  ) {
    session = await reserveFailoverCandidate({
      collection,
      userId,
      session,
      deviceId,
      time,
    });
    const reservationExpiresAt = new Date(
      session?.failoverCandidateExpiresAt || 0,
    ).getTime();
    if (
      session?.failoverCandidateDeviceId === deviceId &&
      reservationExpiresAt > time.getTime()
    ) {
      const pendingTransfer = await collection('playback_transfers').findOne({
        userId,
        sourceDeviceId: session.activeDeviceId,
        targetDeviceId: deviceId,
        status: 'pending',
        expiresAt: { $gt: time },
      });
      if (!pendingTransfer) {
        try {
          await createPlaybackHandoff({
            userId,
            deviceId,
            collection,
            now,
          });
        } catch (error) {
          await releaseFailoverCandidate({
            collection,
            userId,
            deviceId,
            time: now(),
          });
          throw error;
        }
      }
    }
  } else if (!existingDevice?.groupSessionId && claim) {
    if (!snapshot?.trackIds.length) {
      throw apiError(400, 'invalid_playback_claim');
    }
    await ensureSession(sessions, userId, time);
    const claimSession = await sessions.findOne({ _id: userId });
    const anotherDeviceOwnsPlayback = claimSession?.activeDeviceId != null &&
      claimSession.activeDeviceId !== deviceId &&
      claimSession.resumeOnFailover !== true;
    if (!anotherDeviceOwnsPlayback) {
      try {
        const claimFields = sessionFields(snapshot);
        claimFields.failoverCandidateDeviceId = null;
        claimFields.failoverCandidateExpiresAt = null;
        session = await updateSession(
          sessions,
          userId,
          { activeDeviceId: deviceId, ...claimFields },
          {
            queueChanged: true,
            advancePlaybackEpoch: true,
            updatedAt: time,
            expectedRevision: claimSession?.revision || 0,
          },
        );
      } catch (error) {
        if (error.code !== 'playback_conflict') throw error;
        session = await sessions.findOne({ _id: userId });
      }
    }
  } else if (
    !existingDevice?.groupSessionId &&
    snapshot &&
    session?.activeDeviceId === deviceId &&
    (snapshot.playbackEpoch === undefined ||
      snapshot.playbackEpoch === (session.playbackEpoch || 0))
  ) {
    const queueChanged = JSON.stringify(session.trackIds || []) !==
      JSON.stringify(snapshot.trackIds) || session.index !== snapshot.index;
    const snapshotFields = sessionFields(snapshot);
    if (snapshot.trackIds.length === 0) {
      snapshotFields.activeDeviceId = null;
      snapshotFields.resumeOnFailover = false;
    }
    if (!activeSnapshotUnchanged(session, deviceId, snapshot, time)) {
      session = await updateSession(
        sessions,
        userId,
        snapshotFields,
        {
          queueChanged,
          advancePlaybackEpoch: snapshot.advancePlaybackEpoch,
          updatedAt: time,
        },
      );
    }
  }
  session = await sessions.findOne({ _id: userId });
  const pending = existingDevice?.groupSessionId
    ? []
    : await commands
      .find({
        userId,
        deviceId,
        status: 'pending',
        ...commandDeadlineFilter('$gt', time),
      })
      .sort({ createdAt: 1 })
      .limit(20)
      .toArray();
  const activeDevices = await devices.find({ userId })
    .sort({ lastSeenAt: -1 })
    .limit(50)
    .toArray();
  const responseTime = now();
  const publicState = publicSession(session, responseTime);
  if (!existingDevice || (session?.revision || 0) !== initialRevision) {
    publishPlaybackEvent(userId, {
      exceptConnectionId,
      session: publicState,
      serverTimestamp: responseTime.toISOString(),
      ...(existingDevice ? {} : {
        requiresFullSync: true,
        deviceListChanged: true,
      }),
    });
  }
  return {
    serverRequestTimestamp: time.toISOString(),
    serverTimestamp: responseTime.toISOString(),
    session: publicState,
    devices: activeDevices
      .filter((device) => device.visible !== false || device.deviceId === deviceId)
      .map((device) => publicDevice(device, time, session?.activeDeviceId)),
    commands: pending.map((command) => ({
      id: String(command._id),
      action: command.action,
      payload: command.payload || {},
      createdAt: command.createdAt,
    })),
  };
}

export async function claimPlaybackDeviceForGroup({
  userId,
  deviceId,
  groupSessionId,
  groupSessionExpiresAt,
  collection = col,
  now = () => new Date(),
}) {
  const time = now();
  const devices = collection('playback_devices');
  const existingDevice = await devices.findOne({ userId, deviceId });
  if (
    existingDevice?.groupSessionId &&
    existingDevice.groupSessionId !== groupSessionId
  ) {
    let activeGroup = null;
    if (ObjectId.isValid(existingDevice.groupSessionId)) {
      activeGroup = await collection('group_listening_sessions').findOne({
        _id: new ObjectId(existingDevice.groupSessionId),
        status: { $ne: 'ended' },
        expiresAt: { $gt: time },
      });
    }
    const isActiveMember = activeGroup?.members?.some(
      (member) => member.userId === userId && member.deviceId === deviceId,
    );
    if (isActiveMember) throw apiError(409, 'device_in_group_session');
    await devices.updateOne(
      {
        userId,
        deviceId,
        groupSessionId: existingDevice.groupSessionId,
      },
      { $unset: { groupSessionId: '', groupSessionExpiresAt: '' } },
    );
  }
  const result = await devices.updateOne(
    {
      userId,
      deviceId,
      lastSeenAt: { $gte: new Date(time.getTime() - DEVICE_ONLINE_MS) },
      $or: [
        { groupSessionId: { $exists: false } },
        { groupSessionId: null },
        { groupSessionId },
        { groupSessionExpiresAt: { $lte: time } },
      ],
    },
    { $set: { groupSessionId, groupSessionExpiresAt } },
  );
  if (!result.matchedCount) throw apiError(409, 'device_unavailable');

  const pendingCommands = await collection('playback_commands')
    .find({ userId, deviceId, status: 'pending' })
    .toArray();
  await Promise.all(pendingCommands.map((command) =>
    collection('playback_commands').updateOne(
      { _id: command._id, userId, status: 'pending' },
      { $set: { status: 'cancelled', cancelledAt: time } },
    )));
  const pendingTransfers = await collection('playback_transfers')
    .find({ userId, targetDeviceId: deviceId, status: 'pending' })
    .toArray();
  await Promise.all(pendingTransfers.map((transfer) =>
    collection('playback_transfers').updateOne(
      { _id: transfer._id, userId, status: 'pending' },
      {
        $set: {
          status: 'failed',
          error: 'device_in_group_session',
          completedAt: time,
        },
      },
    )));

  const session = await collection('playback_sessions').findOne({ _id: userId });
  if (session?.activeDeviceId === deviceId) {
    await updateSession(
      collection('playback_sessions'),
      userId,
      { activeDeviceId: null, playing: false, resumeOnFailover: false },
      { updatedAt: time },
    );
  }
}

export async function releasePlaybackDeviceFromGroup({
  userId,
  deviceId,
  groupSessionId,
  collection = col,
}) {
  await collection('playback_devices').updateOne(
    { userId, deviceId, groupSessionId },
    { $unset: { groupSessionId: '', groupSessionExpiresAt: '' } },
  );
}

export async function createPlaybackCommand({
  userId,
  action,
  payload,
  idempotencyKey = null,
  expectedRevision = null,
  expectedQueueRevision = null,
  collection = col,
  now = () => new Date(),
}) {
  const commandAction = String(action || '');
  const commandPayloadValue = commandPayload(commandAction, payload);
  if (idempotencyKey !== null &&
      (typeof idempotencyKey !== 'string' ||
       !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey))) {
    throw apiError(400, 'invalid_command');
  }
  const commands = collection('playback_commands');
  if (idempotencyKey) {
    const existing = await commands.findOne({ userId, idempotencyKey });
    if (existing) {
      if (existing.action !== commandAction ||
          !isDeepStrictEqual(existing.payload, commandPayloadValue)) {
        throw apiError(409, 'idempotency_key_reused');
      }
      return {
        commandId: String(existing._id),
        deviceId: existing.deviceId,
        duplicate: true,
      };
    }
  }

  const session = await collection('playback_sessions').findOne({ _id: userId });
  if (!session?.activeDeviceId) throw apiError(409, 'no_active_device');
  if (expectedRevision !== null &&
      expectedRevision !== (session.revision || 0)) {
    throw apiError(409, 'stale_playback_state');
  }
  if (expectedQueueRevision !== null &&
      expectedQueueRevision !== (session.queueRevision || 0)) {
    throw apiError(409, 'stale_queue_state');
  }
  const queueLength = session.trackIds?.length || 0;
  if ((commandAction === 'queuePlay' || commandAction === 'queueRemove') &&
      commandPayloadValue.index >= queueLength) {
    throw apiError(400, 'invalid_command');
  }
  if (commandAction === 'queueReorder' &&
      (commandPayloadValue.from >= queueLength ||
       commandPayloadValue.to >= queueLength)) {
    throw apiError(400, 'invalid_command');
  }
  if (commandAction === 'queueAdd' && queueLength >= MAX_QUEUE_SIZE) {
    throw apiError(400, 'invalid_command');
  }
  const deviceId = session.activeDeviceId;
  const time = now();
  const device = await collection('playback_devices').findOne({
    userId,
    deviceId,
  });
  const deviceOnline =
    device &&
    time.getTime() - new Date(device.lastSeenAt).getTime() <= DEVICE_ONLINE_MS;
  if (!deviceOnline) {
    if (
      ['stop', 'queueClear'].includes(commandAction) &&
      !deviceInGroupSession(device, time)
    ) {
      const stoppedSession = await updateSession(
        collection('playback_sessions'),
        userId,
        {
          activeDeviceId: null,
          trackIds: [],
          index: 0,
          positionMs: 0,
          durationMs: 0,
          playing: false,
          resumeOnFailover: false,
          title: '',
          artist: '',
        },
        {
          queueChanged: true,
          advancePlaybackEpoch: true,
          updatedAt: time,
          expectedRevision: session.revision || 0,
        },
      );
      const inserted = await commands.insertOne({
        userId,
        deviceId,
        action: commandAction,
        payload: commandPayloadValue,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        status: 'ok',
        createdAt: time,
        completedAt: time,
      });
      publishPlaybackEvent(userId, {
        session: publicSession(stoppedSession, time),
        serverTimestamp: time.toISOString(),
      });
      return {
        commandId: String(inserted.insertedId),
        deviceId,
        duplicate: false,
      };
    }
    throw apiError(409, 'device_offline');
  }
  if (deviceInGroupSession(device, time)) {
    throw apiError(409, 'device_in_group_session');
  }
  const requiredCapability = commandAction === 'volume'
    ? 'volume'
    : commandAction === 'seek'
    ? 'seek'
    : commandAction === 'pause'
    ? 'pause'
    : commandAction.startsWith('queue')
    ? 'queue'
    : 'playback';
  if (device.capabilities?.[requiredCapability] === false) {
    throw apiError(409, 'capability_unavailable');
  }
  const createdAt = time;
  const deadlineAt = new Date(createdAt.getTime() + COMMAND_TTL_MS);
  let inserted;
  try {
    inserted = await commands.insertOne({
      userId,
      deviceId,
      action: commandAction,
      payload: commandPayloadValue,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      status: 'pending',
      createdAt,
      deadlineAt,
      expiresAt: new Date(deadlineAt.getTime() + COMMAND_RETENTION_MS),
    });
  } catch (error) {
    if (error.code !== 11000 || !idempotencyKey) throw error;
    const existing = await commands.findOne({ userId, idempotencyKey });
    if (!existing) throw error;
    if (existing.action !== commandAction ||
        !isDeepStrictEqual(existing.payload, commandPayloadValue)) {
      throw apiError(409, 'idempotency_key_reused');
    }
    return {
      commandId: String(existing._id),
      deviceId: existing.deviceId,
      duplicate: true,
    };
  }
  return {
    commandId: String(inserted.insertedId),
    deviceId,
    duplicate: false,
  };
}

export async function createPlaybackPrewarm({
  userId,
  requesterDeviceId,
  deviceId,
  prewarmId,
  collection = col,
  now = () => new Date(),
}) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(prewarmId || ''))) {
    throw apiError(400, 'invalid_prewarm');
  }
  const time = now();
  const [session, target] = await Promise.all([
    collection('playback_sessions').findOne({ _id: userId }),
    collection('playback_devices').findOne({
      userId,
      deviceId,
      lastSeenAt: { $gte: new Date(time.getTime() - DEVICE_ONLINE_MS) },
    }),
  ]);
  if (!session?.activeDeviceId || session.activeDeviceId !== requesterDeviceId ||
      !session.trackIds?.length) throw apiError(409, 'not_active_device');
  if (!target) throw apiError(409, 'device_offline');
  if (deviceInGroupSession(target, time)) throw apiError(409, 'device_in_group_session');
  if (target.capabilities?.playback === false) throw apiError(409, 'device_restricted');
  if (deviceId === requesterDeviceId) throw apiError(400, 'invalid_device');
  const expiresAt = new Date(time.getTime() + PREWARM_TTL_MS);
  const commands = collection('playback_commands');
  const existing = await commands.findOne({ userId, deviceId, action: 'prewarm', 'payload.prewarmId': prewarmId });
  if (existing) return { prewarmId, commandId: String(existing._id), status: existing.status };
  const inserted = await commands.insertOne({
    userId, deviceId, action: 'prewarm',
    payload: {
      prewarmId,
      requesterDeviceId,
      queueRevision: session.queueRevision || 0,
      trackId: session.trackIds[session.index],
      positionMs: session.positionMs || 0,
      positionTimestamp: session.updatedAt || time,
      playbackRate: 1,
      session: publicSession(session, time),
    },
    status: 'pending', createdAt: time, deadlineAt: expiresAt,
    expiresAt: new Date(expiresAt.getTime() + COMMAND_RETENTION_MS),
  });
  publishPlaybackEvent(userId, {
    deviceId,
    pendingCommandsChanged: true,
  });
  return { prewarmId, commandId: String(inserted.insertedId), status: 'pending' };
}

export async function updatePlaybackPrewarmStatus({
  userId,
  deviceId,
  prewarmId,
  status,
  error = null,
  collection = col,
  now = () => new Date(),
}) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(prewarmId || '')) ||
      !['preparing', 'ready', 'failed'].includes(status)) {
    throw apiError(400, 'invalid_prewarm_status');
  }
  const time = now();
  const commands = collection('playback_commands');
  const command = await commands.findOne({
    userId,
    deviceId,
    action: 'prewarm',
    status: 'pending',
    'payload.prewarmId': prewarmId,
    ...commandDeadlineFilter('$gt', time),
  });
  if (!command) {
    const expired = await commands.findOne({
      userId,
      deviceId,
      action: 'prewarm',
      status: 'pending',
      'payload.prewarmId': prewarmId,
    });
    if (expired && commandDeadline(expired) <= time) {
      await commands.updateOne(
        { _id: expired._id, userId, deviceId, status: 'pending' },
        {
          $set: {
            status: 'failed',
            error: 'command_timeout',
            acknowledgedAt: time,
          },
        },
      );
    }
    return { stale: true, prewarmId, deviceId };
  }
  const requesterDeviceId = command.payload.requesterDeviceId;
  await commands.updateOne(
    { _id: command._id, userId, deviceId, status: 'pending' },
    {
      $set: {
        'payload.prewarmStatus': status,
        'payload.prewarmUpdatedAt': time,
        ...(status === 'failed'
          ? { 'payload.prewarmError': String(error || 'prewarm_failed').slice(0, 120) }
          : {}),
      },
    },
  );
  return {
    stale: false,
    prewarmId,
    deviceId,
    requesterDeviceId,
    status,
    error: status === 'failed' ? String(error || 'prewarm_failed').slice(0, 120) : null,
  };
}

export async function cancelPlaybackPrewarm({
  userId,
  requesterDeviceId,
  deviceId,
  prewarmId,
  collection = col,
  now = () => new Date(),
}) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(prewarmId || ''))) {
    throw apiError(400, 'invalid_prewarm');
  }
  const time = now();
  const commands = collection('playback_commands');
  let command = await commands.findOne({
    userId,
    deviceId,
    action: 'prewarm',
    status: 'pending',
    'payload.prewarmId': prewarmId,
    'payload.requesterDeviceId': requesterDeviceId,
    ...commandDeadlineFilter('$gt', time),
  });
  if (!command) {
    command = await commands.findOne({
      userId,
      deviceId,
      action: 'prewarm',
      status: 'ok',
      'payload.prewarmId': prewarmId,
      'payload.requesterDeviceId': requesterDeviceId,
      'payload.prewarmStatus': 'ready',
      acknowledgedAt: {
        $gte: new Date(time.getTime() - PREWARM_TTL_MS),
      },
    });
  }
  if (!command) return { cancelled: false, stale: true, prewarmId, deviceId };
  const result = await commands.updateOne(
    {
      _id: command._id,
      userId,
      deviceId,
      status: command.status,
      'payload.prewarmId': prewarmId,
      'payload.requesterDeviceId': requesterDeviceId,
    },
    {
      $set: {
        status: 'failed',
        error: 'prewarm_cancelled',
        acknowledgedAt: time,
        'payload.prewarmStatus': 'cancelled',
        'payload.prewarmUpdatedAt': time,
      },
    },
  );
  return {
    cancelled: result.matchedCount === 1,
    stale: result.matchedCount !== 1,
    prewarmId,
    deviceId,
    requesterDeviceId,
  };
}

export async function createPlaybackHandoff({
  userId,
  deviceId,
  requesterDeviceId = null,
  prewarmId = null,
  positionMs: requestedPositionMs = null,
  positionTimestamp = null,
  playbackRate: requestedPlaybackRate = 1,
  queueRevision = null,
  scheduledStartAt = null,
  collection = col,
  now = () => new Date(),
}) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(deviceId || ''))) {
    throw apiError(400, 'invalid_device');
  }
  const time = now();
  const target = await collection('playback_devices').findOne({
    userId,
    deviceId,
    lastSeenAt: { $gte: new Date(time.getTime() - DEVICE_ONLINE_MS) },
  });
  if (!target) throw apiError(409, 'device_offline');
  if (deviceInGroupSession(target, time)) {
    throw apiError(409, 'device_in_group_session');
  }
  if (target.capabilities?.playback === false) {
    throw apiError(409, 'device_restricted');
  }
  const session = await collection('playback_sessions').findOne({ _id: userId });
  if (!session?.activeDeviceId || !session.trackIds?.length) {
    throw apiError(409, 'no_active_playback');
  }
  let activeSession = session;
  if (activeSession.resumeOnFailover === true) {
    const candidateId = activeSession.failoverCandidateDeviceId;
    const candidateExpiryMs = new Date(
      activeSession.failoverCandidateExpiresAt || 0,
    ).getTime();
    const otherActiveReservation =
      candidateId &&
      candidateId !== deviceId &&
      candidateId !== requesterDeviceId &&
      candidateExpiryMs > time.getTime();
    if (otherActiveReservation) {
      const candidateOnline = await collection('playback_devices').findOne({
        userId,
        deviceId: candidateId,
        lastSeenAt: { $gte: new Date(time.getTime() - DEVICE_ONLINE_MS) },
      });
      if (candidateOnline) {
        throw apiError(409, 'failover_claim_lost');
      }
    }
    try {
      activeSession = await updateSession(
        collection('playback_sessions'),
        userId,
        {
          failoverCandidateDeviceId: deviceId,
          failoverCandidateExpiresAt: new Date(
            time.getTime() + TRANSFER_TTL_MS,
          ),
        },
        {
          updatedAt: time,
          expectedRevision: activeSession.revision || 0,
        },
      );
    } catch (error) {
      if (error.code !== 'playback_conflict') throw error;
      throw apiError(409, 'failover_claim_lost');
    }
  }
  const requesterIsActiveOwner = requesterDeviceId === session.activeDeviceId;
  const currentQueueRevision = session.queueRevision || 0;
  if (
    requesterIsActiveOwner &&
    queueRevision !== null &&
    queueRevision !== currentQueueRevision
  ) {
    throw apiError(409, 'playback_changed');
  }
  if (session.activeDeviceId === deviceId) {
    return {
      transferId: null,
      status: 'completed',
      session: publicSession(session, time),
    };
  }
  let acceptedPrewarmId = null;
  if (typeof prewarmId === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(prewarmId)) {
    const prepared = await collection('playback_commands').findOne({
      userId,
      deviceId,
      action: 'prewarm',
      'payload.prewarmId': prewarmId,
      'payload.queueRevision': session.queueRevision || 0,
      $or: [
        {
          status: 'ok',
          acknowledgedAt: {
            $gte: new Date(time.getTime() - PREWARM_TTL_MS),
          },
        },
        { status: 'pending', 'payload.prewarmStatus': 'ready' },
      ],
    });
    if (prepared &&
        prepared.payload.session?.trackIds?.[prepared.payload.session.index] ===
          session.trackIds[session.index]) {
      acceptedPrewarmId = prewarmId;
    }
  }
  const transferId = new ObjectId();
  const expiresAt = new Date(time.getTime() + HANDOFF_TTL_MS);
  const resumePlayback =
    session.playing === true || session.resumeOnFailover === true;
  const playbackRate = requesterIsActiveOwner &&
      Number.isFinite(requestedPlaybackRate) &&
      requestedPlaybackRate >= 0.25 && requestedPlaybackRate <= 4
    ? requestedPlaybackRate
    : 1;
  const requestedTimestampMs = requesterIsActiveOwner
    ? Date.parse(positionTimestamp || '')
    : Number.NaN;
  const sourceTimestampMs = Number.isFinite(requestedTimestampMs)
    ? requestedTimestampMs
    : new Date(session.updatedAt || time).getTime();
  const sourceAgeMs = Math.min(
    10_000,
    Math.max(0, time.getTime() - sourceTimestampMs),
  );
  const canUseRequestPosition = Number.isInteger(requestedPositionMs) &&
    requestedPositionMs >= 0 &&
    queueRevision === currentQueueRevision &&
    Number.isFinite(requestedTimestampMs) &&
    time.getTime() - requestedTimestampMs <= 10_000;
  const anchorPositionMs = canUseRequestPosition
    ? requestedPositionMs
    : Math.max(0, session.positionMs || 0);
  const anchorAgeMs = canUseRequestPosition
    ? sourceAgeMs
    : Math.min(
        10_000,
        Math.max(0, time.getTime() - new Date(session.updatedAt || time).getTime()),
      );
  const commitPositionMs = Math.min(
    session.durationMs || MAX_POSITION_MS,
    Math.max(
      0,
      Math.round(
        anchorPositionMs +
          (session.playing ? anchorAgeMs * playbackRate : 0),
      ),
    ),
  );
  const requestedStartMs = Date.parse(scheduledStartAt || '');
  const startTime = new Date(
    Number.isFinite(requestedStartMs) &&
        requestedStartMs >= time.getTime() - 100 &&
        requestedStartMs <= time.getTime() + 2_000
      ? requestedStartMs
      : time.getTime() + 350,
  );
  const transfer = {
    _id: transferId,
    userId,
    sourceDeviceId: session.activeDeviceId,
    targetDeviceId: deviceId,
    queueRevision: currentQueueRevision,
    positionMs: commitPositionMs,
    positionTimestamp: time,
    playbackRate,
    scheduledStartAt: startTime,
    prewarmId: acceptedPrewarmId,
    trackIds: [...(session.trackIds || [])],
    index: session.index || 0,
    resumePlayback,
    phase: 'preparing_target',
    status: 'pending',
    createdAt: time,
    expiresAt,
  };
  await collection('playback_transfers').insertOne(transfer);
  await collection('playback_commands').insertOne({
    userId,
    deviceId,
    action: 'handoff',
    payload: {
      transferId: String(transferId),
      sourceDeviceId: transfer.sourceDeviceId,
      prewarmId: acceptedPrewarmId,
      destinationDeviceId: deviceId,
      positionMs: commitPositionMs,
      positionTimestamp: time,
      playbackRate,
      queueRevision: currentQueueRevision,
      scheduledStartAt: startTime,
      session: publicSession({
        ...session,
        positionMs: commitPositionMs,
        playing: resumePlayback,
        updatedAt: time,
      }, time),
    },
    status: 'pending',
    createdAt: time,
    deadlineAt: expiresAt,
    expiresAt: new Date(expiresAt.getTime() + COMMAND_RETENTION_MS),
  });
  publishPlaybackEvent(userId, {
    deviceId,
    pendingCommandsChanged: true,
  });
  return { transferId: String(transferId), status: 'pending' };
}

export async function acknowledgePlaybackCommand({
  userId,
  commandId,
  deviceId,
  status,
  error: commandError,
  snapshot: rawSnapshot = null,
  collection = col,
  now = () => new Date(),
}) {
  if (!ObjectId.isValid(commandId) || !['ok', 'failed'].includes(status)) {
    throw apiError(400, 'invalid_acknowledgment');
  }
  const snapshot = status === 'ok' ? snapshotFrom(rawSnapshot) : null;
  const acknowledgedAt = now();
  const commands = collection('playback_commands');
  const commandFilter = {
    _id: new ObjectId(commandId),
    userId,
    deviceId,
  };
  const command = await commands.findOne(commandFilter);
  if (!command) throw apiError(404, 'command_not_found');
  const acknowledgmentError = status === 'failed'
    ? String(commandError || 'command_failed').slice(0, 120)
    : null;
  const isSameAcknowledgment = (saved) =>
    saved?.status === status &&
    (saved.error || null) === acknowledgmentError;
  const completedResult = async (saved) => {
    let transferStatus = null;
    let transferError = null;
    const transferId = saved.action === 'handoff'
      ? saved.payload.transferId
      : saved.action === 'pause'
        ? saved.payload.handoffTransferId
        : null;
    if (typeof transferId === 'string' && ObjectId.isValid(transferId)) {
      const transfer = await collection('playback_transfers').findOne({
        _id: new ObjectId(transferId),
        userId,
      });
      transferStatus = transfer?.status || null;
      transferError = transfer?.error || null;
    }
    return {
      ok: true,
      commandId: String(saved._id),
      status: saved.status,
      error: saved.error || null,
      transferId: transferId ? String(transferId) : null,
      transferStatus,
      transferError,
      ...(saved.action === 'prewarm'
        ? {
            prewarmId: saved.payload.prewarmId,
            requesterDeviceId: saved.payload.requesterDeviceId,
          }
        : {}),
    };
  };
  if (command.status !== 'pending') {
    if (isSameAcknowledgment(command)) return completedResult(command);
    throw apiError(409, 'command_not_pending');
  }
  if (commandDeadline(command) <= acknowledgedAt) {
    await commands.updateOne(
      { ...commandFilter, status: 'pending' },
      {
        $set: {
          status: 'failed',
          error: 'command_timeout',
          acknowledgedAt,
        },
      },
    );
    throw apiError(409, 'command_expired');
  }
  const result = await commands.updateOne(
    {
      ...commandFilter,
      status: 'pending',
      ...commandDeadlineFilter('$gt', acknowledgedAt),
    },
    {
      $set: {
        status,
        acknowledgedAt,
        error: acknowledgmentError,
      },
    },
  );
  if (!result.matchedCount) {
    const saved = await commands.findOne(commandFilter);
    if (isSameAcknowledgment(saved)) return completedResult(saved);
    if (!saved) throw apiError(404, 'command_not_found');
    if (saved.status === 'pending' && commandDeadline(saved) <= acknowledgedAt) {
      await commands.updateOne(
        { ...commandFilter, status: 'pending' },
        {
          $set: {
            status: 'failed',
            error: 'command_timeout',
            acknowledgedAt,
          },
        },
      );
      throw apiError(409, 'command_expired');
    }
    throw apiError(409, 'command_not_pending');
  }

  if (snapshot && command.action !== 'handoff') {
    const currentSession = await collection('playback_sessions').findOne({
      _id: userId,
    });
    if (
      currentSession?.activeDeviceId === deviceId &&
      (snapshot.playbackEpoch === undefined ||
        snapshot.playbackEpoch === (currentSession.playbackEpoch || 0))
    ) {
      const fields = sessionFields(snapshot);
      if (snapshot.trackIds.length === 0) {
        fields.activeDeviceId = null;
        fields.resumeOnFailover = false;
      }
      const queueChanged =
        JSON.stringify(currentSession.trackIds || []) !==
          JSON.stringify(snapshot.trackIds) ||
        currentSession.index !== snapshot.index;
      try {
        await updateSession(
          collection('playback_sessions'),
          userId,
          fields,
          {
            queueChanged,
            advancePlaybackEpoch: snapshot.advancePlaybackEpoch,
            updatedAt: acknowledgedAt,
            expectedRevision: currentSession.revision || 0,
          },
        );
      } catch (error) {
        if (error.code !== 'playback_conflict') throw error;
      }
    }
  }

  let transferStatus = null;
  let transferError = null;
  if (command.action === 'handoff') {
    const transferId = new ObjectId(command.payload.transferId);
    const transfers = collection('playback_transfers');
    const transfer = await transfers.findOne({
      _id: transferId,
      userId,
      targetDeviceId: deviceId,
      status: 'pending',
    });
    if (transfer) {
      transferError = status === 'failed'
        ? String(commandError || 'target_rejected').slice(0, 120)
        : null;
      if (!transferError) {
        const currentSession = await collection('playback_sessions').findOne({
          _id: userId,
        });
        const target = await collection('playback_devices').findOne({
          userId,
          deviceId,
          lastSeenAt: {
            $gte: new Date(now().getTime() - DEVICE_ONLINE_MS),
          },
        });
        const source = await collection('playback_devices').findOne({
          userId,
          deviceId: transfer.sourceDeviceId,
          lastSeenAt: {
            $gte: new Date(now().getTime() - DEVICE_ONLINE_MS),
          },
        });
        if (!target) transferError = 'device_offline';
        else if (
          currentSession?.resumeOnFailover === true &&
          currentSession.failoverCandidateDeviceId &&
          currentSession.failoverCandidateDeviceId !== transfer.targetDeviceId &&
          new Date(currentSession.failoverCandidateExpiresAt || 0).getTime() >
            acknowledgedAt.getTime()
        ) {
          transferError = 'failover_claim_lost';
        } else if (
          currentSession?.activeDeviceId !== transfer.sourceDeviceId ||
          handoffPlaybackChanged(transfer, currentSession)
        ) {
          transferError = 'playback_changed';
        } else if (deviceInGroupSession(target, acknowledgedAt)) {
          transferError = 'device_in_group_session';
        } else if (!source) {
          try {
            await updateSession(
              collection('playback_sessions'),
              userId,
              {
                activeDeviceId: transfer.targetDeviceId,
                lastTransferId: String(transfer._id),
                positionMs: transfer.positionMs,
                playing: transfer.resumePlayback,
                resumeOnFailover: false,
                failoverCandidateDeviceId: null,
                failoverCandidateExpiresAt: null,
              },
              {
                updatedAt: now(),
                expectedRevision: currentSession.revision || 0,
              },
            );
            const claimedTarget = await collection('playback_devices')
              .findOne({ userId, deviceId });
            if (deviceInGroupSession(claimedTarget, now())) {
              const sessionAfterClaim = await collection('playback_sessions')
                .findOne({ _id: userId });
              if (sessionAfterClaim?.activeDeviceId === deviceId) {
                await updateSession(
                  collection('playback_sessions'),
                  userId,
                  { activeDeviceId: null, playing: false },
                  { updatedAt: now() },
                );
              }
              transferError = 'device_in_group_session';
            }
          } catch (updateError) {
            if (updateError.code !== 'playback_conflict') throw updateError;
            transferError = 'playback_changed';
          }
          if (!transferError) {
            transferStatus = 'completed';
            await transfers.updateOne(
              { _id: transferId, userId, status: 'pending' },
              { $set: { status: transferStatus, completedAt: now() } },
            );
          }
        } else {
          const pauseCommandId = new ObjectId();
          const pauseCreatedAt = now();
          await collection('playback_commands').insertOne({
            _id: pauseCommandId,
            userId,
            deviceId: transfer.sourceDeviceId,
            action: 'pause',
            payload: { handoffTransferId: String(transferId) },
            status: 'pending',
            createdAt: pauseCreatedAt,
            deadlineAt: transfer.expiresAt,
            expiresAt: new Date(
              transfer.expiresAt.getTime() + COMMAND_RETENTION_MS,
            ),
          });
          await transfers.updateOne(
            { _id: transferId, userId, status: 'pending' },
            {
              $set: {
                phase: 'pausing_source',
                sourcePauseCommandId: String(pauseCommandId),
              },
            },
          );
          publishPlaybackEvent(userId, {
            deviceId: transfer.sourceDeviceId,
            pendingCommandsChanged: true,
          });
          transferStatus = 'pending';
        }
      }
      if (transferError) {
        transferStatus = 'failed';
        await transfers.updateOne(
          { _id: transferId, userId, status: 'pending' },
          {
            $set: {
              status: transferStatus,
              error: transferError,
              completedAt: now(),
            },
          },
        );
        await releaseFailoverCandidate({
          collection,
          userId,
          deviceId: transfer.targetDeviceId,
          time: now(),
        });
      }
    }
  } else if (
    command.action === 'pause' &&
    typeof command.payload.handoffTransferId === 'string'
  ) {
    const transferId = command.payload.handoffTransferId;
    if (ObjectId.isValid(transferId)) {
      const transfers = collection('playback_transfers');
      const transfer = await transfers.findOne({
        _id: new ObjectId(transferId),
        userId,
        sourceDeviceId: deviceId,
        status: 'pending',
        phase: 'pausing_source',
      });
      if (transfer) {
        transferError = status === 'failed'
          ? String(commandError || 'source_pause_failed').slice(0, 120)
          : null;
        if (!transferError) {
          const currentSession = await collection('playback_sessions').findOne({
            _id: userId,
          });
          const target = await collection('playback_devices').findOne({
            userId,
            deviceId: transfer.targetDeviceId,
            lastSeenAt: {
              $gte: new Date(now().getTime() - DEVICE_ONLINE_MS),
            },
          });
          if (!target) transferError = 'device_offline';
          else if (deviceInGroupSession(target, now())) {
            transferError = 'device_in_group_session';
          }
          else if (
            currentSession?.activeDeviceId !== transfer.sourceDeviceId ||
            handoffPlaybackChanged(transfer, currentSession)
          ) {
            transferError = 'playback_changed';
          } else {
            try {
              await updateSession(
                collection('playback_sessions'),
                userId,
                {
                  activeDeviceId: transfer.targetDeviceId,
                  lastTransferId: String(transfer._id),
                  playing: transfer.resumePlayback === true,
                  resumeOnFailover: false,
                  failoverCandidateDeviceId: null,
                  failoverCandidateExpiresAt: null,
                },
                { updatedAt: now() },
              );
              const claimedTarget = await collection('playback_devices')
                .findOne({
                  userId,
                  deviceId: transfer.targetDeviceId,
                });
              if (deviceInGroupSession(claimedTarget, now())) {
                const sessionAfterClaim = await collection('playback_sessions')
                  .findOne({ _id: userId });
                if (
                  sessionAfterClaim?.activeDeviceId === transfer.targetDeviceId
                ) {
                  await updateSession(
                    collection('playback_sessions'),
                    userId,
                    { activeDeviceId: null, playing: false },
                    { updatedAt: now() },
                  );
                }
                transferError = 'device_in_group_session';
              }
            } catch (updateError) {
              if (updateError.code !== 'playback_conflict') throw updateError;
              transferError = 'playback_changed';
            }
          }
        }
        transferStatus = transferError ? 'failed' : 'completed';
        await transfers.updateOne(
          { _id: transfer._id, userId, status: 'pending' },
          {
            $set: {
              status: transferStatus,
              ...(transferError ? { error: transferError } : {}),
              completedAt: now(),
            },
          },
        );
      }
    }
  }
  const session = await collection('playback_sessions').findOne({ _id: userId });
  const serverTimestamp = now();
  publishPlaybackEvent(userId, {
    session: publicSession(session, serverTimestamp),
    serverTimestamp: serverTimestamp.toISOString(),
  });
  return {
    ok: true,
    commandId: String(command._id),
    status,
    error: acknowledgmentError,
    transferId: command.action === 'handoff'
      ? String(command.payload.transferId)
      : command.action === 'pause' &&
          typeof command.payload.handoffTransferId === 'string'
        ? command.payload.handoffTransferId
        : null,
    transferStatus,
    transferError,
    ...(command.action === 'prewarm'
      ? {
          prewarmId: command.payload.prewarmId,
          requesterDeviceId: command.payload.requesterDeviceId,
        }
      : {}),
  };
}

export function createPlaybackRouter({
  collection = col,
  now = () => new Date(),
} = {}) {
  const router = express.Router();

  router.get('/playback/state', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      const time = now();
      let [session, rows] = await Promise.all([
        collection('playback_sessions').findOne({ _id: req.user.id }),
        collection('playback_devices')
          .find({ userId: req.user.id })
          .sort({ lastSeenAt: -1 })
          .limit(50)
          .toArray(),
      ]);
      const initialRevision = session?.revision || 0;
      session = await pauseExpiredPlayback(
        collection,
        req.user.id,
        session,
        time,
      );
      if ((session?.revision || 0) !== initialRevision) {
        publishPlaybackEvent(req.user.id, {
          session: publicSession(session, time),
          serverTimestamp: time.toISOString(),
        });
      }
      res.json({
        session: publicSession(session, time),
        devices: rows
          .filter((device) => device.visible !== false)
          .map((device) => publicDevice(device, time, session?.activeDeviceId)),
      });
    } catch (error) { next(error); }
  });

  router.post('/playback/poll', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      res.json(await pollPlayback({
        userId: req.user.id,
        body: req.body,
        collection,
        now,
      }));
    } catch (error) { next(error); }
  });

  router.post('/playback/handoff', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      const result = await createPlaybackHandoff({
        userId: req.user.id,
        deviceId: req.body?.deviceId,
        requesterDeviceId: req.body?.requesterDeviceId,
        prewarmId: req.body?.prewarmId,
        positionMs: req.body?.positionMs,
        positionTimestamp: req.body?.positionTimestamp,
        playbackRate: req.body?.playbackRate,
        queueRevision: req.body?.queueRevision,
        scheduledStartAt: req.body?.scheduledStartAt,
        collection,
        now,
      });
      res.status(result.status === 'pending' ? 202 : 200).json(result);
    } catch (error) { next(error); }
  });

  router.get('/playback/transfers/:transferId', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      if (!ObjectId.isValid(req.params.transferId)) {
        throw apiError(400, 'invalid_transfer');
      }
      const transfer = await collection('playback_transfers').findOne({
        _id: new ObjectId(req.params.transferId),
        userId: req.user.id,
      });
      if (!transfer) throw apiError(404, 'transfer_not_found');
      if (transfer.status === 'pending') {
        const session = await collection('playback_sessions').findOne({
          _id: req.user.id,
        });
        if (session?.lastTransferId === String(transfer._id)) {
          await collection('playback_transfers').updateOne(
            { _id: transfer._id, userId: req.user.id, status: 'pending' },
            { $set: { status: 'completed', completedAt: now() } },
          );
          transfer.status = 'completed';
        }
      }
      if (transfer.status === 'pending' && transfer.expiresAt <= now()) {
        await collection('playback_transfers').updateOne(
          { _id: transfer._id, userId: req.user.id, status: 'pending' },
          { $set: { status: 'failed', error: 'transfer_timeout', completedAt: now() } },
        );
        transfer.status = 'failed';
        transfer.error = 'transfer_timeout';
      }
      res.json({
        transferId: String(transfer._id),
        status: transfer.status,
        error: transfer.error || null,
      });
    } catch (error) { next(error); }
  });

  router.patch('/playback/devices/:deviceId', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      const updates = {};
      if (req.body?.name !== undefined) {
        const name = String(req.body.name || '').trim();
        if (!name || name.length > 80) throw apiError(400, 'invalid_device_name');
        updates.name = name;
        updates.renamedAt = now();
      }
      if (req.body?.visible !== undefined) {
        if (typeof req.body.visible !== 'boolean') {
          throw apiError(400, 'invalid_device_visibility');
        }
        updates.visible = req.body.visible;
      }
      if (!Object.keys(updates).length) throw apiError(400, 'invalid_device');
      const result = await collection('playback_devices').updateOne(
        { userId: req.user.id, deviceId: req.params.deviceId },
        { $set: updates },
      );
      if (!result.matchedCount) throw apiError(404, 'device_not_found');
      publishPlaybackEvent(req.user.id, {
        requiresFullSync: true,
        deviceListChanged: true,
      });
      res.json({ deviceId: req.params.deviceId, ...updates });
    } catch (error) { next(error); }
  });

  router.post('/playback/devices/:deviceId/disconnect', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      const deviceId = String(req.params.deviceId || '');
      if (deviceId !== req.body?.deviceId) throw apiError(403, 'device_mismatch');
      const time = now();
      const devices = collection('playback_devices');
      const device = await devices.findOne({ userId: req.user.id, deviceId });
      if (!device) {
        res.json({ ok: true });
        return;
      }
      if (deviceInGroupSession(device, now())) {
        throw apiError(409, 'device_in_group_session');
      }
      await devices.deleteOne({ userId: req.user.id, deviceId });
      const session = await collection('playback_sessions').findOne({ _id: req.user.id });
      let updatedSession = session;
      if (session?.activeDeviceId === deviceId) {
        updatedSession = await updateSession(
          collection('playback_sessions'),
          req.user.id,
          { activeDeviceId: null, playing: false },
          { updatedAt: time },
        );
      }
      publishPlaybackEvent(req.user.id, {
        session: publicSession(updatedSession, time),
        serverTimestamp: time.toISOString(),
        requiresFullSync: true,
        deviceListChanged: true,
      });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  router.delete('/playback/devices/:deviceId', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      const deviceId = String(req.params.deviceId || '');
      const time = now();
      const device = await collection('playback_devices').findOne({
        userId: req.user.id,
        deviceId,
      });
      if (!device) {
        res.json({ ok: true });
        return;
      }
      if (deviceInGroupSession(device, time)) {
        throw apiError(409, 'device_in_group_session');
      }
      if (time.getTime() - new Date(device.lastSeenAt).getTime() <= DEVICE_ONLINE_MS) {
        throw apiError(409, 'device_online');
      }
      const session = await collection('playback_sessions').findOne({ _id: req.user.id });
      let updatedSession = session;
      if (session?.activeDeviceId === deviceId) {
        updatedSession = await updateSession(
          collection('playback_sessions'),
          req.user.id,
          { activeDeviceId: null, playing: false },
          { updatedAt: time },
        );
      }
      await collection('playback_devices').deleteOne({ userId: req.user.id, deviceId });
      publishPlaybackEvent(req.user.id, {
        session: publicSession(updatedSession, time),
        serverTimestamp: time.toISOString(),
        requiresFullSync: true,
        deviceListChanged: true,
      });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  router.post('/playback/commands', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      const result = await createPlaybackCommand({
        userId: req.user.id,
        action: req.body?.action,
        payload: req.body?.payload,
        idempotencyKey: req.body?.idempotencyKey ?? null,
        expectedRevision: req.body?.expectedRevision ?? null,
        expectedQueueRevision: req.body?.expectedQueueRevision ?? null,
        collection,
        now,
      });
      publishPlaybackEvent(req.user.id, {
        deviceId: result.deviceId,
        pendingCommandsChanged: true,
      });
      res.status(202).json({
        commandId: result.commandId,
        duplicate: result.duplicate,
      });
    } catch (error) { next(error); }
  });

  router.get('/playback/commands/:commandId', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      if (!ObjectId.isValid(req.params.commandId)) {
        throw apiError(400, 'invalid_command');
      }
      const commands = collection('playback_commands');
      const command = await commands.findOne({
        _id: new ObjectId(req.params.commandId),
        userId: req.user.id,
      });
      if (!command) throw apiError(404, 'command_not_found');
      if (command.status === 'pending' && commandDeadline(command) <= now()) {
        await commands.updateOne(
          { _id: command._id, userId: req.user.id, status: 'pending' },
          {
            $set: {
              status: 'failed',
              error: 'command_timeout',
              acknowledgedAt: now(),
            },
          },
        );
        command.status = 'failed';
        command.error = 'command_timeout';
      }
      res.json({
        commandId: String(command._id),
        status: command.status,
        error: command.error || null,
      });
    } catch (error) { next(error); }
  });

  router.delete('/playback/commands/:commandId', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      if (!ObjectId.isValid(req.params.commandId)) {
        throw apiError(400, 'invalid_command');
      }
      const result = await collection('playback_commands').updateOne(
        {
          _id: new ObjectId(req.params.commandId),
          userId: req.user.id,
          status: 'pending',
        },
        { $set: { status: 'cancelled', cancelledAt: now() } },
      );
      if (!result.matchedCount) throw apiError(409, 'command_not_pending');
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  router.post('/playback/commands/:commandId/ack', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      const result = await acknowledgePlaybackCommand({
        userId: req.user.id,
        commandId: req.params.commandId,
        deviceId: String(req.body?.deviceId || ''),
        status: req.body?.status,
        error: req.body?.error,
        snapshot: req.body?.snapshot,
        collection,
        now,
      });
      res.json(result);
    } catch (error) { next(error); }
  });

  return router;
}

export async function cleanupPlaybackDeviceOnLogout({
  userId,
  deviceId,
  collection = col,
  now = () => new Date(),
} = {}) {
  const time = now();
  const devices = collection('playback_devices');
  const device = await devices.findOne({ userId, deviceId });
  const sessions = collection('playback_sessions');
  const session = await sessions.findOne({ _id: userId });
  let updatedSession = session;

  if (session?.activeDeviceId === deviceId) {
    updatedSession = await updateSession(
      sessions,
      userId,
      { activeDeviceId: null, playing: false },
      { updatedAt: time },
    );
  }

  const preserveGroupClaim = deviceInGroupSession(device, time);
  if (device && !preserveGroupClaim) {
    await devices.deleteOne({ userId, deviceId });
  }
  if (updatedSession !== session || (device && !preserveGroupClaim)) {
    publishPlaybackEvent(userId, {
      ...(updatedSession
        ? { session: publicSession(updatedSession, time) }
        : {}),
      serverTimestamp: time.toISOString(),
      requiresFullSync: true,
      deviceListChanged: Boolean(device && !preserveGroupClaim),
    });
  }
}

export const playbackRoutes = createPlaybackRouter();
