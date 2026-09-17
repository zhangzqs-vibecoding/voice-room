import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoom, joinRoom, type JoinResponse } from './api.js';
import { AudioSession, type SessionAdapter, type SessionState } from './audio-session.js';
import { LiveKitSessionAdapter } from './livekit-session.js';
import { AVATARS, type AudioMode, type AvatarId, loadPreferences, savePreferences, validateNickname } from './domain.js';

type MediaDevicesLike = Pick<MediaDevices, 'enumerateDevices'>;
interface Member { id: string; name: string; avatarId: AvatarId; speaking: boolean }
interface Props { mediaDevices?: MediaDevicesLike; members?: Member[]; sessionFactory?: () => SessionAdapter }
interface Device { deviceId: string; label: string }
const roomIdFromPath = () => new URLSearchParams(location.search).get('room') ?? '';
const errorText: Record<string, string> = { room_not_found: '这间房已失效或不存在。', room_full: '房间已满（最多 10 人）。', room_service_unavailable: '房间服务暂时不可用，请稍后再试。', network_error: '网络连接失败，请检查后重试。' };

export const App = ({ mediaDevices = navigator.mediaDevices, members = [], sessionFactory = () => new LiveKitSessionAdapter() }: Props) => {
  const defaults = useMemo(loadPreferences, []);
  const [roomId, setRoomId] = useState(roomIdFromPath);
  const [nickname, setNickname] = useState(defaults.nickname);
  const [avatarId, setAvatarId] = useState<AvatarId>(defaults.avatarId);
  const [deviceId, setDeviceId] = useState(defaults.deviceId);
  const [mode, setMode] = useState<AudioMode>(defaults.mode);
  const [devices, setDevices] = useState<Device[]>([]);
  const [screen, setScreen] = useState<'lobby' | 'room'>('lobby');
  const [message, setMessage] = useState('');
  const [inviteUrl, setInviteUrl] = useState('');
  const [listenOnly, setListenOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [credentials, setCredentials] = useState<JoinResponse>();
  const refreshDevices = async () => {
    if (!mediaDevices?.enumerateDevices) { setMessage('此浏览器无法选择麦克风设备。'); return; }
    try {
      const inputs = (await mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput').map((device, index) => ({ deviceId: device.deviceId, label: device.label || `麦克风 ${index + 1}` }));
      setDevices(inputs); if (!deviceId && inputs[0]) setDeviceId(inputs[0].deviceId);
    } catch { setMessage('无法读取麦克风列表；可选择仅收听进入。'); }
  };
  useEffect(() => { void refreshDevices(); }, []);
  const persist = () => savePreferences({ nickname: validateNickname(nickname) ?? '', avatarId, deviceId, mode });
  const enter = async (nextListenOnly: boolean) => {
    const validName = validateNickname(nickname);
    if (!validName) { setMessage('请输入 1–32 个字符的昵称。'); return; }
    if (!roomId) { setMessage('请先创建房间或打开邀请链接。'); return; }
    persist(); setBusy(true); setMessage('');
    try { const nextCredentials = await joinRoom(roomId, { nickname: validName, avatarId }); setCredentials(nextCredentials); setListenOnly(nextListenOnly); setScreen('room'); }
    catch (reason) { setMessage(errorText[reason instanceof Error ? reason.message : ''] ?? '加入失败，请稍后重试。'); }
    finally { setBusy(false); }
  };
  const makeRoom = async () => {
    setBusy(true); setMessage('');
    try { const id = await createRoom(); const url = new URL(`?room=${encodeURIComponent(id)}`, location.href).toString(); setRoomId(id); setInviteUrl(url); history.replaceState(null, '', `?room=${encodeURIComponent(id)}`); setMessage('邀请链接已生成，复制后发送给朋友。'); }
    catch { setMessage('创建房间失败，请稍后重试。'); } finally { setBusy(false); }
  };
  const copyInvite = async () => {
    const writeText = navigator.clipboard?.writeText;
    if (!writeText) { setMessage('请手动复制邀请链接。'); return; }
    try { await writeText.call(navigator.clipboard, inviteUrl); setMessage('邀请链接已复制。'); }
    catch { setMessage('请手动复制邀请链接。'); }
  };
  if (screen === 'room' && credentials) return <Room roomId={roomId} nickname={validateNickname(nickname) ?? '我'} avatarId={avatarId} listenOnly={listenOnly} members={members} deviceId={deviceId} devices={devices} mode={mode} credentials={credentials} sessionFactory={sessionFactory} onDeviceChange={setDeviceId} onRefreshDevices={() => void refreshDevices()} onReconnect={() => void enter(listenOnly)} onLeave={() => { setMessage(''); setScreen('lobby'); }} />;
  return <main className="console"><header><p className="eyebrow">LOW LATENCY · PRIVATE SESSION</p><h1>余响 <i>Echo Room</i></h1><p className="subtitle">为对话、演奏与安静聆听准备的临时声场</p></header><section className="rack"><div className="rail"><span>01</span><b>身份</b><span>02</span><b>输入</b><span>03</span><b>入场</b></div><div className="panel"><div className="roomline"><label>房间编号<input aria-label="房间编号" value={roomId} onChange={(event) => setRoomId(event.target.value)} placeholder="打开邀请链接后自动填入" /></label><button className="outline" onClick={() => void makeRoom()} disabled={busy}>创建邀请房间</button></div>{inviteUrl && <div className="invite"><label>邀请链接<input aria-label="邀请链接" readOnly value={inviteUrl} /></label><button className="outline" onClick={() => void copyInvite()}>复制邀请链接</button></div>}<label>昵称<input aria-label="昵称" value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="给这次声音一个名字" maxLength={32} /></label><fieldset><legend>选择身份</legend><div className="avatars">{AVATARS.map((avatar) => <button type="button" aria-label={avatar.label} aria-pressed={avatar.id === avatarId} data-avatar={avatar.id} key={avatar.id} className={avatar.id === avatarId ? 'avatar chosen' : 'avatar'} onClick={() => setAvatarId(avatar.id)}><span>{avatar.icon}</span><small>{avatar.label}</small></button>)}</div></fieldset><div className="input-grid"><label>麦克风设备<select aria-label="麦克风设备" value={deviceId} onChange={(event) => setDeviceId(event.target.value)}><option value="">自动选择</option>{devices.map((device) => <option value={device.deviceId} key={device.deviceId}>{device.label}</option>)}</select></label><button className="refresh" onClick={() => void refreshDevices()} aria-label="刷新设备列表">↻ 刷新设备</button></div><fieldset className="modes"><legend>音频模式</legend><button type="button" className={mode === 'voice' ? 'mode selected' : 'mode'} onClick={() => setMode('voice')}><b>语音</b><span>48 kHz · 人声处理</span></button><button type="button" className={mode === 'instrument' ? 'mode selected' : 'mode'} onClick={() => setMode('instrument')}><b>乐器原声</b><span>48 kHz · 立体声优先</span></button></fieldset>{mode === 'instrument' && <p className="notice">原声模式会关闭回声消除与降噪。请佩戴耳机，实际参数取决于设备。</p>}{message && <p role="alert" className="notice">{message}</p>}<div className="actions"><button className="outline" onClick={() => void enter(true)} disabled={busy}>仅收听进入</button><button className="primary" onClick={() => void enter(false)} disabled={busy}>{busy ? '正在连接…' : '开启麦克风进入'}</button></div></div></section><footer>无需账号 · 不录音 · 邀请链接 5 分钟有效</footer></main>;
};

export const Room = ({ roomId, nickname, avatarId, listenOnly, members, deviceId = '', devices = [], mode = 'voice', credentials, sessionFactory = () => new LiveKitSessionAdapter(), onDeviceChange, onRefreshDevices, onReconnect, onLeave }: { roomId: string; nickname: string; avatarId: AvatarId; listenOnly: boolean; members: Member[]; deviceId?: string; devices?: Device[]; mode?: AudioMode; credentials?: JoinResponse; sessionFactory?: () => SessionAdapter; onDeviceChange?: (deviceId: string) => void; onRefreshDevices?: () => void; onReconnect?: () => void; onLeave: () => void }) => {
  const [muted, setMuted] = useState(false);
  const [state, setState] = useState<SessionState>({ connection: credentials ? 'connecting' : 'connected', activeSpeakerIds: [], localSpeaking: false, members: [] });
  const session = useRef<AudioSession | undefined>(undefined);
  const sessionFactoryRef = useRef(sessionFactory);
  sessionFactoryRef.current = sessionFactory;
  useEffect(() => {
    if (!credentials) return;
    const next = new AudioSession(sessionFactoryRef.current(), setState); session.current = next;
    void next.enter({ ...credentials, listenOnly, mode, deviceId }).catch(() => undefined);
    return () => { void next.leave().catch(() => undefined); };
  }, [credentials?.livekitUrl, credentials?.participantId, credentials?.token]);
  const visibleMembers: Member[] = [...members, ...state.members.map((member) => ({ ...member, avatarId: AVATARS.some((avatar) => avatar.id === member.avatarId) ? member.avatarId as AvatarId : 'fox', speaking: state.activeSpeakerIds.includes(member.id) }))];
  const self: Member = { id: 'self', name: nickname, avatarId, speaking: !muted && state.localSpeaking };
  const leave = async () => { await session.current?.leave(); onLeave(); };
  const toggleMute = () => { const next = !muted; setMuted(next); void session.current?.setMuted(next); };
  const changeDevice = (nextDeviceId: string) => { onDeviceChange?.(nextDeviceId); void session.current?.switchDevice(nextDeviceId, mode); };
  return <main className="console room"><header><p className="eyebrow">ROOM / {roomId}</p><h1>声场已接通</h1><p className="subtitle">{state.connection === 'reconnecting' ? '正在恢复连接…' : state.connection === 'disconnected' ? '连接已断开' : listenOnly ? '仅收听 · 已连接 RTC 音频' : 'RTC 音频已连接'}</p></header>{!listenOnly && <div className="input-grid room-device"><label>麦克风设备<select aria-label="房内麦克风设备" value={deviceId} onChange={(event) => changeDevice(event.target.value)}><option value="">自动选择</option>{devices.map((device) => <option value={device.deviceId} key={device.deviceId}>{device.label}</option>)}</select></label><button className="refresh" onClick={onRefreshDevices}>↻ 刷新设备</button></div>}<section className="participants" aria-label="房间成员">{[self, ...visibleMembers].map((member) => { const avatar = AVATARS.find((item) => item.id === member.avatarId)!; const isSelf = member.id === 'self'; return <article className="participant" key={member.id} data-speaking={member.speaking}><div className="portrait">{avatar.icon}</div><div><b>{member.name}{isSelf ? '（我）' : ''}</b><p>{isSelf ? (listenOnly ? '仅收听' : muted ? '已静音' : member.speaking ? '正在发言' : '静默') : member.speaking ? '正在发言' : '静默'}</p></div>{member.speaking && <span className="meter" aria-label={`${member.name} 正在发言`}>●</span>}</article>; })}</section><div className="actions">{state.connection === 'disconnected' && onReconnect && <button className="primary" onClick={onReconnect}>重新入场</button>}{!listenOnly && <button className="outline" onClick={toggleMute} aria-pressed={muted}>{muted ? '解除静音' : '静音'}</button>}<button className="danger" onClick={leave}>离开房间</button></div></main>;
};
