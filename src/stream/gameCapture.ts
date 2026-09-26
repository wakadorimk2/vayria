// GameCapture wraps getDisplayMedia and produces the same labeled
// contact-sheet input the Phase 0 fixtures used: a short frame
// sequence composited into one JPEG, plus a downscaled luminance
// grid of the latest frame for the static-frame skip.

export interface CapturedWindow {
  sheet: Blob;
  luma: Uint8ClampedArray;
}

const TILE_WIDTH = 512;
const LUMA_WIDTH = 64;
const LUMA_HEIGHT = 36;
const JPEG_QUALITY = 0.8;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export class GameCapture {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private onEnded: (() => void) | null = null;
  private handleTrackEnded = () => this.stop();

  get active(): boolean {
    return this.stream !== null;
  }

  // The browser requires a transient user activation here, so callers
  // must invoke start() from a click handler.
  async start(onEnded?: () => void): Promise<void> {
    if (this.stream) return;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    stream.getVideoTracks()[0]?.addEventListener('ended', this.handleTrackEnded);
    this.stream = stream;
    this.video = video;
    this.onEnded = onEnded ?? null;
  }

  // Samples `frameCount` frames spread over `spanMs`, labels each tile
  // "F<n> <t>s" like the bench contact sheets, and returns the
  // composited JPEG plus a luminance grid of the final frame.
  async captureWindow(
    frameCount = 5,
    spanMs = 2400,
  ): Promise<CapturedWindow> {
    const video = this.video;
    if (!this.stream || !video || video.readyState < 2) {
      throw new Error('Capture is not ready.');
    }
    const tileHeight = Math.max(
      1,
      Math.round((TILE_WIDTH * video.videoHeight) / video.videoWidth),
    );
    const sheet = document.createElement('canvas');
    sheet.width = TILE_WIDTH * frameCount;
    sheet.height = tileHeight;
    const context = sheet.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable.');
    context.fillStyle = '#000';
    context.fillRect(0, 0, sheet.width, sheet.height);

    const frameTimesMs: number[] = [];
    for (let index = 0; index < frameCount; index += 1) {
      const target = (index * spanMs) / Math.max(1, frameCount - 1);
      const elapsed = index === 0 ? 0 : target - frameTimesMs[index - 1];
      if (elapsed > 0) await sleep(elapsed);
      context.drawImage(video, index * TILE_WIDTH, 0, TILE_WIDTH, tileHeight);
      frameTimesMs.push(target);
      const label = `F${index + 1} ${(target / 1000).toFixed(2)}s`;
      context.font = '16px monospace';
      const textWidth = context.measureText(label).width;
      context.fillStyle = 'rgba(0,0,0,0.7)';
      context.fillRect(index * TILE_WIDTH + 4, tileHeight - 24, textWidth + 8, 20);
      context.fillStyle = '#fff';
      context.fillText(label, index * TILE_WIDTH + 8, tileHeight - 9);
    }

    const blob = await new Promise<Blob | null>((resolve) =>
      sheet.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );
    if (!blob) throw new Error('Failed to encode the contact sheet.');

    const lumaCanvas = document.createElement('canvas');
    lumaCanvas.width = LUMA_WIDTH;
    lumaCanvas.height = LUMA_HEIGHT;
    const lumaContext = lumaCanvas.getContext('2d', { willReadFrequently: true });
    if (!lumaContext) throw new Error('Canvas 2D is unavailable.');
    lumaContext.drawImage(video, 0, 0, LUMA_WIDTH, LUMA_HEIGHT);
    const rgba = lumaContext.getImageData(0, 0, LUMA_WIDTH, LUMA_HEIGHT).data;
    const luma = new Uint8ClampedArray(LUMA_WIDTH * LUMA_HEIGHT);
    for (let index = 0; index < luma.length; index += 1) {
      const offset = index * 4;
      luma[index] = Math.round(
        rgba[offset] * 0.2126 + rgba[offset + 1] * 0.7152 + rgba[offset + 2] * 0.0722,
      );
    }

    return { sheet: blob, luma };
  }

  stop(): void {
    if (!this.stream) return;
    this.stream.getVideoTracks()[0]?.removeEventListener('ended', this.handleTrackEnded);
    for (const track of this.stream.getTracks()) track.stop();
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    this.onEnded?.();
  }
}
