import { randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { compileTrustedProxy } from './trusted-proxy.js';

export const AVATAR_IDS = ['fox', 'cat', 'otter', 'owl', 'panda', 'rabbit'] as const;
type AvatarId = (typeof AVATAR_IDS)[number];

export interface LiveKitGateway {
  createRoom(options: { name: string; maxParticipants: number; emptyTimeout: number; departureTimeout: number }, signal?: AbortSignal): Promise<void>;
  createAccessToken(input: {
    participantId: string;
    name: string;
    roomName: string;
    metadata: string;
    grants: { roomJoin: true; canPublish: true; canSubscribe: true; canPublishData: boolean; canPublishSources: string[]; roomAdmin?: true };
    maximumTtlSeconds: number;
    expiresAtMs: number;
  }): Promise<string>;
  roomExists(roomName: string, signal?: AbortSignal): Promise<boolean>;
  removeParticipant(roomName: string, participantId: string): Promise<void>;
  mutePublishedTrack(roomName: string, participantId: string, trackSid: string, muted: boolean): Promise<void>;
  deleteRoom(roomName: string): Promise<void>;
}

export class RoomExpiredError extends Error {
  readonly code = 'room_expired';
}

export interface ApiConfig {
  livekitUrl: string;
  livekitPublicUrl: string;
  apiKey: string;
  apiSecret: string;
  tokenTtlSeconds: number;
  roomCacheMaxEntries: number;
  roomSweepTimeoutMs: number;
  livekitRequestTimeoutMs: number;
  trustedProxyCidrs: string[];
  rateLimit: { max: number; timeWindowMs: number; maxKeys: number };
}

export interface CreateAppOptions {
  config: ApiConfig;
  livekit: LiveKitGateway;
  roomId?: () => string;
  participantId?: () => string;
  now?: () => number;
  hostSecret?: () => string;
  participantSecret?: () => string;
}

const ROOM_ID_PATTERN = /^room_[a-z0-9]{20,}$/;
const MUTATING_METHODS = new Set(['POST']);
const ROOM_LINK_LIFETIME_MS = 300_000;
const DEFAULT_MAX_PARTICIPANTS = 10;
const MAX_PARTICIPANTS = 50;

interface RoomState {
  expiresAt: number;
  reservedParticipants: number;
  maxParticipants: number;
  hostSecret: string;
  participantSecret: string;
  locked: boolean;
}

interface RateLimitEntry {
  count: number;
  expiresAt: number;
}

type RoomRefreshResult = 'renewed' | 'missing' | 'unavailable' | 'timed_out';

class LiveKitTimeoutError extends Error {}

const ROOM_SWEEP_BATCH_SIZE = 25;
const RATE_LIMIT_SWEEP_BATCH_SIZE = 10;

const defaultRoomId = () => `room_${randomBytes(16).toString('hex')}`;
const defaultParticipantId = () => `participant_${randomBytes(16).toString('hex')}`;

const isAvatarId = (value: unknown): value is AvatarId => typeof value === 'string' && (AVATAR_IDS as readonly string[]).includes(value);

const parseJoin = (body: unknown): { nickname: string; avatarId: AvatarId } | undefined => {
  if (!body || typeof body !== 'object') return undefined;
  const { nickname, avatarId } = body as Record<string, unknown>;
  if (typeof nickname !== 'string' || !isAvatarId(avatarId)) return undefined;
  const trimmed = nickname.trim();
  if (Array.from(trimmed).length < 1 || Array.from(trimmed).length > 32) return undefined;
  return { nickname: trimmed, avatarId };
};

const parseMaxParticipants = (body: unknown): number | undefined => {
  if (!body || typeof body !== 'object') return DEFAULT_MAX_PARTICIPANTS;
  const value = (body as Record<string, unknown>).maxParticipants;
  if (value === undefined) return DEFAULT_MAX_PARTICIPANTS;
  return typeof value === 'number' && Number.isInteger(value) && value >= 2 && value <= MAX_PARTICIPANTS ? value : undefined;
};

const secretMatches = (actual: string | undefined, expected: string): boolean => {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};

export const createApp = (options: CreateAppOptions): FastifyInstance => {
  const app = Fastify({ logger: false, trustProxy: compileTrustedProxy(options.config.trustedProxyCidrs) });
  const knownRooms = new Map<string, RoomState>();
  const rateLimits = new Map<string, RateLimitEntry>();
  let pendingCreates = 0;
  let roomSweepCursor = 0;
  const createRoomId = options.roomId ?? defaultRoomId;
  const createParticipantId = options.participantId ?? defaultParticipantId;
  const createHostSecret = options.hostSecret ?? (() => randomBytes(32).toString('base64url'));
  const createParticipantSecret = options.participantSecret ?? (() => randomBytes(32).toString('base64url'));
  const now = options.now ?? Date.now;

  const withLiveKitDeadline = <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      reject(new LiveKitTimeoutError());
    }, options.config.livekitRequestTimeoutMs);
    void Promise.resolve()
      .then(() => operation(controller.signal))
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      }, (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      });
  });

  const sweepKnownRooms = async (): Promise<void> => {
    const sweepTime = now();
    const expiredRooms = [...knownRooms.entries()].filter(([, room]) => room.expiresAt <= sweepTime);
    if (expiredRooms.length === 0) {
      roomSweepCursor = 0;
      return;
    }
    const start = roomSweepCursor % expiredRooms.length;
    const candidates = Array.from(
      { length: Math.min(ROOM_SWEEP_BATCH_SIZE, expiredRooms.length) },
      (_, index) => expiredRooms[(start + index) % expiredRooms.length]!
    );
    roomSweepCursor = (start + candidates.length) % expiredRooms.length;
    await new Promise<void>((resolve) => {
      let finished = false;
      let remaining = candidates.length;
      const controller = new AbortController();
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        controller.abort();
        finish();
      }, options.config.roomSweepTimeoutMs);
      for (const [roomId, room] of candidates) {
        void Promise.resolve()
          .then(() => options.livekit.roomExists(roomId, controller.signal))
          .then((exists) => {
            if (finished || knownRooms.get(roomId) !== room) return;
            if (exists) room.expiresAt = sweepTime + ROOM_LINK_LIFETIME_MS;
            else knownRooms.delete(roomId);
          })
          .catch(() => undefined)
          .finally(() => {
            remaining -= 1;
            if (remaining === 0) finish();
          });
      }
    });
  };

  const refreshExpiredRoom = async (roomId: string, room: RoomState): Promise<RoomRefreshResult> => {
    try {
      if (!await withLiveKitDeadline((signal) => options.livekit.roomExists(roomId, signal))) {
        knownRooms.delete(roomId);
        return 'missing';
      }
      room.expiresAt = now() + ROOM_LINK_LIFETIME_MS;
      return 'renewed';
    } catch (error) {
      if (error instanceof LiveKitTimeoutError) return 'timed_out';
      return 'unavailable';
    }
  };

  const sweepRateLimits = (sweepTime: number): void => {
    let visited = 0;
    for (const [address, entry] of rateLimits) {
      if (visited >= RATE_LIMIT_SWEEP_BATCH_SIZE) return;
      visited += 1;
      if (entry.expiresAt <= sweepTime) rateLimits.delete(address);
    }
  };

  app.setErrorHandler((error, _request, reply) => {
    const details = error as { code?: unknown; statusCode?: unknown; validation?: unknown };
    const statusCode = typeof details.statusCode === 'number' ? details.statusCode : 500;
    if (details.code === 'FST_ERR_CTP_INVALID_JSON_BODY') return reply.code(statusCode).send({ error: 'invalid_json' });
    if (details.validation !== undefined) return reply.code(statusCode).send({ error: 'invalid_request' });
    return reply.code(statusCode >= 400 && statusCode < 500 ? statusCode : 500).send({ error: 'internal_error' });
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method)) return;
    const contentType = request.headers['content-type'];
    const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType && mediaType !== 'application/json' && !/^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType)) {
      return reply.code(415).send({ error: 'invalid_request' });
    }
    const key = clientAddress(request);
    const requestTime = now();
    sweepRateLimits(requestTime);
    const existing = rateLimits.get(key);
    if (existing && existing.expiresAt <= requestTime) rateLimits.delete(key);
    const current = rateLimits.get(key);
    if (!current && rateLimits.size >= options.config.rateLimit.maxKeys) {
      return reply.code(429).send({ error: 'rate_limited' });
    }
    if (current && current.count >= options.config.rateLimit.max) {
      return reply.code(429).send({ error: 'rate_limited' });
    }
    if (current) current.count += 1;
    else rateLimits.set(key, { count: 1, expiresAt: requestTime + options.config.rateLimit.timeWindowMs });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/api/rooms', async (_request, reply) => {
    const maxParticipants = parseMaxParticipants(_request.body);
    if (maxParticipants === undefined) return reply.code(400).send({ error: 'invalid_max_participants' });
    const roomId = createRoomId();
    if (!ROOM_ID_PATTERN.test(roomId)) return reply.code(502).send({ error: 'room_service_unavailable' });
    if (knownRooms.size + pendingCreates >= options.config.roomCacheMaxEntries) {
      await sweepKnownRooms();
      if (knownRooms.size + pendingCreates >= options.config.roomCacheMaxEntries) return reply.code(503).send({ error: 'room_cache_full' });
    }
    pendingCreates += 1;
    try {
      await withLiveKitDeadline((signal) => options.livekit.createRoom({ name: roomId, maxParticipants, emptyTimeout: 300, departureTimeout: 300 }, signal));
      const hostSecret = createHostSecret();
      const participantSecret = createParticipantSecret();
      knownRooms.set(roomId, { expiresAt: now() + ROOM_LINK_LIFETIME_MS, reservedParticipants: 0, maxParticipants, hostSecret, participantSecret, locked: false });
      return reply.code(201).send({
        roomId,
        hostUrl: `/meeting/${roomId}?hostToken=${encodeURIComponent(hostSecret)}`,
        participantUrl: `/meeting/${roomId}?participantToken=${encodeURIComponent(participantSecret)}`
      });
    } catch (error) {
      return reply.code(error instanceof LiveKitTimeoutError ? 503 : 502).send({ error: 'room_service_unavailable' });
    } finally {
      pendingCreates -= 1;
    }
  });

  app.post('/api/rooms/:roomId/join', async (request, reply) => {
    const { roomId } = request.params as { roomId: string };
    const room = knownRooms.get(roomId);
    if (!room) return reply.code(404).send({ error: 'room_not_found' });
    const requestTime = now();
    if (requestTime >= room.expiresAt) {
      const refreshResult = await refreshExpiredRoom(roomId, room);
      if (refreshResult === 'missing') return reply.code(404).send({ error: 'room_not_found' });
      if (refreshResult === 'unavailable') return reply.code(502).send({ error: 'room_service_unavailable' });
      if (refreshResult === 'timed_out') return reply.code(503).send({ error: 'room_service_unavailable' });
    }
    const joinBody = request.body as Record<string, unknown> | undefined;
    const hostToken = typeof joinBody?.hostToken === 'string' ? joinBody.hostToken : undefined;
    const participantToken = typeof joinBody?.participantToken === 'string' ? joinBody.participantToken : undefined;
    const isHost = secretMatches(hostToken, room.hostSecret);
    if (!isHost && !secretMatches(participantToken, room.participantSecret)) {
      return reply.code(403).send({ error: 'credential_invalid' });
    }
    if (room.locked && !isHost) return reply.code(409).send({ error: 'room_locked' });
    const identity = parseJoin(request.body);
    if (!identity) return reply.code(400).send({ error: 'invalid_join_request' });
    if (room.reservedParticipants >= room.maxParticipants) {
      return reply.code(409).send({ error: 'room_full' });
    }

    const participantId = createParticipantId();
    const metadata = JSON.stringify(identity);
    room.reservedParticipants += 1;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (Math.floor((room.expiresAt - now()) / 1000) < 1) {
        const refreshResult = await refreshExpiredRoom(roomId, room);
        if (refreshResult === 'renewed') continue;
        room.reservedParticipants -= 1;
        if (refreshResult === 'missing') return reply.code(404).send({ error: 'room_not_found' });
        if (refreshResult === 'timed_out') return reply.code(503).send({ error: 'room_service_unavailable' });
        return reply.code(502).send({ error: 'room_service_unavailable' });
      }
      try {
        const token = await options.livekit.createAccessToken({
          participantId,
          name: identity.nickname,
          roomName: roomId,
          metadata,
          grants: { roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, canPublishSources: ['microphone', 'camera', 'screen_share'], ...(isHost ? { roomAdmin: true as const } : {}) },
          maximumTtlSeconds: options.config.tokenTtlSeconds,
          expiresAtMs: room.expiresAt
        });
        room.reservedParticipants -= 1;
        return { participantId, livekitUrl: options.config.livekitPublicUrl, token };
      } catch (error) {
        if (!isRoomExpiredError(error)) {
          room.reservedParticipants -= 1;
          return reply.code(502).send({ error: 'token_service_unavailable' });
        }
        const refreshResult = await refreshExpiredRoom(roomId, room);
        if (refreshResult === 'renewed' && attempt === 0) continue;
        room.reservedParticipants -= 1;
        if (refreshResult === 'missing') return reply.code(404).send({ error: 'room_not_found' });
        if (refreshResult === 'timed_out') return reply.code(503).send({ error: 'room_service_unavailable' });
        return reply.code(502).send({ error: 'token_service_unavailable' });
      }
    }
    room.reservedParticipants -= 1;
    return reply.code(502).send({ error: 'token_service_unavailable' });
  });

  const hostSecretFromRequest = (request: FastifyRequest): string | undefined => {
    const body = request.body as Record<string, unknown> | undefined;
    const header = request.headers['x-host-token'];
    return typeof body?.hostToken === 'string' ? body.hostToken : typeof header === 'string' ? header : undefined;
  };

  const requireHost = (request: FastifyRequest, roomId: string, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): RoomState | undefined => {
    const room = knownRooms.get(roomId);
    if (!room) {
      void reply.code(404).send({ error: 'room_not_found' });
      return undefined;
    }
    if (!secretMatches(hostSecretFromRequest(request), room.hostSecret)) {
      void reply.code(403).send({ error: 'host_forbidden' });
      return undefined;
    }
    return room;
  };

  app.post('/api/rooms/:roomId/lock', async (request, reply) => {
    const { roomId } = request.params as { roomId: string };
    const room = requireHost(request, roomId, reply);
    if (!room) return;
    const body = request.body as Record<string, unknown> | undefined;
    room.locked = body?.locked !== false;
    return reply.code(200).send({ locked: room.locked });
  });

  app.post('/api/rooms/:roomId/participants/:participantId/remove', async (request, reply) => {
    const { roomId, participantId } = request.params as { roomId: string; participantId: string };
    if (!requireHost(request, roomId, reply)) return;
    try {
      await options.livekit.removeParticipant(roomId, participantId);
      return reply.code(204).send();
    } catch {
      return reply.code(502).send({ error: 'room_service_unavailable' });
    }
  });

  app.post('/api/rooms/:roomId/participants/:participantId/mute', async (request, reply) => {
    const { roomId, participantId } = request.params as { roomId: string; participantId: string };
    if (!requireHost(request, roomId, reply)) return;
    const body = request.body as Record<string, unknown> | undefined;
    if (typeof body?.trackSid !== 'string' || typeof body.muted !== 'boolean') return reply.code(400).send({ error: 'invalid_request' });
    try {
      await options.livekit.mutePublishedTrack(roomId, participantId, body.trackSid, body.muted);
      return reply.code(204).send();
    } catch {
      return reply.code(502).send({ error: 'room_service_unavailable' });
    }
  });

  app.post('/api/rooms/:roomId/end', async (request, reply) => {
    const { roomId } = request.params as { roomId: string };
    if (!requireHost(request, roomId, reply)) return;
    try {
      await options.livekit.deleteRoom(roomId);
      knownRooms.delete(roomId);
      return reply.code(204).send();
    } catch {
      return reply.code(502).send({ error: 'room_service_unavailable' });
    }
  });

  return app;
};

const clientAddress = (request: FastifyRequest): string => request.ip;

const isRoomExpiredError = (error: unknown): error is RoomExpiredError =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'room_expired';
