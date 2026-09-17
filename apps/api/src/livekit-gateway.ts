import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
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
    roomName: string;
    metadata: string;
    grants: { roomJoin: true; canPublish: true; canSubscribe: true };
    maximumTtlSeconds: number;
    expiresAtMs: number;
  }): Promise<string> {
    const remainingTtlSeconds = Math.floor((input.expiresAtMs - this.now()) / 1_000);
    const ttlSeconds = Math.min(input.maximumTtlSeconds, remainingTtlSeconds);
    if (ttlSeconds < 1) throw new RoomExpiredError('Room expired before token signing');
    const token = new AccessToken(this.config.apiKey, this.config.apiSecret, {
      identity: input.participantId,
      metadata: input.metadata,
      ttl: `${ttlSeconds}s`
    });
    token.addGrant({ room: input.roomName, ...input.grants });
    return token.toJwt();
  }
}
