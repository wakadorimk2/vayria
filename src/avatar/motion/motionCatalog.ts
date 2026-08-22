import {
  parseMotionManifest,
  type MotionAssetDescriptor,
  type MotionManifest,
  type MotionManifestEntry,
} from './motionTypes';

const MOTION_MANIFEST_URL = `${import.meta.env.BASE_URL}avatar/motions/manifest.json`;

export class SavedMotionCatalog {
  private manifest: MotionManifest | null = null;
  private loadPromise: Promise<MotionManifest> | null = null;

  async load(signal?: AbortSignal): Promise<MotionManifest> {
    if (this.manifest) return this.manifest;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = this.fetchManifest(signal).catch((error) => {
      this.loadPromise = null;
      throw error;
    });
    this.manifest = await this.loadPromise;
    return this.manifest;
  }

  async get(
    assetId: string,
    signal?: AbortSignal,
  ): Promise<MotionAssetDescriptor> {
    const manifest = await this.load(signal);
    const entry = manifest.assets.find((candidate) => candidate.assetId === assetId);
    if (!entry) {
      throw new Error(`Saved motion asset was not found: ${assetId}`);
    }
    return createDescriptor(entry);
  }

  clear(): void {
    this.manifest = null;
    this.loadPromise = null;
  }

  private async fetchManifest(signal?: AbortSignal): Promise<MotionManifest> {
    const response = await fetch(MOTION_MANIFEST_URL, {
      cache: 'no-store',
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `Saved motion manifest request failed with status ${response.status}.`,
      );
    }

    return parseMotionManifest(await response.json());
  }
}

function createDescriptor(entry: MotionManifestEntry): MotionAssetDescriptor {
  const manifestUrl = new URL(MOTION_MANIFEST_URL, document.baseURI);
  return {
    schemaVersion: 1,
    assetId: entry.assetId,
    format: 'vrma',
    source: entry.source,
    url: new URL(entry.file, manifestUrl).toString(),
    durationMs: entry.durationMs,
    fps: entry.fps,
    loop: entry.loop,
    tags: entry.tags,
    correctionProfileId: entry.correctionProfileId,
    contentSha256: entry.contentSha256,
  };
}
