import { describe, expect, it, vi } from 'vitest';
import { createApp, type LiveKitGateway } from '../src/app.js';
import { LiveKitServerGateway } from '../src/livekit-gateway.js';

const config = {
  livekitUrl: 'ws://livekit.test',
  apiKey: 'key',
  apiSecret: 'secret',
  tokenTtlSeconds: 900,
  rateLimit: { max: 3, timeWindowMs: 60_000, maxKeys: 1_000 }
};

class FakeLiveKitGateway implements LiveKitGateway {
  createdRooms: Array<Record<string, unknown>> = [];
  createdTokens: Array<Record<string, unknown>> = [];
  shouldFailCreate = false;
  shouldFailToken = false;
  shouldExpireToken = false;
  activeParticipantCount = 0;

  async createRoom(options: Record<string, unknown>) {
    if (this.shouldFailCreate) throw new Error('LiveKit unavailable');
    this.createdRooms.push(options);
  }

  async createAccessToken(input: Record<string, unknown>) {
    if (this.shouldFailToken) throw new Error('LiveKit token signing unavailable');
    if (this.shouldExpireToken) throw Object.assign(new Error('Room expired while signing'), { code: 'room_expired' });
    this.createdTokens.push(input);
    return JSON.stringify(input);
  }

  async getParticipantCount() {
    return this.activeParticipantCount;
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
  it('signs a JWT whose expiration never exceeds the absolute room expiry', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2030-01-01T00:00:00.500Z'));
      const expiresAtMs = Date.now() + 1_500;
      const livekit = new LiveKitServerGateway(config);
      const token = await livekit.createAccessToken({
        participantId: 'participant_123',
        roomName: 'room_abcdefghijklmnopqrstuv',
        metadata: JSON.stringify({ nickname: 'Lee', avatarId: 'fox' }),
        grants: { roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false, canPublishSources: ['microphone'] },
        maximumTtlSeconds: 900,
        expiresAtMs
      } as Parameters<typeof livekit.createAccessToken>[0]);
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      expect(payload.exp * 1_000).toBeLessThanOrEqual(expiresAtMs);
    } finally {
      vi.useRealTimers();
    }
  });

  it('creates a LiveKit JWT that can join only the requested room', async () => {
    const livekit = new LiveKitServerGateway(config);
    const token = await livekit.createAccessToken({
      participantId: 'participant_123',
      roomName: 'room_abcdefghijklmnopqrstuv',
      metadata: JSON.stringify({ nickname: 'Lee', avatarId: 'fox' }),
      grants: { roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false, canPublishSources: ['microphone'] },
      maximumTtlSeconds: 900,
      expiresAtMs: Date.now() + 900_000
    });
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    expect(payload.sub).toBe('participant_123');
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

  it('rejects joins to a room the API did not create', async () => {
    const { app } = buildApp();
    const response = await app.inject({ method: 'POST', url: '/api/rooms/room_abcdefghijklmnopqrstuv/join', payload: { nickname: 'Lee', avatarId: 'fox' } });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('rejects a join after the room link has expired five minutes after creation', async () => {
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

  it('renews a room at the join audit point when the SFU still has active members', async () => {
    const livekit = new FakeLiveKitGateway();
    let currentTime = 0;
    const app = createApp({
      config: { ...config, rateLimit: { max: 30, timeWindowMs: 60_000, maxKeys: 1_000 } },
      livekit,
      roomId: () => 'room_abcdefghijklmnopqrstuv',
      now: () => currentTime
    });
    await app.inject({ method: 'POST', url: '/api/rooms' });
    livekit.activeParticipantCount = 1;
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

  it('does not issue a token with less than one second of room lifetime remaining', async () => {
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
    const full = await app.inject({
      method: 'POST',
      url: '/api/rooms/room_abcdefghijklmnopqrstuv/join',
      payload: { nickname: 'extra', avatarId: 'fox' }
    });
    expect(full.statusCode).toBe(409);
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

  it('issues at most ten join credentials for a room', async () => {
    const { app } = buildApp();
    await app.inject({ method: 'POST', url: '/api/rooms' });
    const responses = await Promise.all(
      Array.from({ length: 11 }, (_, index) => app.inject({
        method: 'POST',
        url: '/api/rooms/room_abcdefghijklmnopqrstuv/join',
        payload: { nickname: `member-${index}`, avatarId: 'fox' }
      }))
    );
    expect(responses.slice(0, 10).every((response) => response.statusCode === 200)).toBe(true);
    expect(responses[10]?.statusCode).toBe(409);
    expect(responses[10]?.json()).toEqual({ error: 'room_full' });
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
});
