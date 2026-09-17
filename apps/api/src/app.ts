import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

export const AVATAR_IDS = ['fox', 'cat', 'otter', 'owl', 'panda', 'rabbit'] as const;
type AvatarId = (typeof AVATAR_IDS)[number];

export interface LiveKitGateway {
  createRoom(options: { name: string; maxParticipants: number; emptyTimeout: number; departureTimeout: number }): Promise<void>;
  createAccessToken(input: {
    participantId: string;
    roomName: string;
    metadata: string;
    grants: { roomJoin: true; canPublish: true; canSubscribe: true };
    maximumTtlSeconds: number;
    expiresAtMs: number;
  }): Promise<string>;
}

export class RoomExpiredError extends Error {
  readonly code = 'room_expired';
}

export interface ApiConfig {
  livekitUrl: string;
  apiKey: string;
  apiSecret: string;
  tokenTtlSeconds: number;
  rateLimit: { max: number; timeWindowMs: number };
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
  issuedParticipants: number;
  reservedParticipants: number;
}

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
  const app = Fastify({ logger: false });
  const knownRooms = new Map<string, RoomState>();
  const requestTimes = new Map<string, number[]>();
  const createRoomId = options.roomId ?? defaultRoomId;
  const createParticipantId = options.participantId ?? defaultParticipantId;
  const now = options.now ?? Date.now;

  app.addHook('onRequest', async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method)) return;
    const key = clientAddress(request);
    const after = now() - options.config.rateLimit.timeWindowMs;
    const recent = (requestTimes.get(key) ?? []).filter((time) => time > after);
    if (recent.length >= options.config.rateLimit.max) {
      return reply.code(429).send({ error: 'rate_limited' });
    }
    recent.push(now());
    requestTimes.set(key, recent);
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/api/rooms', async (_request, reply) => {
    const roomId = createRoomId();
    if (!ROOM_ID_PATTERN.test(roomId)) return reply.code(502).send({ error: 'room_service_unavailable' });
    try {
      await options.livekit.createRoom({ name: roomId, maxParticipants: MAX_PARTICIPANTS, emptyTimeout: 300, departureTimeout: 300 });
      knownRooms.set(roomId, { expiresAt: now() + ROOM_LINK_LIFETIME_MS, issuedParticipants: 0, reservedParticipants: 0 });
      return reply.code(201).send({ roomId });
    } catch {
      return reply.code(502).send({ error: 'room_service_unavailable' });
    }
  });

  app.post('/api/rooms/:roomId/join', async (request, reply) => {
    const { roomId } = request.params as { roomId: string };
    const room = knownRooms.get(roomId);
    const remainingTtlSeconds = room ? Math.floor((room.expiresAt - now()) / 1000) : 0;
    if (!room || remainingTtlSeconds < 1) {
      knownRooms.delete(roomId);
      return reply.code(404).send({ error: 'room_not_found' });
    }
    const identity = parseJoin(request.body);
    if (!identity) return reply.code(400).send({ error: 'invalid_join_request' });
    if (room.issuedParticipants + room.reservedParticipants >= MAX_PARTICIPANTS) {
      return reply.code(409).send({ error: 'room_full' });
    }

    const participantId = createParticipantId();
    const metadata = JSON.stringify(identity);
    room.reservedParticipants += 1;
    try {
      const token = await options.livekit.createAccessToken({
        participantId,
        roomName: roomId,
        metadata,
        grants: { roomJoin: true, canPublish: true, canSubscribe: true },
        maximumTtlSeconds: options.config.tokenTtlSeconds,
        expiresAtMs: room.expiresAt
      });
      room.reservedParticipants -= 1;
      room.issuedParticipants += 1;
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
