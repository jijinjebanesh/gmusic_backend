import { Server } from 'socket.io';
import { z } from 'zod';
import { authenticateBearerToken } from './auth.js';
import { col } from './db.js';
import {
  attachPlaybackSocketServer,
  configurePlaybackEventBus,
  deviceRoom,
  playbackEventsAreShared,
  publishPlaybackEvent,
  userRoom,
} from './playback_event_bus.js';
import {
  acknowledgePlaybackCommand,
  createPlaybackCommand,
  createPlaybackHandoff,
  createPlaybackPrewarm,
  cancelPlaybackPrewarm,
  pollPlayback,
  updatePlaybackPrewarmStatus,
} from './playback.js';
import { attachGroupListeningSocketHandlers } from './group_listening.js';

const SOCKET_PATH = '/api/v1/playback/socket';
const AUTH_TIMEOUT_MS = 5_000;
const MAX_EVENTS_PER_WINDOW = 40;
const RATE_WINDOW_MS = 10_000;

function logPlaybackSocket(event, details = {}) {
  if (process.env.DEBUG_PLAYBACK_SOCKET === 'true') {
    console.log('[Playback Socket.IO]', event, JSON.stringify(details));
  }
}

const deviceSchema = z.object({
  deviceId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  name: z.string().trim().min(1).max(80),
  platform: z.enum(['android', 'ios', 'linux', 'macos', 'web', 'windows', 'unknown']),
  capabilities: z.object({
    playback: z.boolean(),
    pause: z.boolean(),
    seek: z.boolean(),
    volume: z.boolean(),
    queue: z.boolean(),
  }).optional(),
  visible: z.boolean().optional(),
}).strict();

const snapshotSchema = z.object({
  trackIds: z.array(z.string().min(1).max(256)).max(500),
  index: z.number().int().nonnegative(),
  positionMs: z.number().int().nonnegative().max(86_400_000),
  durationMs: z.number().int().nonnegative().max(86_400_000),
  volume: z.number().finite().min(0).max(1),
  playing: z.boolean(),
  shuffle: z.boolean(),
  repeat: z.enum(['none', 'one', 'all']),
  title: z.string().max(200).optional(),
  artist: z.string().max(200).optional(),
  playbackEpoch: z.number().int().nonnegative().optional(),
  advancePlaybackEpoch: z.boolean().optional(),
}).strict();

const registerSchema = z.object({
  device: deviceSchema,
  snapshot: snapshotSchema.nullable().optional(),
  claim: z.boolean().optional(),
}).strict();

const heartbeatSchema = z.object({
  snapshot: snapshotSchema.nullable().optional(),
  claim: z.boolean().optional(),
}).strict();

const syncSchema = z.object({}).strict();

const commandSchema = z.object({
  action: z.string().min(1).max(32),
  payload: z.record(z.string(), z.unknown()).default({}),
  commandId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  expectedRevision: z.number().int().nonnegative().optional(),
  expectedQueueRevision: z.number().int().nonnegative().optional(),
}).strict();

const transferSchema = z.object({
  deviceId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  requesterDeviceId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  prewarmId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/).optional(),
  positionMs: z.number().int().nonnegative().max(86_400_000),
  positionTimestamp: z.string().datetime({ offset: true }),
  playbackRate: z.number().finite().min(0.25).max(4),
  queueRevision: z.number().int().nonnegative(),
  scheduledStartAt: z.string().datetime({ offset: true }),
}).strict();

const prewarmSchema = z.object({
  deviceId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  prewarmId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
}).strict();

const prewarmStatusSchema = z.object({
  prewarmId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  status: z.enum(['preparing', 'ready', 'failed']),
  error: z.string().max(120).optional(),
}).strict();

const cancelPrewarmSchema = z.object({
  deviceId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  prewarmId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
}).strict();

const commandAckSchema = z.object({
  commandId: z.string().regex(/^[a-fA-F0-9]{24}$/),
  status: z.enum(['ok', 'failed']),
  error: z.string().max(120).optional(),
  snapshot: snapshotSchema.nullable().optional(),
}).strict();
const SUPPORTED_EVENTS = new Set([
  'device:register',
  'device:heartbeat',
  'playback:sync',
  'playback:command',
  'playback:transfer',
  'playback:prewarm',
  'playback:prewarm:status',
  'playback:prewarm:cancel',
  'playback:command:ack',
  'group:watch',
  'group:unwatch',
  'group:clock',
]);

function roomForCommand(userId, commandId) {
  return `command:${userId}:${commandId}`;
}

