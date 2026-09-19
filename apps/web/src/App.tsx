import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoom, joinRoom, type JoinResponse } from './api.js';
import { AudioSession, type SessionAdapter, type SessionState } from './audio-session.js';
import { LiveKitSessionAdapter } from './livekit-session.js';
import { MeetingControls } from './meeting-controls.js';
import { MeetingLayout, type VideoParticipant } from './meeting-layout.js';
import { LocalCompositeRecorder } from './local-recorder.js';
import { AVATARS, type AudioMode, type AvatarId, loadPreferences, savePreferences, validateNickname } from './domain.js';

type MediaDevicesLike = Pick<MediaDevices, 'enumerateDevices'>;
interface Member { id: string; name: string; avatarId: AvatarId; speaking: boolean }
interface Props { mediaDevices?: MediaDevicesLike; members?: Member[]; sessionFactory?: () => SessionAdapter }
interface Device { deviceId: string; label: string }
const meetingPath = () => { const match = location.pathname.match(/^\/meeting\/([^/]+)/); return match ? decodeURIComponent(match[1]) : ''; };
const roomIdFromPath = () => meetingPath() || (new URLSearchParams(location.search).get('room') ?? '');
const tokenFromPath = (name: 'hostToken' | 'participantToken') => new URLSearchParams(location.search).get(name) ?? undefined;
const errorText: Record<string, string> = { room_not_found: '这间房已失效或不存在。', room_full: '房间已满。', room_service_unavailable: '房间服务暂时不可用，请稍后再试。', network_error: '网络连接失败，请检查后重试。' };

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
  const [maxParticipants] = useState(10);
  const [hostInviteUrl, setHostInviteUrl] = useState('');
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
    try { const nextCredentials = await joinRoom(roomId, { nickname: validName, avatarId, hostToken: tokenFromPath('hostToken'), participantToken: tokenFromPath('participantToken') }); setCredentials(nextCredentials); setListenOnly(nextListenOnly); setScreen('room'); }
    catch (reason) { setMessage(errorText[reason instanceof Error ? reason.message : ''] ?? '加入失败，请稍后重试。'); }
    finally { setBusy(false); }
  };
  const makeRoom = async () => {
    setBusy(true); setMessage('');
    try { const room = await createRoom(maxParticipants); const url = room.participantUrl || new URL(`?room=${encodeURIComponent(room.roomId)}`, location.href).toString(); setRoomId(room.roomId); setInviteUrl(url); setHostInviteUrl(room.hostUrl || url); history.replaceState(null, '', new URL(url).pathname + new URL(url).search); setMessage('邀请链接已生成，复制后发送给朋友。'); }
    catch { setMessage('创建房间失败，请稍后重试。'); } finally { setBusy(false); }
  };
  const copyInvite = async () => {
    const writeText = navigator.clipboard?.writeText;
    if (!writeText) { setMessage('请手动复制邀请链接。'); return; }
    try { await writeText.call(navigator.clipboard, inviteUrl); setMessage(hostInviteUrl ? '邀请链接已复制。主持人链接已保留在创建者页面。' : '邀请链接已复制。'); }
    catch { setMessage('请手动复制邀请链接。'); }
  };
  if (screen === 'room' && credentials) return <Room roomId={roomId} nickname={validateNickname(nickname) ?? '我'} avatarId={avatarId} listenOnly={listenOnly} members={members} deviceId={deviceId} devices={devices} mode={mode} credentials={credentials} sessionFactory={sessionFactory} onDeviceChange={setDeviceId} onRefreshDevices={() => void refreshDevices()} onReconnect={() => void enter(listenOnly)} onLeave={() => { setMessage(''); setScreen('lobby'); }} />;
  return <main className="console"><header><p className="eyebrow">LOW LATENCY · PRIVATE SESSION</p><h1>余响 <i>Echo Room</i></h1><p className="subtitle">为对话、演奏与安静聆听准备的临时声场</p></header><section className="rack"><div className="rail"><span>01</span><b>身份</b><span>02</span><b>输入</b><span>03</span><b>入场</b></div><div className="panel"><div className="roomline"><label>房间编号<input aria-label="房间编号" value={roomId} onChange={(event) => setRoomId(event.target.value)} placeholder="打开邀请链接后自动填入" /></label><button className="outline" onClick={() => void makeRoom()} disabled={busy}>创建邀请房间</button></div>{inviteUrl && <div className="invite"><label>邀请链接<input aria-label="邀请链接" readOnly value={inviteUrl} /></label><button className="outline" onClick={() => void copyInvite()}>复制邀请链接</button></div>}<label>昵称<input aria-label="昵称" value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="给这次声音一个名字" maxLength={32} /></label><fieldset><legend>选择身份</legend><div className="avatars">{AVATARS.map((avatar) => <button type="button" aria-label={avatar.label} aria-pressed={avatar.id === avatarId} data-avatar={avatar.id} key={avatar.id} className={avatar.id === avatarId ? 'avatar chosen' : 'avatar'} onClick={() => setAvatarId(avatar.id)}><span>{avatar.icon}</span><small>{avatar.label}</small></button>)}</div></fieldset><div className="input-grid"><label>麦克风设备<select aria-label="麦克风设备" value={deviceId} onChange={(event) => setDeviceId(event.target.value)}><option value="">自动选择</option>{devices.map((device) => <option value={device.deviceId} key={device.deviceId}>{device.label}</option>)}</select></label><button className="refresh" onClick={() => void refreshDevices()} aria-label="刷新设备列表">↻ 刷新设备</button></div><fieldset className="modes"><legend>音频模式</legend><button type="button" className={mode === 'voice' ? 'mode selected' : 'mode'} onClick={() => setMode('voice')}><b>语音</b><span>48 kHz · 人声处理</span></button><button type="button" className={mode === 'instrument' ? 'mode selected' : 'mode'} onClick={() => setMode('instrument')}><b>乐器原声</b><span>48 kHz · 立体声优先</span></button></fieldset>{mode === 'instrument' && <p className="notice">原声模式会关闭回声消除与降噪。请佩戴耳机，实际参数取决于设备。</p>}{message && <p role="alert" className="notice">{message}</p>}<div className="actions"><button className="outline" onClick={() => void enter(true)} disabled={busy}>仅收听进入</button><button className="primary" onClick={() => void enter(false)} disabled={busy}>{busy ? '正在连接…' : '开启麦克风进入'}</button></div></div></section><footer>无需账号 · 不录音 · 邀请链接 5 分钟有效</footer></main>;
};

