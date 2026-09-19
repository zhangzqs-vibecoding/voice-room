import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { MeetingLayout } from '../src/meeting-layout.js';

let host: HTMLDivElement | undefined;
afterEach(() => { host?.remove(); host = undefined; });

describe('视频会议布局', () => {
  it('将当前发言人放入主画面，其余成员放入缩略网格', async () => {
    host = document.createElement('div'); document.body.append(host);
    await act(async () => { createRoot(host!).render(<MeetingLayout activeSpeakerIds={['guest']} participants={[{ id: 'self', name: '我', avatar: '🦊', cameraEnabled: false, speaking: false }, { id: 'guest', name: '小林', avatar: '🐈', cameraEnabled: false, speaking: true }]} />); });
    expect(host.querySelector('[data-participant="guest"]')?.className).toContain('video-tile-featured');
    expect(host.querySelector('.video-thumbnails [data-participant="self"]')).toBeTruthy();
    expect(host.textContent).toContain('小林');
  });

  it('摄像头关闭时展示身份头像和可访问说明', async () => {
    host = document.createElement('div'); document.body.append(host);
    await act(async () => { createRoot(host!).render(<MeetingLayout participants={[{ id: 'self', name: '我', avatar: '🦊', cameraEnabled: false, speaking: false }]} />); });
    expect(host.querySelector('[aria-label="我 摄像头已关闭"]')).toBeTruthy();
    expect(host.textContent).toContain('🦊');
  });
});