function socketFailure(error) {
  return {
    ok: false,
    error: String(error?.code || error?.name || 'socket_request_failed').slice(0, 120),
  };
}

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw Object.assign(new Error('invalid_payload'), {
      code: 'invalid_payload',
      status: 400,
    });
  }
  return result.data;
}

function callbackAck(callback, value) {
  if (typeof callback === 'function') callback(value);
}

export function attachPlaybackSocketIO(server, {
  apiToken,
  collection = col,
  now = () => new Date(),
  authenticate = authenticateBearerToken,
  poll = pollPlayback,
  createCommand = createPlaybackCommand,
  createHandoff = createPlaybackHandoff,
  createPrewarm = createPlaybackPrewarm,
  acknowledgeCommand = acknowledgePlaybackCommand,
  configureEventBus = configurePlaybackEventBus,
  onConnectionError = (error) => {
    console.error('Playback Socket.IO connection failed:', error.name);
  },
} = {}) {
  const io = new Server(server, {
    path: SOCKET_PATH,
    maxHttpBufferSize: 64 * 1024,
    transports: ['websocket'],
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingInterval: 20_000,
    pingTimeout: 20_000,
  });
  io.engine.on('connection_error', (error) => {
    logPlaybackSocket('transport_error', {
      code: error.code,
      message: error.message,
    });
  });
  attachPlaybackSocketServer(io);
  const eventBusReady = Promise.resolve()
    .then(() => configureEventBus(io))
    .catch((error) => {
      console.error('Playback Redis adapter initialization failed:', error.name);
      return false;
    });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || token.length === 0 || token.length > 512) {
      logPlaybackSocket('authentication_failed', {
        reason: 'authentication_required',
      });
      next(new Error('authentication_required'));
      return;
    }
    try {
      const result = await authenticate(token, apiToken, { renew: false });
      if (result.ownerMode || !result.user?.id || result.user.id === 'owner') {
        logPlaybackSocket('authentication_failed', {
          reason: 'personal_account_required',
        });
        next(new Error('personal_account_required'));
        return;
      }
      socket.data.userId = result.user.id;
      socket.data.sessionToken = token;
      logPlaybackSocket('authenticated');
      next();
    } catch (error) {
      const code = String(error?.code || 'authentication_failed');
      logPlaybackSocket('authentication_failed', { reason: code });
      next(new Error(code));
    }
  });

  io.on('connection', (socket) => {
    logPlaybackSocket('connected', {
      transport: socket.conn.transport.name,
    });
    let device = null;
    let operations = Promise.resolve();
    const rateWindow = [];
    const authTimeout = setTimeout(() => {
      if (!device) socket.disconnect(true);
    }, AUTH_TIMEOUT_MS);
    let sessionVerifyTimer;

    const enqueue = (callback, operation, event = null) => {
      operations = operations.then(async () => {
        if (!rateLimit()) {
          socket.emit('session:error', { error: 'rate_limited' });
          socket.disconnect(true);
          return;
        }
        try {
          await operation();
        } catch (error) {
          if (event) {
            logPlaybackSocket(`${event}_failed`, {
              reason: error?.code || error?.name || 'unknown_error',
            });
          }
          callbackAck(callback, socketFailure(error));
          if (error?.code === 'session_expired' ||
              error?.code === 'session_invalid' ||
              error?.code === 'session_user_missing' ||
              error?.code === 'unauthorized' ||
              error?.code === 'personal_account_required') {
            socket.emit('session:error', { error: error.code });
            socket.disconnect(true);
          }
        }
      }).catch((error) => {
        onConnectionError(error);
      });
    };

    const rateLimit = () => {
      const cutoff = Date.now() - RATE_WINDOW_MS;
      while (rateWindow.length && rateWindow[0] < cutoff) rateWindow.shift();
      rateWindow.push(Date.now());
      return rateWindow.length <= MAX_EVENTS_PER_WINDOW;
    };

    const ensureAuthenticated = async () => {
      const result = await authenticate(
        socket.data.sessionToken,
        apiToken,
        { renew: false },
      );
      if (result.ownerMode || result.user?.id !== socket.data.userId) {
        throw Object.assign(new Error('session_invalid'), {
          code: 'session_invalid',
          status: 401,
        });
      }
    };

    const requireDevice = () => {
      if (!device) {
        throw Object.assign(new Error('device_not_registered'), {
          code: 'device_not_registered',
          status: 401,
        });
      }
      return device;
    };

    socket.onAny((event) => {
      if (!SUPPORTED_EVENTS.has(event)) socket.disconnect(true);
    });

    const sync = async (snapshot = null, claim = false) => {
      const identity = requireDevice();
      const result = await poll({
        userId: socket.data.userId,
        body: { ...identity, snapshot, claim },
        collection,
        now,
        exceptConnectionId: socket.id,
      });
      return result;
    };

    socket.on('device:register', (raw, callback) => {
      logPlaybackSocket('register_received', {
        platform: raw?.device?.platform,
      });
      enqueue(callback, async () => {
        await ensureAuthenticated();
        // Redis adapter setup is asynchronous during server startup/restarts.
        // Do not tell a newly registered device to downgrade to REST recovery
        // until that setup has settled.
        await eventBusReady;
        const input = parse(registerSchema, raw);
        if (device && device.deviceId !== input.device.deviceId) {
          throw Object.assign(new Error('device_identity_mismatch'), {
            code: 'device_identity_mismatch',
            status: 403,
          });
        }
        device = {
          deviceId: input.device.deviceId,
          name: input.device.name,
          platform: input.device.platform,
          capabilities: input.device.capabilities,
          visible: input.device.visible,
        };
        socket.data.deviceId = device.deviceId;
        socket.data.device = device;
        await socket.join(userRoom(socket.data.userId));
        await socket.join(deviceRoom(socket.data.userId, device.deviceId));
        const result = await sync(input.snapshot ?? null, input.claim === true);
        clearTimeout(authTimeout);
        clearInterval(sessionVerifyTimer);
        sessionVerifyTimer = setInterval(() => {
          ensureAuthenticated().catch((error) => {
            socket.emit('session:error', socketFailure(error));
            socket.disconnect(true);
          });
        }, 15_000);
        const crossInstance = playbackEventsAreShared();
        callbackAck(callback, {
          ok: true,
          crossInstance,
          result,
        });
        logPlaybackSocket('register_ack', { crossInstance });
      }, 'register');
    });

    socket.on('device:heartbeat', (raw, callback) => {
      enqueue(callback, async () => {
        await ensureAuthenticated();
        requireDevice();
        const input = parse(heartbeatSchema, raw);
        callbackAck(callback, {
          ok: true,
          result: await sync(input.snapshot ?? null, input.claim === true),
        });
      });
    });

    socket.on('playback:sync', (raw, callback) => {
      enqueue(callback, async () => {
        await ensureAuthenticated();
        parse(syncSchema, raw ?? {});
        callbackAck(callback, { ok: true, result: await sync() });
      });
    });

    socket.on('playback:command', (raw, callback) => {
      enqueue(callback, async () => {
        await ensureAuthenticated();
        const input = parse(commandSchema, raw);
        const result = await createCommand({
          userId: socket.data.userId,
          action: input.action,
          payload: input.payload,
          idempotencyKey: input.commandId,
          expectedRevision: input.expectedRevision ?? null,
          expectedQueueRevision: input.expectedQueueRevision ?? null,
          collection,
          now,
        });
        const commandRoom = roomForCommand(
          socket.data.userId,
          result.commandId,
        );
        await socket.join(commandRoom);
        publishPlaybackEvent(socket.data.userId, { deviceId: result.deviceId });
        callbackAck(callback, {
          ok: true,
          status: 'accepted',
          commandId: result.commandId,
          duplicate: result.duplicate === true,
        });
      });
    });

    socket.on('playback:transfer', (raw, callback) => {
      enqueue(callback, async () => {
        await ensureAuthenticated();
        const identity = requireDevice();
        const input = parse(transferSchema, raw);
        if (input.requesterDeviceId !== identity.deviceId) {
          throw Object.assign(new Error('requester_device_mismatch'), {
            code: 'requester_device_mismatch',
            status: 403,
          });
        }
        const result = await createHandoff({
          userId: socket.data.userId,
          deviceId: input.deviceId,
          requesterDeviceId: identity.deviceId,
          prewarmId: input.prewarmId,
          positionMs: input.positionMs,
          positionTimestamp: input.positionTimestamp,
          playbackRate: input.playbackRate,
          queueRevision: input.queueRevision,
          scheduledStartAt: input.scheduledStartAt,
          collection,
          now,
        });
        callbackAck(callback, { ok: true, ...result });
      });
    });

    socket.on('playback:prewarm', (raw, callback) => {
      enqueue(callback, async () => {
        await ensureAuthenticated();
        const identity = requireDevice();
        const input = parse(prewarmSchema, raw);
        const result = await createPrewarm({
          userId: socket.data.userId,
          requesterDeviceId: identity.deviceId,
          deviceId: input.deviceId,
          prewarmId: input.prewarmId,
          collection,
          now,
        });
        io.to(deviceRoom(socket.data.userId, input.deviceId)).emit(
          'playback:prewarm:request',
          {
            prewarmId: input.prewarmId,
            requesterDeviceId: identity.deviceId,
          },
        );
        io.to(deviceRoom(socket.data.userId, identity.deviceId)).emit(
          'playback:prewarm:result',
          {
            prewarmId: input.prewarmId,
            deviceId: input.deviceId,
            status: 'accepted',
            error: null,
          },
        );
        callbackAck(callback, { ok: true, ...result });
      });
    });

    socket.on('playback:prewarm:status', (raw, callback) => {
      enqueue(callback, async () => {
        await ensureAuthenticated();
        const identity = requireDevice();
        const input = parse(prewarmStatusSchema, raw);
        const result = await updatePlaybackPrewarmStatus({
          userId: socket.data.userId,
          deviceId: identity.deviceId,
          ...input,
          collection,
          now,
        });
        if (!result.stale && result.requesterDeviceId) {
          io.to(deviceRoom(socket.data.userId, result.requesterDeviceId)).emit(
            'playback:prewarm:result',
            {
              prewarmId: result.prewarmId,
              deviceId: result.deviceId,
              status: result.status,
              error: result.error,
            },
          );
        }
        callbackAck(callback, { ok: true, ...result });
      });
    });

    socket.on('playback:prewarm:cancel', (raw, callback) => {
      enqueue(callback, async () => {
        await ensureAuthenticated();
        const identity = requireDevice();
        const input = parse(cancelPrewarmSchema, raw);
        const result = await cancelPlaybackPrewarm({
          userId: socket.data.userId,
          requesterDeviceId: identity.deviceId,
          ...input,
          collection,
          now,
        });
        if (result.cancelled) {
          io.to(deviceRoom(socket.data.userId, result.deviceId)).emit(
            'playback:prewarm:cancel',
            { prewarmId: result.prewarmId },
          );
          io.to(deviceRoom(socket.data.userId, identity.deviceId)).emit(
            'playback:prewarm:result',
            {
              prewarmId: result.prewarmId,
              deviceId: result.deviceId,
              status: 'cancelled',
              error: null,
            },
          );
        }
        callbackAck(callback, { ok: true, ...result });
      });
    });

    socket.on('playback:command:ack', (raw, callback) => {
      enqueue(callback, async () => {
        await ensureAuthenticated();
        const identity = requireDevice();
        const input = parse(commandAckSchema, raw);
        const result = await acknowledgeCommand({
          userId: socket.data.userId,
          commandId: input.commandId,
          deviceId: identity.deviceId,
          status: input.status,
          error: input.error,
          snapshot: input.snapshot,
          collection,
          now,
        });
        if (result.commandId) {
          io.to(roomForCommand(socket.data.userId, input.commandId)).emit(
            'playback:command:result',
            {
              commandId: input.commandId,
              status: result.status,
              error: result.error,
            },
          );
        }
        if (result.prewarmId && result.requesterDeviceId) {
          io.to(deviceRoom(socket.data.userId, result.requesterDeviceId)).emit(
            'playback:prewarm:result',
            {
              prewarmId: result.prewarmId,
              deviceId: identity.deviceId,
              status: result.status === 'ok' ? 'ready' : 'failed',
              error: result.error || null,
            },
          );
        }
        if (result.transferId && result.transferStatus) {
          io.to(userRoom(socket.data.userId)).emit(
            'playback:transfer:result',
            {
              transferId: result.transferId,
              status: result.transferStatus,
              error: result.transferError || null,
            },
          );
        }
        callbackAck(callback, { ok: true, ...result });
      });
    });

    socket.on('disconnect', () => {
      logPlaybackSocket('disconnected');
      clearTimeout(authTimeout);
      clearInterval(sessionVerifyTimer);
      // CP-B4: Mark device as disconnected in DB so it doesn't appear online
      // for up to 12 seconds after the socket drops.
      const currentDevice = device || socket.data?.device;
      if (currentDevice && socket.data?.userId) {
        try {
          const devices = collection?.('playback_devices');
          if (typeof devices?.updateOne === 'function') {
            devices.updateOne(
              { userId: socket.data.userId, deviceId: currentDevice.deviceId },
              { $set: { disconnectedAt: now() } },
            ).catch((err) => {
              console.error('Failed to update disconnectedAt on disconnect:', err.name);
            });
          }
        } catch (err) {
          console.error('Failed to update disconnectedAt on disconnect:', err.name);
        }
      }
    });
    socket.on('error', onConnectionError);
  });

  attachGroupListeningSocketHandlers(io, { collection, now });

  return {
    io,
    eventBusReady,
    path: SOCKET_PATH,
    close: () => io.close(),
  };
}
