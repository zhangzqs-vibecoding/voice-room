import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';

let host: HTMLDivElement | undefined;
afterEach(() => { host?.remove(); host = undefined; localStorage.clear(); });
const render = async () => { host = document.createElement('div'); document.body.append(host); await act(async () => { createRoot(host!).render(<App mediaDevices={{ enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'audioinput', deviceId: 'usb', label: 'USB Mic' }]) }} />); }); return host; };

describe('入场控制台', () => {
  it('展示昵称、六个头像、麦克风设备和仅收听入口', async () => {
    const page = await render();
    expect(page.querySelector('[aria-label="昵称"]')).toBeTruthy();
    expect(page.querySelectorAll('[data-avatar]')).toHaveLength(6);
    expect(page.querySelector('[aria-label="麦克风设备"]')).toBeTruthy();
    expect([...page.querySelectorAll('button')].some((button) => button.textContent === '仅收听进入')).toBe(true);
  });
});
