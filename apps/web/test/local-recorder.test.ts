import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalCompositeRecorder, selectRecordingMimeType, type RecorderDependencies, type VideoTile } from '../src/local-recorder.js';

const track = (kind: 'audio' | 'video') => ({ kind, stop: vi.fn() }) as unknown as MediaStreamTrack;

const createHarness = (supportedMime = 'video/webm;codecs=vp8,opus') => {
  const drawImage = vi.fn();
  const canvasVideoTrack = track('video');
  const canvasStream = { getTracks: vi.fn(() => [canvasVideoTrack]), getVideoTracks: vi.fn(() => [canvasVideoTrack]) } as unknown as MediaStream;
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({ fillStyle: '', fillRect: vi.fn(), drawImage })),
    captureStream: vi.fn(() => canvasStream)
  } as unknown as HTMLCanvasElement;
  const destinationTrack = track('audio');
  const destinationStream = { getTracks: vi.fn(() => [destinationTrack]), getAudioTracks: vi.fn(() => [destinationTrack]) } as unknown as MediaStream;
  const connect = vi.fn();
  const close = vi.fn().mockResolvedValue(undefined);
  const audioContext = {
    createMediaStreamSource: vi.fn(() => ({ connect })),
    createMediaStreamDestination: vi.fn(() => ({ stream: destinationStream })),
    close
  } as unknown as AudioContext;
  class FakeMediaRecorder {
    static isTypeSupported = vi.fn((mime: string) => mime === supportedMime);
    state: RecordingState = 'inactive';
    ondataavailable: ((event: BlobEvent) => void) | null = null;
    onstop: (() => void) | null = null;
    start = vi.fn(() => { this.state = 'recording'; });
    stop = vi.fn(() => {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['webm'], { type: this.mimeType }) } as BlobEvent);
      this.onstop?.();
    });
    constructor(public readonly stream: MediaStream, public readonly options?: MediaRecorderOptions) {}
    get mimeType() { return this.options?.mimeType ?? ''; }
  }
  const url = { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() };
  const anchor = { href: '', download: '', click: vi.fn() };
  const deps: RecorderDependencies = {
    MediaRecorder: FakeMediaRecorder as unknown as typeof MediaRecorder,
    createAudioContext: () => audioContext,
    createMediaStream: (tracks) => ({ getTracks: () => tracks, getAudioTracks: () => tracks.filter((item) => item.kind === 'audio'), getVideoTracks: () => tracks.filter((item) => item.kind === 'video') } as unknown as MediaStream),
    url,
    createDownloadAnchor: () => anchor as unknown as HTMLAnchorElement,
    schedule: (callback, delay) => { if (delay === 0) callback(); return 1; },
    cancelSchedule: vi.fn()
  };
  return { canvas, drawImage, canvasStream, destinationStream, audioContext, connect, close, url, anchor, deps };
};

const tile = (id: string): VideoTile => ({ element: { id } as unknown as HTMLVideoElement, x: 0, y: 0, width: 640, height: 360 });

afterEach(() => vi.restoreAllMocks());

describe('录制编码选择', () => {
  it('优先 VP9/Opus，不支持时回退到 WebM VP8/Opus 和浏览器默认值', () => {
    const supported = vi.fn((mime: string) => mime === 'video/webm;codecs=vp8,opus');
    expect(selectRecordingMimeType(supported)).toBe('video/webm;codecs=vp8,opus');
    expect(supported).toHaveBeenCalledWith('video/webm;codecs=vp9,opus');
  });

  it('编码器完全不支持时返回 undefined', () => {
    expect(selectRecordingMimeType(() => false)).toBeUndefined();
  });
});

