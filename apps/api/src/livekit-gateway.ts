import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import type { ApiConfig, LiveKitGateway } from './app.js';

export class LiveKitServerGateway implements LiveKitGateway {
  private readonly roomService: RoomServiceClient;

  constructor(private readonly config: Pick<ApiConfig, 'livekitUrl' | 'apiKey' | 'apiSecret'>) {
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
    ttlSeconds: number;
  }): Promise<string> {
    const token = new AccessToken(this.config.apiKey, this.config.apiSecret, {
      identity: input.participantId,
      metadata: input.metadata,
      ttl: `${input.ttlSeconds}s`
    });
    token.addGrant({ room: input.roomName, ...input.grants });
    return token.toJwt();
  }
}
