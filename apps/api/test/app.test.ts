import { describe, expect, it } from 'vitest';
import { createApp, type LiveKitGateway } from '../src/app.js';
import { LiveKitServerGateway } from '../src/livekit-gateway.js';

const config = {
  livekitUrl: 'ws://livekit.test',
  apiKey: 'key',
  apiSecret: 'secret',
  tokenTtlSeconds: 900,
  roomCacheMaxEntries: 1_000,
  trustedProxyCidrs: [],
  roomSweepTimeoutMs: 25,
  rateLimit: { max: 3, timeWindowMs: 60_000, maxKeys: 1_000 }
};

class FakeLiveKitGateway implements LiveKitGateway {
  createdRooms: Array<Record<string, unknown>> = [];
  createdTokens: Array<Record<string, unknown>> = [];
  shouldFailCreate = false;
  shouldFailToken = false;
  shouldExpireToken = false;
  tokenExpirationFailuresRemaining = 0;
  roomStillExists = false;
  readonly existingRoomIds = new Set<string>();
  readonly roomExistsCalls: string[] = [];
  readonly slowRoomIds = new Set<string>();
  roomExistsDelayMs = 0;
  deferRoomCreation = false;
  deferTokenSigning = false;
  private readonly pendingRoomCreationResolutions: Array<() => void> = [];
  private readonly pendingTokenResolutions: Array<() => void> = [];

  async createRoom(options: Record<string, unknown>) {
    if (this.shouldFailCreate) throw new Error('LiveKit unavailable');
    this.createdRooms.push(options);
    if (this.deferRoomCreation) {
      await new Promise<void>((resolve) => this.pendingRoomCreationResolutions.push(resolve));
    }
  }

  async createAccessToken(input: Record<string, unknown>) {
    if (this.shouldFailToken) throw new Error('LiveKit token signing unavailable');
    if (this.shouldExpireToken || this.tokenExpirationFailuresRemaining > 0) {
      this.tokenExpirationFailuresRemaining -= 1;
      throw Object.assign(new Error('Room expired while signing'), { code: 'room_expired' });
    }
    this.createdTokens.push(input);
    if (this.deferTokenSigning) {
      await new Promise<void>((resolve) => this.pendingTokenResolutions.push(resolve));
    }
    return JSON.stringify(input);
  }

  finishPendingTokenSignatures() {
    for (const resolve of this.pendingTokenResolutions.splice(0)) resolve();
  }

  finishPendingRoomCreations() {
    for (const resolve of this.pendingRoomCreationResolutions.splice(0)) resolve();
  }

  async roomExists(roomName: string) {
    this.roomExistsCalls.push(roomName);
    if (this.slowRoomIds.has(roomName)) await new Promise((resolve) => setTimeout(resolve, this.roomExistsDelayMs));
    return this.existingRoomIds.size > 0 ? this.existingRoomIds.has(roomName) : this.roomStillExists;
  }
}

const buildApp = (overrides: Partial<Parameters<typeof createApp>[0]> = {}) => {
  const livekit = new FakeLiveKitGateway();
  return {
    app: createApp({
      config: { ...config, rateLimit: { max: 30, timeWindowMs: 60_000, maxKeys: 1_000 }, ...overrides.config },
      livekit,
      roomId: () => 'room_abcdefghijklmnopqrstuv',
      ...overrides
    }),
    livekit
  };
};

