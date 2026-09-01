/**
 * The Iris pipeline, executed on WebGPU.
 *
 * Pass order is Iris': shadow -> gbuffers(opaque) -> deferred -> gbuffers(translucent) ->
 * composite -> final. Composite-style stages have no fallback — a missing one is skipped,
 * not substituted — while gbuffers programs walk the fallback graph, which is how
 * `gbuffers_terrain` ends up served by `gbuffers_textured` in a pack that ships no terrain
 * program.
 *
 * Everything here degrades. A program that failed to translate, a pipeline that fails to
 * build, a pass whose attachments exceed a device limit: each is recorded in `skipped`
 * with a reason and the rest of the frame still runs. That is deliberate — SHADERPACKS.md
 * §8 puts Sildur's at 95% translatable, and a pack at 95% is worth far more than a pack
 * rejected over the 5%.
 */

import type { PerspectiveCamera } from 'three';
import { resolveProgram } from './iris-pipeline.js';
import { availablePrograms, type BundleProgram, type ShaderBundle } from './bundle.js';
import { IrisUniformState } from './shader-uniforms.js';
import { ShaderTargets } from './webgpu-targets.js';
import { VERTEX_FLOATS, vertexBufferLayout } from './shader-vertex.js';
import {
  buildLayout, buildTextureBindGroup, createSamplers, makeSolidTexture, uniformLayout,
  type ResourceContext, type SamplerSet,
} from './webgpu-bindings.js';
import { DEPTH_BLIT_WGSL } from './webgpu-blit.js';

export type GeometryLayer = 'solid' | 'cutout' | 'translucent';

export interface ShaderSection {
  readonly vertex: GPUBuffer;
  readonly index: GPUBuffer;
  readonly indexCount: number;
  readonly layer: GeometryLayer;
}

export interface SkippedPass {
  readonly program: string;
  readonly reason: string;
}

export interface ShaderFrameStats {
  passesRun: number;
  drawCalls: number;
  triangles: number;
}

interface CompiledProgram {
  readonly name: string;
  readonly pipeline: GPURenderPipeline;
  readonly textureLayout: GPUBindGroupLayout;
  readonly bundle: BundleProgram;
  /** colortex indices this program writes, for the ping-pong flip */
  readonly targets: readonly number[];
}

const FULLSCREEN_VERTICES = 6;

export class ShaderPipeline {
  private targets!: ShaderTargets;
  private samplers!: SamplerSet;
  private uniforms = new IrisUniformState();
  private worldUbo!: GPUBuffer;
  private screenUbo!: GPUBuffer;
  private uniformGroupLayout!: GPUBindGroupLayout;
  private worldUniformGroup!: GPUBindGroup;
  private screenUniformGroup!: GPUBindGroup;
  private fullscreenVerts!: GPUBuffer;
  private resources!: ResourceContext;
  private compiled = new Map<string, CompiledProgram | null>();
  private sections = new Map<string, ShaderSection[]>();
  private blit!: { pipeline: GPURenderPipeline; layout: GPUBindGroupLayout };

  readonly skipped: SkippedPass[] = [];
  /**
   * WebGPU reports most validation failures asynchronously, not by throwing. Without
   * capturing them a pass that produces nothing looks identical to a pass that worked,
   * which is exactly the "no shaders, no explanation" case this is here to prevent.
   */
  readonly runtimeErrors: string[] = [];
  deviceLost: string | null = null;

  private constructor(
    readonly device: GPUDevice,
    private context: GPUCanvasContext,
    private canvasFormat: GPUTextureFormat,
    readonly bundle: ShaderBundle,
  ) {}