export const Room = ({ roomId, nickname, avatarId, listenOnly, members, deviceId = '', devices = [], mode = 'voice', credentials, sessionFactory = () => new LiveKitSessionAdapter(), onDeviceChange, onRefreshDevices, onReconnect, onLeave }: { roomId: string; nickname: string; avatarId: AvatarId; listenOnly: boolean; members: Member[]; deviceId?: string; devices?: Device[]; mode?: AudioMode; credentials?: JoinResponse; sessionFactory?: () => SessionAdapter; onDeviceChange?: (deviceId: string) => void; onRefreshDevices?: () => void; onReconnect?: () => void; onLeave: () => void }) => {
  const [muted, setMuted] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [handRaised, setHandRaised] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorder = useRef<LocalCompositeRecorder | undefined>(undefined);
  const [controlError, setControlError] = useState('');
  const [state, setState] = useState<SessionState>({ connection: credentials ? 'connecting' : 'connected', activeSpeakerIds: [], localSpeaking: false, members: [], videoTracks: {}, screenTracks: {}, localCameraEnabled: false, localScreenSharing: false });
  const session = useRef<AudioSession | undefined>(undefined);
  const sessionFactoryRef = useRef(sessionFactory);
  sessionFactoryRef.current = sessionFactory;
  useEffect(() => {
    if (!credentials) return;
    const next = new AudioSession(sessionFactoryRef.current(), setState); session.current = next;
    void next.enter({ ...credentials, listenOnly, mode, deviceId }).then(() => listenOnly ? undefined : next.startCamera()).catch(() => undefined);
    return () => { void next.leave().catch(() => undefined); };
  }, [credentials?.livekitUrl, credentials?.participantId, credentials?.token]);
  const visibleMembers: Member[] = [...members, ...state.members.map((member) => ({ ...member, avatarId: AVATARS.some((avatar) => avatar.id === member.avatarId) ? member.avatarId as AvatarId : 'fox', speaking: state.activeSpeakerIds.includes(member.id) }))];
  const self: Member = { id: 'self', name: listenOnly ? `${nickname} · 仅收听` : nickname, avatarId, speaking: !muted && state.localSpeaking };
  const leave = async () => { try { await session.current?.leave(); } catch { setControlError('释放音频失败，已离开房间。'); } finally { onLeave(); } };
  const toggleMute = async () => { const next = !muted; try { await session.current?.setMuted(next); setMuted(next); setControlError(''); } catch { setControlError('静音切换失败，请重试。'); } };
  const changeDevice = async (nextDeviceId: string) => { try { await session.current?.switchDevice(nextDeviceId, mode); onDeviceChange?.(nextDeviceId); setControlError(''); } catch { setControlError('麦克风切换失败，请检查设备后重试。'); } };
  const participants: VideoParticipant[] = [{ id: 'self', name: self.name, avatar: AVATARS.find((item) => item.id === avatarId)?.icon ?? '🦊', track: state.videoTracks.self, cameraEnabled: state.localCameraEnabled, speaking: !muted && state.localSpeaking }, ...visibleMembers.map((member) => ({ id: member.id, name: member.name, avatar: AVATARS.find((item) => item.id === member.avatarId)?.icon ?? '🦊', track: state.videoTracks[member.id], cameraEnabled: Boolean(state.videoTracks[member.id]), speaking: member.speaking }))];
  const toggleCamera = async () => { try { await session.current?.setCameraEnabled(!state.localCameraEnabled); setControlError(''); } catch { setControlError('摄像头不可用，请检查浏览器权限。'); } };
  const toggleScreen = async () => { try { if (state.localScreenSharing) await session.current?.stopScreenShare(); else await session.current?.startScreenShare(); setControlError(''); } catch { setControlError('屏幕共享不可用或已被取消。'); } };
  useEffect(() => {
    if (!recording) { if (recorder.current) void recorder.current.stop().catch(() => undefined); recorder.current = undefined; return; }
    const canvas = document.createElement('canvas');
    const tiles = () => [...document.querySelectorAll<HTMLVideoElement>('.video-tile video')].map((element, index) => ({ element, x: index === 0 ? 0 : (index % 2) * 320, y: index === 0 ? 0 : Math.floor(index / 2) * 180, width: index === 0 ? 1280 : 320, height: index === 0 ? 720 : 180 }));
    try { recorder.current = new LocalCompositeRecorder({ canvas, tiles, audioTracks: [...document.querySelectorAll<HTMLAudioElement>('[data-livekit-audio="true"]')].map((element) => element.srcObject instanceof MediaStream ? element.srcObject.getAudioTracks()[0] : undefined).filter((track): track is MediaStreamTrack => Boolean(track)) }); recorder.current.start(); setControlError(''); }
    catch { recorder.current = undefined; setRecording(false); setControlError('浏览器不支持本地录制。'); }
    return () => { if (recorder.current) void recorder.current.stop().catch(() => undefined); };
  }, [recording]);
  return <main className="console room"><header><p className="eyebrow">ROOM / {roomId}</p><h1>会议已接通</h1><p className="subtitle">{state.connection === 'reconnecting' ? '正在恢复连接…' : state.connection === 'disconnected' ? '连接已断开' : listenOnly ? '仅收听 · 已连接 RTC' : '720p 自适应视频 · RTC 已连接'}</p></header><MeetingLayout participants={participants} activeSpeakerIds={state.activeSpeakerIds} screenTrack={state.screenTracks.self ?? Object.values(state.screenTracks)[0]} />{!listenOnly && <div className="input-grid room-device"><label>麦克风设备<select aria-label="房内麦克风设备" value={deviceId} onChange={(event) => void changeDevice(event.target.value)}><option value="">自动选择</option>{devices.map((device) => <option value={device.deviceId} key={device.deviceId}>{device.label}</option>)}</select></label><button className="refresh" onClick={onRefreshDevices}>↻ 刷新设备</button></div>}{controlError && <p role="alert" className="notice">{controlError}</p>}<div className="meeting-extra"><button className="outline" aria-pressed={chatOpen} onClick={() => setChatOpen(!chatOpen)}>聊天</button><button className="outline" aria-pressed={handRaised} onClick={() => setHandRaised(!handRaised)}>{handRaised ? '放下手' : '举手'}</button></div>{chatOpen && <aside className="chat-panel" aria-label="文字聊天"><p>聊天功能已打开，消息通道将在加入会议后启用。</p></aside>}<MeetingControls muted={muted} cameraEnabled={state.localCameraEnabled} sharingScreen={state.localScreenSharing} recording={recording} handlers={{ onMute: () => void toggleMute(), onCamera: () => void toggleCamera(), onScreenShare: () => void toggleScreen(), onRecord: () => setRecording(!recording), onLeave: () => void leave() }} disabled={state.connection !== 'connected'} />{state.connection === 'disconnected' && onReconnect && <button className="primary" onClick={onReconnect}>重新入场</button>}</main>;
};
