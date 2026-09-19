export interface VideoTile {
  element: CanvasImageSource;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RecorderOptions {
  canvas: HTMLCanvasElement;
  /** 返回当前布局中的视频元素和位置，录制期间会按帧读取。 */
  tiles: () => readonly VideoTile[];
  audioTracks?: readonly MediaStreamTrack[];
  width?: number;
  height?: number;
  frameRate?: number;
  fileName?: string;
}

export interface RecorderDependencies {
  MediaRecorder?: typeof MediaRecorder;
  createAudioContext?: () => AudioContext;
  createMediaStream?: (tracks: MediaStreamTrack[]) => MediaStream;
  url?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
  createDownloadAnchor?: () => HTMLAnchorElement;
  schedule?: (callback: () => void, delay: number) => number;
  cancelSchedule?: (handle: number) => void;
}

const RECORDING_MIME_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm'
] as const;

export class LocalRecorderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LocalRecorderError';
  }
}

export const selectRecordingMimeType = (isTypeSupported: (mimeType: string) => boolean): string | undefined => {
  for (const mimeType of RECORDING_MIME_TYPES) {
    try {
      if (isTypeSupported(mimeType)) return mimeType;
    } catch {
      // 某些浏览器在不支持的 codec 上会直接抛异常，继续尝试下一个。
    }
  }
  return undefined;
};

const defaultDependencies = (): Required<RecorderDependencies> => ({
  MediaRecorder: globalThis.MediaRecorder,
  createAudioContext: () => new AudioContext(),
  createMediaStream: (tracks) => new MediaStream(tracks),
  url: URL,
  createDownloadAnchor: () => document.createElement('a'),
  schedule: (callback, delay) => window.setTimeout(callback, delay),
  cancelSchedule: (handle) => window.clearTimeout(handle)
});

const drawTiles = (context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, tiles: readonly VideoTile[]): void => {
  context.fillStyle = '#0b1018';
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (const tile of tiles) {
    try {
      context.drawImage(tile.element, tile.x, tile.y, tile.width, tile.height);
    } catch {
      // 视频轨道尚未产出第一帧时跳过该 tile，不能影响其他成员录制。
    }
  }
};

export class LocalCompositeRecorder {
  private readonly deps: Required<RecorderDependencies>;
  private readonly options: Required<Pick<RecorderOptions, 'width' | 'height' | 'frameRate' | 'fileName'>> & RecorderOptions;
  private readonly mimeType: string | undefined;
  private mediaRecorder?: MediaRecorder;
  private recordingStream?: MediaStream;
  private audioContext?: AudioContext;
  private audioDestination?: MediaStreamAudioDestinationNode;
  private scheduleHandle?: number;
  private chunks: Blob[] = [];
  private stopPromise?: Promise<Blob | undefined>;
  private recordingError?: LocalRecorderError;
  private pendingStopReject?: (error: unknown) => void;

  public constructor(options: RecorderOptions, dependencies: RecorderDependencies = {}) {
    this.options = { width: 1280, height: 720, frameRate: 30, fileName: 'voice-room-meeting.webm', ...options };
    this.deps = { ...defaultDependencies(), ...dependencies };
    const MediaRecorderClass = this.deps.MediaRecorder;
    this.mimeType = MediaRecorderClass ? selectRecordingMimeType((mime) => MediaRecorderClass.isTypeSupported(mime)) : undefined;
  }

  public start(): void {
    if (this.mediaRecorder) throw new LocalRecorderError('录制已经开始');
    if (!this.mimeType || !this.deps.MediaRecorder) throw new LocalRecorderError('浏览器不支持本地录制');
    this.recordingError = undefined;

    const context = this.options.canvas.getContext('2d');
    if (!context) throw new LocalRecorderError('无法创建录制画布');
    this.options.canvas.width = this.options.width;
    this.options.canvas.height = this.options.height;
    drawTiles(context, this.options.canvas, this.options.tiles());

    try {
      const videoStream = this.options.canvas.captureStream(this.options.frameRate);
      this.recordingStream = videoStream;
      const tracks = [...videoStream.getVideoTracks()];
      this.setupAudio(tracks);
      this.mediaRecorder = new this.deps.MediaRecorder(this.recordingStream, { mimeType: this.mimeType });
      this.mediaRecorder.ondataavailable = (event) => { if (event.data.size > 0) this.chunks.push(event.data); };
      this.mediaRecorder.onerror = () => this.handleRecorderError();
      this.mediaRecorder.start();
      this.scheduleHandle = this.deps.schedule(() => this.drawFrame(), Math.max(1, 1000 / this.options.frameRate));
    } catch (error) {
      this.cleanup();
      throw error;
    }
  }

