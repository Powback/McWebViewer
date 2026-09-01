/**
 * Iris render targets on WebGPU: colortex0-15 with ping-pong, the three depth copies, the
 * shadow map, and the generated helper textures.
 *
 * Two WebGPU constraints shape this and are worth stating, because neither is obvious
 * from the Iris side:
 *
 *  1. **Depth textures cannot be bound to a `texture_2d<f32>`.** Packs declare
 *     `uniform sampler2D depthtex0;` and sample it like any other texture, but WebGPU
 *     requires a depth-format texture to be bound as `texture_depth_2d`. Rather than
 *     rewrite every pack's depth reads, the depth buffer is blitted into an `r32float`
 *     texture after each stage that changes it. That is one extra fullscreen pass per
 *     depth copy, and it keeps `depthtex0/1/2` ordinary sampled textures.
 *  2. **The shadow map is sampled both ways.** `gbuffers_textured` declares
 *     `sampler2D shadowtex0` while `deferred` declares `sampler2DShadow shadowtex0` — the
 *     same texture, once as a plain sample and once as a hardware comparison. WebGPU has
 *     no binding that serves both, so both a depth copy and an r32float copy are kept and
 *     the runtime picks by the reflected WGSL type.
 *
 * Buffers are double-buffered because Iris flips a composite-style pass's outputs after it
 * runs, so a pass reads the previous contents of the very buffer it writes.
 */

import { formatBytes, mapFormat } from './iris-pipeline.js';

export interface ColorTexSpec {
  readonly index: number;
  readonly declared: string;
  readonly webgpu: string;
}

const DEFAULT_FORMAT: GPUTextureFormat = 'rgba16float';
/** Iris allocates colortex0-7 whether or not the pack declares a format for them. */
const MIN_COLOR_BUFFERS = 8;

interface PingPong {
  main: GPUTexture;
  alt: GPUTexture;
  format: GPUTextureFormat;
  /** true when `alt` currently holds the live contents */
  flipped: boolean;
}

/** Lazy for the same reason as `visibility()` in webgpu-bindings: `GPUTextureUsage` is
 * absent without WebGPU, and a module-scope reference breaks the bundle for everyone. */
function colorUsage(): number {
  return GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
}

export class ShaderTargets {
  private color: PingPong[] = [];
  private depth!: GPUTexture;
  /** r32float copies sampled as depthtex0/1/2 */
  private depthCopies: GPUTexture[] = [];
  private shadowDepth!: GPUTexture;
  private shadowCopy!: GPUTexture;
  private shadowColor!: GPUTexture;
  noisetex!: GPUTexture;
  lightmap!: GPUTexture;
  atlas: GPUTexture | null = null;

  width = 0;
  height = 0;

  constructor(
    private device: GPUDevice,
    private specs: readonly ColorTexSpec[],
    readonly shadowResolution: number,
  ) {}

  /** Total bytes/sample of a candidate attachment set, for the WebGPU limit check. */
  static bytesPerSample(formats: readonly GPUTextureFormat[]): number {
    return formats.reduce((n, f) => n + formatBytes(f), 0);
  }

