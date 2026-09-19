export interface MeetingControlHandlers {
  onMute: () => void;
  onCamera: () => void;
  onScreenShare: () => void;
  onRecord: () => void;
  onLeave: () => void;
}

export const MeetingControls = ({ muted, cameraEnabled, sharingScreen, recording, handlers, disabled = false }: { muted: boolean; cameraEnabled: boolean; sharingScreen: boolean; recording: boolean; handlers: MeetingControlHandlers; disabled?: boolean }) => <nav className="meeting-controls" aria-label="会议控制">
  <button className="outline" aria-pressed={muted} onClick={handlers.onMute} disabled={disabled}>{muted ? '解除静音' : '静音'}</button>
  <button className="outline" aria-pressed={!cameraEnabled} onClick={handlers.onCamera} disabled={disabled}>{cameraEnabled ? '关闭摄像头' : '开启摄像头'}</button>
  <button className="outline" aria-pressed={sharingScreen} onClick={handlers.onScreenShare} disabled={disabled}>{sharingScreen ? '停止共享' : '共享屏幕'}</button>
  <button className={recording ? 'recording' : 'outline'} aria-pressed={recording} onClick={handlers.onRecord} disabled={disabled}>{recording ? '停止录制' : '开始录制'}</button>
  <button className="danger" onClick={handlers.onLeave} disabled={false}>离开房间</button>
</nav>;
