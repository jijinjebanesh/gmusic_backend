import crypto from 'node:crypto';
import express from 'express';
import { ObjectId } from 'mongodb';
import { col } from './db.js';
import {
  claimPlaybackDeviceForGroup,
  releasePlaybackDeviceFromGroup,
} from './playback.js';
import {
  groupRoom,
  playbackEventsAreShared,
  publishAccountSyncInvite,
  publishGroupEvent,
  removeGroupDeviceFromRoom,
  removeGroupRoomSockets,
} from './playback_event_bus.js';

const MAX_MEMBERS = 20;
const MAX_QUEUE_SIZE = 500;
const MEMBER_ONLINE_MS = 12_000;
const MEMBER_READY_MS = 15_000;
const MIN_GROUP_BUFFER_MS = 2_000;
const GROUP_PAUSE_LEAD_MS = 1_500;
const ROOM_TTL_MS = 24 * 60 * 60_000;
const MAX_POSITION_MS = 86_400_000;
const MAX_POSITION_SAMPLE_AGE_MS = 15_000;
const VALID_AUDIO_CHANNELS = new Set([
  'full',
  'left',
  'right',
  'center',
  'subwoofer',
  'surround_left',
  'surround_right',
]);
const CHANNEL_LAYOUT_PRESETS = {
  all_stereo: null,
  stereo_split: ['left', 'right'],
  surround_2_1: ['left', 'right', 'subwoofer'],
  surround_5_1: [
    'left',
    'right',
    'center',
    'subwoofer',
    'surround_left',
    'surround_right',
  ],
};
const HOST_ONLY_CONTROL_ACTIONS = new Set([
  'play',
  'pause',
  'seek',
  'next',
  'previous',
  'queuePlay',
  'queueReplace',
  'queueRemove',
  'queueReorder',
  'queueClear',
  'setChannel',
  'setChannelLayout',
  'end',
]);

function apiError(status, code) {
  return Object.assign(new Error(code), { status, code });
}

function requirePersonalAccount(req, res) {
  if (req.ownerMode || !req.user?.id || req.user.id === 'owner') {
    res.status(403).json({ error: 'personal_account_required' });
    return false;
  }
  return true;
}

function validateQueue(trackIds, index = 0, positionMs = 0) {
  if (!Array.isArray(trackIds) || trackIds.length === 0 ||
      trackIds.length > MAX_QUEUE_SIZE ||
      trackIds.some((id) =>
        typeof id !== 'string' || id.length === 0 || id.length > 256) ||
      !Number.isSafeInteger(index) || index < 0 || index >= trackIds.length ||
      !Number.isSafeInteger(positionMs) || positionMs < 0 ||
      positionMs > MAX_POSITION_MS) {
    throw apiError(400, 'invalid_group_queue');
  }
}

function parseSessionId(value) {
  if (!ObjectId.isValid(value)) throw apiError(400, 'invalid_group_session');
  return new ObjectId(value);
}

function roomPosition(room, time) {
  if (!room.playing || room.status === 'preparing') {
    return room.positionMs || 0;
  }
  const anchor = room.startAtServerTime
    ? new Date(room.startAtServerTime).getTime()
    : new Date(room.updatedAt || time).getTime();
  const elapsed = Math.max(0, time.getTime() - anchor);
  const position = (room.positionMs || 0) + elapsed;
  return Math.min(
    MAX_POSITION_MS,
    room.durationMs > 0 ? Math.min(position, room.durationMs) : position,
  );
}

function isOnline(member, time) {
  return time.getTime() - new Date(member.lastSeenAt).getTime() <= MEMBER_ONLINE_MS;
}

function isReady(member, time) {
  if (member.ready !== true || !member.readyAt) return false;
  const readyAt = new Date(member.readyAt).getTime();
  const age = time.getTime() - readyAt;
  return age >= 0 && age <= MEMBER_READY_MS;
}

