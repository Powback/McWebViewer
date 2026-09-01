/**
 * Regression tests for the GLSL uplift.
 *
 * Both cases here were real failures that took the pack from compiling to not compiling in
 * ways whose error messages pointed nowhere near the cause, which is exactly the kind of
 * bug that deserves a check rather than a comment.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { irisUniformLayout } from './iris-uniforms.js';
import { planProgram } from './glsl-plan.js';
import { normaliseStageSource, uplift } from './glsl-uplift.js';

const layout = irisUniformLayout();
const noDefines = new Map<string, string>();

function build(src: string, stage: 'vertex' | 'fragment') {
  const normalised = normaliseStageSource(src);
  const plan = planProgram([normalised]);
  return uplift(normalised, { stage, plan, layout, drawBuffers: [0], hostDefines: noDefines });
}

test('the atlas sampler is renamed before texture2D becomes texture', () => {
  // OptiFine names the albedo sampler `texture`, colliding with the 1.30+ builtin. If the
  // rename runs after the builtin rewrite, the emitted `#define texture …` swallows every
  // `texture(...)` call and the shader fails with "function call expected".
  const src = 'uniform sampler2D texture;\nvoid main() { gl_FragData[0] = texture2D(texture, vec2(0.0)); }';
  const out = build(src, 'fragment').code;
  assert.ok(out.includes('#define gtexture sampler2D(gtexture_T, gtexture_S)'),
    'sampler should be split under its renamed identifier');
  assert.ok(out.includes('texture(gtexture,'), 'the call should be the core builtin');
  assert.ok(!/#define texture\b/.test(out), 'must never define the builtin name');
});

test('a uniform that is also a local becomes a shadowable global, not a macro', () => {
  // Sildur's composite1 declares `uniform vec3 sunVec;` and then a local `vec3 sunVec` in a
  // function. As a macro the local expands to `vec3 iu.iu_vec[N].xyz = …` and will not parse.
  const src = [
    'uniform vec3 sunPosition;',
    'void main() { vec3 sunPosition = vec3(1.0); gl_FragData[0] = vec4(sunPosition, 1.0); }',
  ].join('\n');
  const out = build(src, 'fragment').code;
  assert.ok(/vec3 sunPosition = iu\.iu_vec\[\d+\]\.xyz;/.test(out),
    'should emit a global initialised from the block');
  assert.ok(!/#define sunPosition/.test(out), 'a macro would corrupt the local declaration');
});

test('gl_ builtins are substituted textually, never #defined', () => {
  // GLSL reserves every `gl_` name, macros included: `#define gl_Vertex …` is rejected and
  // the identifier then survives to the parser as undeclared.
  const out = build('void main() { gl_Position = ftransform(); }', 'vertex').code;
  assert.ok(!/#define gl_/.test(out), 'gl_ names are reserved and cannot be macros');
  assert.ok(out.includes('vec4(vaPosition, 1.0)'), 'gl_Vertex should expand to the attribute');
  assert.ok(out.includes('layout(location = 0) in vec3 vaPosition;'));
});

test('a mat3 varying is split into three vec3s in both stages', () => {
  // WGSL forbids matrices as entry-point I/O.
  const src = 'varying mat3 tbnMatrix;\nvoid main() { gl_Position = vec4(tbnMatrix[0], 1.0); }';
  const vs = build(src, 'vertex').code;
  assert.ok(vs.includes('out vec3 tbnMatrix__c0;'));
  assert.ok(vs.includes('mat3 tbnMatrix;'), 'the vertex stage assigns it, so it stays a mat3');
  assert.ok(vs.includes('void iris_main('), 'main is wrapped so the split outs get written');

  const fs = build('varying mat3 tbnMatrix;\nvoid main() { gl_FragData[0] = vec4(tbnMatrix[1], 1.0); }', 'fragment').code;
  assert.ok(fs.includes('in vec3 tbnMatrix__c1;'));
  assert.ok(fs.includes('#define tbnMatrix mat3(tbnMatrix__c0, tbnMatrix__c1, tbnMatrix__c2)'));
});

test('an unknown uniform binds to zero rather than failing', () => {
  // Iris leaves an unrecognised uniform unbound and it reads zero; refusing instead would
  // reject packs over a uniform they may never branch on.
  const r = build('uniform float notARealUniform;\nvoid main() { gl_FragData[0] = vec4(notARealUniform); }', 'fragment');
  assert.deepEqual(r.unknownUniforms, ['notARealUniform']);
  assert.ok(r.code.includes('float notARealUniform = 0.0;'));
});

test('DRAWBUFFERS maps gl_FragData indices onto located outputs', () => {
  const r = uplift(
    normaliseStageSource('void main() { gl_FragData[0] = vec4(1.0); gl_FragData[2] = vec4(0.0); }'),
    {
      stage: 'fragment',
      plan: planProgram(['']),
      layout,
      drawBuffers: [4, 1, 2],
      hostDefines: noDefines,
    },
  );
  assert.equal(r.fragOutputs, 3);
  assert.ok(r.code.includes('layout(location = 0) out vec4 iris_FragData0;'));
  assert.ok(r.code.includes('layout(location = 2) out vec4 iris_FragData2;'));
  assert.ok(r.code.includes('iris_FragData2 = vec4(0.0);'));
});
