import { createSecretKey } from 'node:crypto';
import { SignJWT } from 'jose';
import { RoomServiceClient } from 'livekit-server-sdk';
import { RoomExpiredError, type ApiConfig, type LiveKitGateway } from './app.js';

export class LiveKitServerGateway implements LiveKitGateway {
  private readonly roomService: RoomServiceClient;

  constructor(
    private readonly config: Pick<ApiConfig, 'livekitUrl' | 'apiKey' | 'apiSecret'>,
    private readonly now: () => number = Date.now
  ) {
    this.roomService = new RoomServiceClient(config.livekitUrl, config.apiKey, config.apiSecret);
  }

  async createRoom(options: { name: string; maxParticipants: number; emptyTimeout: number; departureTimeout: number }): Promise<void> {
    await this.roomService.createRoom(options);
  }

  async createAccessToken(input: {
    participantId: string;
    name: string;
    roomName: string;
    metadata: string;
    grants: { roomJoin: true; canPublish: true; canSubscribe: true; canPublishData: false; canPublishSources: ['microphone'] };
    maximumTtlSeconds: number;
    expiresAtMs: number;
  }): Promise<string> {
    const issuedAtSeconds = Math.floor(this.now() / 1_000);
    const expiresAtSeconds = Math.floor(input.expiresAtMs / 1_000);
    const expiresAt = Math.min(expiresAtSeconds, issuedAtSeconds + input.maximumTtlSeconds);
    if (expiresAt <= issuedAtSeconds) throw new RoomExpiredError('Room expired before token signing');
    return new SignJWT({
      name: input.name,
      metadata: input.metadata,
      video: { ...input.grants, room: input.roomName, canPublishData: false, canPublishSources: ['microphone'] }
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.config.apiKey)
      .setSubject(input.participantId)
      .setIssuedAt(issuedAtSeconds)
      .setNotBefore(issuedAtSeconds)
      .setExpirationTime(expiresAt)
      .sign(createSecretKey(Buffer.from(this.config.apiSecret, 'utf8')));
  }

  async roomExists(roomName: string): Promise<boolean> {
    return (await this.roomService.listRooms([roomName])).some((room) => room.name === roomName);
  }
}