describe('LocalCompositeRecorder', () => {
  it('将主讲人与网格视频绘制到 720p Canvas，并混合音频后下载', async () => {
    const h = createHarness();
    const localAudio = track('audio');
    const remoteAudio = track('audio');
    const recorder = new LocalCompositeRecorder({ canvas: h.canvas, tiles: () => [tile('speaker'), tile('guest')], audioTracks: [localAudio, remoteAudio], fileName: 'meeting.webm' }, h.deps);
    recorder.start();
    expect(h.canvas.width).toBe(1280);
    expect(h.canvas.height).toBe(720);
    expect(h.drawImage).toHaveBeenCalledTimes(2);
    expect(h.audioContext.createMediaStreamSource).toHaveBeenCalledTimes(2);
    expect(h.connect).toHaveBeenCalledTimes(2);
    const blob = await recorder.stop();
    expect(blob?.type).toBe('video/webm;codecs=vp8,opus');
    expect(h.anchor.download).toBe('meeting.webm');
    expect(h.anchor.click).toHaveBeenCalledOnce();
    expect(h.url.createObjectURL).toHaveBeenCalledOnce();
  });

  it('停止时清理定时器、录制流、AudioContext 和下载 URL', async () => {
    const h = createHarness();
    const cancel = vi.spyOn(h.deps, 'cancelSchedule');
    const recorder = new LocalCompositeRecorder({ canvas: h.canvas, tiles: () => [], audioTracks: [track('audio')] }, h.deps);
    recorder.start();
    await recorder.stop();
    expect(cancel).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.canvasStream.getTracks()[0].stop).toHaveBeenCalledOnce();
    expect(h.destinationStream.getTracks()[0].stop).toHaveBeenCalledOnce();
    expect(h.url.revokeObjectURL).toHaveBeenCalledWith('blob:test');
    await expect(recorder.stop()).resolves.toBeInstanceOf(Blob);
  });

  it('编码器不可用时抛出错误，但不会创建录制器', () => {
    const h = createHarness('unsupported');
    expect(() => new LocalCompositeRecorder({ canvas: h.canvas, tiles: () => [] }, { ...h.deps, MediaRecorder: class { static isTypeSupported = () => false; } as unknown as typeof MediaRecorder }).start()).toThrow('浏览器不支持本地录制');
  });

  it('停止后可以再次开始并完成第二次录制', async () => {
    const h = createHarness();
    const recorder = new LocalCompositeRecorder({ canvas: h.canvas, tiles: () => [] }, h.deps);
    recorder.start();
    await recorder.stop();
    expect(() => recorder.start()).not.toThrow();
    await expect(recorder.stop()).resolves.toBeInstanceOf(Blob);
    expect(h.canvas.captureStream).toHaveBeenCalledTimes(2);
  });

  it('Web Audio 初始化失败时关闭已创建的上下文并继续录制画面', async () => {
    const h = createHarness();
    const createAudioContext = vi.fn(() => ({
      createMediaStreamDestination: vi.fn(() => { throw new Error('unsupported'); }),
      close: h.close
    } as unknown as AudioContext));
    const recorder = new LocalCompositeRecorder({ canvas: h.canvas, tiles: () => [], audioTracks: [track('audio')] }, { ...h.deps, createAudioContext });
    recorder.start();
    expect(h.close).toHaveBeenCalledOnce();
    await expect(recorder.stop()).resolves.toBeInstanceOf(Blob);
  });

  it('MediaRecorder 构造或启动失败时清理已经创建的媒体资源', () => {
    const h = createHarness();
    class FailingRecorder {
      static isTypeSupported = () => true;
      constructor() { throw new Error('encoder failed'); }
    }
    const recorder = new LocalCompositeRecorder({ canvas: h.canvas, tiles: () => [], audioTracks: [track('audio')] }, { ...h.deps, MediaRecorder: FailingRecorder as unknown as typeof MediaRecorder });
    expect(() => recorder.start()).toThrow('encoder failed');
    expect(h.canvasStream.getTracks()[0].stop).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('编码器异步报错后 stop 返回失败且已释放资源', async () => {
    const h = createHarness();
    class ErrorRecorder {
      static isTypeSupported = () => true;
      static latest: ErrorRecorder | undefined;
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor() { ErrorRecorder.latest = this; }
      start = vi.fn();
      stop = vi.fn();
    }
    const recorder = new LocalCompositeRecorder({ canvas: h.canvas, tiles: () => [] }, { ...h.deps, MediaRecorder: ErrorRecorder as unknown as typeof MediaRecorder });
    recorder.start();
    ErrorRecorder.latest?.onerror?.(new Event('error'));
    await expect(recorder.stop()).rejects.toThrow('录制失败');
    expect(h.canvasStream.getTracks()[0].stop).toHaveBeenCalledOnce();
  });
});