  formatOf(index: number): GPUTextureFormat {
    const spec = this.specs.find((s) => s.index === index);
    if (!spec) return index === 0 ? 'rgba16float' : DEFAULT_FORMAT;
    return (mapFormat(spec.declared)?.webgpu ?? DEFAULT_FORMAT);
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.destroySized();
    this.width = width;
    this.height = height;
    const count = Math.max(MIN_COLOR_BUFFERS, ...this.specs.map((s) => s.index + 1));
    this.color = [];
    for (let i = 0; i < count; i++) {
      const format = this.formatOf(i);
      this.color.push({
        format,
        flipped: false,
        main: this.makeColor(width, height, format, `colortex${i}`),
        alt: this.makeColor(width, height, format, `colortex${i}alt`),
      });
    }
    this.depth = this.device.createTexture({
      label: 'depth',
      size: [width, height],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.depthCopies = [0, 1, 2].map((i) =>
      this.makeColor(width, height, 'r32float', `depthtex${i}`));
  }

  private makeColor(w: number, h: number, format: GPUTextureFormat, label: string): GPUTexture {
    return this.device.createTexture({
      label, size: [w, h], format, usage: colorUsage(),
    });
  }

  /** Shadow map and the generated helper textures do not depend on the viewport. */
  initStatic(): void {
    const s = this.shadowResolution;
    this.shadowDepth = this.device.createTexture({
      label: 'shadowtex',
      size: [s, s],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.shadowCopy = this.makeColor(s, s, 'r32float', 'shadowtex-copy');
    this.shadowColor = this.makeColor(s, s, 'rgba8unorm', 'shadowcolor0');
    this.noisetex = this.makeNoise(256);
    this.lightmap = this.makeLightmap();
  }

  /**
   * `noisetex` is a 256x256 RGB noise texture Iris supplies; packs sample it for dithering
   * and cloud shapes and assume it is not blank.
   */
  private makeNoise(size: number): GPUTexture {
    const tex = this.makeColor(size, size, 'rgba8unorm', 'noisetex');
    const data = new Uint8Array(size * size * 4);
    let seed = 0x9e3779b9;
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = (seed >>> 24) & 0xff;
    }
    this.device.queue.writeTexture(
      { texture: tex }, data, { bytesPerRow: size * 4 }, [size, size],
    );
    return tex;
  }

  /**
   * The 16x16 lightmap: block light along one axis, sky light along the other. Vanilla
   * builds this per frame from the world's light colour; the ramp here matches its shape
   * closely enough that `lmcoord` reads as light rather than as a gradient.
   */
  private makeLightmap(): GPUTexture {
    const tex = this.makeColor(16, 16, 'rgba8unorm', 'lightmap');
    const data = new Uint8Array(16 * 16 * 4);
    for (let sky = 0; sky < 16; sky++) {
      for (let block = 0; block < 16; block++) {
        const b = Math.pow(block / 15, 1.4);
        const s = Math.pow(sky / 15, 1.4);
        const i = (sky * 16 + block) * 4;
        data[i] = Math.min(255, (b * 255 * 1.0 + s * 200) | 0);
        data[i + 1] = Math.min(255, (b * 255 * 0.75 + s * 205) | 0);
        data[i + 2] = Math.min(255, (b * 255 * 0.5 + s * 255) | 0);
        data[i + 3] = 255;
      }
    }
    this.device.queue.writeTexture(
      { texture: tex }, data, { bytesPerRow: 64 }, [16, 16],
    );
    return tex;
  }

  /* ---------------------------------------------------------------- access */

  /** The view a pass writes into for colortex `index`. */
  writeView(index: number): GPUTextureView {
    const b = this.color[index];
    return (b.flipped ? b.main : b.alt).createView();
  }

  /** The view holding the live contents of colortex `index`. */
  readView(index: number): GPUTextureView {
    const b = this.color[index];
    return (b.flipped ? b.alt : b.main).createView();
  }

  colorFormat(index: number): GPUTextureFormat {
    return this.color[index].format;
  }

  /** Iris flips a buffer after the pass that wrote it, so the next pass reads the result. */
  flip(indices: readonly number[]): void {
    for (const i of indices) {
      if (this.color[i]) this.color[i].flipped = !this.color[i].flipped;
    }
  }

  depthView(): GPUTextureView {
    return this.depth.createView();
  }

  depthTexture(): GPUTexture {
    return this.depth;
  }

  depthCopyView(index: number): GPUTextureView {
    return this.depthCopies[Math.min(index, 2)].createView();
  }

  depthCopyTexture(index: number): GPUTexture {
    return this.depthCopies[Math.min(index, 2)];
  }

  shadowDepthView(): GPUTextureView {
    return this.shadowDepth.createView();
  }

  shadowTexture(): GPUTexture {
    return this.shadowDepth;
  }

  shadowCopyTexture(): GPUTexture {
    return this.shadowCopy;
  }

  shadowColorView(): GPUTextureView {
    return this.shadowColor.createView();
  }

  private destroySized(): void {
    for (const b of this.color) {
      b.main.destroy();
      b.alt.destroy();
    }
    this.color = [];
    for (const t of this.depthCopies) t.destroy();
    this.depthCopies = [];
    this.depth?.destroy();
  }

  destroy(): void {
    this.destroySized();
    this.shadowDepth?.destroy();
    this.shadowCopy?.destroy();
    this.shadowColor?.destroy();
    this.noisetex?.destroy();
    this.lightmap?.destroy();
  }
}
