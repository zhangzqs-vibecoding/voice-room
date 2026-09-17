import { describe, expect, it } from 'vitest';
import { createApp, type LiveKitGateway } from '../src/app.js';
import { LiveKitServerGateway } from '../src/livekit-gateway.js';

const config = {
  livekitUrl: 'ws://livekit.test',
  apiKey: 'key',
  apiSecret: 'secret',
  tokenTtlSeconds: 900,
  rateLimit: { max: 3, timeWindowMs: 60_000 }
};

class FakeLiveKitGateway implements LiveKitGateway {
  createdRooms: Array<Record<string, unknown>> = [];
  shouldFailCreate = false;

  async createRoom(options: Record<string, unknown>) {
    if (this.shouldFailCreate) throw new Error('LiveKit unavailable');
    this.createdRooms.push(options);
  }

  async createAccessToken(input: Record<string, unknown>) {
    return JSON.stringify(input);
  }
}

const buildApp = () => {
  const livekit = new FakeLiveKitGateway();
  return { app: createApp({ config, livekit, roomId: () => 'room_abcdefghijklmnopqrstuv' }), livekit };
};

describe('voice room API', () => {
  it('creates a LiveKit JWT that can join only the requested room', async () => {
    const livekit = new LiveKitServerGateway(config);
    const token = await livekit.createAccessToken({
      participantId: 'participant_123',
      roomName: 'room_abcdefghijklmnopqrstuv',
      metadata: JSON.stringify({ nickname: 'Lee', avatarId: 'fox' }),
      grants: { roomJoin: true, canPublish: true, canSubscribe: true },
      ttlSeconds: 900
    });
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    expect(payload.sub).toBe('participant_123');
    expect(payload.metadata).toBe(JSON.stringify({ nickname: 'Lee', avatarId: 'fox' }));
    expect(payload.video).toMatchObject({ room: 'room_abcdefghijklmnopqrstuv', roomJoin: true, canPublish: true, canSubscribe: true });
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
    expect(token.grants).toEqual({ roomJoin: true, canPublish: true, canSubscribe: true });
    expect(token.metadata).toBe(JSON.stringify({ nickname: '小王', avatarId: 'fox' }));
    expect(token.ttlSeconds).toBe(900);
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

  it('maps LiveKit room creation failures without exposing internals', async () => {
    const { app, livekit } = buildApp();
    livekit.shouldFailCreate = true;
    const response = await app.inject({ method: 'POST', url: '/api/rooms' });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: 'room_service_unavailable' });
    await app.close();
  });

  it('rate limits repeated mutating requests from the same client IP', async () => {
    const { app } = buildApp();
    const responses = await Promise.all(Array.from({ length: 4 }, () => app.inject({ method: 'POST', url: '/api/rooms', remoteAddress: '203.0.113.8' })));
    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(3);
    expect(responses.at(-1)?.statusCode).toBe(429);
    await app.close();
  });
});
