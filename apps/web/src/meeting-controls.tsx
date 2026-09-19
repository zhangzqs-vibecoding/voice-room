import { useState } from 'react';

export interface MeetingControlHandlers {
  onMute: () => void;
  onCamera: () => void;
  onScreenShare: () => void;
  onRecord: () => void;
  onLeave: () => void;
}

export const MeetingControls = ({ muted, cameraEnabled, sharingScreen, recording, handlers, disabled = false }: { muted: boolean; cameraEnabled: boolean; sharingScreen: boolean; recording: boolean; handlers: MeetingControlHandlers; disabled?: boolean }) => {
  const isHost = typeof location !== 'undefined' && new URLSearchParams(location.search).has('hostToken');
  const [hostError, setHostError] = useState('');
  const [targetId, setTargetId] = useState('');
  const targets = typeof document === 'undefined' ? [] : [...document.querySelectorAll<HTMLElement>('.video-tile[data-participant]:not([data-participant="self"])')].map((element) => ({ id: element.dataset.participant ?? '', label: element.textContent?.trim() || element.dataset.participant || '', trackSid: element.dataset.trackSid ?? '' })).filter((target) => target.id);
  const hostAction = async (action: 'mute' | 'camera' | 'remove' | 'lock' | 'end') => {
    const room = location.pathname.match(/^\/meeting\/([^/]+)/)?.[1]; if (!room) return;
    const target = document.querySelector<HTMLElement>(`.video-tile[data-participant="${targetId || (targets[0]?.id ?? '')}"]`);
    const participantId = target?.dataset.participant;
    if ((action === 'mute' || action === 'remove') && !participantId) { setHostError('请先选择成员。'); return; }
    if ((action === 'mute' && !target?.dataset.micTrackSid) || (action === 'camera' && !target?.dataset.trackSid)) { setHostError('该成员的音视频轨道尚未就绪。'); return; }
    const base = `/api/rooms/${room}`;
    const path = action === 'lock' ? `${base}/lock` : action === 'end' ? `${base}/end` : `${base}/participants/${encodeURIComponent(participantId!)}/${action}`;
    const body = action === 'lock' ? { locked: true } : action === 'mute' ? { trackSid: target?.dataset.micTrackSid, muted: true } : action === 'camera' ? { trackSid: target?.dataset.trackSid, muted: true } : undefined;
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-host-token': new URLSearchParams(location.search).get('hostToken') ?? '' }, ...(body ? { body: JSON.stringify(body) } : {}) }).catch(() => undefined);
    if (!response?.ok) setHostError('主持人操作失败，请重试。'); else setHostError('');
  };
  return <nav className="meeting-controls" aria-label="会议控制">
  <button className="outline" aria-pressed={muted} onClick={handlers.onMute} disabled={disabled}>{muted ? '解除静音' : '静音'}</button>
  <button className="outline" aria-pressed={!cameraEnabled} onClick={handlers.onCamera} disabled={disabled}>{cameraEnabled ? '关闭摄像头' : '开启摄像头'}</button>
  <button className="outline" aria-pressed={sharingScreen} onClick={handlers.onScreenShare} disabled={disabled}>{sharingScreen ? '停止共享' : '共享屏幕'}</button>
  <button className={recording ? 'recording' : 'outline'} aria-pressed={recording} onClick={handlers.onRecord} disabled={disabled}>{recording ? '停止录制' : '开始录制'}</button>
  <button className="danger" onClick={handlers.onLeave} disabled={false}>离开房间</button>
  {isHost && <div className="host-controls" aria-label="主持人控制"><span>主持人</span><select aria-label="主持人目标成员" value={targetId} onChange={(event) => setTargetId(event.target.value)}><option value="">选择成员</option>{targets.map((target) => <option value={target.id} key={target.id}>{target.label}</option>)}</select><button className="outline" onClick={() => void hostAction('mute')}>静音成员</button><button className="outline" onClick={() => void hostAction('camera')}>关闭成员摄像头</button><button className="outline" onClick={() => void hostAction('remove')}>移除成员</button><button className="outline" onClick={() => void hostAction('lock')}>锁定会议</button><button className="danger" onClick={() => void hostAction('end')}>结束会议</button>{hostError && <small role="alert">{hostError}</small>}</div>}
</nav>;
};
