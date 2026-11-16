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
  pollPlayback,
} from './playback.js';

const SOCKET_PATH = '/api/v1/playback/socket';
const AUTH_TIMEOUT_MS = 5_000;
const MAX_EVENTS_PER_WINDOW = 40;
const RATE_WINDOW_MS = 10_000;

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
}).strict();

const commandAckSchema = z.object({
  commandId: z.string().regex(/^[a-fA-F0-9]{24}$/),
  status: z.enum(['ok', 'failed']),
  error: z.string().max(120).optional(),
}).strict();
const SUPPORTED_EVENTS = new Set([
  'device:register',
  'device:heartbeat',
  'playback:sync',
  'playback:command',
  'playback:transfer',
  'playback:command:ack',
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
      next(new Error('authentication_required'));
      return;
    }
    try {
      const result = await authenticate(token, apiToken, { renew: false });
      if (result.ownerMode || !result.user?.id || result.user.id === 'owner') {
        next(new Error('personal_account_required'));
        return;
      }
      socket.data.userId = result.user.id;
      socket.data.sessionToken = token;
      next();
    } catch (error) {
      next(new Error(String(error?.code || 'authentication_failed')));
    }
  });

  io.on('connection', (socket) => {
    let device = null;
    let operations = Promise.resolve();
    const rateWindow = [];
    const authTimeout = setTimeout(() => {
      if (!device) socket.disconnect(true);
    }, AUTH_TIMEOUT_MS);
    let sessionVerifyTimer;

    const enqueue = (callback, operation) => {
      operations = operations.then(async () => {
        if (!rateLimit()) {
          socket.emit('session:error', { error: 'rate_limited' });
          socket.disconnect(true);
          return;
        }
        try {
          await operation();
        } catch (error) {
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
      enqueue(callback, async () => {
        await ensureAuthenticated();
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
        await socket.join(userRoom(socket.data.userId));
        await socket.join(deviceRoom(socket.data.userId, device.deviceId));
        const result = await sync(input.snapshot ?? null, input.claim === true);
        clearTimeout(authTimeout);
        sessionVerifyTimer = setInterval(() => {
          ensureAuthenticated().catch((error) => {
            socket.emit('session:error', socketFailure(error));
            socket.disconnect(true);
          });
        }, 15_000);
        callbackAck(callback, {
          ok: true,
          crossInstance: playbackEventsAreShared(),
          result,
        });
      });
    });

    socket.on('device:heartbeat', (raw, callback) => {
      enqueue(callback, async () => {
        await ensureAuthenticated();
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
        const input = parse(transferSchema, raw);
        const result = await createHandoff({
          userId: socket.data.userId,
          deviceId: input.deviceId,
          collection,
          now,
        });
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
        callbackAck(callback, { ok: true, ...result });
      });
    });

    socket.on('disconnect', () => {
      clearTimeout(authTimeout);
      clearInterval(sessionVerifyTimer);
    });
    socket.on('error', onConnectionError);
  });

  return {
    io,
    eventBusReady,
    path: SOCKET_PATH,
    close: () => io.close(),
  };
}
