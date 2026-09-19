import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MeetingLayout } from '../src/meeting-layout.js';

let host: HTMLDivElement | undefined;
afterEach(() => { host?.remove(); host = undefined; vi.unstubAllGlobals(); });

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

  it('远端视频元素保持静音以允许自动播放，音频由独立轨道播放', async () => {
    vi.stubGlobal('MediaStream', class { constructor(public readonly tracks: MediaStreamTrack[]) {} });
    const track = {} as MediaStreamTrack;
    host = document.createElement('div'); document.body.append(host);
    await act(async () => { createRoot(host!).render(<MeetingLayout participants={[{ id: 'guest', name: '小林', avatar: '🐈', track, cameraEnabled: true, speaking: false }]} />); });
    expect(host.querySelector<HTMLVideoElement>('[data-participant="guest"] video')?.muted).toBe(true);
  });

it('在成员视频卡片显示举手状态', async () => {
    host = document.createElement('div'); document.body.append(host);
    await act(async () => { createRoot(host!).render(<MeetingLayout participants={[{ id: 'guest', name: '小林', avatar: '🐈', cameraEnabled: false, speaking: false, handRaised: true }]} />); });
    expect(host.querySelector('[aria-label="小林正在举手"]')).toBeTruthy();
  });
});

it('共享屏幕视频保持静音以允许自动播放', async () => {
  vi.stubGlobal('MediaStream', class { constructor(public readonly tracks: MediaStreamTrack[]) {} });
  host = document.createElement('div'); document.body.append(host);
  await act(async () => { createRoot(host!).render(<MeetingLayout participants={[]} screenTrack={{} as MediaStreamTrack} />); });
  expect(host.querySelector<HTMLVideoElement>('.screen-share video')?.muted).toBe(true);
});
