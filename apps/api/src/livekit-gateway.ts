import { createSecretKey } from 'node:crypto';
import { SignJWT } from 'jose';
import { RoomServiceClient } from 'livekit-server-sdk';
import { RoomExpiredError, type ApiConfig, type LiveKitGateway } from './app.js';

export class LiveKitServerGateway implements LiveKitGateway {
  private readonly roomService: RoomServiceClient;
  private readonly roomChecks = new Map<string, Promise<boolean>>();
  private activeRoomChecks = 0;

  constructor(
    private readonly config: Pick<ApiConfig, 'livekitUrl' | 'apiKey' | 'apiSecret' | 'livekitRequestTimeoutMs'>,
    private readonly now: () => number = Date.now
  ) {
    this.roomService = new RoomServiceClient(config.livekitUrl, config.apiKey, config.apiSecret, {
      requestTimeout: Math.ceil(config.livekitRequestTimeoutMs / 1_000),
      failover: false
    });
  }

  async createRoom(options: { name: string; maxParticipants: number; emptyTimeout: number; departureTimeout: number }, signal?: AbortSignal): Promise<void> {
    // The SDK has no AbortSignal API; its configured requestTimeout enforces the physical request deadline.
    void signal;
    await this.roomService.createRoom(options);
  }

  async createAccessToken(input: {
    participantId: string;
    name: string;
    roomName: string;
    metadata: string;
    grants: { roomJoin: true; canPublish: true; canSubscribe: true; canPublishData: boolean; canPublishSources: string[]; roomAdmin?: true };
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
      video: { ...input.grants, room: input.roomName }
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.config.apiKey)
      .setSubject(input.participantId)
      .setIssuedAt(issuedAtSeconds)
      .setNotBefore(issuedAtSeconds)
      .setExpirationTime(expiresAt)
      .sign(createSecretKey(Buffer.from(this.config.apiSecret, 'utf8')));
  }

  async removeParticipant(roomName: string, participantId: string): Promise<void> {
    await this.roomService.removeParticipant(roomName, participantId);
  }

  async mutePublishedTrack(roomName: string, participantId: string, trackSid: string, muted: boolean): Promise<void> {
    await this.roomService.mutePublishedTrack(roomName, participantId, trackSid, muted);
  }
  async muteCameraTrack(roomName: string, participantId: string, trackSid: string, muted: boolean): Promise<void> {
    await this.roomService.mutePublishedTrack(roomName, participantId, trackSid, muted);
  }

  async deleteRoom(roomName: string): Promise<void> {
    await this.roomService.deleteRoom(roomName);
  }

  async roomExists(roomName: string, signal?: AbortSignal): Promise<boolean> {
    let check = this.roomChecks.get(roomName);
    if (!check) {
      if (this.activeRoomChecks >= 25) throw new Error('LiveKit room lookup capacity reached');
      check = this.createRoomCheck(roomName);
      this.roomChecks.set(roomName, check);
    }
    return this.waitForRoomCheck(check, signal);
  }

  private async createRoomCheck(roomName: string): Promise<boolean> {
    this.activeRoomChecks += 1;
    try {
      return (await this.roomService.listRooms([roomName])).some((room) => room.name === roomName);
    } finally {
      this.activeRoomChecks -= 1;
      this.roomChecks.delete(roomName);
    }
  }

  private waitForRoomCheck(check: Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
    if (!signal) return check;
    if (signal.aborted) return Promise.reject(new DOMException('Room lookup aborted', 'AbortError'));
    return new Promise<boolean>((resolve, reject) => {
      const cleanup = () => signal.removeEventListener('abort', abort);
      const abort = () => {
        cleanup();
        reject(new DOMException('Room lookup aborted', 'AbortError'));
      };
      signal.addEventListener('abort', abort, { once: true });
      void check.then(resolve, reject).finally(cleanup);
    });
  }
}
