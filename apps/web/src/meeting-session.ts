import { AudioSession, type EnterOptions, type SessionAdapter, type SessionState } from './audio-session.js';

/**
 * 会议媒体会话门面：复用现有音频生命周期，同时暴露摄像头和屏幕共享控制。
 * 这样 UI 不需要知道 LiveKit 的具体实现，便于测试和未来替换媒体适配器。
 */
export class MeetingSession {
  private readonly session: AudioSession;
  constructor(adapter: SessionAdapter, onState?: (state: SessionState) => void) {
    this.session = new AudioSession(adapter, onState);
  }
  enter(options: EnterOptions): Promise<void> { return this.session.enter(options); }
  leave(): Promise<void> { return this.session.leave(); }
  setMuted(muted: boolean): Promise<void> { return this.session.setMuted(muted); }
  switchDevice(deviceId: string, mode: EnterOptions['mode']): Promise<void> { return this.session.switchDevice(deviceId, mode); }
  startCamera(deviceId?: string): Promise<void> { return this.session.startCamera(deviceId); }
  setCameraEnabled(enabled: boolean): Promise<void> { return this.session.setCameraEnabled(enabled); }
  startScreenShare(): Promise<void> { return this.session.startScreenShare(); }
  stopScreenShare(): Promise<void> { return this.session.stopScreenShare(); }
}
