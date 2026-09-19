import type { AudioMode } from './domain.js';

export type AudioConstraints = MediaTrackConstraints;
export type VideoConstraints = MediaTrackConstraints;
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export interface RemoteMember { id: string; name: string; avatarId: string; cameraTrackSid?: string; cameraEnabled?: boolean }
export interface SessionEvent {
  type: 'connected' | 'reconnecting' | 'reconnected' | 'disconnected' | 'active-speakers' | 'local-level' | 'participants' | 'video-track' | 'screen-track' | 'track-removed' | 'screen-share' | 'participant-camera' | 'chat' | 'hand';
  participantIds?: string[];
  reason?: string;
  speaking?: boolean;
  members?: RemoteMember[];
  track?: MediaStreamTrack;
  source?: 'camera' | 'screen';
  enabled?: boolean;
  trackSid?: string;
  message?: { id: string; name: string; text: string };
  handRaised?: boolean;
}
export interface SessionAdapter {
  connect(url: string, token: string): Promise<void>;
  publish(constraints: AudioConstraints): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  switchDevice(constraints: AudioConstraints): Promise<void>;
  disconnect(): Promise<void>;
  onEvent(listener: (event: SessionEvent) => void): () => void;
  publishVideo?: (constraints: VideoConstraints) => Promise<void>;
  setCameraEnabled?: (enabled: boolean) => Promise<void>;
  startScreenShare?: () => Promise<void>;
  stopScreenShare?: () => Promise<void>;
  sendData?: (payload: Uint8Array) => Promise<void>;
  getRecorderAudioTracks?: () => MediaStreamTrack[];
}
export interface SessionState { connection: ConnectionState; activeSpeakerIds: string[]; localSpeaking: boolean; members: RemoteMember[]; videoTracks: Record<string, MediaStreamTrack>; screenTracks: Record<string, MediaStreamTrack>; localCameraEnabled: boolean; localScreenSharing: boolean; chatMessages?: Array<{ id: string; name: string; text: string }>; raisedHands?: string[]; disconnectReason?: string }
export interface EnterOptions { livekitUrl: string; token: string; listenOnly: boolean; mode: AudioMode; deviceId: string }

export const voiceConstraints = (deviceId: string): AudioConstraints => ({
  ...(deviceId ? { deviceId: { exact: deviceId } } : {}), channelCount: 1, sampleRate: 48_000,
  echoCancellation: true, noiseSuppression: true, autoGainControl: true
});
export const instrumentConstraints = (deviceId: string): AudioConstraints => ({
  ...(deviceId ? { deviceId: { exact: deviceId } } : {}), channelCount: 2, sampleRate: 48_000,
  echoCancellation: false, noiseSuppression: false, autoGainControl: false
});
export const cameraConstraints = (deviceId: string): VideoConstraints => ({
  ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, facingMode: 'user'
});
const constraintsFor = (mode: AudioMode, deviceId: string) => mode === 'instrument' ? instrumentConstraints(deviceId) : voiceConstraints(deviceId);

export class AudioSession {
  private state: SessionState = { connection: 'disconnected', activeSpeakerIds: [], localSpeaking: false, members: [], videoTracks: {}, screenTracks: {}, localCameraEnabled: false, localScreenSharing: false, chatMessages: [], raisedHands: [] };
  private muted = false;
  private listening = true;
  private stopEvents?: () => void;
  private leaving?: Promise<void>;
  public constructor(private readonly adapter: SessionAdapter, private readonly onState: (state: SessionState) => void = () => {}) {}

