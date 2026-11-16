import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { authenticateBearerToken } from './auth.js';
import { col } from './db.js';
import {
  playbackEventsAreShared,
  subscribePlaybackEvents,
} from './playback_event_bus.js';
import { pollPlayback } from './playback.js';

const SOCKET_PATH = '/api/v1/playback/socket';
const AUTH_TIMEOUT_MS = 5_000;

function parseMessage(data) {
  let message;
  try {
    message = JSON.parse(data.toString());
  } catch {
    throw Object.assign(new Error('invalid_message'), { code: 'invalid_message' });
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw Object.assign(new Error('invalid_message'), { code: 'invalid_message' });
  }
  return message;
}

function socketError(error) {
  return String(error?.code || error?.name || 'socket_request_failed').slice(0, 120);
}

export function attachPlaybackWebSocket(server, {
  apiToken,
  collection = col,
  now = () => new Date(),
  authenticate = authenticateBearerToken,
  poll = pollPlayback,
  isShared = playbackEventsAreShared,
  subscribe = subscribePlaybackEvents,
} = {}) {
  const sockets = new WebSocketServer({
    server,
    path: SOCKET_PATH,
    maxPayload: 64 * 1024,
  });

  sockets.on('connection', (socket) => {
    let authenticated = false;
    let userId;
    let device;
    let sessionToken;
    let unsubscribe = () => {};
    let work = Promise.resolve();
    const connectionId = crypto.randomUUID();
    const authTimeout = setTimeout(() => {
      if (!authenticated) socket.close(1008, 'authentication_timeout');
    }, AUTH_TIMEOUT_MS);

    const send = (message) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    };

    const sendErrorAndClose = (error, closeCode, reason) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({ type: 'error', error }),
          () => socket.close(closeCode, reason),
        );
      } else {
        socket.close(closeCode, reason);
      }
    };

    const sendSync = async (body, type = 'sync') => {
      const result = await poll({
        userId,
        body,
        collection,
        now,
        exceptConnectionId: connectionId,
      });
      send({ type, result });
    };

    const verifySession = async () => {
      try {
        const result = await authenticate(sessionToken, apiToken, { renew: false });
        if (result.ownerMode || result.user?.id !== userId) {
          throw Object.assign(new Error('session_invalid'), {
            code: 'session_invalid',
          });
        }
        return true;
      } catch (error) {
        sendErrorAndClose(
          socketError(error),
          error.status === 503 ? 1013 : 1008,
          'session_invalid',
        );
        return false;
      }
    };

    const enqueue = (operation) => {
      work = work.then(operation).catch((error) => {
        send({ type: 'error', error: socketError(error) });
      });
    };

    const authenticateSocket = async (message) => {
      if (message.type !== 'authenticate' ||
          typeof message.token !== 'string' ||
          message.token.length > 512 ||
          !message.device ||
          typeof message.device !== 'object' ||
          Array.isArray(message.device)) {
        socket.close(1008, 'authentication_required');
        return;
      }
      let result;
      try {
        result = await authenticate(message.token, apiToken);
      } catch (error) {
        sendErrorAndClose(
          socketError(error),
          error.status === 503 ? 1013 : 1008,
          'authentication_failed',
        );
        return;
      }
      if (result.ownerMode || !result.user?.id || result.user.id === 'owner') {
        socket.close(1008, 'personal_account_required');
        return;
      }
      userId = result.user.id;
      sessionToken = message.token;
      device = message.device;
      const initialResult = await poll({
        userId,
        body: {
          ...device,
          snapshot: message.snapshot,
          claim: message.claim === true,
        },
        collection,
        now,
        exceptConnectionId: connectionId,
      });
      authenticated = true;
      clearTimeout(authTimeout);
      unsubscribe = subscribe({
        userId,
        deviceId: device.deviceId,
        connectionId,
        onEvent: () => enqueue(async () => sendSync({
          ...device,
          snapshot: null,
          claim: false,
        })),
      });
      send({
        type: 'ready',
        crossInstance: isShared(),
        result: initialResult,
      });
    };

    socket.on('message', (data) => {
      enqueue(async () => {
        const message = parseMessage(data);
        if (!authenticated) {
          await authenticateSocket(message);
          return;
        }
        if (message.type === 'heartbeat') {
          if (message.verifySession === true && !await verifySession()) return;
          await sendSync({
            ...device,
            snapshot: message.snapshot,
            claim: message.claim === true,
          });
        } else if (message.type === 'refresh') {
          if (!await verifySession()) return;
          await sendSync({ ...device, snapshot: null, claim: false });
        } else if (message.type === 'disconnect') {
          socket.close(1000, 'client_disconnect');
        } else {
          socket.close(1008, 'unsupported_message');
        }
      });
    });

    socket.on('close', () => {
      clearTimeout(authTimeout);
      unsubscribe();
    });
    socket.on('error', (error) => {
      console.error('Playback WebSocket error:', error.name);
      clearTimeout(authTimeout);
      unsubscribe();
    });
  });

  sockets.on('error', (error) => {
    console.error('Playback WebSocket server error:', error.name);
  });
  return sockets;
}
