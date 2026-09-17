import { describe, expect, it, vi } from 'vitest';
import { AudioSession, instrumentConstraints, voiceConstraints, type SessionAdapter, type SessionEvent } from '../src/audio-session.js';

const adapter = (): SessionAdapter & { emit: (event: SessionEvent) => void } => {
  let listener: ((event: SessionEvent) => void) | undefined;
  return {
    connect: vi.fn(), publish: vi.fn(), setMuted: vi.fn(), switchDevice: vi.fn(), disconnect: vi.fn(),
    onEvent: vi.fn((next) => { listener = next; return () => { listener = undefined; }; }),
    emit: (event) => listener?.(event)
  };
};

describe('音频采集参数', () => {
  it('语音模式请求人声处理的 48kHz 单声道', () => {
    expect(voiceConstraints('usb')).toMatchObject({ deviceId: { exact: 'usb' }, channelCount: 1, sampleRate: 48_000, echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  });

  it('乐器模式请求无处理的 48kHz 立体声', () => {
    expect(instrumentConstraints('line')).toMatchObject({ deviceId: { exact: 'line' }, channelCount: 2, sampleRate: 48_000, echoCancellation: false, noiseSuppression: false, autoGainControl: false });
  });
});

describe('AudioSession', () => {
  it('仅收听连接但绝不采集或发布本地音轨', async () => {
    const fake = adapter();
    const session = new AudioSession(fake);
    await session.enter({ livekitUrl: 'wss://rtc', token: 'token', listenOnly: true, mode: 'voice', deviceId: 'usb' });
    expect(fake.connect).toHaveBeenCalledWith('wss://rtc', 'token');
    expect(fake.publish).not.toHaveBeenCalled();
  });

  it('切换输入后保留静音状态', async () => {
    const fake = adapter();
    const session = new AudioSession(fake);
    await session.enter({ livekitUrl: 'wss://rtc', token: 'token', listenOnly: false, mode: 'voice', deviceId: 'usb' });
    await session.setMuted(true);
    await session.switchDevice('line', 'instrument');
    expect(fake.switchDevice).toHaveBeenCalledWith(instrumentConstraints('line'));
    expect(fake.setMuted).toHaveBeenLastCalledWith(true);
  });

  it('将重连、彻底断开和远端发言者转为可呈现状态', async () => {
    const fake = adapter();
    const onState = vi.fn();
    const session = new AudioSession(fake, onState);
    await session.enter({ livekitUrl: 'wss://rtc', token: 'token', listenOnly: true, mode: 'voice', deviceId: '' });
    fake.emit({ type: 'reconnecting' });
    fake.emit({ type: 'active-speakers', participantIds: ['p1'] });
    fake.emit({ type: 'disconnected', reason: 'network' });
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ connection: 'reconnecting' }));
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ activeSpeakerIds: ['p1'] }));
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ connection: 'disconnected', disconnectReason: 'network' }));
  });

  it('离开时释放适配器资源且之后不会再接收事件', async () => {
    const fake = adapter();
    const onState = vi.fn();
    const session = new AudioSession(fake, onState);
    await session.enter({ livekitUrl: 'wss://rtc', token: 'token', listenOnly: true, mode: 'voice', deviceId: '' });
    await session.leave();
    fake.emit({ type: 'reconnecting' });
    expect(fake.disconnect).toHaveBeenCalledOnce();
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ connection: 'disconnected', disconnectReason: 'left' }));
  });
});
