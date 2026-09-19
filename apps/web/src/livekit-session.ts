import { AudioPresets, Room, RoomEvent, Track, VideoPresets, createLocalAudioTrack, createLocalScreenTracks, createLocalVideoTrack, type LocalAudioTrack, type LocalVideoTrack, type RemoteTrack, type TrackPublishOptions } from 'livekit-client';
import type { AudioConstraints, RemoteMember, SessionAdapter, SessionEvent, VideoConstraints } from './audio-session.js';

/** Browser-only LiveKit bridge. The SFU receives audio directly; this class never records or stores it. */
export const publishOptions = (constraints: AudioConstraints): TrackPublishOptions => {
  const instrument = constraints.channelCount === 2;
  return { source: Track.Source.Microphone, forceStereo: instrument, dtx: !instrument, red: true, audioPreset: instrument ? AudioPresets.musicHighQualityStereo : AudioPresets.speech };
};
export class LiveKitSessionAdapter implements SessionAdapter {
  private readonly room = new Room({ adaptiveStream: false, dynacast: true });
  private localTrack?: LocalAudioTrack;
  private localVideoTrack?: LocalVideoTrack;
  private localScreenTrack?: LocalVideoTrack;
  private listener?: (event: SessionEvent) => void;
  private attached = new Set<HTMLAudioElement>();
  private readonly trackElements = new Map<RemoteTrack, HTMLAudioElement>();
  private analyser?: AnalyserNode;
  private analyserTimer?: number;
  private context?: AudioContext;

