import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, Room } from '../src/App.js';
import type { SessionAdapter } from '../src/audio-session.js';

let host: HTMLDivElement | undefined;
afterEach(() => { host?.remove(); host = undefined; localStorage.clear(); history.replaceState(null, '', '/'); });
const render = async () => { host = document.createElement('div'); document.body.append(host); await act(async () => { createRoot(host!).render(<App mediaDevices={{ enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'audioinput', deviceId: 'usb', label: 'USB Mic' }]) }} />); }); return host; };

describe('入场控制台', () => {
  it('展示昵称、六个头像、麦克风设备和仅收听入口', async () => {
    const page = await render();
    expect(page.querySelector('[aria-label="昵称"]')).toBeTruthy();
    expect(page.querySelectorAll('[data-avatar]')).toHaveLength(6);
    expect(page.querySelector('[aria-label="麦克风设备"]')).toBeTruthy();
    expect([...page.querySelectorAll('button')].some((button) => button.textContent === '仅收听进入')).toBe(true);
  });

  it('创建后显示可复制的完整邀请链接和成功反馈', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ roomId: 'room_invite' }), { status: 201 })));
    const page = await render();
    await act(async () => { [...page.querySelectorAll('button')].find((button) => button.textContent === '创建邀请房间')?.click(); });
    expect(page.querySelector<HTMLInputElement>('[aria-label="邀请链接"]')?.value).toContain('?room=room_invite');
    expect(page.textContent).toContain('邀请链接已生成');
    expect([...page.querySelectorAll('button')].some((button) => button.textContent === '复制邀请链接')).toBe(true);
  });

  it('Clipboard API 缺失时提示手动复制而不假称成功', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ roomId: 'room_invite' }), { status: 201 })));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const page = await render();
    await act(async () => { [...page.querySelectorAll('button')].find((button) => button.textContent === '创建邀请房间')?.click(); });
    await act(async () => { [...page.querySelectorAll('button')].find((button) => button.textContent === '复制邀请链接')?.click(); });
    expect(page.textContent).toContain('请手动复制邀请链接。');
  });

  it('Clipboard 写入被拒绝时提示手动复制', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ roomId: 'room_invite' }), { status: 201 })));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    const page = await render();
    await act(async () => { [...page.querySelectorAll('button')].find((button) => button.textContent === '创建邀请房间')?.click(); });
    await act(async () => { [...page.querySelectorAll('button')].find((button) => button.textContent === '复制邀请链接')?.click(); });
    expect(page.textContent).toContain('请手动复制邀请链接。');
  });

  it('仅收听加入后在房间保留仅收听状态', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ participantId: 'p1', livekitUrl: 'wss://rtc', token: 't' }))));
    localStorage.setItem('voice-room.preferences', JSON.stringify({ nickname: '阿北', avatarId: 'owl', deviceId: 'usb', mode: 'voice' }));
    history.replaceState(null, '', '?room=room_a');
    const page = await render();
    await act(async () => { [...page.querySelectorAll('button')].find((button) => button.textContent === '仅收听进入')?.click(); });
    expect(page.textContent).toContain('仅收听');
    expect(page.textContent).not.toContain('正在发言');
  });
});

describe('房间成员模型', () => {
  it('仅收听的当前成员显示等待连接且不显示发言中', async () => {
    host = document.createElement('div'); document.body.append(host);
    await act(async () => { createRoot(host!).render(<Room roomId="room_a" nickname="阿北" avatarId="owl" listenOnly members={[{ id: 'other', name: '小林', avatarId: 'cat', speaking: true }]} onLeave={vi.fn()} />); });
    expect(host.textContent).toContain('仅收听');
    expect(host.querySelectorAll('[data-speaking="true"]')).toHaveLength(1);
    expect(host.textContent).not.toContain('阿北（我）正在发言');
  });

  it('房内切换麦克风时调用会话并保留可访问控件', async () => {
    const session: SessionAdapter = { connect: vi.fn(), publish: vi.fn(), setMuted: vi.fn(), switchDevice: vi.fn(), disconnect: vi.fn(), onEvent: vi.fn(() => () => undefined) };
    const changed = vi.fn();
    host = document.createElement('div'); document.body.append(host);
    await act(async () => { createRoot(host!).render(<Room roomId="room_a" nickname="阿北" avatarId="owl" listenOnly={false} members={[]} deviceId="usb" devices={[{ deviceId: 'usb', label: 'USB' }, { deviceId: 'line', label: 'Line' }]} credentials={{ participantId: 'p1', livekitUrl: 'wss://rtc', token: 't' }} sessionFactory={() => session} onDeviceChange={changed} onLeave={vi.fn()} />); });
    const select = host.querySelector<HTMLSelectElement>('[aria-label="房内麦克风设备"]')!;
    await act(async () => { select.value = 'line'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(changed).toHaveBeenCalledWith('line');
    expect(session.switchDevice).toHaveBeenCalledOnce();
  });
});
