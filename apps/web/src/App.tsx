import { useEffect, useMemo, useState } from 'react';
import { createRoom, joinRoom } from './api.js';
import { AVATARS, type AudioMode, type AvatarId, loadPreferences, savePreferences, validateNickname } from './domain.js';

type MediaDevicesLike = Pick<MediaDevices, 'enumerateDevices'>;
interface Props { mediaDevices?: MediaDevicesLike }
interface Device { deviceId: string; label: string }
const roomIdFromPath = () => new URLSearchParams(location.search).get('room') ?? '';
const errorText: Record<string, string> = { room_not_found: '这间房已失效或不存在。', room_full: '房间已满（最多 10 人）。', room_service_unavailable: '房间服务暂时不可用，请稍后再试。', network_error: '网络连接失败，请检查后重试。' };

export const App = ({ mediaDevices = navigator.mediaDevices }: Props) => {
  const defaults = useMemo(loadPreferences, []);
  const [roomId, setRoomId] = useState(roomIdFromPath);
  const [nickname, setNickname] = useState(defaults.nickname);
  const [avatarId, setAvatarId] = useState<AvatarId>(defaults.avatarId);
  const [deviceId, setDeviceId] = useState(defaults.deviceId);
  const [mode, setMode] = useState<AudioMode>(defaults.mode);
  const [devices, setDevices] = useState<Device[]>([]);
  const [screen, setScreen] = useState<'lobby' | 'room'>('lobby');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refreshDevices = async () => {
    if (!mediaDevices?.enumerateDevices) { setError('此浏览器无法选择麦克风设备。'); return; }
    try { const inputs = (await mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput').map((device, index) => ({ deviceId: device.deviceId, label: device.label || `麦克风 ${index + 1}` })); setDevices(inputs); if (!deviceId && inputs[0]) setDeviceId(inputs[0].deviceId); } catch { setError('无法读取麦克风列表；可选择仅收听进入。'); }
  };
  useEffect(() => { void refreshDevices(); }, []);
  const persist = () => savePreferences({ nickname: validateNickname(nickname) ?? '', avatarId, deviceId, mode });
  const enter = async (listenOnly: boolean) => {
    const validName = validateNickname(nickname);
    if (!validName) { setError('请输入 1–32 个字符的昵称。'); return; }
    if (!roomId) { setError('请先创建房间或打开邀请链接。'); return; }
    persist(); setBusy(true); setError('');
    try { await joinRoom(roomId, { nickname: validName, avatarId }); setScreen('room'); if (listenOnly) setError('已以仅收听模式进入；连接音频将在下一步完成。'); }
    catch (reason) { setError(errorText[reason instanceof Error ? reason.message : ''] ?? '加入失败，请稍后重试。'); }
    finally { setBusy(false); }
  };
  const makeRoom = async () => { setBusy(true); setError(''); try { const id = await createRoom(); setRoomId(id); history.replaceState(null, '', `?room=${encodeURIComponent(id)}`); } catch { setError('创建房间失败，请稍后重试。'); } finally { setBusy(false); } };
  if (screen === 'room') return <Room roomId={roomId} nickname={validateNickname(nickname) ?? '我'} avatarId={avatarId} onLeave={() => setScreen('lobby')} />;
  return <main className="console"><header><p className="eyebrow">LOW LATENCY · PRIVATE SESSION</p><h1>余响 <i>Echo Room</i></h1><p className="subtitle">为对话、演奏与安静聆听准备的临时声场</p></header><section className="rack"><div className="rail"><span>01</span><b>身份</b><span>02</span><b>输入</b><span>03</span><b>入场</b></div><div className="panel"><div className="roomline"><label>房间编号<input aria-label="房间编号" value={roomId} onChange={(event) => setRoomId(event.target.value)} placeholder="打开邀请链接后自动填入" /></label><button className="outline" onClick={() => void makeRoom()} disabled={busy}>创建邀请房间</button></div><label>昵称<input aria-label="昵称" value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="给这次声音一个名字" maxLength={32} /></label><fieldset><legend>选择身份</legend><div className="avatars">{AVATARS.map((avatar) => <button type="button" aria-label={avatar.label} aria-pressed={avatar.id === avatarId} data-avatar={avatar.id} key={avatar.id} className={avatar.id === avatarId ? 'avatar chosen' : 'avatar'} onClick={() => setAvatarId(avatar.id)}><span>{avatar.icon}</span><small>{avatar.label}</small></button>)}</div></fieldset><div className="input-grid"><label>麦克风设备<select aria-label="麦克风设备" value={deviceId} onChange={(event) => setDeviceId(event.target.value)}><option value="">自动选择</option>{devices.map((device) => <option value={device.deviceId} key={device.deviceId}>{device.label}</option>)}</select></label><button className="refresh" onClick={() => void refreshDevices()} aria-label="刷新麦克风设备">↻ 刷新设备</button></div><fieldset className="modes"><legend>音频模式</legend><button type="button" className={mode === 'voice' ? 'mode selected' : 'mode'} onClick={() => setMode('voice')}><b>语音</b><span>48 kHz · 人声处理</span></button><button type="button" className={mode === 'instrument' ? 'mode selected' : 'mode'} onClick={() => setMode('instrument')}><b>乐器原声</b><span>48 kHz · 立体声优先</span></button></fieldset>{mode === 'instrument' && <p className="notice">原声模式会关闭回声消除与降噪。请佩戴耳机，实际参数取决于设备。</p>} {error && <p role="alert" className="notice">{error}</p>}<div className="actions"><button className="outline" onClick={() => void enter(true)} disabled={busy}>仅收听进入</button><button className="primary" onClick={() => void enter(false)} disabled={busy}>{busy ? '正在连接…' : '开启麦克风进入'}</button></div></div></section><footer>无需账号 · 不录音 · 邀请链接 5 分钟有效</footer></main>;
};

const Room = ({ roomId, nickname, avatarId, onLeave }: { roomId: string; nickname: string; avatarId: AvatarId; onLeave: () => void }) => {
  const [muted, setMuted] = useState(false); const avatar = AVATARS.find((item) => item.id === avatarId)!;
  return <main className="console room"><header><p className="eyebrow">ROOM / {roomId}</p><h1>声场已接通</h1><p className="subtitle">RTC 音频连接将在此控制台下一阶段启用</p></header><section className="participants" aria-label="房间成员"><article className="participant speaking"><div className="portrait">{avatar.icon}</div><div><b>{nickname}（我）</b><p>{muted ? '已静音' : '等待音轨连接'}</p></div><span className="meter" aria-label="说话状态">●</span></article></section><div className="actions"><button className="outline" onClick={() => setMuted(!muted)} aria-pressed={muted}>{muted ? '解除静音' : '静音'}</button><button className="danger" onClick={onLeave}>离开房间</button></div></main>;
};