  constructor() {
    this.room.on(RoomEvent.Reconnecting, () => this.emit({ type: 'reconnecting' }));
    this.room.on(RoomEvent.Reconnected, () => this.emit({ type: 'reconnected' }));
    this.room.on(RoomEvent.Disconnected, (reason) => this.emit({ type: 'disconnected', reason: String(reason ?? 'disconnected') }));
    this.room.on(RoomEvent.ActiveSpeakersChanged, (participants) => this.emit({ type: 'active-speakers', participantIds: participants.map((participant) => participant.identity) }));
    this.room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => this.attachRemoteTrack(track, publication.source, participant.identity));
    this.room.on(RoomEvent.TrackUnsubscribed, (track) => this.detachRemoteAudio(track));
    this.room.on(RoomEvent.ParticipantConnected, () => this.emitMembers());
    this.room.on(RoomEvent.ParticipantDisconnected, () => this.emitMembers());
  }
  async connect(url: string, token: string): Promise<void> { await this.room.connect(url, token); this.emitMembers(); this.emit({ type: 'connected' }); }
  async publish(constraints: AudioConstraints): Promise<void> {
    this.localTrack = await createLocalAudioTrack({ ...constraints });
    await this.room.localParticipant.publishTrack(this.localTrack, publishOptions(constraints));
    this.startLevelMeter(this.localTrack);
  }
  async setMuted(muted: boolean): Promise<void> {
    if (!this.localTrack) return;
    if (muted) await this.localTrack.mute();
    else await this.localTrack.unmute();
  }
  async switchDevice(constraints: AudioConstraints): Promise<void> {
    if (!this.localTrack) return;
    await this.room.localParticipant.unpublishTrack(this.localTrack, true);
    this.stopLevelMeter(); this.localTrack.stop();
    this.localTrack = await createLocalAudioTrack({ ...constraints });
    await this.room.localParticipant.publishTrack(this.localTrack, publishOptions(constraints));
    this.startLevelMeter(this.localTrack);
  }
  async publishVideo(constraints: VideoConstraints): Promise<void> {
    if (this.localVideoTrack) await this.room.localParticipant.unpublishTrack(this.localVideoTrack, true);
    this.localVideoTrack = await createLocalVideoTrack(constraints as Parameters<typeof createLocalVideoTrack>[0]);
    await this.room.localParticipant.publishTrack(this.localVideoTrack, { source: Track.Source.Camera, simulcast: true, videoSimulcastLayers: [VideoPresets.h360, VideoPresets.h180], degradationPreference: 'maintain-framerate' });
    this.emit({ type: 'video-track', participantIds: ['self'], track: this.localVideoTrack.mediaStreamTrack });
  }
  async setCameraEnabled(enabled: boolean): Promise<void> {
    if (!this.localVideoTrack) return;
    if (enabled) await this.localVideoTrack.unmute(); else await this.localVideoTrack.mute();
  }
  async startScreenShare(): Promise<void> {
    await this.stopScreenShare();
    const tracks = await createLocalScreenTracks({ audio: false });
    const track = tracks.find((item) => item.kind === Track.Kind.Video) as LocalVideoTrack | undefined;
    if (!track) throw new Error('screen_share_not_supported');
    this.localScreenTrack = track;
    track.mediaStreamTrack.addEventListener('ended', () => { void this.stopScreenShare(); });
    await this.room.localParticipant.publishTrack(track, { source: Track.Source.ScreenShare, screenShareEncoding: { maxBitrate: 2_500_000, maxFramerate: 15 }, degradationPreference: 'maintain-resolution' });
    this.emit({ type: 'screen-track', participantIds: ['self'], track: track.mediaStreamTrack });
    this.emit({ type: 'screen-share', speaking: true });
  }
  async stopScreenShare(): Promise<void> {
    if (!this.localScreenTrack) return;
    const track = this.localScreenTrack;
    this.localScreenTrack = undefined;
    await this.room.localParticipant.unpublishTrack(track, true);
    track.stop();
    this.emit({ type: 'screen-share', speaking: false });
  }
  onEvent(listener: (event: SessionEvent) => void): () => void { this.listener = listener; return () => { if (this.listener === listener) this.listener = undefined; }; }
  async disconnect(): Promise<void> {
    this.stopLevelMeter();
    if (this.localTrack) { await this.room.localParticipant.unpublishTrack(this.localTrack, true); this.localTrack.stop(); this.localTrack = undefined; }
    if (this.localVideoTrack) { await this.room.localParticipant.unpublishTrack(this.localVideoTrack, true); this.localVideoTrack.stop(); this.localVideoTrack = undefined; }
    await this.stopScreenShare();
    for (const element of this.attached) { element.pause(); element.remove(); }
    this.attached.clear(); await this.room.disconnect();
  }
  private attachRemoteTrack(track: RemoteTrack, source: Track.Source, participantId: string): void {
    if (track.kind !== Track.Kind.Audio && track.kind !== Track.Kind.Video) return;
    if (track.kind === Track.Kind.Video) {
      this.emit({ type: source === Track.Source.ScreenShare ? 'screen-track' : 'video-track', participantIds: [participantId], track: track.mediaStreamTrack });
      return;
    }
    const element = track.attach(); element.autoplay = true; element.setAttribute('playsinline', ''); element.dataset.livekitAudio = 'true';
    document.body.append(element); this.attached.add(element); this.trackElements.set(track, element);
  }
  private detachRemoteAudio(track: RemoteTrack): void {
    const element = this.trackElements.get(track);
    if (!element) return;
    track.detach(element); element.pause(); element.remove(); this.attached.delete(element); this.trackElements.delete(track);
  }
  private startLevelMeter(track: LocalAudioTrack): void {
    try {
      this.context = new AudioContext(); this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 512;
      this.context.createMediaStreamSource(new MediaStream([track.mediaStreamTrack])).connect(this.analyser);
      const samples = new Uint8Array(this.analyser.fftSize);
      this.analyserTimer = window.setInterval(() => { this.analyser?.getByteTimeDomainData(samples); const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value - 128)), 0); this.emit({ type: 'local-level', speaking: peak > 5 }); }, 100);
    } catch { /* Metering is optional and must not block publishing. */ }
  }
  private stopLevelMeter(): void { if (this.analyserTimer) window.clearInterval(this.analyserTimer); this.analyserTimer = undefined; void this.context?.close(); this.context = undefined; this.analyser = undefined; }
  private emit(event: SessionEvent): void { this.listener?.(event); }
  private emitMembers(): void {
    const members: RemoteMember[] = [...this.room.remoteParticipants.values()].map((participant) => {
      let avatarId = 'fox';
      try { avatarId = (JSON.parse(participant.metadata || '{}') as { avatarId?: string }).avatarId ?? avatarId; } catch { /* metadata is optional */ }
      return { id: participant.identity, name: participant.name || participant.identity, avatarId };
    });
    this.emit({ type: 'participants', members });
  }
}
