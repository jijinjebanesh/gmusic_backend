import express from 'express';
import { ObjectId } from 'mongodb';
import { isDeepStrictEqual } from 'node:util';
import { col } from './db.js';
import { publishPlaybackEvent } from './playback_event_bus.js';

const DEVICE_ONLINE_MS = 12_000;
const COMMAND_TTL_MS = 60_000;
const COMMAND_RETENTION_MS = 24 * 60 * 60 * 1000;
const TRANSFER_TTL_MS = 30_000;
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
  'shuffle',
  'stop',
  'volume',
]);

function apiError(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
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
  };
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
  fields,
  {
    queueChanged = false,
    advancePlaybackEpoch = false,
    updatedAt = new Date(),
  } = {},
) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await sessions.findOne({ _id: userId });
    if (!current) throw apiError(409, 'playback_session_missing');
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
      { _id: userId, revision: current.revision || 0 },
      update,
    );
    if (result.matchedCount) {
      return {
        ...current,
        ...fields,
        updatedAt,
        revision: (current.revision || 0) + 1,
        playbackEpoch:
          (current.playbackEpoch || 0) + (epochChanged ? 1 : 0),
        queueRevision: (current.queueRevision || 0) + (queueChanged ? 1 : 0),
      };
    }
  }
  throw apiError(409, 'playback_conflict');
}

async function pauseExpiredPlayback(collection, userId, session, time) {
  if (!session?.activeDeviceId || !session.playing) return session;
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
  return updateSession(
    collection('playback_sessions'),
    userId,
    { playing: false, resumeOnFailover: true },
    { updatedAt: time },
  );
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
  const existingDevice = await devices.findOne({ userId, deviceId });
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
    },
    { upsert: true },
  );
  let session = await sessions.findOne({ _id: userId });
  const initialRevision = session?.revision || 0;
  session = await pauseExpiredPlayback(collection, userId, session, time);
  if (claim) {
    if (!snapshot?.trackIds.length || !snapshot.playing) {
      throw apiError(400, 'invalid_playback_claim');
    }
    const anotherDeviceOwnsPlayback =
      session?.activeDeviceId != null &&
      session.activeDeviceId !== deviceId &&
      session.resumeOnFailover !== true;
    if (!anotherDeviceOwnsPlayback) {
      await ensureSession(sessions, userId, time);
      session = await updateSession(
        sessions,
        userId,
        { activeDeviceId: deviceId, ...sessionFields(snapshot) },
        {
          queueChanged: true,
          advancePlaybackEpoch: true,
          updatedAt: time,
        },
      );
    }
  } else if (
    snapshot &&
    session?.activeDeviceId === deviceId &&
    (snapshot.playbackEpoch === undefined ||
      snapshot.playbackEpoch === (session.playbackEpoch || 0))
  ) {
    const queueChanged = JSON.stringify(session.trackIds || []) !==
      JSON.stringify(snapshot.trackIds) || session.index !== snapshot.index;
    session = await updateSession(
      sessions,
      userId,
      sessionFields(snapshot),
      {
        queueChanged,
        advancePlaybackEpoch: snapshot.advancePlaybackEpoch,
        updatedAt: time,
      },
    );
  }
  session = await sessions.findOne({ _id: userId });
  const pending = await commands
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
  const device = await collection('playback_devices').findOne({
    userId,
    deviceId,
    lastSeenAt: { $gte: new Date(now().getTime() - DEVICE_ONLINE_MS) },
  });
  if (!device) throw apiError(409, 'device_offline');
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
  const createdAt = now();
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

export async function createPlaybackHandoff({
  userId,
  deviceId,
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
  if (target.capabilities?.playback === false) {
    throw apiError(409, 'device_restricted');
  }
  const session = await collection('playback_sessions').findOne({ _id: userId });
  if (!session?.activeDeviceId || !session.trackIds?.length) {
    throw apiError(409, 'no_active_playback');
  }
  if (session.activeDeviceId === deviceId) {
    return {
      transferId: null,
      status: 'completed',
      session: publicSession(session, time),
    };
  }
  const transferId = new ObjectId();
  const expiresAt = new Date(time.getTime() + TRANSFER_TTL_MS);
  const resumePlayback =
    session.playing === true || session.resumeOnFailover === true;
  const transfer = {
    _id: transferId,
    userId,
    sourceDeviceId: session.activeDeviceId,
    targetDeviceId: deviceId,
    queueRevision: session.queueRevision || 0,
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
      session: publicSession({ ...session, playing: resumePlayback }),
    },
    status: 'pending',
    createdAt: time,
    deadlineAt: expiresAt,
    expiresAt: new Date(expiresAt.getTime() + COMMAND_RETENTION_MS),
  });
  publishPlaybackEvent(userId, { deviceId });
  return { transferId: String(transferId), status: 'pending' };
}

export async function acknowledgePlaybackCommand({
  userId,
  commandId,
  deviceId,
  status,
  error: commandError,
  collection = col,
  now = () => new Date(),
}) {
  if (!ObjectId.isValid(commandId) || !['ok', 'failed'].includes(status)) {
    throw apiError(400, 'invalid_acknowledgment');
  }
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
    if (saved.action === 'handoff') {
      const transfer = await collection('playback_transfers').findOne({
        _id: new ObjectId(saved.payload.transferId),
        userId,
        targetDeviceId: deviceId,
      });
      transferStatus = transfer?.status || null;
    }
    return {
      ok: true,
      commandId: String(saved._id),
      status: saved.status,
      error: saved.error || null,
      transferStatus,
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

  let transferStatus = null;
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
      let transferError = status === 'failed'
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
        else if (!source && currentSession?.resumeOnFailover !== true) {
          transferError = 'source_offline';
        } else if (
          currentSession?.activeDeviceId !== transfer.sourceDeviceId ||
          (currentSession.queueRevision || 0) !== transfer.queueRevision
        ) {
          transferError = 'playback_changed';
        } else if (!source) {
          try {
            await updateSession(
              collection('playback_sessions'),
              userId,
              {
                activeDeviceId: transfer.targetDeviceId,
                lastTransferId: String(transfer._id),
                playing: transfer.resumePlayback,
                resumeOnFailover: false,
              },
              { updatedAt: now() },
            );
            transferStatus = 'completed';
            await transfers.updateOne(
              { _id: transferId, userId, status: 'pending' },
              { $set: { status: transferStatus, completedAt: now() } },
            );
          } catch (updateError) {
            if (updateError.code !== 'playback_conflict') throw updateError;
            transferError = 'playback_changed';
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
          publishPlaybackEvent(userId, { deviceId: transfer.sourceDeviceId });
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
        let transferError = status === 'failed'
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
          else if (
            currentSession?.activeDeviceId !== transfer.sourceDeviceId ||
            (currentSession.queueRevision || 0) !== transfer.queueRevision
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
                },
                { updatedAt: now() },
              );
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
    transferStatus,
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
      publishPlaybackEvent(req.user.id);
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
      });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  router.delete('/playback/devices/:deviceId', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      const deviceId = String(req.params.deviceId || '');
      const device = await collection('playback_devices').findOne({
        userId: req.user.id,
        deviceId,
      });
      if (!device) {
        res.json({ ok: true });
        return;
      }
      const time = now();
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
      publishPlaybackEvent(req.user.id, { deviceId: result.deviceId });
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
        collection,
        now,
      });
      res.json(result);
    } catch (error) { next(error); }
  });

  return router;
}

export const playbackRoutes = createPlaybackRouter();
