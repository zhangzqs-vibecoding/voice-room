export interface MeetingControlHandlers {
  onMute: () => void;
  onCamera: () => void;
  onScreenShare: () => void;
  onRecord: () => void;
  onLeave: () => void;
}

export const MeetingControls = ({ muted, cameraEnabled, sharingScreen, recording, handlers, disabled = false }: { muted: boolean; cameraEnabled: boolean; sharingScreen: boolean; recording: boolean; handlers: MeetingControlHandlers; disabled?: boolean }) => {
  const isHost = typeof location !== 'undefined' && new URLSearchParams(location.search).has('hostToken');
  const hostAction = async (action: 'mute' | 'remove' | 'lock' | 'end') => { const room = location.pathname.match(/^\/meeting\/([^/]+)/)?.[1]; if (!room) return; await fetch(`/api/rooms/${room}/host/${action}`, { method: 'POST', headers: { authorization: `Bearer ${new URLSearchParams(location.search).get('hostToken') ?? ''}` } }).catch(() => undefined); };
  return <nav className="meeting-controls" aria-label="会议控制">
  <button className="outline" aria-pressed={muted} onClick={handlers.onMute} disabled={disabled}>{muted ? '解除静音' : '静音'}</button>
  <button className="outline" aria-pressed={!cameraEnabled} onClick={handlers.onCamera} disabled={disabled}>{cameraEnabled ? '关闭摄像头' : '开启摄像头'}</button>
  <button className="outline" aria-pressed={sharingScreen} onClick={handlers.onScreenShare} disabled={disabled}>{sharingScreen ? '停止共享' : '共享屏幕'}</button>
  <button className={recording ? 'recording' : 'outline'} aria-pressed={recording} onClick={handlers.onRecord} disabled={disabled}>{recording ? '停止录制' : '开始录制'}</button>
  <button className="danger" onClick={handlers.onLeave} disabled={false}>离开房间</button>
  {isHost && <div className="host-controls" aria-label="主持人控制"><span>主持人</span><button className="outline" onClick={() => void hostAction('mute')}>静音成员</button><button className="outline" onClick={() => void hostAction('remove')}>移除成员</button><button className="outline" onClick={() => void hostAction('lock')}>锁定会议</button><button className="danger" onClick={() => void hostAction('end')}>结束会议</button></div>}
</nav>;
};