function publicRoom(room, time) {
  const positionMs = roomPosition(room, time);
  const status = room.status === 'scheduled' &&
      new Date(room.startAtServerTime).getTime() <= time.getTime()
    ? 'playing'
    : room.status;
  return {
    sessionId: String(room._id),
    invitationCode: room.code,
    title: room.title,
    hostMemberId: room.hostMemberId,
    hostDeviceId: room.hostDeviceId,
    status,
    trackIds: room.trackIds,
    index: room.index,
    positionMs,
    durationMs: room.durationMs || 0,
    playing: room.playing === true,
    startAtServerTime: room.startAtServerTime || null,
    stateVersion: room.stateVersion || 0,
    queueRevision: room.queueRevision || 0,
    channelLayout: room.channelLayout || 'all_stereo',
    serverTime: time.toISOString(),
    members: (room.members || []).map((member) => ({
      memberId: member.memberId,
      deviceId: member.deviceId,
      name: member.name,
      platform: member.platform,
      isHost: member.memberId === room.hostMemberId,
      canControlPlayback: member.userId === room.hostUserId,
      online: isOnline(member, time),
      ready: isReady(member, time),
      driftMs: Number.isFinite(member.driftMs) ? member.driftMs : null,
      latencyCompensationMs: member.latencyCompensationMs || 0,
      audioChannel: member.audioChannel || 'full',
      joinedAt: member.joinedAt,
    })),
  };
}

async function updateRoom(groups, roomId, mutate, time) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await groups.findOne({ _id: roomId });
    if (!current || current.status === 'ended') {
      throw apiError(404, 'group_session_not_found');
    }
    const next = mutate({ ...current, members: [...(current.members || [])] });
    if (next === current) return current;
    next.stateVersion = (current.stateVersion || 0) + 1;
    next.updatedAt = time;
    const { _id, ...fields } = next;
    const result = await groups.updateOne(
      { _id, stateVersion: current.stateVersion || 0 },
      { $set: fields },
    );
    if (result.matchedCount) return next;
  }
  throw apiError(409, 'group_session_conflict');
}

async function refreshHost(groups, room, time) {
  const members = room.members || [];
  const host = members.find((member) => member.memberId === room.hostMemberId);
  if (host && isOnline(host, time)) return room;
  const online = members
    .filter((member) => isOnline(member, time))
    .sort((left, right) =>
      new Date(left.joinedAt).getTime() - new Date(right.joinedAt).getTime());
  return updateRoom(groups, room._id, (current) => {
    if (online.length === 0) {
      return { ...current, status: 'ended', playing: false, endedAt: time };
    }
    return {
      ...current,
      hostMemberId: online[0].memberId,
      hostUserId: online[0].userId,
      hostDeviceId: online[0].deviceId,
      members: current.members,
    };
  }, time);
}

async function requireMember(groups, sessionId, userId, deviceId, time) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(deviceId || ''))) {
    throw apiError(400, 'invalid_device');
  }
  let room = await groups.findOne({
    _id: parseSessionId(sessionId),
    expiresAt: { $gt: time },
  });
  if (!room || room.status === 'ended') {
    throw apiError(404, 'group_session_not_found');
  }
  let member = (room.members || []).find(
    (item) => item.userId === userId && item.deviceId === deviceId,
  );
  if (!member) throw apiError(403, 'not_a_group_member');
  if (!isOnline(member, time)) {
    room = await updateRoom(groups, room._id, (current) => ({
      ...current,
      members: current.members.map((item) =>
        item.memberId === member.memberId
          ? {
            ...item,
            lastSeenAt: time,
            needsCatchUp: current.playing === true || item.needsCatchUp,
          }
          : item),
    }), time);
    member = room.members.find((item) => item.memberId === member.memberId);
  }
  const priorHostMemberId = room.hostMemberId;
  room = await refreshHost(groups, room, time);
  if (priorHostMemberId !== room.hostMemberId || room.status === 'ended') {
    emitRoom(room, time);
  }
  if (room.status === 'ended') throw apiError(404, 'group_session_not_found');
  member = room.members.find((item) => item.memberId === member.memberId);
  if (!member) throw apiError(403, 'not_a_group_member');
  return { room, member };
}

async function verifyTrackAccess(req, ids, getAccessibleTracks) {
  const rows = await getAccessibleTracks(req, ids);
  const accessible = new Set(rows.map((track) => track.id));
  if (ids.some((id) => !accessible.has(id))) {
    throw apiError(403, 'group_track_unavailable');
  }
}

async function verifyRoomTrackAccess(req, room, ids, getAccessibleTracks) {
  const checked = new Set();
  if (req.user?.id) {
    checked.add(req.user.id);
    await verifyTrackAccess(req, ids, getAccessibleTracks);
  }
  for (const member of room.members || []) {
    if (!member.userId || checked.has(member.userId)) continue;
    checked.add(member.userId);
    await verifyTrackAccess(
      { user: { id: member.userId } },
      ids,
      getAccessibleTracks,
    );
  }
}

