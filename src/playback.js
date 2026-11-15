import express from 'express';
import { ObjectId } from 'mongodb';
import { col } from './db.js';

const DEVICE_ONLINE_MS = 20_000;
const COMMAND_TTL_MS = 60_000;
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
  return { deviceId, name, platform };
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
  if (!Number.isSafeInteger(index) || index < 0 ||
      (trackIds.length === 0 ? index !== 0 : index >= trackIds.length) ||
      !integer(positionMs) || !integer(durationMs) ||
      typeof value.playing !== 'boolean' ||
      typeof value.shuffle !== 'boolean' ||
      !['none', 'one', 'all'].includes(value.repeat)) {
    throw apiError(400, 'invalid_playback_state');
  }
  return {
    trackIds,
    index,
    positionMs,
    durationMs,
    playing: value.playing,
    shuffle: value.shuffle,
    repeat: value.repeat,
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
    playing: snapshot.playing,
    shuffle: snapshot.shuffle,
    repeat: snapshot.repeat,
    title: snapshot.title,
    artist: snapshot.artist,
  };
}

function publicSession(session) {
  if (!session) return null;
  return {
    activeDeviceId: session.activeDeviceId || null,
    trackIds: session.trackIds || [],
    index: session.index || 0,
    positionMs: session.positionMs || 0,
    durationMs: session.durationMs || 0,
    playing: session.playing === true,
    shuffle: session.shuffle === true,
    repeat: session.repeat || 'none',
    title: session.title || '',
    artist: session.artist || '',
    queueRevision: session.queueRevision || 0,
    updatedAt: session.updatedAt || null,
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
        playing: false,
        shuffle: false,
        repeat: 'none',
        title: '',
        artist: '',
        queueRevision: 0,
        revision: 0,
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
  { queueChanged = false, updatedAt = new Date() } = {},
) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await sessions.findOne({ _id: userId });
    if (!current) throw apiError(409, 'playback_session_missing');
    const update = {
      $set: { ...fields, updatedAt },
      $inc: {
        revision: 1,
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
        queueRevision: (current.queueRevision || 0) + (queueChanged ? 1 : 0),
      };
    }
  }
  throw apiError(409, 'playback_conflict');
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