  async enter(options: EnterOptions): Promise<void> {
    this.listening = options.listenOnly;
    this.update({ connection: 'connecting', activeSpeakerIds: [], localSpeaking: false, members: [], videoTracks: {}, screenTracks: {}, localCameraEnabled: false, localScreenSharing: false, chatMessages: [], raisedHands: [], disconnectReason: undefined });
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
  async startCamera(deviceId = ''): Promise<void> {
    if (!this.adapter.publishVideo) throw new Error('video_not_supported');
    await this.adapter.publishVideo(cameraConstraints(deviceId));
    this.update({ localCameraEnabled: true });
  }
  async setCameraEnabled(enabled: boolean): Promise<void> {
    if (!this.adapter.setCameraEnabled) throw new Error('video_not_supported');
    await this.adapter.setCameraEnabled(enabled);
    this.update({ localCameraEnabled: enabled });
  }
  async startScreenShare(): Promise<void> {
    if (!this.adapter.startScreenShare) throw new Error('screen_share_not_supported');
    await this.adapter.startScreenShare();
    this.update({ localScreenSharing: true });
  }
  async stopScreenShare(): Promise<void> {
    if (!this.adapter.stopScreenShare) throw new Error('screen_share_not_supported');
    await this.adapter.stopScreenShare();
    this.update({ localScreenSharing: false });
  }
  async sendChat(text: string, name: string): Promise<void> { if (!this.adapter.sendData) throw new Error('data_not_supported'); await this.adapter.sendData(new TextEncoder().encode(JSON.stringify({ type: 'chat', id: crypto.randomUUID(), name, text: text.trim().slice(0, 500) }))); }
  async setHandRaised(raised: boolean): Promise<void> { if (!this.adapter.sendData) throw new Error('data_not_supported'); await this.adapter.sendData(new TextEncoder().encode(JSON.stringify({ type: 'hand', raised }))); }
  getRecorderAudioTracks(): MediaStreamTrack[] { return this.adapter.getRecorderAudioTracks?.() ?? []; }
  async leave(): Promise<void> {
    if (this.leaving) return this.leaving;
    this.leaving = this.leaveOnce();
    return this.leaving;
  }
  private async leaveOnce(): Promise<void> {
    this.stopEvents?.(); this.stopEvents = undefined;
    await this.adapter.disconnect();
    this.update({ connection: 'disconnected', activeSpeakerIds: [], disconnectReason: 'left' });
  }
  private handle(event: SessionEvent): void {
    if (event.type === 'active-speakers') this.update({ activeSpeakerIds: event.participantIds ?? [] });
    if (event.type === 'local-level') this.update({ localSpeaking: Boolean(event.speaking) });
    if (event.type === 'participants') this.update({ members: event.members ?? [] });
    if (event.type === 'video-track' && event.participantIds?.[0] && event.track) this.update({ videoTracks: { ...this.state.videoTracks, [event.participantIds[0]]: event.track } });
    if (event.type === 'screen-track' && event.participantIds?.[0] && event.track) this.update({ screenTracks: { ...this.state.screenTracks, [event.participantIds[0]]: event.track } });
    if (event.type === 'track-removed' && event.participantIds?.[0]) {
      const id = event.participantIds[0];
      if (event.source === 'screen') { const screenTracks = { ...this.state.screenTracks }; delete screenTracks[id]; this.update({ screenTracks }); }
      else { const videoTracks = { ...this.state.videoTracks }; delete videoTracks[id]; this.update({ videoTracks }); }
    }
    if (event.type === 'participant-camera' && event.participantIds?.[0]) this.update({ members: this.state.members.map((member) => member.id === event.participantIds![0] ? { ...member, cameraEnabled: event.enabled, cameraTrackSid: event.trackSid ?? member.cameraTrackSid } : member) });
    if (event.type === 'screen-share') this.update({ localScreenSharing: Boolean(event.speaking) });
    if (event.type === 'chat' && event.message) this.update({ chatMessages: [...(this.state.chatMessages ?? []), event.message] });
    if (event.type === 'hand' && event.participantIds?.[0]) { const hands = this.state.raisedHands ?? []; this.update({ raisedHands: event.handRaised ? [...new Set([...hands, event.participantIds[0]])] : hands.filter((id) => id !== event.participantIds![0]) }); }
    if (event.type === 'reconnecting') this.update({ connection: 'reconnecting', disconnectReason: undefined });
    if (event.type === 'reconnected' || event.type === 'connected') this.update({ connection: 'connected', disconnectReason: undefined });
    if (event.type === 'disconnected') this.update({ connection: 'disconnected', disconnectReason: event.reason ?? 'disconnected' });
  }
  private update(next: Partial<SessionState>): void { this.state = { ...this.state, ...next }; this.onState(this.state); }
}
