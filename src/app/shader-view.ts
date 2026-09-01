/**
 * Glue between the save-file renderer and the WebGPU shaderpack pipeline.
 *
 * Runs on its own canvas stacked over the three.js one rather than replacing it, because a
 * canvas can only ever have one context type — and because keeping the WebGL renderer alive
 * is what lets the whole shader path fall back to it without reloading the world.
 *
 * Everything is optional and everything degrades: no WebGPU, no bundle, a pack that fails
 * to compile, a pass whose pipeline will not build — each leaves the ordinary renderer on
 * screen and reports why, rather than showing a black page.
 */

import type { PerspectiveCamera } from 'three';
import type { SectionMesh, Layer } from '../render/mesher.js';
import type { TextureAtlas } from '../render/atlas.js';
import { blockIdLookup, type ShaderBundle } from '../shaders/bundle.js';
import { buildShaderVertices } from '../shaders/shader-vertex.js';
import {
  ShaderPipeline, type ShaderSection, type ShaderFrameStats,
} from '../shaders/webgpu-runtime.js';

export interface ShaderViewStatus {
  readonly active: boolean;
  readonly reason: string;
  readonly pack: string;
  readonly skipped: ReadonlyArray<{ program: string; reason: string }>;
}

const LAYERS: readonly Layer[] = ['solid', 'cutout', 'translucent'];

/** Per-pass state plus anything the driver has said, as displayable lines. */
function passLines(p: ShaderPipeline): string[] {
  const lines = ['', 'passes:'];
  for (const n of p.plannedPasses()) {
    const skip = p.skipped.find((s) => s.program === n);
    lines.push(`  ${p.isCompiled(n) ? 'OK  ' : 'FAIL'} ${n}${skip ? `  — ${skip.reason}` : ''}`);
  }
  if (p.deviceLost) lines.push('', `DEVICE LOST: ${p.deviceLost}`);
  if (p.runtimeErrors.length) {
    lines.push('', 'webgpu errors:');
    for (const e of p.runtimeErrors.slice(0, 6)) lines.push(`  ${e}`);
  }
  return lines;
}

export class ShaderView {
  private pipeline: ShaderPipeline | null = null;
  private canvas: HTMLCanvasElement | null = null;
  /** user escape hatch; see setEnabled */
  private enabled = true;
  private unproductiveFrames = 0;
  reason = 'not requested';

  private constructor(readonly bundle: ShaderBundle) {}

  /**
   * Served from the container's read-only `.cache` mount in production and from the Vite
   * dev mount in development; the two have different prefixes, so both are tried rather
   * than making the caller know which one it is running under.
   */
  static async fetchBundle(id: string): Promise<ShaderBundle | null> {
    const name = `${encodeURIComponent(id)}.bundle.json`;
    for (const url of [`/shaderpacks/${name}`, `/dev/shaderpack/${name}`]) {
      const r = await fetch(url).catch(() => null);
      if (r?.ok) return (await r.json()) as ShaderBundle;
    }
    return null;
  }

  /** The pack-defined `mc_Entity.x` table the mesher needs BEFORE it meshes anything. */
  static blockIds(bundle: ShaderBundle): (stateKey: string) => number {
    return blockIdLookup(bundle);
  }

  static async create(bundle: ShaderBundle, base: HTMLCanvasElement): Promise<ShaderView> {
    const view = new ShaderView(bundle);
    const canvas = document.createElement('canvas');
    canvas.id = 'shaderview';
    Object.assign(canvas.style, {
      position: 'fixed', inset: '0', width: '100%', height: '100%', display: 'block',
    });
    base.parentElement?.insertBefore(canvas, base.nextSibling);
    const pipeline = await ShaderPipeline.create(canvas, bundle).catch(() => null);
    if (!pipeline) {
      canvas.remove();
      view.reason = navigator.gpu
        ? 'WebGPU adapter or device request returned null'
        : 'this browser does not expose navigator.gpu';
      view.showPanel();
      return view;
    }
    view.pipeline = pipeline;
    view.canvas = canvas;

    // Build every pass BEFORE taking the screen. If nothing survives, the WebGPU canvas
    // would present an empty black frame forever with no clue why — so in that case the
    // WebGL renderer keeps the screen and the overlay explains what failed.
    await pipeline.warmup(pipeline.plannedPasses());
    const usable = pipeline.plannedPasses().some((n) => pipeline.isCompiled(n));
    if (!usable) {
      view.reason = 'every pass failed to build — see the shader panel';
      view.showPanel();
      canvas.remove();
      view.canvas = null;
      view.pipeline = pipeline;
      return view;
    }
    view.reason = 'active';
    base.style.display = 'none';
    view.showPanel();
    return view;
  }

  get active(): boolean {
    return this.pipeline !== null && this.canvas !== null && this.enabled;
  }

  /**
   * Toggle the shader canvas without tearing the pipeline down.
   *
   * A shader path that builds but renders wrongly would otherwise leave the viewer stuck
   * looking at a broken image with the working renderer hidden behind it. Geometry keeps
   * being uploaded while hidden, so toggling back is instant.
   */
  setEnabled(on: boolean): void {
    if (!this.pipeline || !this.canvas) return;
    this.enabled = on;
    this.canvas.style.display = on ? 'block' : 'none';
    const base = document.getElementById('view');
    if (base) (base as HTMLCanvasElement).style.display = on ? 'none' : 'block';
    this.reason = on ? 'active' : 'disabled with ` — press again to re-enable';
    this.showPanel();
  }

