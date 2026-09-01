/**
 * Per-frame fill of the shared std140 block.
 *
 * The long tail of this contract is quirk-compatibility, and packs branch on it, so the
 * sentinels are reproduced rather than zeroed: `frameTimeCounter` wraps at 3600 s,
 * `frameCounter` at 720719, `cameraPosition` wraps every 30000 blocks, and the
 * previous-frame matrices are zero-filled on frame 1. A host that returns a plausible-
 * looking zero for these is telling the pack something specific and wrong.
 *
 * `entityId` is the sharpest example: 0 means "no entity.properties file", 65535 means
 * "entity not listed in it". Returning 0 unconditionally tells every pack the host does
 * not support entity ids at all.
 */

import { Matrix4, Vector3, type PerspectiveCamera } from 'three';
import {
  irisUniformLayout, isFloatKind, isMatrixKind, type UniformLayout, type UniformSlot,
} from './iris-uniforms.js';

export interface WorldTimeState {
  /** 0..23999 */
  readonly worldTime: number;
  readonly worldDay: number;
  readonly rainStrength: number;
  readonly isEyeInWater: number;
}

const DEFAULT_TIME: WorldTimeState = {
  worldTime: 6000, worldDay: 0, rainStrength: 0, isEyeInWater: 0,
};

/** wrap points the packs are written against */
const FRAME_TIME_WRAP = 3600;
const FRAME_COUNTER_WRAP = 720720;
const CAMERA_WRAP = 30000;

export class IrisUniformState {
  readonly layout: UniformLayout = irisUniformLayout();
  readonly data: ArrayBuffer;
  private floats: Float32Array;
  private ints: Int32Array;

  private frame = 0;
  private elapsed = 0;
  private prevModelView = new Matrix4();
  private prevProjection = new Matrix4();
  private prevCamera = new Vector3();
  /** frame 1 must report zero-filled previous matrices, not the current ones */
  private hasPrevious = false;

  time: WorldTimeState = DEFAULT_TIME;
  shadowMapResolution = 1024;
  shadowDistance = 120;
  sunPathRotation = 0;
  atlasSize: [number, number] = [0, 0];

  constructor() {
    this.data = new ArrayBuffer(this.layout.sizeBytes);
    this.floats = new Float32Array(this.data);
    this.ints = new Int32Array(this.data);
  }

  private setMat(name: string, m: Matrix4): void {
    const slot = this.layout.slots.get(name);
    if (!slot || !isMatrixKind(slot.kind)) return;
    this.floats.set(m.elements, slot.offset / 4);
  }

  private setVec(name: string, x: number, y = 0, z = 0, w = 0): void {
    const slot = this.layout.slots.get(name);
    if (!slot || !isFloatKind(slot.kind)) return;
    const i = slot.offset / 4;
    this.floats[i] = x;
    this.floats[i + 1] = y;
    this.floats[i + 2] = z;
    this.floats[i + 3] = w;
  }

  private setInt(name: string, x: number, y = 0): void {
    const slot = this.layout.slots.get(name);
    if (!slot || isFloatKind(slot.kind) || isMatrixKind(slot.kind)) return;
    const i = slot.offset / 4;
    this.ints[i] = x | 0;
    this.ints[i + 1] = y | 0;
  }

  /** Advance the frame counters. Separate from update() so a paused view still renders. */
  tick(dtSeconds: number): void {
    this.frame = (this.frame + 1) % FRAME_COUNTER_WRAP;
    this.elapsed = (this.elapsed + dtSeconds) % FRAME_TIME_WRAP;
    this.setVec('frameTime', dtSeconds);
    this.setVec('frameTimeCounter', this.elapsed);
    this.setInt('frameCounter', this.frame);
  }

  update(camera: PerspectiveCamera, width: number, height: number): void {
    this.writeMatrices(camera);
    this.writeCamera(camera, width, height);
    this.writeCelestial();
    this.writePlayerAndWorld();
  }