  public stop(): Promise<Blob | undefined> {
    if (this.stopPromise) return this.stopPromise;
    if (this.recordingError) {
      const error = this.recordingError;
      this.recordingError = undefined;
      return Promise.reject(error);
    }
    if (!this.mediaRecorder) return Promise.resolve(undefined);
    this.stopPromise = new Promise<Blob | undefined>((resolve, reject) => {
      const recorder = this.mediaRecorder!;
      this.pendingStopReject = reject;
      recorder.onstop = () => {
        const blob = this.chunks.length ? new Blob(this.chunks, { type: this.mimeType }) : undefined;
        try {
          if (blob) this.download(blob);
          this.cleanup();
          this.pendingStopReject = undefined;
          resolve(blob);
        } catch (error) {
          this.cleanup();
          this.pendingStopReject = undefined;
          reject(error);
        }
      };
      try {
        recorder.stop();
      } catch (error) {
        this.cleanup();
        this.pendingStopReject = undefined;
        reject(error);
      }
    });
    return this.stopPromise;
  }

  private setupAudio(videoTracks: MediaStreamTrack[]): void {
    const audioTracks = this.options.audioTracks ?? [];
    if (!audioTracks.length) {
      this.recordingStream = this.deps.createMediaStream(videoTracks);
      return;
    }
    try {
      this.audioContext = this.deps.createAudioContext();
      this.audioDestination = this.audioContext.createMediaStreamDestination();
      for (const track of audioTracks) {
        this.audioContext.createMediaStreamSource(this.deps.createMediaStream([track])).connect(this.audioDestination);
      }
      tracksAppend(videoTracks, this.audioDestination.stream.getAudioTracks());
      this.recordingStream = this.deps.createMediaStream(videoTracks);
    } catch {
      // 不支持 Web Audio 混音时仍录制画面，保持会议通话不受影响。
      this.closeAudioResources();
      this.recordingStream = this.deps.createMediaStream(videoTracks);
    }
  }

  private drawFrame(): void {
    if (!this.mediaRecorder) return;
    try {
      const context = this.options.canvas.getContext('2d');
      if (context) drawTiles(context, this.options.canvas, this.options.tiles());
    } catch {
      // 布局在成员离开或 React 卸载的瞬间可能暂时不可读，继续下一帧。
    }
    this.scheduleHandle = this.deps.schedule(() => this.drawFrame(), Math.max(1, 1000 / this.options.frameRate));
  }

  private handleRecorderError(): void {
    const error = new LocalRecorderError('录制失败');
    this.recordingError = error;
    this.cleanup();
    this.pendingStopReject?.(error);
    this.pendingStopReject = undefined;
  }

  private download(blob: Blob): void {
    const objectUrl = this.deps.url.createObjectURL(blob);
    const anchor = this.deps.createDownloadAnchor();
    anchor.href = objectUrl;
    anchor.download = this.options.fileName;
    anchor.click();
    this.deps.schedule(() => this.deps.url.revokeObjectURL(objectUrl), 0);
  }

  private cleanup(): void {
    if (this.scheduleHandle !== undefined) this.deps.cancelSchedule(this.scheduleHandle);
    this.scheduleHandle = undefined;
    const tracks = new Set<MediaStreamTrack>([
      ...(this.recordingStream?.getTracks() ?? []),
      ...(this.audioDestination?.stream.getTracks() ?? [])
    ]);
    for (const track of tracks) track.stop();
    this.recordingStream = undefined;
    this.closeAudioResources(false);
    this.mediaRecorder = undefined;
    this.chunks = [];
    this.stopPromise = undefined;
  }

  private closeAudioResources(stopTracks = true): void {
    const destination = this.audioDestination;
    const context = this.audioContext;
    this.audioDestination = undefined;
    this.audioContext = undefined;
    if (stopTracks) for (const track of destination?.stream.getTracks() ?? []) track.stop();
    if (context) void context.close();
  }
}

const tracksAppend = (target: MediaStreamTrack[], tracks: readonly MediaStreamTrack[]): void => {
  target.push(...tracks);
};