  toggle(): void {
    this.setEnabled(!this.enabled);
  }

  /**
   * An on-screen panel, not just a console line. "No shaders" with nothing to read is the
   * worst possible failure mode: it is indistinguishable from the feature not existing.
   * Every pass is listed with its state, and every skip with the driver's own words.
   */
  showPanel(): void {
    const p = this.pipeline;
    const lines: string[] = [];
    lines.push(`shaderpack: ${this.bundle.id}  [${this.active ? 'ACTIVE' : 'INACTIVE'}]`);
    lines.push(`reason: ${this.reason}`);
    lines.push(`webgpu: ${navigator.gpu ? 'present' : 'ABSENT — needs Chrome 113+ / Edge 113+'}`);
    const progs = Object.values(this.bundle.programs);
    lines.push(`translated: ${progs.filter((x) => x.ok).length}/${progs.length} programs`);
    if (p) lines.push(...passLines(p));
    const text = lines.join('\n');
    for (const line of lines) console.log('[mcwv-shaders]', line);

    let el = document.getElementById('shaderdiag');
    if (!el) {
      el = document.createElement('pre');
      el.id = 'shaderdiag';
      Object.assign(el.style, {
        position: 'fixed', top: '32px', right: '8px', maxWidth: '46vw', maxHeight: '80vh',
        overflow: 'auto', margin: '0', padding: '8px 10px', zIndex: '10',
        background: 'rgba(0,0,0,.82)', color: '#9fe', font: '11px ui-monospace, Menlo, monospace',
        borderRadius: '4px', whiteSpace: 'pre-wrap', border: '1px solid #2a6',
      });
      document.body.appendChild(el);
    }
    el.textContent = text;
  }

  /** Refresh the panel with anything the GPU has reported since the last frame. */
  refreshPanel(): void {
    if (this.pipeline) this.showPanel();
  }

  status(): ShaderViewStatus {
    return {
      active: this.active,
      reason: this.reason,
      pack: this.bundle.id,
      skipped: this.pipeline?.skipped ?? [],
    };
  }

  setAtlas(atlas: TextureAtlas): void {
    const p = this.pipeline;
    if (!p) return;
    const texture = p.device.createTexture({
      label: 'block-atlas',
      size: [atlas.width, atlas.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    p.device.queue.copyExternalImageToTexture(
      { source: atlas.canvas as unknown as HTMLCanvasElement },
      { texture },
      [atlas.width, atlas.height],
    );
    p.setAtlas(texture);
  }

  /** Upload one meshed section in the shaderpack vertex format. */
  addSection(mesh: SectionMesh): void {
    const p = this.pipeline;
    if (!p) return;
    const origin: [number, number, number] = [mesh.cx * 16, mesh.cy * 16, mesh.cz * 16];
    const out: ShaderSection[] = [];
    for (const layer of LAYERS) {
      const buf = mesh.layers[layer];
      if (!buf) continue;
      const verts = buildShaderVertices(buf, origin);
      out.push({
        layer,
        indexCount: buf.indices.length,
        vertex: this.upload(verts, GPUBufferUsage.VERTEX),
        index: this.upload(buf.indices, GPUBufferUsage.INDEX),
      });
    }
    if (out.length) p.addSection(`${mesh.cx},${mesh.cy},${mesh.cz}`, out);
  }

  private upload(data: Float32Array | Uint32Array, usage: number): GPUBuffer {
    const p = this.pipeline!;
    const buffer = p.device.createBuffer({
      size: Math.ceil(data.byteLength / 4) * 4,
      usage: usage | GPUBufferUsage.COPY_DST,
    });
    p.device.queue.writeBuffer(buffer, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    return buffer;
  }

  render(camera: PerspectiveCamera, dt: number): ShaderFrameStats | null {
    const p = this.pipeline;
    if (!p || !this.canvas) return null;
    const dpr = Math.min(devicePixelRatio, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    try {
      const stats = p.render(camera, dt, w, h);
      this.checkProductive(stats);
      return stats;
    } catch (e) {
      // A device loss or a validation error must not take the page with it.
      this.reason = `render failed: ${(e as Error).message}`;
      this.disable();
      this.showPanel();
      return null;
    }
  }

  /**
   * Hand the screen back if the shader path is drawing nothing.
   *
   * It hides the WebGL canvas to take over, so a pipeline that builds but issues no draws
   * leaves the viewer staring at an empty frame with the renderer that works sitting
   * hidden behind it. Geometry uploads lag the first frames, so this only trips once
   * sections exist and the pass chain still produced no draw.
   */
  private checkProductive(stats: ShaderFrameStats): void {
    if (stats.drawCalls > 0) {
      this.unproductiveFrames = 0;
      return;
    }
    if (++this.unproductiveFrames < 120) return;
    this.reason = 'shader passes drew nothing for 120 frames — fell back to the WebGL renderer';
    this.setEnabled(false);
  }

  /** Tear the shader path down and hand the screen back to the WebGL renderer. */
  disable(): void {
    this.pipeline?.destroy();
    this.pipeline = null;
    this.canvas?.remove();
    this.canvas = null;
    const base = document.getElementById('view');
    if (base) (base as HTMLCanvasElement).style.display = 'block';
  }
}