export function createPlaybackRouter({
  collection = col,
  now = () => new Date(),
} = {}) {
  const router = express.Router();

  router.get('/playback/state', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      const time = now();
      const [session, rows] = await Promise.all([
        collection('playback_sessions').findOne({ _id: req.user.id }),
        collection('playback_devices')
          .find({ userId: req.user.id })
          .sort({ lastSeenAt: -1 })
          .limit(50)
          .toArray(),
      ]);
      res.json({
        session: publicSession(session),
        devices: rows.map((device) => ({
          deviceId: device.deviceId,
          name: device.name,
          platform: device.platform,
          lastSeenAt: device.lastSeenAt,
          online: time.getTime() - new Date(device.lastSeenAt).getTime() <= DEVICE_ONLINE_MS,
        })),
      });
    } catch (error) { next(error); }
  });

  router.post('/playback/poll', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      const { deviceId, name, platform } = deviceFrom(req.body);
      const snapshot = snapshotFrom(req.body?.snapshot);
      const claim = req.body?.claim === true;
      const time = now();
      const userId = req.user.id;
      const devices = collection('playback_devices');
      const sessions = collection('playback_sessions');
      const commands = collection('playback_commands');
      await devices.updateOne(
        { userId, deviceId },
        {
          $set: { userId, deviceId, name, platform, lastSeenAt: time },
          $setOnInsert: { createdAt: time },
        },
        { upsert: true },
      );
      let session = await sessions.findOne({ _id: userId });
      if (claim) {
        if (!snapshot?.trackIds.length || !snapshot.playing) {
          throw apiError(400, 'invalid_playback_claim');
        }
        await ensureSession(sessions, userId, time);
        session = await updateSession(
          sessions,
          userId,
          { activeDeviceId: deviceId, ...sessionFields(snapshot) },
          { queueChanged: true, updatedAt: time },
        );
      } else if (snapshot && session?.activeDeviceId === deviceId) {
        const queueChanged = JSON.stringify(session.trackIds || []) !==
          JSON.stringify(snapshot.trackIds) || session.index !== snapshot.index;
        session = await updateSession(
          sessions,
          userId,
          sessionFields(snapshot),
          { queueChanged, updatedAt: time },
        );
      }
      session = await sessions.findOne({ _id: userId });
      const pending = await commands
        .find({ userId, deviceId, status: 'pending', expiresAt: { $gt: time } })
        .sort({ createdAt: 1 })
        .limit(20)
        .toArray();
      const activeDevices = await devices.find({ userId })
        .sort({ lastSeenAt: -1 })
        .limit(50)
        .toArray();
      res.json({
        session: publicSession(session),
        devices: activeDevices.map((device) => ({
          deviceId: device.deviceId,
          name: device.name,
          platform: device.platform,
          lastSeenAt: device.lastSeenAt,
          online: time.getTime() - new Date(device.lastSeenAt).getTime() <= DEVICE_ONLINE_MS,
        })),
        commands: pending.map((command) => ({
          id: String(command._id),
          action: command.action,
          payload: command.payload || {},
          createdAt: command.createdAt,
        })),
      });
    } catch (error) { next(error); }
  });

  router.post('/playback/handoff', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      const deviceId = String(req.body?.deviceId || '');
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(deviceId)) {
        throw apiError(400, 'invalid_device');
      }
      const userId = req.user.id;
      const time = now();
      const target = await collection('playback_devices').findOne({
        userId,
        deviceId,
        lastSeenAt: { $gte: new Date(time.getTime() - DEVICE_ONLINE_MS) },
      });
      if (!target) throw apiError(409, 'device_offline');
      const sessions = collection('playback_sessions');
      await ensureSession(sessions, userId, time);
      let session = await sessions.findOne({ _id: userId });
      if (session.activeDeviceId !== deviceId) {
        session = await updateSession(
          sessions,
          userId,
          { activeDeviceId: deviceId },
          { queueChanged: true, updatedAt: time },
        );
      }
      res.json({ session: publicSession(session) });
    } catch (error) { next(error); }
  });

  router.post('/playback/commands', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      const action = String(req.body?.action || '');
      const payload = commandPayload(action, req.body?.payload);
      const userId = req.user.id;
      const session = await collection('playback_sessions').findOne({ _id: userId });
      if (!session?.activeDeviceId) throw apiError(409, 'no_active_device');
      const queueLength = session.trackIds?.length || 0;
      if ((action === 'queuePlay' || action === 'queueRemove') &&
          payload.index >= queueLength) {
        throw apiError(400, 'invalid_command');
      }
      if (action === 'queueReorder' &&
          (payload.from >= queueLength || payload.to >= queueLength)) {
        throw apiError(400, 'invalid_command');
      }
      if (action === 'queueAdd' && queueLength >= MAX_QUEUE_SIZE) {
        throw apiError(400, 'invalid_command');
      }
      const device = await collection('playback_devices').findOne({
        userId,
        deviceId: session.activeDeviceId,
        lastSeenAt: { $gte: new Date(now().getTime() - DEVICE_ONLINE_MS) },
      });
      if (!device) throw apiError(409, 'device_offline');
      const createdAt = now();
      const result = await collection('playback_commands').insertOne({
        userId,
        deviceId: session.activeDeviceId,
        action,
        payload,
        status: 'pending',
        createdAt,
        expiresAt: new Date(createdAt.getTime() + COMMAND_TTL_MS),
      });
      res.status(202).json({ commandId: String(result.insertedId) });
    } catch (error) { next(error); }
  });

  router.post('/playback/commands/:commandId/ack', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      if (!ObjectId.isValid(req.params.commandId) ||
          !['ok', 'failed'].includes(req.body?.status)) {
        throw apiError(400, 'invalid_acknowledgment');
      }
      const deviceId = String(req.body?.deviceId || '');
      const result = await collection('playback_commands').updateOne(
        {
          _id: new ObjectId(req.params.commandId),
          userId: req.user.id,
          deviceId,
          status: 'pending',
        },
        {
          $set: {
            status: req.body.status,
            acknowledgedAt: now(),
            error: req.body.status === 'failed'
              ? String(req.body.error || 'command_failed').slice(0, 120)
              : null,
          },
        },
      );
      if (!result.matchedCount) throw apiError(404, 'command_not_found');
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  return router;
}

export const playbackRoutes = createPlaybackRouter();