  /**
   * Returns null when WebGPU is unavailable rather than throwing, so the caller can fall
   * back to the ordinary renderer. A viewer that shows nothing is worse than a viewer
   * without shaders.
   */
  static async create(
    canvas: HTMLCanvasElement,
    bundle: ShaderBundle,
  ): Promise<ShaderPipeline | null> {
    if (!navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter().catch(() => null);
    const device = await adapter?.requestDevice().catch(() => null);
    if (!device) return null;
    const context = canvas.getContext('webgpu');
    if (!context) return null;
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    const p = new ShaderPipeline(device, context, format, bundle);
    device.onuncapturederror = (e) => {
      const msg = (e as GPUUncapturedErrorEvent).error.message;
      if (p.runtimeErrors.length < 20) p.runtimeErrors.push(msg);
    };
    void device.lost.then((info) => { p.deviceLost = info.message || 'device lost'; });
    p.init();
    return p;
  }

  private init(): void {
    const res = this.bundle.consts.shadowMapResolution ?? 1024;
    this.targets = new ShaderTargets(this.device, this.bundle.colortex, res);
    this.targets.initStatic();
    this.samplers = createSamplers(this.device);
    this.uniforms.shadowMapResolution = res;
    this.uniforms.shadowDistance = this.bundle.consts.shadowDistance ?? 120;
    this.uniforms.sunPathRotation = this.bundle.consts.sunPathRotation ?? 0;

    const size = this.uniforms.layout.sizeBytes;
    const usage = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    this.worldUbo = this.device.createBuffer({ size, usage, label: 'iris-uniforms-world' });
    this.screenUbo = this.device.createBuffer({ size, usage, label: 'iris-uniforms-screen' });
    this.uniformGroupLayout = uniformLayout(this.device);
    this.worldUniformGroup = this.bindUniform(this.worldUbo);
    this.screenUniformGroup = this.bindUniform(this.screenUbo);

    this.resources = {
      targets: this.targets,
      samplers: this.samplers,
      fallbackTexture: makeSolidTexture(this.device, [0, 0, 0, 255]),
      flatNormalTexture: makeSolidTexture(this.device, [128, 128, 255, 255]),
    };
    this.fullscreenVerts = this.makeFullscreenQuad();
    this.blit = this.makeBlit();
  }

  private bindUniform(buffer: GPUBuffer): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.uniformGroupLayout,
      entries: [{ binding: 0, resource: { buffer } }],
    });
  }

  /**
   * Composite-style vertex shaders call `ftransform()` on `gl_Vertex`, so Iris feeds them a
   * unit quad under an orthographic 0..1 projection. Reproducing that exactly is what lets
   * the pack's own `texcoord = gl_MultiTexCoord0` land on screen space unchanged.
   */
  private makeFullscreenQuad(): GPUBuffer {
    const corners = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]];
    const data = new Float32Array(FULLSCREEN_VERTICES * VERTEX_FLOATS);
    corners.forEach(([x, y], i) => {
      const o = i * VERTEX_FLOATS;
      data[o] = x;
      data[o + 1] = y;
      data[o + 3] = 1; data[o + 4] = 1; data[o + 5] = 1; data[o + 6] = 1; // vaColor
      data[o + 7] = x; data[o + 8] = y;                                    // vaUV0
    });
    const buf = this.device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: 'fullscreen-quad',
    });
    this.device.queue.writeBuffer(buf, 0, data);
    return buf;
  }

  private makeBlit(): { pipeline: GPURenderPipeline; layout: GPUBindGroupLayout } {
    const module = this.device.createShaderModule({ code: DEPTH_BLIT_WGSL });
    const layout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      ],
    });
    const pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'r32float' }] },
      primitive: { topology: 'triangle-list' },
    });
    return { pipeline, layout };
  }

  /* ---------------------------------------------------------------- geometry */

  setAtlas(texture: GPUTexture): void {
    this.targets.atlas = texture;
    this.uniforms.atlasSize = [texture.width, texture.height];
    // Bind groups capture texture views, so any cached pipeline state must be rebuilt.
    this.compiled.clear();
  }

  addSection(key: string, sections: ShaderSection[]): void {
    this.removeSection(key);
    this.sections.set(key, sections);
  }

  removeSection(key: string): void {
    for (const s of this.sections.get(key) ?? []) {
      s.vertex.destroy();
      s.index.destroy();
    }
    this.sections.delete(key);
  }

  clear(): void {
    for (const key of [...this.sections.keys()]) this.removeSection(key);
  }

  /* ---------------------------------------------------------------- pipelines */

  private colorTargetsFor(prog: BundleProgram): GPUColorTargetState[] {
    if (prog.name === 'final') return [{ format: this.canvasFormat }];
    if (prog.stage === 'shadow') return [{ format: 'rgba8unorm' }];
    const indices = prog.drawBuffers.length ? prog.drawBuffers : [0];
    return indices.map((i) => ({ format: this.targets.colorFormat(i) }));
  }

  /**
   * Build every pass up front instead of on first use.
   *
   * `createRenderPipelineAsync` rejects with the driver's actual message, where the
   * synchronous form surfaces many failures only through the uncaptured-error channel.
   * Doing this eagerly means the diagnostics are complete before the first frame rather
   * than filling in as passes happen to run.
   */
  async warmup(names: readonly string[]): Promise<void> {
    for (const name of names) {
      const prog = this.bundle.programs[name];
      if (!prog?.ok || !prog.stages.vertex || !prog.stages.fragment) {
        if (prog) this.skip(name, Object.values(prog.errors)[0] ?? 'not translated');
        continue;
      }
      try {
        this.compiled.set(name, await this.buildPipelineAsync(prog));
      } catch (e) {
        this.compiled.set(name, null);
        this.skip(name, `pipeline: ${(e as Error).message}`);
      }
    }
  }

  private async buildPipelineAsync(prog: BundleProgram): Promise<CompiledProgram> {
    const desc = this.pipelineDescriptor(prog);
    const pipeline = await this.device.createRenderPipelineAsync(desc.descriptor);
    return { ...desc.meta, pipeline };
  }

  private compile(name: string): CompiledProgram | null {
    const cached = this.compiled.get(name);
    if (cached !== undefined) return cached;
    const built = this.tryCompile(name);
    this.compiled.set(name, built);
    return built;
  }

  private tryCompile(name: string): CompiledProgram | null {
    const prog = this.bundle.programs[name];
    if (!prog?.ok || !prog.stages.vertex || !prog.stages.fragment) {
      this.skip(name, prog ? (Object.values(prog.errors)[0] ?? 'not translated') : 'absent');
      return null;
    }
    try {
      return this.buildPipeline(prog);
    } catch (e) {
      this.skip(name, `pipeline: ${(e as Error).message}`);
      return null;
    }
  }

  private buildPipeline(prog: BundleProgram): CompiledProgram {
    const d = this.pipelineDescriptor(prog);
    return { ...d.meta, pipeline: this.device.createRenderPipeline(d.descriptor) };
  }

  private pipelineDescriptor(prog: BundleProgram): {
    descriptor: GPURenderPipelineDescriptor;
    meta: Omit<CompiledProgram, 'pipeline'>;
  } {
    const vs = prog.stages.vertex!;
    const fs = prog.stages.fragment!;
    const bindings = [...vs.bindings, ...fs.bindings];
    const textureLayout = buildLayout(this.device, bindings, prog.samplerRoles);
    const isWorld = prog.stage === 'gbuffers' || prog.stage === 'shadow';
    const translucent = prog.name.includes('water') || prog.name.includes('translucent');

    const descriptor: GPURenderPipelineDescriptor = {
      label: prog.name,
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.uniformGroupLayout, textureLayout],
      }),
      vertex: {
        module: this.device.createShaderModule({ code: vs.wgsl, label: `${prog.name}.vs` }),
        entryPoint: 'main',
        buffers: [vertexBufferLayout()],
      },
      fragment: {
        module: this.device.createShaderModule({ code: fs.wgsl, label: `${prog.name}.fs` }),
        entryPoint: 'main',
        targets: this.colorTargetsFor(prog).map((t) =>
          (translucent ? { ...t, blend: ALPHA_BLEND } : t)),
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: isWorld ? 'back' : 'none',
        // frontFace 'cw', NOT the 'ccw' default. Facing is decided in framebuffer space,
        // and WebGPU's framebuffer Y points down where OpenGL's points up — so the mesher's
        // counter-clockwise-from-outside winding arrives clockwise here. Leaving the
        // default culls precisely the faces that should be visible and keeps the ones that
        // should not, which reads as every block having lost its top.
        frontFace: 'cw',
      },
      depthStencil: isWorld
        ? {
          format: 'depth32float',
          depthWriteEnabled: !translucent,
          depthCompare: 'less',
        }
        : undefined,
    };
    return {
      descriptor,
      meta: {
        name: prog.name,
        textureLayout,
        bundle: prog,
        targets: prog.drawBuffers.length ? prog.drawBuffers : [],
      },
    };
  }

  /** The passes this pipeline would run, in order — used to warm up and to report. */
  plannedPasses(): string[] {
    const names = ['shadow'];
    const avail = availablePrograms(this.bundle);
    for (const want of ['gbuffers_terrain', 'gbuffers_water']) {
      const r = resolveProgram(want, avail);
      if (r) names.push(r);
    }
    for (const base of ['deferred', 'composite']) {
      for (let i = 0; i < 16; i++) {
        const n = i === 0 ? base : `${base}${i}`;
        if (this.bundle.programs[n]) names.push(n);
      }
    }
    names.push('final');
    return [...new Set(names)];
  }

  isCompiled(name: string): boolean {
    return this.compiled.get(name) != null;
  }

  private skip(program: string, reason: string): void {
    if (!this.skipped.some((s) => s.program === program)) this.skipped.push({ program, reason });
  }

  private textureGroup(c: CompiledProgram): GPUBindGroup {
    const bindings = [
      ...(c.bundle.stages.vertex?.bindings ?? []),
      ...(c.bundle.stages.fragment?.bindings ?? []),
    ];
    return buildTextureBindGroup(
      this.device, c.textureLayout, bindings, c.bundle.samplerRoles, this.resources,
    );
  }

  /* ---------------------------------------------------------------- frame */

  resize(width: number, height: number): void {
    this.targets.resize(width, height);
    this.compiled.clear();
  }

  render(camera: PerspectiveCamera, dt: number, width: number, height: number): ShaderFrameStats {
    this.resize(width, height);
    this.uniforms.tick(dt);
    this.uniforms.update(camera, width, height);
    this.writeUniformBuffers();

    const encoder = this.device.createCommandEncoder();
    const stats = { passesRun: 0, drawCalls: 0, triangles: 0 };
    this.runShadow(encoder, stats);
    this.runGbuffers(encoder, stats, ['solid', 'cutout'], 'gbuffers_terrain');
    this.blitDepth(encoder, 1);
    this.blitDepth(encoder, 2);
    this.runChain(encoder, stats, 'deferred');
    this.runGbuffers(encoder, stats, ['translucent'], 'gbuffers_water');
    this.blitDepth(encoder, 0);
    this.runChain(encoder, stats, 'composite');
    this.runFinal(encoder, stats);
    this.device.queue.submit([encoder.finish()]);
    return stats;
  }

  private writeUniformBuffers(): void {
    this.device.queue.writeBuffer(this.worldUbo, 0, this.uniforms.data);
    // Fullscreen passes see an identity model-view and a 0..1 orthographic projection,
    // which is the transform Iris draws its composite quad under.
    const screen = this.uniforms.data.slice(0);
    const f = new Float32Array(screen);
    const mv = this.uniforms.slotOf('modelViewMatrix');
    const proj = this.uniforms.slotOf('projectionMatrix');
    if (mv) f.set(IDENTITY, mv.offset / 4);
    if (proj) f.set(ORTHO_01, proj.offset / 4);
    this.device.queue.writeBuffer(this.screenUbo, 0, screen);
  }

  private runShadow(encoder: GPUCommandEncoder, stats: ShaderFrameStats): void {
    const c = this.compile('shadow');
    if (!c) return;
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.targets.shadowColorView(),
        clearValue: { r: 1, g: 1, b: 1, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.targets.shadowDepthView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    this.drawWorld(pass, c, ['solid', 'cutout'], stats);
    pass.end();
    this.blitShadowDepth(encoder);
  }

  private runGbuffers(
    encoder: GPUCommandEncoder,
    stats: ShaderFrameStats,
    layers: readonly GeometryLayer[],
    want: string,
  ): void {
    const name = resolveProgram(want, availablePrograms(this.bundle));
    if (!name) {
      this.skip(want, 'no program in the fallback chain translated');
      return;
    }
    const c = this.compile(name);
    if (!c) return;
    const first = layers[0] === 'solid';
    const pass = encoder.beginRenderPass({
      colorAttachments: (c.targets.length ? c.targets : [0]).map((i) => ({
        view: this.targets.writeView(i),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: first ? 'clear' as const : 'load' as const,
        storeOp: 'store' as const,
      })),
      depthStencilAttachment: {
        view: this.targets.depthView(),
        depthClearValue: 1,
        depthLoadOp: first ? 'clear' : 'load',
        depthStoreOp: 'store',
      },
    });
    this.drawWorld(pass, c, layers, stats);
    pass.end();
    this.targets.flip(c.targets);
  }

  private drawWorld(
    pass: GPURenderPassEncoder,
    c: CompiledProgram,
    layers: readonly GeometryLayer[],
    stats: ShaderFrameStats,
  ): void {
    pass.setPipeline(c.pipeline);
    pass.setBindGroup(0, this.worldUniformGroup);
    pass.setBindGroup(1, this.textureGroup(c));
    for (const list of this.sections.values()) {
      for (const s of list) {
        if (!layers.includes(s.layer)) continue;
        pass.setVertexBuffer(0, s.vertex);
        pass.setIndexBuffer(s.index, 'uint32');
        pass.drawIndexed(s.indexCount);
        stats.drawCalls++;
        stats.triangles += s.indexCount / 3;
      }
    }
    stats.passesRun++;
  }

  /** `deferred`, `deferred1`, … / `composite`, `composite1`, … until the names run out. */
  private runChain(encoder: GPUCommandEncoder, stats: ShaderFrameStats, base: string): void {
    for (let i = 0; i < 16; i++) {
      const name = i === 0 ? base : `${base}${i}`;
      if (!this.bundle.programs[name]) {
        if (i > 0) return;
        continue;
      }
      const c = this.compile(name);
      if (!c) continue;
      this.runFullscreen(encoder, c, stats);
    }
  }

  private runFullscreen(
    encoder: GPUCommandEncoder,
    c: CompiledProgram,
    stats: ShaderFrameStats,
  ): void {
    const indices = c.targets.length ? c.targets : [0];
    const pass = encoder.beginRenderPass({
      colorAttachments: indices.map((i) => ({
        view: this.targets.writeView(i),
        loadOp: 'load' as const,
        storeOp: 'store' as const,
      })),
    });
    pass.setPipeline(c.pipeline);
    pass.setBindGroup(0, this.screenUniformGroup);
    pass.setBindGroup(1, this.textureGroup(c));
    pass.setVertexBuffer(0, this.fullscreenVerts);
    pass.draw(FULLSCREEN_VERTICES);
    pass.end();
    // Iris flips after the pass, so the next one reads what this wrote.
    this.targets.flip(indices);
    stats.passesRun++;
    stats.drawCalls++;
  }

  private runFinal(encoder: GPUCommandEncoder, stats: ShaderFrameStats): void {
    const c = this.compile('final');
    if (!c) return;
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(c.pipeline);
    pass.setBindGroup(0, this.screenUniformGroup);
    pass.setBindGroup(1, this.textureGroup(c));
    pass.setVertexBuffer(0, this.fullscreenVerts);
    pass.draw(FULLSCREEN_VERTICES);
    pass.end();
    stats.passesRun++;
    stats.drawCalls++;
  }

  /** Depth is a depth-format texture; packs sample it as an ordinary one. See targets. */
  private blitDepth(encoder: GPUCommandEncoder, index: number): void {
    this.blitInto(encoder, this.targets.depthView(), this.targets.depthCopyTexture(index));
  }

  private blitShadowDepth(encoder: GPUCommandEncoder): void {
    this.blitInto(encoder, this.targets.shadowDepthView(), this.targets.shadowCopyTexture());
  }

  private blitInto(encoder: GPUCommandEncoder, src: GPUTextureView, dst: GPUTexture): void {
    const group = this.device.createBindGroup({
      layout: this.blit.layout,
      entries: [{ binding: 0, resource: src }],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: dst.createView(), loadOp: 'clear', storeOp: 'store',
        clearValue: { r: 1, g: 1, b: 1, a: 1 },
      }],
    });
    pass.setPipeline(this.blit.pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    this.clear();
    this.targets.destroy();
  }
}

const ALPHA_BLEND: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/** column-major orthographic projection of the 0..1 unit quad */
const ORTHO_01 = new Float32Array([
  2, 0, 0, 0,
  0, 2, 0, 0,
  0, 0, -1, 0,
  -1, -1, 0, 1,
]);
