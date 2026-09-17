import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, Room } from '../src/App.js';

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

  it('仅收听加入后在房间保留仅收听状态', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ participantId: 'p1', livekitUrl: 'wss://rtc', token: 't' }))));
    localStorage.setItem('voice-room.preferences', JSON.stringify({ nickname: '阿北', avatarId: 'owl', deviceId: 'usb', mode: 'voice' }));
    history.replaceState(null, '', '?room=room_a');
    const page = await render();
    await act(async () => { [...page.querySelectorAll('button')].find((button) => button.textContent === '仅收听进入')?.click(); });
    expect(page.textContent).toContain('仅收听 · 等待音频连接');
    expect(page.textContent).not.toContain('正在发言');
  });
});

describe('房间成员模型', () => {
  it('仅收听的当前成员显示等待连接且不显示发言中', async () => {
    host = document.createElement('div'); document.body.append(host);
    await act(async () => { createRoot(host!).render(<Room roomId="room_a" nickname="阿北" avatarId="owl" listenOnly members={[{ id: 'other', name: '小林', avatarId: 'cat', speaking: true }]} onLeave={vi.fn()} />); });
    expect(host.textContent).toContain('仅收听 · 等待音频连接');
    expect(host.querySelectorAll('[data-speaking="true"]')).toHaveLength(1);
    expect(host.textContent).not.toContain('阿北（我）正在发言');
  });
});