function readyMembers(room, time) {
  const active = (room.members || []).filter((member) => isOnline(member, time));
  if (active.length === 0) return false;
  // In a multi-member room, don't schedule until at least 2 members are online
  // and ready.  A solo room (single member total) can still start immediately.
  if ((room.members || []).length > 1 && active.length < 2) return false;
  return active.every((member) => isReady(member, time));
}

function scheduleIfReady(room, time) {
  if (room.status !== 'preparing' || !room.playing || !readyMembers(room, time)) {
    return room;
  }
  return {
    ...room,
    status: 'scheduled',
    startAtServerTime: new Date(time.getTime() + 3_000).toISOString(),
  };
}

function emitRoom(room, time) {
  publishGroupEvent(String(room._id), {
    room: publicRoom(room, time),
    serverTime: time.toISOString(),
  });
}

function createMember(req, device, time) {
  return {
    memberId: crypto.randomUUID(),
    userId: req.user.id,
    deviceId: device.deviceId,
    name: String(req.user.displayName || device.name).slice(0, 80),
    platform: device.platform,
    joinedAt: time,
    lastSeenAt: time,
    ready: false,
    readyAt: null,
    needsCatchUp: false,
    driftMs: null,
    clockOffsetMs: 0,
    latencyCompensationMs: 0,
  };
}

async function onlineDevice(collection, userId, deviceId, time) {
  const device = await collection('playback_devices').findOne({
    userId,
    deviceId,
    lastSeenAt: { $gte: new Date(time.getTime() - MEMBER_ONLINE_MS) },
  });
  if (!device) throw apiError(409, 'device_offline');
  return device;
}