describe('voice room API', () => {
  it('signs the precise absolute room expiration after the signer clock advances', async () => {
    const startedAtMs = Math.floor(Date.now() / 1_000) * 1_000 + 100;
    const expiresAtMs = startedAtMs + 5_000;
    let signerNowMs = startedAtMs;
    const livekit = new LiveKitServerGateway(config, () => signerNowMs);
    signerNowMs += 1_100;
    const token = await livekit.createAccessToken({
      participantId: 'participant_123',
      name: 'Lee',
      roomName: 'room_abcdefghijklmnopqrstuv',
      metadata: JSON.stringify({ nickname: 'Lee', avatarId: 'fox' }),
      grants: { roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false, canPublishSources: ['microphone'] },
      maximumTtlSeconds: 900,
      expiresAtMs
    });
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    expect(payload.iat * 1_000).toBe(Math.floor(signerNowMs / 1_000) * 1_000);
    expect(payload.exp * 1_000).toBe(Math.floor(expiresAtMs / 1_000) * 1_000);
    expect(payload.exp * 1_000).toBeLessThanOrEqual(expiresAtMs);
  });

  it('creates a LiveKit JWT that can join only the requested room', async () => {
    const livekit = new LiveKitServerGateway(config);
    const token = await livekit.createAccessToken({
      participantId: 'participant_123',
      name: 'Lee',
      roomName: 'room_abcdefghijklmnopqrstuv',
      metadata: JSON.stringify({ nickname: 'Lee', avatarId: 'fox' }),
      grants: { roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false, canPublishSources: ['microphone'] },
      maximumTtlSeconds: 900,
      expiresAtMs: Date.now() + 900_000
    });
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    expect(payload.sub).toBe('participant_123');
    expect(payload.name).toBe('Lee');
    expect(payload.metadata).toBe(JSON.stringify({ nickname: 'Lee', avatarId: 'fox' }));
    expect(payload.video).toMatchObject({ room: 'room_abcdefghijklmnopqrstuv', roomJoin: true, canPublish: true, canSubscribe: true });
    expect(payload.video).toMatchObject({ canPublishData: false, canPublishSources: ['microphone'] });
  });

  it('returns a health response', async () => {
    const { app } = buildApp();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('creates a random room and configures LiveKit capacity and expiry', async () => {
    const { app, livekit } = buildApp();
    const response = await app.inject({ method: 'POST', url: '/api/rooms' });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ roomId: 'room_abcdefghijklmnopqrstuv' });
    expect(livekit.createdRooms).toEqual([{ name: 'room_abcdefghijklmnopqrstuv', maxParticipants: 10, emptyTimeout: 300, departureTimeout: 300 }]);
    await app.close();
  });

  it('reserves a cache slot before concurrent room creation reaches the SFU', async () => {
    const livekit = new FakeLiveKitGateway();
    livekit.deferRoomCreation = true;
    const roomIds = ['room_aaaaaaaaaaaaaaaaaaaa', 'room_bbbbbbbbbbbbbbbbbbbb'];
    const app = createApp({
      config: { ...config, roomCacheMaxEntries: 1, rateLimit: { max: 10, timeWindowMs: 60_000, maxKeys: 10 } },
      livekit,
      roomId: () => roomIds.shift() ?? 'room_cccccccccccccccccccc'
    });
    const first = app.inject({ method: 'POST', url: '/api/rooms' });
    for (let attempt = 0; attempt < 10 && livekit.createdRooms.length === 0; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    const second = app.inject({ method: 'POST', url: '/api/rooms' });
    for (let attempt = 0; attempt < 10 && livekit.createdRooms.length < 2; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(livekit.createdRooms).toHaveLength(1);
    livekit.finishPendingRoomCreations();
    expect((await first).statusCode).toBe(201);
    const secondResponse = await second;
    expect(secondResponse.statusCode).toBe(503);
    expect(secondResponse.json()).toEqual({ error: 'room_cache_full' });
    expect((await app.inject({ method: 'POST', url: '/api/rooms' })).statusCode).toBe(503);
    await app.close();
  });

  it('generates unique opaque room IDs by default', async () => {
    const livekit = new FakeLiveKitGateway();
    const app = createApp({ config, livekit });
    const first = await app.inject({ method: 'POST', url: '/api/rooms', remoteAddress: '203.0.113.1' });
    const second = await app.inject({ method: 'POST', url: '/api/rooms', remoteAddress: '203.0.113.2' });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().roomId).toMatch(/^room_[a-z0-9]{20,}$/);
    expect(second.json().roomId).toMatch(/^room_[a-z0-9]{20,}$/);
    expect(second.json().roomId).not.toBe(first.json().roomId);
    await app.close();
  });

  it('rejects a room id that does not match the opaque room format', async () => {
    const livekit = new FakeLiveKitGateway();
    const app = createApp({ config, livekit, roomId: () => 'easy-to-guess' });
    const response = await app.inject({ method: 'POST', url: '/api/rooms' });
    expect(response.statusCode).toBe(502);
    expect(livekit.createdRooms).toHaveLength(0);
    await app.close();
  });

  it('issues a scoped token for a known room and accepted identity', async () => {
    const { app } = buildApp();
    await app.inject({ method: 'POST', url: '/api/rooms' });
    const response = await app.inject({ method: 'POST', url: '/api/rooms/room_abcdefghijklmnopqrstuv/join', payload: { nickname: '  小王  ', avatarId: 'fox' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.participantId).toMatch(/^participant_[a-z0-9]{20,}$/);
    expect(body.livekitUrl).toBe('ws://livekit.test');
    const token = JSON.parse(body.token);
    expect(token.roomName).toBe('room_abcdefghijklmnopqrstuv');
    expect(token.grants).toEqual({ roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false, canPublishSources: ['microphone'] });
    expect(token.metadata).toBe(JSON.stringify({ nickname: '小王', avatarId: 'fox' }));
    expect(token.maximumTtlSeconds).toBe(900);
    expect(token.expiresAtMs).toBeGreaterThan(Date.now());
    expect(token.apiSecret).toBeUndefined();
    await app.close();
  });

  it.each([
    { nickname: '', avatarId: 'fox' },
    { nickname: 'a'.repeat(33), avatarId: 'fox' },
    { nickname: 'valid', avatarId: 'dragon' }
  ])('rejects invalid join input', async (payload) => {
    const { app } = buildApp();
    await app.inject({ method: 'POST', url: '/api/rooms' });
    const response = await app.inject({ method: 'POST', url: '/api/rooms/room_abcdefghijklmnopqrstuv/join', payload });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('returns a stable malformed JSON error without parser details', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { 'content-type': 'application/json' },
      payload: '{"broken":'
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_json' });
    await app.close();
  });

  it('rejects joins to a room the API did not create', async () => {
    const { app } = buildApp();
    const response = await app.inject({ method: 'POST', url: '/api/rooms/room_abcdefghijklmnopqrstuv/join', payload: { nickname: 'Lee', avatarId: 'fox' } });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('rejects a join after the room link expires when the SFU room no longer exists', async () => {
    const livekit = new FakeLiveKitGateway();
    let currentTime = 0;
    const app = createApp({
      config: { ...config, rateLimit: { max: 30, timeWindowMs: 60_000, maxKeys: 1_000 } },
      livekit,
      roomId: () => 'room_abcdefghijklmnopqrstuv',
      now: () => currentTime
    });
    await app.inject({ method: 'POST', url: '/api/rooms' });
    currentTime = 300_000;
    const response = await app.inject({
      method: 'POST',
      url: '/api/rooms/room_abcdefghijklmnopqrstuv/join',
      payload: { nickname: 'Lee', avatarId: 'fox' }
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'room_not_found' });
    await app.close();
  });

  it('renews a room when the SFU keeps an empty room during departure timeout', async () => {
    const livekit = new FakeLiveKitGateway();
    let currentTime = 0;
    const app = createApp({
      config: { ...config, rateLimit: { max: 30, timeWindowMs: 60_000, maxKeys: 1_000 } },
      livekit,
      roomId: () => 'room_abcdefghijklmnopqrstuv',
      now: () => currentTime
    });
    await app.inject({ method: 'POST', url: '/api/rooms' });
    livekit.roomStillExists = true;
    currentTime = 300_000;
    const response = await app.inject({
      method: 'POST',
      url: '/api/rooms/room_abcdefghijklmnopqrstuv/join',
      payload: { nickname: 'Lee', avatarId: 'fox' }
    });
    expect(response.statusCode).toBe(200);
    expect(livekit.createdTokens[0]?.expiresAtMs).toBe(600_000);
    await app.close();
  });

  it('limits token lifetime to the remaining room lifetime', async () => {
    const livekit = new FakeLiveKitGateway();
    let currentTime = 0;
    const app = createApp({
      config: { ...config, rateLimit: { max: 30, timeWindowMs: 60_000, maxKeys: 1_000 } },
      livekit,
      roomId: () => 'room_abcdefghijklmnopqrstuv',
      now: () => currentTime
    });
    await app.inject({ method: 'POST', url: '/api/rooms' });
    currentTime = 299_000;
    const response = await app.inject({
      method: 'POST',
      url: '/api/rooms/room_abcdefghijklmnopqrstuv/join',
      payload: { nickname: 'Lee', avatarId: 'fox' }
    });
    expect(response.statusCode).toBe(200);
    expect(livekit.createdTokens).toHaveLength(1);
    expect(livekit.createdTokens[0]?.maximumTtlSeconds).toBe(900);
    expect(livekit.createdTokens[0]?.expiresAtMs).toBe(300_000);
    await app.close();
  });

  it('returns 404 with less than one second remaining when the SFU room is missing', async () => {
    const livekit = new FakeLiveKitGateway();
    let currentTime = 0;
    const app = createApp({
      config: { ...config, rateLimit: { max: 30, timeWindowMs: 60_000, maxKeys: 1_000 } },
      livekit,
      roomId: () => 'room_abcdefghijklmnopqrstuv',
      now: () => currentTime
    });
    await app.inject({ method: 'POST', url: '/api/rooms' });
    currentTime = 299_001;
    const response = await app.inject({
      method: 'POST',
      url: '/api/rooms/room_abcdefghijklmnopqrstuv/join',
      payload: { nickname: 'Lee', avatarId: 'fox' }
    });
    expect(response.statusCode).toBe(404);
    expect(livekit.createdTokens).toHaveLength(0);
    await app.close();
  });

  it('renews a room with less than one second remaining when the SFU room exists', async () => {
    const livekit = new FakeLiveKitGateway();
    livekit.roomStillExists = true;
    let currentTime = 0;
    const app = createApp({
      config: { ...config, rateLimit: { max: 30, timeWindowMs: 60_000, maxKeys: 1_000 } },
      livekit,
      roomId: () => 'room_abcdefghijklmnopqrstuv',
      now: () => currentTime
    });
    await app.inject({ method: 'POST', url: '/api/rooms' });
    currentTime = 299_001;
    const response = await app.inject({
      method: 'POST',
      url: '/api/rooms/room_abcdefghijklmnopqrstuv/join',
      payload: { nickname: 'Lee', avatarId: 'fox' }
    });
    expect(response.statusCode).toBe(200);
    expect(livekit.createdTokens[0]?.expiresAtMs).toBe(599_001);
    await app.close();
  });

  it('releases a failed token-signing reservation for a subsequent valid join', async () => {
    const { app, livekit } = buildApp();
    await app.inject({ method: 'POST', url: '/api/rooms' });
    for (let index = 0; index < 9; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/rooms/room_abcdefghijklmnopqrstuv/join',
        payload: { nickname: `member-${index}`, avatarId: 'fox' }
      });
      expect(response.statusCode).toBe(200);
    }
    livekit.shouldFailToken = true;
    const failed = await app.inject({
      method: 'POST',
      url: '/api/rooms/room_abcdefghijklmnopqrstuv/join',
      payload: { nickname: 'will-fail', avatarId: 'fox' }
    });
    expect(failed.statusCode).toBe(502);
    livekit.shouldFailToken = false;
    const recovered = await app.inject({
      method: 'POST',
      url: '/api/rooms/room_abcdefghijklmnopqrstuv/join',
      payload: { nickname: 'recovered', avatarId: 'fox' }
    });
    expect(recovered.statusCode).toBe(200);
    const additionalReconnect = await app.inject({
      method: 'POST',
      url: '/api/rooms/room_abcdefghijklmnopqrstuv/join',
      payload: { nickname: 'extra', avatarId: 'fox' }
    });
    expect(additionalReconnect.statusCode).toBe(200);
    await app.close();
  });

  it('releases the reservation and removes the room when signing detects expiry', async () => {
    const { app, livekit } = buildApp();
    await app.inject({ method: 'POST', url: '/api/rooms' });
    livekit.shouldExpireToken = true;
    const expired = await app.inject({
      method: 'POST',
      url: '/api/rooms/room_abcdefghijklmnopqrstuv/join',
      payload: { nickname: 'Lee', avatarId: 'fox' }
    });
    expect(expired.statusCode).toBe(404);
    livekit.shouldExpireToken = false;
    const retry = await app.inject({
      method: 'POST',
      url: '/api/rooms/room_abcdefghijklmnopqrstuv/join',
      payload: { nickname: 'Lee', avatarId: 'fox' }
    });
    expect(retry.statusCode).toBe(404);
    expect(livekit.createdTokens).toHaveLength(0);
    await app.close();
  });

  it('renews and retries once when signing detects expiry but the SFU room exists', async () => {
    const { app, livekit } = buildApp();
    livekit.roomStillExists = true;
    livekit.tokenExpirationFailuresRemaining = 1;
    await app.inject({ method: 'POST', url: '/api/rooms' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/rooms/room_abcdefghijklmnopqrstuv/join',
      payload: { nickname: 'Lee', avatarId: 'fox' }
    });
    expect(response.statusCode).toBe(200);
    expect(livekit.createdTokens).toHaveLength(1);
    await app.close();
  });

  it('limits concurrent signing reservations and permits reconnect after they release', async () => {
    const { app, livekit } = buildApp();
    livekit.deferTokenSigning = true;
    await app.inject({ method: 'POST', url: '/api/rooms' });
    const pendingResponses = Array.from({ length: 11 }, (_, index) => app.inject({
        method: 'POST',
        url: '/api/rooms/room_abcdefghijklmnopqrstuv/join',
        payload: { nickname: `member-${index}`, avatarId: 'fox' }
      }));
    for (let attempt = 0; attempt < 10 && livekit.createdTokens.length < 10; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(livekit.createdTokens).toHaveLength(10);
    livekit.finishPendingTokenSignatures();
    const responses = await Promise.all(pendingResponses);
    expect(responses.slice(0, 10).every((response) => response.statusCode === 200)).toBe(true);
    expect(responses[10]?.statusCode).toBe(409);
    expect(responses[10]?.json()).toEqual({ error: 'room_full' });
    livekit.deferTokenSigning = false;
    const reconnect = await app.inject({
      method: 'POST',
      url: '/api/rooms/room_abcdefghijklmnopqrstuv/join',
      payload: { nickname: 'reconnect', avatarId: 'fox' }
    });
    expect(reconnect.statusCode).toBe(200);
    await app.close();
  });

  it('maps LiveKit room creation failures without exposing internals', async () => {
    const { app, livekit } = buildApp();
    livekit.shouldFailCreate = true;
    const response = await app.inject({ method: 'POST', url: '/api/rooms' });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: 'room_service_unavailable' });
    await app.close();
  });

  it('rate limits repeated mutating requests from the same client IP', async () => {
    const { app } = buildApp({ config });
    const responses = await Promise.all(Array.from({ length: 4 }, () => app.inject({ method: 'POST', url: '/api/rooms', remoteAddress: '203.0.113.8' })));
    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(3);
    expect(responses.at(-1)?.statusCode).toBe(429);
    await app.close();
  });

  it('bounds rate-limit state and admits a new IP after expired entries are cleaned up', async () => {
    const livekit = new FakeLiveKitGateway();
    let currentTime = 0;
    const app = createApp({
      config: { ...config, rateLimit: { max: 10, timeWindowMs: 100, maxKeys: 2 } },
      livekit,
      now: () => currentTime
    });
    const first = await app.inject({ method: 'POST', url: '/api/rooms', remoteAddress: '203.0.113.1' });
    const second = await app.inject({ method: 'POST', url: '/api/rooms', remoteAddress: '203.0.113.2' });
    const capped = await app.inject({ method: 'POST', url: '/api/rooms', remoteAddress: '203.0.113.3' });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(capped.statusCode).toBe(429);
    currentTime = 101;
    const afterCleanup = await app.inject({ method: 'POST', url: '/api/rooms', remoteAddress: '203.0.113.3' });
    expect(afterCleanup.statusCode).toBe(201);
    await app.close();
  });

  it('does not trust forged forwarded addresses from a non-allowlisted peer', async () => {
    const app = createApp({
      config: { ...config, trustedProxyCidrs: ['127.0.0.1/32'], roomCacheMaxEntries: 10, rateLimit: { max: 1, timeWindowMs: 60_000, maxKeys: 10 } },
      livekit: new FakeLiveKitGateway()
    });
    const first = await app.inject({ method: 'POST', url: '/api/rooms', remoteAddress: '203.0.113.10', headers: { 'x-forwarded-for': '198.51.100.1' } });
    const second = await app.inject({ method: 'POST', url: '/api/rooms', remoteAddress: '203.0.113.10', headers: { 'x-forwarded-for': '198.51.100.2' } });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(429);
    await app.close();
  });

  it('uses forwarded addresses only from an allowlisted proxy', async () => {
    const app = createApp({
      config: { ...config, trustedProxyCidrs: ['127.0.0.1/32'], roomCacheMaxEntries: 10, rateLimit: { max: 1, timeWindowMs: 60_000, maxKeys: 10 } },
      livekit: new FakeLiveKitGateway()
    });
    const first = await app.inject({ method: 'POST', url: '/api/rooms', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '198.51.100.1' } });
    const second = await app.inject({ method: 'POST', url: '/api/rooms', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '198.51.100.2' } });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    await app.close();
  });

  it('sweeps expired missing rooms before creating a new cached room', async () => {
    const roomIds = ['room_aaaaaaaaaaaaaaaaaaaa', 'room_bbbbbbbbbbbbbbbbbbbb'];
    const livekit = new FakeLiveKitGateway();
    let currentTime = 0;
    const app = createApp({
      config: { ...config, roomCacheMaxEntries: 1, rateLimit: { max: 10, timeWindowMs: 60_000, maxKeys: 10 } },
      livekit,
      roomId: () => roomIds.shift() ?? 'room_cccccccccccccccccccc',
      now: () => currentTime
    });
    expect((await app.inject({ method: 'POST', url: '/api/rooms' })).statusCode).toBe(201);
    currentTime = 300_000;
    expect((await app.inject({ method: 'POST', url: '/api/rooms' })).statusCode).toBe(201);
    await app.close();
  });

  it('retains an expired SFU room and rejects creation when the room cache is full', async () => {
    const roomIds = ['room_aaaaaaaaaaaaaaaaaaaa', 'room_bbbbbbbbbbbbbbbbbbbb'];
    const livekit = new FakeLiveKitGateway();
    livekit.roomStillExists = true;
    let currentTime = 0;
    const app = createApp({
      config: { ...config, roomCacheMaxEntries: 1, rateLimit: { max: 10, timeWindowMs: 60_000, maxKeys: 10 } },
      livekit,
      roomId: () => roomIds.shift() ?? 'room_cccccccccccccccccccc',
      now: () => currentTime
    });
    expect((await app.inject({ method: 'POST', url: '/api/rooms' })).statusCode).toBe(201);
    currentTime = 300_000;
    const response = await app.inject({ method: 'POST', url: '/api/rooms' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'room_cache_full' });
    await app.close();
  });

  it('does not sweep unrelated expired rooms before joining an active target room', async () => {
    const livekit = new FakeLiveKitGateway();
    const roomIds = Array.from({ length: 26 }, (_, index) => `room_${index.toString(36).padStart(20, 'a')}`);
    let currentTime = 0;
    const app = createApp({
      config: { ...config, roomCacheMaxEntries: 26, rateLimit: { max: 100, timeWindowMs: 60_000, maxKeys: 100 } },
      livekit,
      roomId: () => roomIds.shift() ?? 'room_zzzzzzzzzzzzzzzzzzzz',
      now: () => currentTime
    });
    for (let index = 0; index < 26; index += 1) expect((await app.inject({ method: 'POST', url: '/api/rooms' })).statusCode).toBe(201);
    const targetRoomId = livekit.createdRooms[25]?.name as string;
    livekit.existingRoomIds.add(targetRoomId);
    for (const room of livekit.createdRooms.slice(0, 25)) livekit.slowRoomIds.add(room.name as string);
    livekit.roomExistsDelayMs = 50;
    currentTime = 300_000;
    const response = await app.inject({ method: 'POST', url: `/api/rooms/${targetRoomId}/join`, payload: { nickname: 'Lee', avatarId: 'fox' } });
    expect(response.statusCode).toBe(200);
    expect(livekit.roomExistsCalls).toEqual([targetRoomId]);
    await app.close();
  });

  it('bounds a full-cache sweep instead of waiting once per expired room', async () => {
    const livekit = new FakeLiveKitGateway();
    const roomIds = Array.from({ length: 26 }, (_, index) => `room_${index.toString(36).padStart(20, 'a')}`);
    let currentTime = 0;
    const app = createApp({
      config: { ...config, roomCacheMaxEntries: 25, roomSweepTimeoutMs: 15, rateLimit: { max: 100, timeWindowMs: 60_000, maxKeys: 100 } },
      livekit,
      roomId: () => roomIds.shift() ?? 'room_zzzzzzzzzzzzzzzzzzzz',
      now: () => currentTime
    });
    for (let index = 0; index < 25; index += 1) expect((await app.inject({ method: 'POST', url: '/api/rooms' })).statusCode).toBe(201);
    for (const room of livekit.createdRooms) livekit.slowRoomIds.add(room.name as string);
    livekit.roomExistsDelayMs = 50;
    currentTime = 300_000;
    const startedAt = Date.now();
    const response = await app.inject({ method: 'POST', url: '/api/rooms' });
    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'room_cache_full' });
    await app.close();
  });
});
