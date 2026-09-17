import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

export const AVATAR_IDS = ['fox', 'cat', 'otter', 'owl', 'panda', 'rabbit'] as const;
type AvatarId = (typeof AVATAR_IDS)[number];

export interface LiveKitGateway {
  createRoom(options: { name: string; maxParticipants: number; emptyTimeout: number; departureTimeout: number }): Promise<void>;
  createAccessToken(input: {
    participantId: string;
    name: string;
    roomName: string;
    metadata: string;
    grants: { roomJoin: true; canPublish: true; canSubscribe: true; canPublishData: false; canPublishSources: ['microphone'] };
    maximumTtlSeconds: number;
    expiresAtMs: number;
  }): Promise<string>;
  roomExists(roomName: string): Promise<boolean>;
}

export class RoomExpiredError extends Error {
  readonly code = 'room_expired';
}

export interface ApiConfig {
  livekitUrl: string;
  apiKey: string;
  apiSecret: string;
  tokenTtlSeconds: number;
  roomCacheMaxEntries: number;
  trustProxy: boolean;
  rateLimit: { max: number; timeWindowMs: number; maxKeys: number };
}

export interface CreateAppOptions {
  config: ApiConfig;
  livekit: LiveKitGateway;
  roomId?: () => string;
  participantId?: () => string;
  now?: () => number;
}

const ROOM_ID_PATTERN = /^room_[a-z0-9]{20,}$/;
const MUTATING_METHODS = new Set(['POST']);
const ROOM_LINK_LIFETIME_MS = 300_000;
const MAX_PARTICIPANTS = 10;

interface RoomState {
  expiresAt: number;
  reservedParticipants: number;
}

interface RateLimitEntry {
  count: number;
  expiresAt: number;
}

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

export const createApp = (options: CreateAppOptions): FastifyInstance => {
  const app = Fastify({ logger: false, trustProxy: options.config.trustProxy });
  const knownRooms = new Map<string, RoomState>();
  const rateLimits = new Map<string, RateLimitEntry>();
  const createRoomId = options.roomId ?? defaultRoomId;
  const createParticipantId = options.participantId ?? defaultParticipantId;
  const now = options.now ?? Date.now;

  const sweepKnownRooms = async (): Promise<void> => {
    const sweepTime = now();
    let visited = 0;
    for (const [roomId, room] of knownRooms) {
      if (visited >= ROOM_SWEEP_BATCH_SIZE) return;
      visited += 1;
      if (room.expiresAt > sweepTime) continue;
      try {
        if (await options.livekit.roomExists(roomId)) room.expiresAt = sweepTime + ROOM_LINK_LIFETIME_MS;
        else knownRooms.delete(roomId);
      } catch {
        // Keep the room on transient SFU errors; join will report the service error if needed.
      }
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
    await sweepKnownRooms();
    if (knownRooms.size >= options.config.roomCacheMaxEntries) return reply.code(503).send({ error: 'room_cache_full' });
    const roomId = createRoomId();
    if (!ROOM_ID_PATTERN.test(roomId)) return reply.code(502).send({ error: 'room_service_unavailable' });
    try {
      await options.livekit.createRoom({ name: roomId, maxParticipants: MAX_PARTICIPANTS, emptyTimeout: 300, departureTimeout: 300 });
      knownRooms.set(roomId, { expiresAt: now() + ROOM_LINK_LIFETIME_MS, reservedParticipants: 0 });
      return reply.code(201).send({ roomId });
    } catch {
      return reply.code(502).send({ error: 'room_service_unavailable' });
    }
  });

  app.post('/api/rooms/:roomId/join', async (request, reply) => {
    await sweepKnownRooms();
    const { roomId } = request.params as { roomId: string };
    const room = knownRooms.get(roomId);
    if (!room) return reply.code(404).send({ error: 'room_not_found' });
    const requestTime = now();
    if (requestTime >= room.expiresAt) {
      try {
        if (!await options.livekit.roomExists(roomId)) {
          knownRooms.delete(roomId);
          return reply.code(404).send({ error: 'room_not_found' });
        }
        room.expiresAt = requestTime + ROOM_LINK_LIFETIME_MS;
      } catch {
        return reply.code(502).send({ error: 'room_service_unavailable' });
      }
    }
    const remainingTtlSeconds = Math.floor((room.expiresAt - now()) / 1000);
    if (remainingTtlSeconds < 1) {
      knownRooms.delete(roomId);
      return reply.code(404).send({ error: 'room_not_found' });
    }
    const identity = parseJoin(request.body);
    if (!identity) return reply.code(400).send({ error: 'invalid_join_request' });
    if (room.reservedParticipants >= MAX_PARTICIPANTS) {
      return reply.code(409).send({ error: 'room_full' });
    }

    const participantId = createParticipantId();
    const metadata = JSON.stringify(identity);
    room.reservedParticipants += 1;
    try {
      const token = await options.livekit.createAccessToken({
        participantId,
        name: identity.nickname,
        roomName: roomId,
        metadata,
        grants: { roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false, canPublishSources: ['microphone'] },
        maximumTtlSeconds: options.config.tokenTtlSeconds,
        expiresAtMs: room.expiresAt
      });
      room.reservedParticipants -= 1;
      return { participantId, livekitUrl: options.config.livekitUrl, token };
    } catch (error) {
      room.reservedParticipants -= 1;
      if (isRoomExpiredError(error)) {
        knownRooms.delete(roomId);
        return reply.code(404).send({ error: 'room_not_found' });
      }
      return reply.code(502).send({ error: 'token_service_unavailable' });
    }
  });

  return app;
};

const clientAddress = (request: FastifyRequest): string => request.ip;

const isRoomExpiredError = (error: unknown): error is RoomExpiredError =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'room_expired';