export function createGroupListeningRouter({
  collection = col,
  now = () => new Date(),
  getAccessibleTracks = async () => [],
} = {}) {
  const router = express.Router();
  const groups = () => collection('group_listening_sessions');

  router.post('/group-listening', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      const time = now();
      const title = String(req.body?.title || '').trim();
      const deviceId = String(req.body?.deviceId || '');
      const trackIds = req.body?.trackIds;
      const index = req.body?.index ?? 0;
      const positionMs = req.body?.positionMs ?? 0;
      const durationMs = req.body?.durationMs ?? 0;
      if (!title || title.length > 80) throw apiError(400, 'invalid_group_title');
      validateQueue(trackIds, index, positionMs);
      if (!Number.isSafeInteger(durationMs) || durationMs < 0 ||
          durationMs > MAX_POSITION_MS) {
        throw apiError(400, 'invalid_group_queue');
      }
      const device = await onlineDevice(collection, req.user.id, deviceId, time);
      const existingRoom = await groups().findOne({
        status: { $ne: 'ended' },
        expiresAt: { $gt: time },
        members: {
          $elemMatch: { userId: req.user.id, deviceId },
        },
      });
      if (existingRoom) {
        await verifyRoomTrackAccess(
          req,
          existingRoom,
          existingRoom.trackIds,
          getAccessibleTracks,
        );
        const { room: recoveredRoom } = await requireMember(
          groups(),
          String(existingRoom._id),
          req.user.id,
          deviceId,
          time,
        );
        await claimPlaybackDeviceForGroup({
          userId: req.user.id,
          deviceId,
          groupSessionId: String(recoveredRoom._id),
          groupSessionExpiresAt: recoveredRoom.expiresAt,
          collection,
          now,
        });
        res.json({ room: publicRoom(recoveredRoom, time), recovered: true });
        return;
      }
      await verifyTrackAccess(req, trackIds, getAccessibleTracks);
      const member = createMember(req, device, time);
      let room;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const code = crypto.randomBytes(8).toString('base64url')
          .slice(0, 8).toUpperCase();
        const document = {
          code,
          title,
          hostUserId: req.user.id,
          hostDeviceId: deviceId,
          hostMemberId: member.memberId,
          status: 'paused',
          trackIds,
          index,
          positionMs,
          durationMs,
          playing: false,
          startAtServerTime: null,
          stateVersion: 1,
          queueRevision: 1,
          members: [member],
          createdAt: time,
          updatedAt: time,
          expiresAt: new Date(time.getTime() + ROOM_TTL_MS),
        };
        try {
          const inserted = await groups().insertOne(document);
          room = { ...document, _id: inserted.insertedId };
          break;
        } catch (error) {
          if (error.code !== 11000 || attempt === 2) throw error;
        }
      }
      try {
        await claimPlaybackDeviceForGroup({
          userId: req.user.id,
          deviceId,
          groupSessionId: String(room._id),
          groupSessionExpiresAt: room.expiresAt,
          collection,
          now,
        });
      } catch (error) {
        await groups().deleteOne({ _id: room._id });
        throw error;
      }
      emitRoom(room, time);
      res.status(201).json({ room: publicRoom(room, time) });
    } catch (error) { next(error); }
  });

  router.post('/group-listening/join', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      const time = now();
      const code = String(req.body?.invitationCode || '')
        .trim().toUpperCase();
      const deviceId = String(req.body?.deviceId || '');
      if (!/^[A-Z0-9_-]{6,12}$/.test(code)) {
        throw apiError(400, 'invalid_invitation_code');
      }
      const room = await groups().findOne({
        code,
        status: { $ne: 'ended' },
        expiresAt: { $gt: time },
      });
      if (!room) throw apiError(404, 'group_session_not_found');
      await verifyRoomTrackAccess(req, room, room.trackIds, getAccessibleTracks);
      const device = await onlineDevice(collection, req.user.id, deviceId, time);
      const existing = (room.members || []).find(
        (member) => member.userId === req.user.id &&
          member.deviceId === deviceId,
      );
      if (existing) {
        await claimPlaybackDeviceForGroup({
          userId: req.user.id,
          deviceId,
          groupSessionId: String(room._id),
          groupSessionExpiresAt: room.expiresAt,
          collection,
          now,
        });
        res.json({ room: publicRoom(room, time) });
        return;
      }
      if ((room.members || []).length >= MAX_MEMBERS) {
        throw apiError(409, 'group_session_full');
      }
      const member = createMember(req, device, time);
      member.needsCatchUp = room.playing === true;
      await claimPlaybackDeviceForGroup({
        userId: req.user.id,
        deviceId,
        groupSessionId: String(room._id),
        groupSessionExpiresAt: room.expiresAt,
        collection,
        now,
      });
      try {
        const updated = await updateRoom(groups(), room._id, (current) => ({
          ...current,
          members: [
            ...current.members,
            member,
          ],
        }), time);
        emitRoom(updated, time);
        res.status(201).json({ room: publicRoom(updated, time) });
      } catch (error) {
        await releasePlaybackDeviceFromGroup({
          userId: req.user.id,
          deviceId,
          groupSessionId: String(room._id),
          collection,
        });
        throw error;
      }
    } catch (error) { next(error); }
  });

  router.get('/group-listening/:sessionId', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      const time = now();
      const { room } = await requireMember(
        groups(), req.params.sessionId, req.user.id, req.query.deviceId, time,
      );
      res.json({ room: publicRoom(room, time) });
    } catch (error) { next(error); }
  });

  router.post('/group-listening/:sessionId/heartbeat', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      const time = now();
      const deviceId = String(req.body?.deviceId || '');
      const { room, member } = await requireMember(
        groups(), req.params.sessionId, req.user.id, deviceId, time,
      );
      const {
        ready,
        trackId,
        positionMs,
        durationMs,
        bufferedMs,
        clockOffsetMs,
        latencyCompensationMs,
        positionTimestampMs,
      } = req.body || {};
      if (ready !== undefined && typeof ready !== 'boolean') {
        throw apiError(400, 'invalid_group_heartbeat');
      }
      if (positionMs !== undefined &&
          (!Number.isSafeInteger(positionMs) || positionMs < 0 ||
           positionMs > MAX_POSITION_MS)) {
        throw apiError(400, 'invalid_group_heartbeat');
      }
      if (durationMs !== undefined &&
          (!Number.isSafeInteger(durationMs) || durationMs < 0 ||
           durationMs > MAX_POSITION_MS)) {
        throw apiError(400, 'invalid_group_heartbeat');
      }
      if (bufferedMs !== undefined &&
          (!Number.isSafeInteger(bufferedMs) || bufferedMs < 0 ||
           bufferedMs > MAX_POSITION_MS)) {
        throw apiError(400, 'invalid_group_heartbeat');
      }
      if (clockOffsetMs !== undefined &&
          (!Number.isSafeInteger(clockOffsetMs) || Math.abs(clockOffsetMs) > 120_000)) {
        throw apiError(400, 'invalid_group_heartbeat');
      }
      if (latencyCompensationMs !== undefined &&
          (!Number.isSafeInteger(latencyCompensationMs) ||
           Math.abs(latencyCompensationMs) > 5_000)) {
        throw apiError(400, 'invalid_group_heartbeat');
      }
      if (positionTimestampMs !== undefined &&
          (!Number.isSafeInteger(positionTimestampMs) ||
           Math.abs(positionTimestampMs - time.getTime()) >
             MAX_POSITION_SAMPLE_AGE_MS)) {
        throw apiError(400, 'invalid_group_heartbeat');
      }
      if (ready && trackId !== room.trackIds[room.index]) {
        throw apiError(409, 'group_track_changed');
      }
      const hasUsableBuffer = bufferedMs !== undefined &&
        (bufferedMs >= MIN_GROUP_BUFFER_MS ||
          (durationMs > 0 && positionMs + bufferedMs >= durationMs));
      const memberReady = ready === true && hasUsableBuffer;
      const positionSampleTime = positionTimestampMs === undefined
        ? time
        : new Date(positionTimestampMs);
      const updated = await updateRoom(groups(), room._id, (current) => {
        const members = current.members.map((item) =>
          item.memberId === member.memberId
            ? {
                ...item,
                lastSeenAt: time,
                ...(ready !== undefined
                  ? { ready: memberReady, readyAt: memberReady ? time : null }
                  : {}),
                ...(memberReady && item.needsCatchUp
                  ? { needsCatchUp: false }
                  : {}),
                ...(clockOffsetMs !== undefined ? { clockOffsetMs } : {}),
                ...(latencyCompensationMs !== undefined
                  ? { latencyCompensationMs }
                  : {}),
                ...(positionMs !== undefined
                  ? {
                      reportedPositionMs: positionMs,
                      driftMs: Math.round(
                        positionMs - roomPosition(current, positionSampleTime),
                      ),
                    }
                  : {}),
              }
            : item);
        let next = {
          ...current,
          members,
          ...(durationMs !== undefined ? { durationMs } : {}),
        };
        if (next.playing && next.durationMs > 0 &&
            roomPosition(next, time) >= next.durationMs) {
          if (next.index + 1 < next.trackIds.length) {
            next = {
              ...next,
              index: next.index + 1,
              positionMs: 0,
              durationMs: 0,
              status: 'preparing',
              startAtServerTime: null,
              members: next.members.map((item) => ({
                ...item,
                ready: false,
                readyAt: null,
              })),
              queueRevision: (next.queueRevision || 0) + 1,
            };
          } else {
            next = {
              ...next,
              playing: false,
              status: 'paused',
              positionMs: 0,
              startAtServerTime: null,
            };
          }
        }
        if (next.status === 'scheduled' && !readyMembers(next, time)) {
          if (new Date(next.startAtServerTime).getTime() > time.getTime()) {
            next = {
              ...next,
              status: 'preparing',
              startAtServerTime: null,
            };
          } else {
            next = { ...next, status: 'playing' };
          }
        }
        return scheduleIfReady(next, time);
      }, time);
      if (updated.status !== room.status || updated.index !== room.index ||
          updated.hostMemberId !== room.hostMemberId) {
        emitRoom(updated, time);
      }
      res.json({
        room: publicRoom(updated, time),
        driftMs: updated.members.find(
          (item) => item.memberId === member.memberId,
        )?.driftMs ?? null,
        catchUpAtServerTime: member.needsCatchUp && memberReady
        ? new Date(time.getTime() + 2_000).toISOString()
        : null,
      });
    } catch (error) { next(error); }
  });

  router.post('/group-listening/:sessionId/control', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      const time = now();
      const deviceId = String(req.body?.deviceId || '');
      const action = String(req.body?.action || '');
      const { room, member } = await requireMember(
        groups(), req.params.sessionId, req.user.id, deviceId, time,
      );
      if (HOST_ONLY_CONTROL_ACTIONS.has(action) &&
          member.memberId !== room.hostMemberId &&
          member.userId !== room.hostUserId) {
        throw apiError(403, 'group_host_required');
      }
      let addedTrackId = null;
      let replacementTrackIds = null;
      if (action === 'queueAdd') {
        addedTrackId = req.body?.trackId;
        if (typeof addedTrackId !== 'string' || !addedTrackId ||
            addedTrackId.length > 256 || room.trackIds.length >= MAX_QUEUE_SIZE ||
            !['next', 'last'].includes(req.body?.placement)) {
          throw apiError(400, 'invalid_group_command');
        }
        await verifyRoomTrackAccess(
          req,
          room,
          [addedTrackId],
          getAccessibleTracks,
        );
      } else if (action === 'queueReplace') {
        replacementTrackIds = req.body?.trackIds;
        const index = req.body?.index ?? 0;
        validateQueue(replacementTrackIds, index, 0);
        await verifyRoomTrackAccess(
          req,
          room,
          replacementTrackIds,
          getAccessibleTracks,
        );
      }
      const updated = await updateRoom(groups(), room._id, (current) => {
        if (HOST_ONLY_CONTROL_ACTIONS.has(action) &&
            member.memberId !== current.hostMemberId &&
            member.userId !== current.hostUserId) {
          throw apiError(403, 'group_host_required');
        }
        const currentPosition = roomPosition(current, time);
        switch (action) {
          case 'play':
            return scheduleIfReady({
              ...current,
              playing: true,
              status: 'preparing',
              positionMs: currentPosition,
              startAtServerTime: null,
            }, time);
          case 'pause':
            if (!current.playing) return current;
            {
              const pauseAt = new Date(time.getTime() + GROUP_PAUSE_LEAD_MS);
              const positionMs = roomPosition(current, time) +
                GROUP_PAUSE_LEAD_MS;
              return {
                ...current,
                playing: false,
                status: 'paused',
                positionMs: current.durationMs > 0
                  ? Math.min(positionMs, current.durationMs)
                  : positionMs,
                startAtServerTime: pauseAt.toISOString(),
              };
            }
          case 'seek': {
            const positionMs = req.body?.positionMs;
            if (!Number.isSafeInteger(positionMs) || positionMs < 0 ||
                positionMs > MAX_POSITION_MS) {
              throw apiError(400, 'invalid_group_command');
            }
            return {
              ...current,
              positionMs,
              startAtServerTime: null,
              status: current.playing ? 'preparing' : 'paused',
              members: current.members.map((item) => ({
                ...item,
                ready: false,
                readyAt: null,
              })),
            };
          }
          case 'next':
          case 'previous':
          case 'queuePlay': {
            const index = action === 'next'
              ? Math.min(current.trackIds.length - 1, current.index + 1)
              : action === 'previous'
              ? Math.max(0, current.index - 1)
              : req.body?.index;
            if (!Number.isSafeInteger(index) ||
                index < 0 || index >= current.trackIds.length) {
              throw apiError(400, 'invalid_group_command');
            }
            const playing = current.playing;
            return scheduleIfReady({
              ...current,
              index,
              positionMs: 0,
              durationMs: 0,
              playing,
              status: playing ? 'preparing' : 'paused',
              startAtServerTime: null,
              members: current.members.map((item) => ({
                ...item,
                ready: false,
                readyAt: null,
              })),
              queueRevision: (current.queueRevision || 0) + 1,
            }, time);
          }
          case 'queueAdd':
            {
              const trackIds = [...current.trackIds];
              const insertAt = req.body?.placement === 'next'
                ? Math.min(current.index + 1, trackIds.length)
                : trackIds.length;
              trackIds.splice(insertAt, 0, addedTrackId);
            return {
              ...current,
              trackIds,
              queueRevision: (current.queueRevision || 0) + 1,
            };
            }
          case 'queueReplace': {
            const index = req.body?.index ?? 0;
            return {
              ...current,
              trackIds: replacementTrackIds,
              index,
              positionMs: 0,
              durationMs: 0,
              playing: true,
              status: 'preparing',
              startAtServerTime: null,
              members: current.members.map((item) => ({
                ...item,
                ready: false,
                readyAt: null,
              })),
              queueRevision: (current.queueRevision || 0) + 1,
            };
          }
          case 'queueClear':
            return {
              ...current,
              trackIds: [],
              index: 0,
              positionMs: 0,
              durationMs: 0,
              playing: false,
              status: 'paused',
              startAtServerTime: null,
              queueRevision: (current.queueRevision || 0) + 1,
            };
          case 'queueRemove': {
            const index = req.body?.index;
            if (!Number.isSafeInteger(index) || index < 0 ||
                index >= current.trackIds.length) {
              throw apiError(400, 'invalid_group_command');
            }
            const trackIds = [...current.trackIds];
            trackIds.splice(index, 1);
            if (!trackIds.length) {
              return {
                ...current,
                trackIds,
                index: 0,
                positionMs: 0,
                playing: false,
                status: 'paused',
                startAtServerTime: null,
                queueRevision: (current.queueRevision || 0) + 1,
              };
            }
            const nextIndex = index < current.index
              ? current.index - 1
              : index === current.index
              ? Math.min(index, trackIds.length - 1)
              : current.index;
            const changedTrack = nextIndex !== current.index;
            return {
              ...current,
              trackIds,
              index: nextIndex,
              ...(changedTrack ? { positionMs: 0, durationMs: 0 } : {}),
              ...(changedTrack ? {
                status: current.playing ? 'preparing' : 'paused',
                members: current.members.map((item) => ({
                  ...item,
                  ready: false,
                  readyAt: null,
                })),
              } : {}),
              queueRevision: (current.queueRevision || 0) + 1,
            };
          }
          case 'queueReorder': {
            const { from, to } = req.body || {};
            if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) ||
                from < 0 || to < 0 ||
                from >= current.trackIds.length || to >= current.trackIds.length) {
              throw apiError(400, 'invalid_group_command');
            }
            const trackIds = [...current.trackIds];
            const [trackId] = trackIds.splice(from, 1);
            trackIds.splice(to, 0, trackId);
            const index = current.index === from
              ? to
              : from < current.index && to >= current.index
              ? current.index - 1
              : from > current.index && to <= current.index
              ? current.index + 1
              : current.index;
            return {
              ...current,
              trackIds,
              index,
              queueRevision: (current.queueRevision || 0) + 1,
            };
          }
          case 'setChannel': {
            const targetMemberId = String(req.body?.memberId || '');
            const channel = String(req.body?.channel || '');
            if (!targetMemberId || !VALID_AUDIO_CHANNELS.has(channel)) {
              throw apiError(400, 'invalid_group_command');
            }
            const exists = (current.members || []).some(
              (item) => item.memberId === targetMemberId,
            );
            if (!exists) throw apiError(404, 'group_member_not_found');
            return {
              ...current,
              channelLayout: 'custom',
              members: (current.members || []).map((item) =>
                item.memberId === targetMemberId
                  ? { ...item, audioChannel: channel }
                  : item,
              ),
            };
          }
          case 'setChannelLayout': {
            const layout = String(req.body?.layout || '');
            if (!Object.prototype.hasOwnProperty.call(CHANNEL_LAYOUT_PRESETS, layout)) {
              throw apiError(400, 'invalid_group_command');
            }
            const slots = CHANNEL_LAYOUT_PRESETS[layout];
            const orderedOnline = (current.members || [])
              .filter((item) => isOnline(item, time))
              .sort((a, b) =>
                new Date(a.joinedAt || 0).getTime() -
                new Date(b.joinedAt || 0).getTime(),
              );
            const assignments = new Map();
            orderedOnline.forEach((item, idx) => {
              assignments.set(
                item.memberId,
                slots ? (slots[idx] || 'full') : 'full',
              );
            });
            return {
              ...current,
              channelLayout: layout,
              members: (current.members || []).map((item) => ({
                ...item,
                audioChannel: assignments.get(item.memberId) || 'full',
              })),
            };
          }
          case 'end':
            return {
              ...current,
              status: 'ended',
              playing: false,
              endedAt: time,
              startAtServerTime: null,
            };
          default:
            throw apiError(400, 'invalid_group_command');
        }
      }, time);
      if (updated.status === 'ended') {
        await Promise.all(updated.members.map((item) =>
          releasePlaybackDeviceFromGroup({
            userId: item.userId,
            deviceId: item.deviceId,
            groupSessionId: String(updated._id),
            collection,
          })));
      }
      emitRoom(updated, time);
      if (updated.status === 'ended') {
        removeGroupRoomSockets(String(updated._id));
      }
      res.json({ room: publicRoom(updated, time), actorMemberId: member.memberId });
    } catch (error) { next(error); }
  });

  router.post('/group-listening/:sessionId/invite-devices', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      const time = now();
      const deviceId = String(req.body?.deviceId || '');
      const { room } = await requireMember(
        groups(), req.params.sessionId, req.user.id, deviceId, time,
      );
      const requestedIds = Array.isArray(req.body?.deviceIds)
        ? new Set(req.body.deviceIds.map((v) => String(v)))
        : null;
      const joinedDeviceIds = new Set(
        (room.members || [])
          .filter((m) => m.userId === req.user.id)
          .map((m) => m.deviceId),
      );
      const onlineThreshold = new Date(time.getTime() - MEMBER_ONLINE_MS);
      const devices = await collection('playback_devices')
        .find({
          userId: req.user.id,
          lastSeenAt: { $gte: onlineThreshold },
        })
        .toArray();
      const invitedDeviceIds = [];
      for (const target of devices) {
        if (!target.deviceId || target.deviceId === deviceId) continue;
        if (joinedDeviceIds.has(target.deviceId)) continue;
        if (target.capabilities?.playback === false) continue;
        if (requestedIds && !requestedIds.has(target.deviceId)) continue;
        invitedDeviceIds.push(target.deviceId);
        publishAccountSyncInvite(req.user.id, target.deviceId, {
          sessionId: String(room._id),
          invitationCode: room.code,
          title: room.title,
          hostDeviceId: deviceId,
        });
      }
      res.json({
        invitedDeviceIds,
        invitationCode: room.code,
      });
    } catch (error) { next(error); }
  });

  router.post('/group-listening/:sessionId/leave', async (req, res, next) => {
    if (!requirePersonalAccount(req, res)) return;
    try {
      const time = now();
      const deviceId = String(req.body?.deviceId || '');
      const { room, member } = await requireMember(
        groups(), req.params.sessionId, req.user.id, deviceId, time,
      );
      await releasePlaybackDeviceFromGroup({
        userId: req.user.id,
        deviceId,
        groupSessionId: String(room._id),
        collection,
      });
      const updated = await updateRoom(groups(), room._id, (current) => {
        const members = current.members.filter(
          (item) => item.memberId !== member.memberId,
        );
        if (!members.length) {
          return {
            ...current,
            members,
            status: 'ended',
            playing: false,
            endedAt: time,
            startAtServerTime: null,
          };
        }
        const next = { ...current, members };
        if (current.hostMemberId === member.memberId) {
          const nextHost = members
            .filter((item) => isOnline(item, time))
            .sort((left, right) =>
              new Date(left.joinedAt).getTime() -
              new Date(right.joinedAt).getTime())[0];
          if (nextHost) {
            next.hostMemberId = nextHost.memberId;
            next.hostUserId = nextHost.userId;
            next.hostDeviceId = nextHost.deviceId;
          } else {
            next.status = 'ended';
            next.playing = false;
            next.endedAt = time;
            next.startAtServerTime = null;
          }
        }
        if (next.status === 'preparing') return scheduleIfReady(next, time);
        return next;
      }, time);
      if (updated.status === 'ended') {
        await Promise.all(updated.members.map((item) =>
          releasePlaybackDeviceFromGroup({
            userId: item.userId,
            deviceId: item.deviceId,
            groupSessionId: String(updated._id),
            collection,
          })));
      }
      emitRoom(updated, time);
      if (updated.status === 'ended') {
        removeGroupRoomSockets(String(updated._id));
      } else {
        removeGroupDeviceFromRoom(
          String(updated._id),
          req.user.id,
          deviceId,
        );
      }
      res.json({ room: publicRoom(updated, time) });
    } catch (error) { next(error); }
  });

  return router;
}

