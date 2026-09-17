import type { AudioMode } from './domain.js';

export type AudioConstraints = MediaTrackConstraints;
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export interface RemoteMember { id: string; name: string; avatarId: string }
export interface SessionEvent {
  type: 'connected' | 'reconnecting' | 'reconnected' | 'disconnected' | 'active-speakers' | 'local-level' | 'participants';
  participantIds?: string[];
  reason?: string;
  speaking?: boolean;
  members?: RemoteMember[];
}
export interface SessionAdapter {
  connect(url: string, token: string): Promise<void>;
  publish(constraints: AudioConstraints): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  switchDevice(constraints: AudioConstraints): Promise<void>;
  disconnect(): Promise<void>;
  onEvent(listener: (event: SessionEvent) => void): () => void;
}
export interface SessionState { connection: ConnectionState; activeSpeakerIds: string[]; localSpeaking: boolean; members: RemoteMember[]; disconnectReason?: string }
export interface EnterOptions { livekitUrl: string; token: string; listenOnly: boolean; mode: AudioMode; deviceId: string }

export const voiceConstraints = (deviceId: string): AudioConstraints => ({
  ...(deviceId ? { deviceId: { exact: deviceId } } : {}), channelCount: 1, sampleRate: 48_000,
  echoCancellation: true, noiseSuppression: true, autoGainControl: true
});
export const instrumentConstraints = (deviceId: string): AudioConstraints => ({
  ...(deviceId ? { deviceId: { exact: deviceId } } : {}), channelCount: 2, sampleRate: 48_000,
  echoCancellation: false, noiseSuppression: false, autoGainControl: false
});
const constraintsFor = (mode: AudioMode, deviceId: string) => mode === 'instrument' ? instrumentConstraints(deviceId) : voiceConstraints(deviceId);

export class AudioSession {
  private state: SessionState = { connection: 'disconnected', activeSpeakerIds: [], localSpeaking: false, members: [] };
  private muted = false;
  private listening = true;
  private stopEvents?: () => void;
  public constructor(private readonly adapter: SessionAdapter, private readonly onState: (state: SessionState) => void = () => {}) {}

  async enter(options: EnterOptions): Promise<void> {
    this.listening = options.listenOnly;
    this.update({ connection: 'connecting', activeSpeakerIds: [], localSpeaking: false, members: [], disconnectReason: undefined });
    this.stopEvents = this.adapter.onEvent((event) => this.handle(event));
    try {
      await this.adapter.connect(options.livekitUrl, options.token);
      if (!options.listenOnly) await this.adapter.publish(constraintsFor(options.mode, options.deviceId));
      this.update({ connection: 'connected' });
    } catch (error) {
      this.stopEvents?.(); this.stopEvents = undefined;
      this.update({ connection: 'disconnected', disconnectReason: error instanceof Error ? error.message : 'connection_failed' });
      throw error;
    }
  }

  async setMuted(muted: boolean): Promise<void> { if (!this.listening) await this.adapter.setMuted(muted); this.muted = muted; }
  async switchDevice(deviceId: string, mode: AudioMode): Promise<void> {
    if (this.listening) return;
    await this.adapter.switchDevice(constraintsFor(mode, deviceId));
    await this.adapter.setMuted(this.muted);
  }
  async leave(): Promise<void> {
    this.stopEvents?.(); this.stopEvents = undefined;
    await this.adapter.disconnect();
    this.update({ connection: 'disconnected', activeSpeakerIds: [], disconnectReason: 'left' });
  }
  private handle(event: SessionEvent): void {
    if (event.type === 'active-speakers') this.update({ activeSpeakerIds: event.participantIds ?? [] });
    if (event.type === 'local-level') this.update({ localSpeaking: Boolean(event.speaking) });
    if (event.type === 'participants') this.update({ members: event.members ?? [] });
    if (event.type === 'reconnecting') this.update({ connection: 'reconnecting', disconnectReason: undefined });
    if (event.type === 'reconnected' || event.type === 'connected') this.update({ connection: 'connected', disconnectReason: undefined });
    if (event.type === 'disconnected') this.update({ connection: 'disconnected', disconnectReason: event.reason ?? 'disconnected' });
  }
  private update(next: Partial<SessionState>): void { this.state = { ...this.state, ...next }; this.onState(this.state); }
}