  private writeMatrices(camera: PerspectiveCamera): void {
    camera.updateMatrixWorld();
    const view = new Matrix4().copy(camera.matrixWorldInverse);
    const proj = camera.projectionMatrix;

    // `gl_Vertex` carries absolute world coordinates, so the model-view matrix has to
    // carry the camera translation that Minecraft would have baked into the chunk
    // transform. gbufferModelView stays the pure view matrix, which is what makes
    // `gbufferModelViewInverse * gl_ModelViewMatrix * gl_Vertex + cameraPosition`
    // reproduce the world position the packs expect.
    const p = camera.position;
    const modelView = new Matrix4().multiply(view).multiply(
      new Matrix4().makeTranslation(-p.x, -p.y, -p.z),
    );

    this.setMat('gbufferModelView', view);
    this.setMat('gbufferModelViewInverse', new Matrix4().copy(view).invert());
    this.setMat('gbufferProjection', proj);
    this.setMat('gbufferProjectionInverse', new Matrix4().copy(proj).invert());
    this.setMat('modelViewMatrix', modelView);
    this.setMat('modelViewMatrixInverse', new Matrix4().copy(modelView).invert());
    this.setMat('projectionMatrix', proj);
    this.setMat('projectionMatrixInverse', new Matrix4().copy(proj).invert());
    this.setMat('normalMatrix', new Matrix4().copy(modelView).invert().transpose());
    this.setMat('textureMatrix', new Matrix4());
    this.setMat('iris_TextureMatrix0', new Matrix4());
    this.setMat('iris_TextureMatrix1', lightmapMatrix());
    this.setMat('iris_TextureMatrix2', lightmapMatrix());

    this.setMat('gbufferPreviousModelView', this.hasPrevious ? this.prevModelView : ZERO);
    this.setMat('gbufferPreviousProjection', this.hasPrevious ? this.prevProjection : ZERO);
    this.writeShadowMatrices();

    this.prevModelView.copy(view);
    this.prevProjection.copy(proj);
    this.hasPrevious = true;
  }

  /**
   * The shadow pass renders from the sun with an orthographic projection covering
   * `shadowDistance` around the camera. `sunPathRotation` tilts the whole celestial path
   * and is a pack constant, not a world property.
   */
  private writeShadowMatrices(): void {
    const sun = this.sunDirection();
    const view = new Matrix4().lookAt(
      new Vector3(sun.x * 100, sun.y * 100, sun.z * 100),
      new Vector3(0, 0, 0),
      new Vector3(0, 1, 0),
    );
    const shadowView = new Matrix4().copy(view).invert();
    const d = this.shadowDistance;
    const proj = new Matrix4().makeOrthographic(-d, d, d, -d, -d * 2, d * 2);
    this.setMat('shadowModelView', shadowView);
    this.setMat('shadowModelViewInverse', new Matrix4().copy(shadowView).invert());
    this.setMat('shadowProjection', proj);
    this.setMat('shadowProjectionInverse', new Matrix4().copy(proj).invert());
  }

  /** Unit vector toward the sun for the current world time. */
  sunDirection(): Vector3 {
    const angle = ((this.time.worldTime / 24000) - 0.25) * Math.PI * 2;
    const tilt = (this.sunPathRotation * Math.PI) / 180;
    const v = new Vector3(-Math.sin(angle), Math.cos(angle), 0);
    v.applyAxisAngle(new Vector3(0, 0, 1), tilt);
    return v.normalize();
  }

  private writeCamera(camera: PerspectiveCamera, width: number, height: number): void {
    const p = camera.position;
    // Vanilla wraps the camera position so float precision never degrades far from spawn;
    // packs that hash on it depend on the wrap being there.
    const wrap = (v: number) => v - Math.floor(v / CAMERA_WRAP) * CAMERA_WRAP;
    this.setVec('cameraPosition', wrap(p.x), wrap(p.y), wrap(p.z));
    this.setVec('previousCameraPosition', this.prevCamera.x, this.prevCamera.y, this.prevCamera.z);
    this.prevCamera.set(wrap(p.x), wrap(p.y), wrap(p.z));

    this.setVec('viewWidth', width);
    this.setVec('viewHeight', height);
    this.setVec('aspectRatio', width / Math.max(1, height));
    this.setVec('near', camera.near);
    this.setVec('far', camera.far);
    this.setVec('eyeAltitude', p.y);
    this.setVec('centerDepthSmooth', 0.5);
    this.setInt('atlasSize', this.atlasSize[0], this.atlasSize[1]);
  }