export function attachGroupListeningSocketHandlers(
  io,
  { collection = col, now = () => new Date() } = {},
) {
  io.on('connection', (socket) => {
    const rateWindow = [];
    const rateLimit = () => {
      const cutoff = Date.now() - 10_000;
      while (rateWindow.length && rateWindow[0] < cutoff) rateWindow.shift();
      rateWindow.push(Date.now());
      return rateWindow.length <= 40;
    };

    socket.on('group:watch', async (raw, callback) => {
      try {
        if (!rateLimit()) throw apiError(429, 'rate_limited');
        const sessionId = String(raw?.sessionId || '');
        const roomId = parseSessionId(sessionId);
        const deviceId = socket.data.deviceId;
        if (!deviceId) throw apiError(401, 'device_not_registered');
        const time = now();
        const { room } = await requireMember(
          collection('group_listening_sessions'),
          sessionId,
          socket.data.userId,
          deviceId,
          time,
        );
        await socket.join(groupRoom(String(roomId)));
        if (typeof callback === 'function') {
          callback({
            ok: true,
            crossInstance: playbackEventsAreShared(),
            room: publicRoom(room, time),
          });
        }
      } catch (error) {
        if (typeof callback === 'function') {
          callback({ ok: false, error: error.code || 'group_socket_failed' });
        }
      }
    });

    socket.on('group:unwatch', async (raw, callback) => {
      try {
        if (!rateLimit()) throw apiError(429, 'rate_limited');
        const roomId = parseSessionId(String(raw?.sessionId || ''));
        await socket.leave(groupRoom(String(roomId)));
        if (typeof callback === 'function') callback({ ok: true });
      } catch (error) {
        if (typeof callback === 'function') {
          callback({ ok: false, error: error.code || 'group_socket_failed' });
        }
      }
    });

    socket.on('group:clock', (_raw, callback) => {
      if (!rateLimit() || !socket.data.deviceId) {
        if (typeof callback === 'function') {
          callback({
            ok: false,
            error: !socket.data.deviceId ? 'device_not_registered' : 'rate_limited',
          });
        }
        return;
      }
      if (typeof callback === 'function') {
        callback({ ok: true, serverTime: now().toISOString() });
      }
    });
  });
}