  private writeCelestial(): void {
    const sun = this.sunDirection();
    // *Position uniforms are in view space in Iris; the packs normalise them anyway, and
    // supplying world space here would rotate every lighting term with the camera.
    const view = new Matrix4();
    const slot = this.layout.slots.get('gbufferModelView');
    if (slot) view.fromArray(Array.from(this.floats.subarray(slot.offset / 4, slot.offset / 4 + 16)));
    const toView = (v: Vector3) => v.clone().transformDirection(view).multiplyScalar(100);

    const sunView = toView(sun);
    const moonView = toView(sun.clone().negate());
    const up = toView(new Vector3(0, 1, 0));
    this.setVec('sunPosition', sunView.x, sunView.y, sunView.z);
    this.setVec('moonPosition', moonView.x, moonView.y, moonView.z);
    this.setVec('upPosition', up.x, up.y, up.z);
    // Iris points shadowLightPosition at whichever of sun/moon is above the horizon.
    const shadow = sun.y >= 0 ? sunView : moonView;
    this.setVec('shadowLightPosition', shadow.x, shadow.y, shadow.z);

    const day = Math.max(0, sun.y);
    this.setVec('sunAngle', (this.time.worldTime / 24000 + 0.75) % 1);
    this.setVec('shadowAngle', (this.time.worldTime / 24000 + 0.75) % 0.5);
    this.setVec('skyColor', 0.47 * day + 0.05, 0.65 * day + 0.06, 1.0 * day + 0.09);
    this.setVec('fogColor', 0.75 * day + 0.02, 0.82 * day + 0.03, 1.0 * day + 0.05);
    this.setVec('ambientLight', 0.05);
  }

  private writePlayerAndWorld(): void {
    const t = this.time;
    this.setInt('worldTime', t.worldTime);
    this.setInt('worldDay', t.worldDay);
    this.setInt('moonPhase', t.worldDay % 8);
    this.setInt('isEyeInWater', t.isEyeInWater);
    this.setVec('rainStrength', t.rainStrength);
    this.setVec('wetness', t.rainStrength);
    this.setVec('thunderStrength', 0);
    this.setVec('screenBrightness', 1);
    this.setVec('nightVision', 0);
    this.setVec('blindness', 0);
    this.setVec('playerMood', 0);
    this.setVec('fogStart', 0);
    this.setVec('fogEnd', 256);
    this.setVec('fogDensity', 0.02);
    this.setVec('alphaTestRef', 0.1);
    this.setInt('eyeBrightness', 240, 240);
    this.setInt('eyeBrightnessSmooth', 240, 240);
    this.setInt('heldItemId', -1);
    this.setInt('heldItemId2', -1);
    // 0 says "no entity.properties"; 65535 says "present but unlisted". Neither is a
    // stand-in for the other, and packs branch on the difference.
    this.setInt('entityId', 65535);
    this.setInt('blockEntityId', 65535);
    this.setInt('currentRenderedItemId', 65535);
    this.setInt('currentSelectedBlockId', 0);
    this.setInt('heightLimit', 384);
    this.setInt('bedrockLevel', -64);
    this.setInt('hasSkylight', 1);
    this.setInt('isRightHanded', 1);
  }

  /** For a pass that needs a slot the caller computes itself (e.g. renderStage). */
  setStage(stage: number): void {
    this.setInt('renderStage', stage);
  }

  slotOf(name: string): UniformSlot | undefined {
    return this.layout.slots.get(name);
  }
}

const ZERO = new Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

/**
 * `gl_TextureMatrix[1]` maps the packed 0..240 lightmap coordinate into the 0..1 range of
 * the lightmap texture, landing on texel centres (0.03125 .. 0.96875).
 */
function lightmapMatrix(): Matrix4 {
  const s = 1 / 256;
  return new Matrix4().set(
    s, 0, 0, 0.03125,
    0, s, 0, 0.03125,
    0, 0, s, 0,
    0, 0, 0, 1,
  );
}
