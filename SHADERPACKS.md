# Can OptiFine/Iris shaderpacks run in a browser under WebGPU?

An **empirical** answer. Four real shaderpacks were downloaded, a minimal Iris-compatible
preprocessor was implemented, and all **756 shader programs were actually compiled**
GLSL → SPIR-V → WGSL with a real toolchain. This supersedes the feature-table argument in
`ARCHITECTURE.md` §4 "Rejected: shaderpack reuse", which reached its conclusion without
running a compiler.

Everything below is **measured** unless explicitly marked `[INFERRED]` or `[DOC]`.

---

## TL;DR

| Question | Feature-table answer (prior) | Measured answer |
|---|---|---|
| Do the packs compile to WGSL? | "No — WGSL only, no GLSL" | **607 / 756 programs (80.3%) compile to valid WGSL today** |
| Is there a WebGPU-absent construct? | geometry + tessellation | **Yes, but only geometry, in 3 of 756 programs (0.40%)** — all one file. Zero tessellation. |
| Does `maxColorAttachmentBytesPerSample` (32 B) kill it? | "cannot hold eight RGBA16F" | **No.** No pack exceeds 8 attachments or 32 B/sample. Worst case is BSL at exactly 32 B. The "eight RGBA16F" case never occurs. |
| Compute / SSBO / image load-store? | listed as blockers | **Not blockers under WebGPU** (that is a WebGL2 argument). All three exist in WebGPU. |

**The headline number: of 149 failures, 3 are inherent to WebGPU (0.40% of the corpus).
The other 146 are mechanical rewrites or artifacts of my own transformer.**

The real blockers are *not* the shader language. They are the runtime contract (§7), a
handful of concrete resource-limit overruns (§6), and the fact that the transformation
needs a real GLSL parser rather than regex (§5.4).

---

## 1. Reproducibility: tools, versions, commands

Host: macOS 26.3.1, arm64.

```
glslang           16.5.0                (brew install glslang)     -> glslangValidator
spirv-cross       1.4.357.0             (brew install spirv-cross)
SPIRV-Tools       v2026.3               (bundled with glslang/spirv-cross)  -> spirv-val, spirv-dis
naga-cli          30.0.1                (cargo install naga-cli)   -> naga
rustc             1.98.0 (Homebrew)     (brew install rust)
python            3.14.5
```

Packs, fetched programmatically from the Modrinth API
(`https://api.modrinth.com/v2/project/<slug>/version`). All four were downloadable; no
substitutions were needed.

| Pack | Version | SHA-256 (first 16) | Programs |
|---|---|---|---|
| Sildur's Vibrant Shaders Lite | 2.01 | `9c190bff0f33de2c` | 126 |
| BSL | v10.1.3 | `185774628b5259c3` | 179 |
| Complementary Reimagined | r5.8.1 | `3f1cd389e717b2e6` | 219 |
| Rethinking Voxels | r0.1-beta9 | `a8cd9d4338c7d3d1` | 232 |

The per-program pipeline actually executed:

```sh
# 1. GLSL -> SPIR-V  (Vulkan semantics; this is the model WebGPU's binding system matches)
glslangValidator -V --auto-map-locations --auto-map-bindings -S <frag|vert|comp|geom> in.glsl -o out.spv

# 2. SPIR-V -> WGSL  (the actual WebGPU target)
naga out.spv out.wgsl

# 3. independent cross-check: SPIR-V -> Metal
spirv-cross --msl out.spv
```

Harness (in the scratch dir, not in this repo): `iris_pp.py` (preprocessor), `run_matrix.py`
(compile matrix), `limits.py` (WebGPU limit arithmetic), `analyze.py` (aggregation).

### Corpus shape (measured)

`#version` directives across all 756 programs:

```
363  #version 130          361  #version 120          91  #version 430 (compatibility)
  3  #version 400 compatibility
```

Expanded source sizes after `#include` resolution reach **18,273 lines / 522 KB** for a
single Complementary fragment program. BSL/Complementary/Rethinking ship a full copy of
every program per dimension (`world0`, `world1`, `world-1`); distinct programs are
Sildur's 42, BSL 61, Complementary 73, Rethinking 78.

---

## 2. What the loader must do before a compiler ever sees the code

The packs do not compile raw — not because of the shading language, but because a
shaderpack is only *half* a program until the host fills in the rest. Implemented in
`iris_pp.py`:

1. **`#include` resolution** with Iris semantics: `"/foo"` resolves from `shaders/`,
   `"foo"` relative to the including file. Both forms occur (Sildur's uses the relative
   form, BSL/Complementary/Rethinking the absolute form).
2. **Host `#define` injection**: `MC_VERSION`, `MC_GL_VERSION`, `MC_GLSL_VERSION`,
   `MC_NORMAL_MAP`, `MC_SPECULAR_MAP`, `MC_OS_*`, `MC_RENDER_STAGE_*` (24 constants),
   `IS_IRIS`, … A plausible set was used; the packs branch heavily on these.
3. **`/* DRAWBUFFERS:0123 */` and `/* RENDERTARGETS: 0,3,7 */` parsing** to synthesise the
   fragment output declarations.
4. **`const int colortexNFormat = …` scraping.** These are **deliberately inside block
   comments** in real packs — Sildur's declares its entire format table inside a `/* … */`.
   [DOC] the Iris docs state this explicitly: *"the format names are not defined as part of
   glsl, [so] the directive must either be put in a block comment, or the format name must
   be otherwise manually defined … to avoid compilation errors."* A host **must** text-scrape
   these; they can never be compiled.
5. **`shaders.properties` `image.<name> = <sampler> …` parsing.** Iris injects a sampler
   uniform per line. Without it, real packs have undeclared identifiers (`voxel_sampler`,
   `voxeltex`, `lighttex0`) — measured, this broke compilation until implemented.

Point 4 alone disproves any "just feed it to a compiler" model in either direction: the
resource declarations live in comments, and the compiler must never see the identifiers.

---

## 3. The uplift ladder

Four escalating transform levels were tried per program, each carried all the way to WGSL:

| Level | What it does |
|---|---|
| **L0 raw** | original `#version`, host defines only |
| **L1 uplift** | `attribute`→`in`, `varying`→`in/out`, `texture2D`→`texture`, `gl_ModelViewMatrix` &c → uniforms, `gl_FragData[N]` → located outputs, `ftransform()`, `gl_Fog`, `gl_VertexID`→`gl_VertexIndex`, `isnan`/`isinf` |
| **L2 + UBO** | L1 + hoist default uniforms into a `std140` block (WebGPU has no default uniform block) |
| **L3 + sampler split** | L2 + split combined samplers into `texture2D` + `sampler`, and split `mat3` varyings into vector varyings |

**Measured result — which level each program needed:**

```
L0_raw               0   (0.0%)     <-- raw #version 120 NEVER compiles to SPIR-V
L1_uplift            3   (0.4%)
L2_uplift_ubo      359  (47.5%)
L3_sampler_split   245  (32.4%)
failed             149  (19.7%)
```

`L0 = 0` is a clean confirmation of the prior analysis's first bullet: the corpus is
compatibility-profile GLSL and **cannot** be handed to a modern compiler unmodified.
glslang rejects it two ways — `#version 120` is below the Vulkan minimum of 140, and
compatibility built-ins cannot be lowered to SPIR-V at all
(`INTERNAL ERROR: Unable to parse built-ins`). But that bullet was an argument about
*needing a rewrite*, not about *impossibility*: with the rewrite, 80.3% get through.

### Non-obvious rewrites the experiment forced out

These are the ones a capability table does not predict:

- **`uniform sampler2D texture;`** — OptiFine's albedo sampler is literally named `texture`,
  which collides with the GLSL 1.30+ `texture()` builtin. This is *why* the corpus is stuck
  on `texture2D`. Must be renamed.
- **`shadow2D()` returns `vec4`; core `texture(sampler2DShadow,…)` returns `float`.** A naive
  `shadow2D`→`texture` rewrite silently produces `.z` swizzle errors. Iris routes these
  through helpers; so must any port.
- **Combined image-samplers have no WGSL equivalent.** `OpTypeSampledImage` is rejected by
  naga outright (`invalid id %N`). Every `sampler2D` must become `texture_2d` + `sampler`.
  Verified: after splitting, the same shader emits clean WGSL using `textureSample()`.
- **WGSL forbids arrays and matrices as entry-point I/O.** The near-universal
  `varying mat3 tbnMatrix` (TBN basis, 20 files) must be split into 3 `vec3` varyings, and
  `gl_FragData[]` flattened into individually-located outputs. Measured: every `gl_FragData`
  index in the entire corpus is a literal constant (0–5), so flattening is mechanical.
- **Sampler names shadow local variables.** OptiFine's samplers are named `specular`,
  `normals`, `lightmap` — names packs also use for locals. A `#define`-based split corrupts
  the local. This is the single clearest place where correctness needs scoping.

---

## 4. THE MATRIX

`PASS(2)` = both `.vsh` and `.fsh` reached WGSL. `PASS(1)` = single-stage (compute).
`F:REASON` = failed. `-` = program not present in that pack. One canonical dimension per
pack (`world0`, or `shaders/` for Sildur's).

| program | Sildur's Lite | BSL | Comp. Reimagined | Rethinking Voxels |
|---|---|---|---|---|
| clrwl_gbuffers | – | – | F:TOOL_SAMPLER | – |
| clrwl_gbuffers_damagedblock | – | – | F:TOOL_SAMPLER | – |
| clrwl_gbuffers_translucent | – | – | F:TOOL_SAMPLER | – |
| clrwl_shadow | – | – | F:TOOL_SAMPLER | – |
| composite | PASS(2) | PASS(2) | F:COMBINED_SAMPLER | PASS(2) |
| composite1 | PASS(2) | PASS(2) | PASS(2) | – |
| composite2 | PASS(2) | PASS(2) | – | PASS(2) |
| composite3 | – | PASS(2) | PASS(2) | PASS(2) |
| composite4 | – | PASS(2) | PASS(2) | PASS(2) |
| composite5 | – | PASS(2) | PASS(2) | PASS(2) |
| composite6 | – | PASS(2) | F:COMBINED_SAMPLER | F:COMBINED_SAMPLER |
| composite7 | – | F:COMBINED_SAMPLER | PASS(2) | PASS(2) |
| deferred | PASS(2) | F:COMBINED_SAMPLER | – | – |
| deferred1 | PASS(2) | F:COMBINED_SAMPLER | F:COMBINED_SAMPLER | F:OTHER |
| deferred1_a | – | – | – | PASS(1) |
| dh_terrain | PASS(2) | F:COMBINED_SAMPLER | F:OTHER | F:OTHER |
| dh_water | F:OTHER | F:COMBINED_SAMPLER | F:OTHER | F:OTHER |
| final | PASS(2) | PASS(2) | PASS(2) | F:TOOL_BINDING |
| gbuffers_armor_glint | PASS(2) | PASS(2) | PASS(2) | PASS(2) |
| gbuffers_basic | PASS(2) | F:COMBINED_SAMPLER | PASS(2) | PASS(2) |
| gbuffers_beaconbeam | – | PASS(2) | PASS(2) | PASS(2) |
| gbuffers_block | – | F:COMBINED_SAMPLER | PASS(2) | PASS(2) |
| gbuffers_block_translucent | PASS(2) | – | PASS(2) | – |
| gbuffers_clouds | PASS(2) | PASS(2) | PASS(2) | PASS(2) |
| gbuffers_damagedblock | – | PASS(2) | PASS(2) | PASS(2) |
| gbuffers_entities | – | F:COMBINED_SAMPLER | PASS(2) | PASS(2) |
| gbuffers_entities_glowing | – | F:COMBINED_SAMPLER | PASS(2) | PASS(2) |
| gbuffers_entities_translucent | PASS(2) | – | PASS(2) | – |
| gbuffers_hand | – | F:COMBINED_SAMPLER | PASS(2) | PASS(2) |
| gbuffers_hand_water | PASS(2) | – | – | – |
| gbuffers_lightning | – | – | PASS(2) | – |
| gbuffers_line | – | – | PASS(2) | PASS(2) |
| gbuffers_particles_translucent | PASS(2) | – | – | – |
| gbuffers_skybasic | PASS(2) | PASS(2) | PASS(2) | PASS(2) |
| gbuffers_skytextured | PASS(2) | PASS(2) | PASS(2) | PASS(2) |
| gbuffers_spidereyes | – | PASS(2) | PASS(2) | PASS(2) |
| gbuffers_terrain | – | F:COMBINED_SAMPLER | PASS(2) | PASS(2) |
| gbuffers_textured | PASS(2) | F:COMBINED_SAMPLER | PASS(2) | PASS(2) |
| gbuffers_water | F:COMBINED_SAMPLER | F:COMBINED_SAMPLER | F:COMBINED_SAMPLER | F:OTHER |
| gbuffers_weather | PASS(2) | PASS(2) | PASS(2) | PASS(2) |
| prepare | – | – | – | PASS(2) |
| prepare1 | – | – | – | F:OTHER |
| prepare2 | – | – | – | F:OTHER |
| prepare3 | – | – | – | PASS(2) |
| prepare4 | – | – | – | F:ATOMIC |
| prepare4_a | – | – | – | PASS(1) |
| shadow | PASS(2) | PASS(2) | PASS(2) | F:OTHER |
| shadow (geometry stage) | – | – | – | **F:GEOMETRY** |
| shadowcomp | – | F:OTHER | F:OTHER | F:OTHER |
| shadowcomp1 | – | – | – | PASS(1) |
| shadowcomp1_a | – | – | – | F:ATOMIC |
| shadowcomp1_b | – | – | – | F:OTHER |
| shadowcomp2 | – | – | – | PASS(1) |
| shadowcomp_a | – | – | – | F:OTHER |
| shadowcomp_b | – | – | – | PASS(1) |

### Aggregates (all 756 programs, including per-dimension copies)

**Per pack**

| Pack | Total | Pass | Fail | Rate |
|---|---|---|---|---|
| Sildur's Lite | 126 | 120 | 6 | **95.2%** |
| BSL | 179 | 139 | 40 | **77.7%** |
| Complementary Reimagined | 219 | 180 | 39 | **82.2%** |
| Rethinking Voxels | 232 | 168 | 64 | **72.4%** |
| **All** | **756** | **607** | **149** | **80.3%** |

**Per stage**

| Ext | Total | Pass | Rate |
|---|---|---|---|
| `.vsh` | 358 | 325 | 90.8% |
| `.fsh` | 358 | 269 | 75.1% |
| `.csh` | 37 | 13 | 35.1% |
| `.gsh` | 3 | 0 | **0.0%** |

**Per pass type**

| Pass type | Sildur's | BSL | Complementary | Rethinking | All |
|---|---|---|---|---|---|
| gbuffers | 69/72 96% | 75/92 82% | 117/120 98% | 99/102 97% | **93%** |
| composite | 18/18 100% | 45/48 94% | 36/42 86% | 39/42 93% | **92%** |
| final | 6/6 100% | 6/6 100% | 6/6 100% | 0/6 0% | 75% |
| deferred | 12/12 100% | 6/12 50% | 3/6 50% | 8/12 67% | 69% |
| shadow | 6/6 100% | 6/6 100% | 6/6 100% | 0/9 0% | 67% |
| prepare | – | – | – | 15/30 50% | 50% |
| shadowcomp | – | 0/3 0% | 0/3 0% | 7/19 37% | 28% |
| dh_* (Distant Horizons) | 9/12 75% | 1/12 8% | 0/12 0% | 0/12 0% | 21% |

**The gbuffers path — the part you actually need to render a world — is at 93%, and at
96–98% for three of the four packs.**

### Independent cross-check

Every SPIR-V module produced was also fed to `spirv-cross --msl`:
**689 attempted, 689 succeeded (100%)**. The SPIR-V is well-formed and portable, not an
artifact that only naga tolerates.

---

## 5. Failure taxonomy

| Reason | Count | Class |
|---|---|---|
| `OTHER` (see breakdown) | 73 | tool-artifact / mechanical |
| `COMBINED_SAMPLER` | 49 | **mechanical** |
| `TOOL_SAMPLER_SPLIT` | 12 | tool-artifact |
| `TOOL_BINDING` | 6 | tool-artifact |
| `ATOMIC` | 6 | mechanical (naga gap) |
| `GEOMETRY` | 3 | **INHERENT** |

| Class | Count | % of 756 |
|---|---|---|
| Tool-artifact (my transformer / naga gaps) | 91 | 12.0% |
| Mechanical (documented rewrite exists) | 55 | 7.3% |
| **Inherent to WebGPU** | **3** | **0.40%** |

Where they died: 67 at GLSL→SPIR-V, 82 at SPIR-V→WGSL.

### 5.1 The one inherent failure: geometry shaders

`GEOMETRY x3` is **Rethinking Voxels' `shadow.gsh`**, the same file copied into `world0`,
`world1`, `world-1`. It is a real geometry shader:

```glsl
layout(triangles) in;
layout(triangle_strip, max_vertices = 6) out;
```

It does voxelisation: it re-projects each triangle onto its dominant-normal axis to
rasterise into a voxel grid, *and* emits the ordinary shadow triangle — two primitives from
one, with `bestNormalAxis` and `lowerBound` computed from **all three vertices** of the
triangle.

WebGPU has no geometry stage and no plan for one. **This is the only construct in 756
programs that WebGPU genuinely cannot express.**

It is not, however, unimplementable: 2× amplification can be emulated with an instanced
draw (2 instances, per-instance branch), and the whole-triangle data dependency can be
served by non-indexed drawing plus vertex-stage storage-buffer pulling of
`gl_VertexIndex/3` — WebGPU allows storage buffers in the vertex stage. That is a
**rewrite of the draw**, not a translation of the shader.

Measured absence of everything else WebGPU lacks — across all four packs, **zero** uses of:
`.tcs`/`.tes` files, `TESSELATION_SHADERS`/`TESSELLATION_SHADERS` feature flags,
`gl_ClipDistance`, `gl_CullDistance`, `gl_Layer`, `gl_ViewportIndex`, `gl_PrimitiveID`,
`gl_SampleMask`, `EmitStreamVertex`, `textureQueryLod`, `sparseTexture`, and **no `double`
/ `dvec` anywhere** (all 61 `double` hits were comment text and `block.properties`
`slab:type=double`).

### 5.2 Categories the prior analysis expected to be fatal — measured

| Category | Prediction | Measured |
|---|---|---|
| `COMPUTE` (`.csh`) | blocker | **Not a language blocker.** 13/37 compute shaders reached WGSL. Failures are naga SSBO-decoration gaps and workgroup-size limits, not "compute is missing". WebGPU has compute. |
| `SSBO` | blocker | WebGPU has storage buffers. Rethinking declares `iris.features.required = CUSTOM_IMAGES SSBO COMPUTE_SHADERS` — **all three exist in WebGPU**. The failures are naga frontend gaps (`Unknown decoration Restrict`, `unsupported storage class`), not WGSL gaps. |
| `TEXTURE_GATHER` | blocker | **Zero uses of `textureGather` in the entire corpus.** A non-issue. WGSL has `textureGather` anyway. |
| `EXTENSION` | possible blocker | 67 `#extension` directives, dominated by `GL_ARB_shader_texture_lod` (57). None caused a failure. |
| `TESSELLATION` | blocker | **Zero uses.** |

The "no compute, no SSBO, no image load/store, no `textureGather`" bullet in
`ARCHITECTURE.md` is accurate **for WebGL2** and was carried over to the WebGPU paragraph
where it does not apply.

### 5.3 The `OTHER` bucket, itemised

| Message | Count | What it really is |
|---|---|---|
| `'gbufferProjection'/'projectionMatrix' : redefinition` | 24 | **My bug** — injected a uniform the pack also declares |
| `'dhMaterialId' : undeclared identifier` | 21 | Distant Horizons attribute the host must inject; I did not implement it. Mechanical — this is the whole `dh_*` row |
| naga `Unknown decoration Restrict` / `unsupported storage class` | 18 | **naga SPIR-V frontend gap** on SSBOs, not a WGSL gap |
| `StorageImageWriteWithoutFormat` | 3 | naga gap; fixed by adding an explicit format qualifier |
| `voxel_sampler` / `lightColorsRGB` undeclared | 6 | pack-config-dependent include branches under my default `#define` set |
| `#define GL_CAVE_FACTOR` rejected | 1 | pack defines a macro starting with `GL_`; glslang rejects, OptiFine tolerates |

### 5.4 Honest limitation: regex is the wrong tool

The residual `COMBINED_SAMPLER` (49) and `TOOL_SAMPLER_SPLIT` (12) failures are **my
transformer's limits, not WebGPU's**. Both stem from needing scope awareness:

- a sampler passed to a user-defined function needs the *function signature* rewritten to
  take `(texture2D, sampler)` — Vulkan-GLSL forbids passing a sampler constructor, though
  **WGSL itself allows texture and sampler function parameters natively**;
- a local variable shadowing a sampler name must not be rewritten.

I got the pass rate from 4.5% → 73.7% → 80.3% purely by fixing my own transformer. Each
fix moved programs out of "fail" and none into it. **80.3% is therefore a lower bound, and
a loose one.**

This is itself the finding: **the transformation is mechanical but requires a real GLSL
parser, not pattern substitution.** Iris reaches the same conclusion — it uses
`glsl-transformer`, an ANTLR-based AST transformer. A serious port would use
[`glslang`'s AST], `naga`'s IR, or `glsl-transformer` directly.

I also tested naga's **GLSL frontend** as an alternative path (it splits combined samplers
itself). It is not viable: it rejects real input with `Not implemented: variable qualifier`.
The SPIR-V path is the only working one.

---

## 6. WebGPU resource limits — the actual arithmetic

Formats were parsed from each pack's `const int colortexNFormat = …` declarations
(including from inside comments), and every `DRAWBUFFERS:`/`RENDERTARGETS:` group in every
`.fsh` was costed — **all variants, including those behind `#ifdef`**.

### 6.1 Colour attachments — PASSES

Default limits: `maxColorAttachments = 8`, `maxColorAttachmentBytesPerSample = 32`.

| Pack | Distinct MRT groups | Max attachments | Max bytes/sample | Over limit? |
|---|---|---|---|---|
| Sildur's Lite | 6 | 3 | 16 | no |
| BSL | 29 | **6** | **32** | **no — exactly at the limit** |
| Complementary Reimagined | 23 | 5 | 24 | no |
| Rethinking Voxels | 15 | 5 | 28 | no |

Worst case, BSL `gbuffers_entities` writing `/* DRAWBUFFERS:018367 */`:

```
colortex0 R11F_G11F_B10F  4 B
colortex1 RGB8            4 B   (promoted to rgba8unorm)
colortex8 RGB8            4 B
colortex3 RGB8            4 B
colortex6 RGBA16          8 B
colortex7 RGBA16          8 B
                        ------
                         32 B  == maxColorAttachmentBytesPerSample (default 32)
```

**The prior claim — "its default `maxColorAttachmentBytesPerSample` (32 bytes) cannot even
hold eight `RGBA16F` targets" — is arithmetically true but vacuous. No pack in this sample
binds eight `RGBA16F` targets. The real maximum is six attachments at exactly 32 bytes.**

One caveat, checked: [DOC] when a `.fsh` has *no* `DRAWBUFFERS`/`RENDERTARGETS` directive,
Iris binds the first 8 buffers, which would cost 40–44 B/sample for all four packs — over
the limit. But the only directive-less fragment shaders in the entire corpus are
`shadow.fsh` and `final.fsh`, and **neither writes colortex** (`final` renders to the
backbuffer; `shadow` writes shadowcolor). A host that binds only what the shader declares
never hits this.

### 6.2 Texture formats — FAILS, and this is the real format problem

Several declared formats are **not colour-renderable in core WebGPU**:

| Pack | Buffer | Declared | WebGPU status |
|---|---|---|---|
| BSL | colortex2, 6, 7 | `RGBA16` | `rgba16unorm` **not in core WebGPU** |
| Complementary | colortex1 | `RGB8_SNORM` | snorm **not colour-renderable** |
| Complementary | colortex4 | `RGBA8_SNORM` | snorm **not colour-renderable** |
| Rethinking | colortex5 | `RGBA8_SNORM` | snorm **not colour-renderable** |
| all | `RGB8`, `RGB16F` | 3-component | not renderable; must promote to 4-component (costs bytes) |

These are gbuffer normal/material buffers written every frame. Substituting
`rgba16float` for `RGBA16` and `rgba8unorm` (with a manual ±1 remap) for the snorm targets
is possible but **changes precision and requires editing the pack's encode/decode maths**.
This is a more real obstacle than the attachment-bytes limit, and the prior analysis did
not identify it.

### 6.3 Compute limits — FAILS in specific programs

`maxComputeInvocationsPerWorkgroup` default = **256**.

| Declared workgroup | Invocations | Files | Verdict |
|---|---|---|---|
| `8, 8, 8` | 512 | 8 | **over** |
| `32, 32` / `32, 32, 1` | 1024 | 2 | **over** |
| `16, 16` | 256 | 3 | at limit |

Affected: `shadowcomp.glsl` in **BSL, Complementary and Rethinking** (not just the voxel
pack), plus Rethinking's `prepare4_csh`, `shadowcomp1`, `shadowcomp2`. Re-tiling
(8×8×4 with a z-loop) is mechanical but edits the pack.

`maxComputeWorkgroupStorageSize` default = **16384 B**. Declared `shared` totals (upper
bound: all `#ifdef` branches active, `MAX_LIGHT_COUNT = 512`):

```
complementary/program/shadowcomp.glsl      16 000 B   (just under)
rethinking/program/prepare4_csh.glsl       29 220 B   OVER
rethinking/program/shadowcomp1.glsl        37 548 B   OVER
rethinking/program/shadowcomp.glsl         38 828 B   OVER
```

At the `MAX_LIGHT_COUNT = 128` quality setting these fit; at 512 they do not.

### 6.4 Storage buffers — FAILS at high quality tiers only

`maxStorageBufferBindingSize` default = **128 MiB**. Complementary scales its
`COLORED_LIGHTING` buffer with quality:

```
bufferObject.0 =  50 855 936   ( 48 MB)  fits
bufferObject.0 = 114 229 248   (109 MB)  fits
bufferObject.0 = 202 899 456   (193 MB)  OVER default
bufferObject.0 = 456 130 560   (435 MB)  OVER
bufferObject.0 = 810 549 248   (773 MB)  OVER
```

Rethinking asks for only 5 000 192 B (4.8 MB) — fits easily. **The two lowest
Complementary tiers fit inside stock WebGPU limits.** This is a quality-slider problem, not
a wall.

### 6.5 Storage textures — PASSES

All declared 3D image dimensions are ≤ 512 per axis (limit `maxTextureDimension3D` = 2048).
All declared image formats map to WebGPU storage formats:
`rgba16f→rgba16float`, `rgba8→rgba8unorm`, `r32ui→r32uint`, `r32i→r32sint`,
`rgba16i→rgba16sint`. Rethinking's read-write `occupancyVolume` is `r32i`, which is inside
WebGPU's `read_write` storage-texture format set.

**Gap:** `imageAtomicOr/And/Add/Min` are used (20 call sites, **Rethinking only**, on
`iimage3D`/`iimage2D`). **WebGPU core has no texture atomics.** Workaround: move the voxel
grid into a storage *buffer*, where WGSL atomics are fully supported. That is a
data-structure rewrite of the pack's voxelisation, not a translation.

---

## 7. The runtime contract — where the work actually is

Sources: [shaders.properties](https://shaders.properties/) (official Iris docs),
[IrisShaders/ShaderDoc](https://github.com/IrisShaders/ShaderDoc),
[OptiFine `shaders.txt`](https://raw.githubusercontent.com/sp614x/optifine/master/OptiFineDoc/doc/shaders.txt).

**Uniforms.** [DOC] The docs do not state a total; counting the reference pages gives ~131
non-sampler uniforms (matrices 18, camera 18, player status 29, system 11, ID 10, world 16,
biome 12, rendering 17) plus 30–50 samplers ≈ **160–180**. Measured independently: the four
packs reference **170 distinct uniform names**. The "~200 uniforms" figure in the prior
analysis is about right.

The long tail is quirk-compatibility, and packs branch on it: `frameTimeCounter` wraps at
3600 s, `frameCounter` at 720719, `cameraPosition` wraps every 30000 blocks, the previous-frame
matrices are **zero-filled on frame 1**, `atlasSize` is 0 when unbound,
`currentSelectedBlockPos` is −256 when nothing is selected, `cloudHeight` is NaN in
dimensions without clouds, `heldItemId` is −1, and `entityId` is **0 if the properties file
is absent but 65535 if the entity is unlisted** — so a host that returns 0 unconditionally
is telling every pack "I don't support this".

**Render targets.** [DOC] `colortex0`–`colortex15` (raised to 32 in Iris 1.10.5+, exposed as
`MAX_COLOR_BUFFERS`); legacy aliases `gcolor`/`gdepth`/`gnormal`/`composite`/`gaux1-4` map to
0–7; `gdepth` is promoted to `RGBA32F` if the legacy name is used with no explicit format —
a quirk a host must replicate. Plus `depthtex0/1/2`, `shadowtex0/1` (+`shadowtex0HW/1HW`
under `SEPARATE_HARDWARE_SAMPLERS`), `shadowcolor0/1` (to 7 under `HIGHER_SHADOWCOLOR`),
`noisetex`, and the gbuffers-only atlases `gtexture`/`lightmap`/`normals`/`specular`.
Attachments are double-buffered (main/alt) with automatic ping-pong after each composite
pass, overridable per-pass via `flip.<program>.<buffer>`.

**Vertex attributes the chunk mesher must emit.** Measured usage across the four packs:

| Attribute | Sildur's | BSL | Comp. | Rethinking | Semantics [DOC] |
|---|---|---|---|---|---|
| `mc_Entity` | 15 | 11 | 3 | 3 | `.x` = block ID **from the pack's own `block.properties`**, −1 if unlisted |
| `mc_midTexCoord` | 3 | 11 | 8 | 7 | UV of the quad's texture centre (average of 4 vertices) |
| `at_tangent` | 6 | 7 | 6 | 6 | `.xyz` tangent, `.w` handedness |
| `at_midBlock` | 0 | 2 | 4 | 4 | offset to block centre in 1/64 block; `.w` = block light 0–15 (Iris 1.7+) |
| `at_velocity` | 0 | 0 | 0 | 0 | **unused by all four packs** |

(counts = files referencing). All four packs need the first three. `at_velocity` — called
out as a blocker in the prior analysis — is **used by none of them**.

This is the expensive part for McWebViewer specifically: `mc_Entity.x` needs a per-block-state
lookup against a *pack-defined* ID table (`block.properties`: Sildur's 53 rules, BSL 124,
Complementary 425, Rethinking 391), `at_midBlock` needs block-origin tracking through
meshing, and `at_tangent`/`mc_midTexCoord` need quad-level rather than vertex-level context.
None fall out of a greedy mesher for free. ShaderDoc gives the exact per-quad normal
(`normalize(cross(v2-v0, v3-v1))`, scaled by 127 and byte-packed) and tangent derivation to
match.

**Program fallback chain.** [DOC] Rooted at `gbuffers_basic`:
`gbuffers_entities → gbuffers_textured_lit → gbuffers_textured → gbuffers_basic`, with
`gbuffers_terrain`, `gbuffers_water`, `gbuffers_block`, `gbuffers_hand`, `gbuffers_weather`,
`gbuffers_particles` &c hanging off it. Composite-style stages (`begin`, `shadowcomp`,
`prepare`, `deferred`, `composite`, `final`) have **no fallback** — absent means skipped.

**Pipeline order.** [DOC] `setup → begin → shadow → shadowcomp → prepare → gbuffers(opaque)
→ deferred → gbuffers(translucent) → composite → final`. Compute is allowed in `setup`
(compute-only, runs at load/resize) and in all six composite-style stages, and runs *before*
the vertex stage in those passes. Compute is **not** allowed in `gbuffers` or `shadow`.

**`shaders.properties`.** Measured directive usage: `screen.*` (the config UI),
`uniform.*`/`variable.*` custom uniforms (**BSL 39, Complementary 29, Rethinking 23
expressions**), `image.*` (30 lines), `program.*.enabled`, `alphaTest.*`, `blend.*`,
`profile.*`, `texture.*`, `size.buffer.*`, `flip.*`, `indirect.*`, `bufferObject.*`.

The custom-uniform system is a genuine embedded expression language evaluated per frame —
e.g. `uniform.float.sunHeight = sin(2.0*pi * sunAngle)`, with `smooth()` (temporal, needs
history) and `if()`. Conditional-program expressions are real too:
`program.composite1.enabled = Bloom || Godrays || Volumetric_Lighting || Lens_Flares || Celshading || Fog`.
The settings UI is another scraper: options are declared as `#define` lines whose **trailing
comments** carry the allowed values (`// [1 2 3]`) and whose labels live in
`shaders/lang/*.lang`.

---

## 8. Judgement

**The previous conclusion — "cannot be run under WebGPU without a rewrite, and this is not a
close call" — is right about "rewrite" and wrong about "not a close call", and the specific
reasons given for WebGPU were largely wrong.**

What survives scrutiny:
- The corpus genuinely cannot be compiled as-is. **Measured: 0 of 756 programs compile raw.**
- The majority of the work is not shader code. **Confirmed and quantified in §7.**
- There is no "load the zip and it works" path. **Confirmed.**

What does not survive:
- *"WebGPU … still has no geometry/tessellation stages"* — true, but this costs **3 of 756
  programs (0.40%)**, all one file in one pack. Zero tessellation is used at all.
- *"its default `maxColorAttachmentBytesPerSample` (32 bytes) cannot even hold eight
  `RGBA16F` targets"* — vacuous. **No pack binds eight `RGBA16F`. Measured worst case: six
  attachments, exactly 32 bytes.**
- *"no compute shaders, no SSBOs, no image load/store, no `textureGather`"* — a **WebGL2**
  fact applied to WebGPU. WebGPU has all four. `textureGather` is used **zero** times.
- *"accepts only WGSL — no GLSL, no SPIR-V"* — true of the browser API, irrelevant as an
  obstacle: the translation is a build step, and it demonstrably works.

### Could a minimal Iris-compatible WebGPU pipeline run a subset of packs?

**Yes.** Scoped concretely:

**Tier 1 — works with a modest port.** Sildur's Vibrant Lite: **95.2%** of programs already
reach WGSL, no compute, no SSBO, no geometry, 3 attachments / 16 bytes worst case, all
formats mappable. This is a `#version 120` pack with `gbuffers → deferred → composite →
final` and a shadow pass. The remaining 6 failures are my transformer's, not WebGPU's.

**Tier 2 — works with passes degraded.** BSL (77.7%) and Complementary Reimagined (82.2%):
gbuffers at 82% and 98%. Needs `RGBA16`/`RGB8_SNORM`/`RGBA8_SNORM` format substitution
(precision-affecting), workgroup re-tiling for `shadowcomp`, and — for Complementary's
coloured lighting — pinning `COLORED_LIGHTING` to one of the two lower tiers so the SSBO
fits in 128 MiB. Disabling `shadowcomp` entirely costs coloured lighting but leaves the pack
renderable.

**Tier 3 — needs pack-specific rewriting.** Rethinking Voxels (72.4%): the shadow geometry
shader must be re-expressed as an instanced draw with vertex-stage storage-buffer pulling,
the voxel grid must move from image-atomics to buffer-atomics, and shared memory must drop
below 16 KB. Each is tractable; together they are a port of the pack, not of the loader.

**Not viable in any tier:** Distant Horizons integration (`dh_*`, 21% pass) — but that is a
separate mod's terrain system, irrelevant to a save-file viewer.

### What would need building

Ordered by cost, largest first:

1. **The runtime contract** (§7) — ~170 uniforms with their wrap/sentinel quirks, colortex
   allocation with ping-pong and `flip`, the program fallback graph, the shadow-pass camera,
   `block.properties`/`entity.properties`/`item.properties` ID mapping, the `shaders.properties`
   expression evaluator, and the settings-scraper UI. **This is the bulk of the work and it
   is unchanged by the WebGPU-vs-WebGL2 choice.**
2. **Chunk mesher changes** — emit `mc_Entity`, `mc_midTexCoord`, `at_tangent`, `at_midBlock`
   with per-quad context and pack-defined block IDs. For McWebViewer this means reworking
   the existing mesher, and `mc_Entity` couples it to the loaded pack.
3. **A real AST-based GLSL→WGSL transformer** (§5.4) — not regex. Reuse `glsl-transformer`
   (Iris's own), or drive `glslang`+`naga` as a build step. **This is the smallest of the
   three and is the only one the prior analysis treated as the blocker.**
4. **Per-pack fix-ups** — format substitution, workgroup re-tiling, quality-tier pinning.

### The specific construct that kills the general case

There is exactly one, and it kills only one pack's shadow pass: **the geometry shader**,
because WebGPU has no geometry stage and Rethinking Voxels uses one for conservative
voxelisation that needs whole-triangle context. Even that has a documented emulation path
(instancing + vertex-stage storage-buffer pulling), so it is a rewrite rather than an
impossibility.

**Nothing else in 756 programs is inherently un-portable.** The honest blocker is effort in
the host, not expressiveness in WGSL — and the effort is dominated by the ~170-uniform
runtime contract and the mesher, both of which the previous analysis correctly identified
but filed underneath a set of shader-language objections that the experiment does not
support.

---

## 9. What was built (2026-08-31)

The measurement above is no longer the end of the story: the pipeline described in §8 was
implemented. What follows is measured, not projected.

### 9.1 Sildur's Vibrant Lite: 21/21 programs translated

`npm run build-shaderpack -- .cache/shaderpacks/sildurs-lite` drives the same
GLSL → SPIR-V → WGSL toolchain as §1 and now reaches **21 of 21 programs (100%)** for this
pack, including the two Distant Horizons programs. That is above the 95.2% measured in §4,
and the difference is entirely §5.4's prediction coming true — every remaining failure was
in the transformer, not in WebGPU:

| Fix | Programs recovered | Class |
|---|---|---|
| CRLF line endings defeated every line-anchored regex, so **no `#include` ever expanded** | 8 | tool-artifact |
| `gl_`-prefixed names are reserved *including macro names*, so `#define gl_Vertex …` is rejected and the identifier survives to the parser | 6 | tool-artifact |
| The sampler rename must precede the `texture2D(` → `texture(` rewrite, or the emitted `#define texture …` eats every call it just created | 6 | tool-artifact |
| A uniform that is also used as a local must become a shadowable **global**, not a macro (`composite1` declares `uniform vec3 sunVec` and a local `vec3 sunVec`) | 1 | mechanical |
| `dhMaterialId` + the `DH_BLOCK_*` constants injected as host-supplied values | 1 | mechanical |

The last two are exactly the cases §5.3 and §5.4 named. The first three were mine.

**`npm run shader-audit -- .cache/shaderpacks/sildurs-lite.bundle.json`** prints this per
pass, with every skip's reason and class, and writes `out/shader-audit.json`.

### 9.2 The three inherent failures, named

These are the only constructs in the 756-program corpus that WebGPU cannot express, and
what a workaround costs. Naming them here so the ceiling is documented rather than
rediscovered:

| # | Where | Construct | Why WebGPU cannot | What a workaround costs |
|---|---|---|---|---|
| 1–3 | Rethinking Voxels `shadow.gsh`, copied into `world0`, `world1`, `world-1` — 3 files, one program | Geometry shader: `layout(triangles) in; layout(triangle_strip, max_vertices = 6) out;` performing conservative voxelisation, emitting **two** primitives per input triangle and computing `bestNormalAxis`/`lowerBound` from **all three vertices** | WebGPU has no geometry stage and no plan for one | Two independent rewrites, both of the *draw* rather than the shader: (a) the 2× amplification becomes an instanced draw with 2 instances and a per-instance branch; (b) the whole-triangle data dependency becomes a **non-indexed** draw plus vertex-stage storage-buffer pulling of `gl_VertexIndex/3`, which WebGPU permits. Cost is a per-pack port of the shadow pass plus giving up indexed drawing for it (roughly 3× the vertex fetch on shadow geometry). It is not a translation, and no generic loader can do it for you. |

Two adjacent hard limits that are *not* language failures but do bound the same pack:

- **Texture atomics.** `imageAtomicOr/And/Add/Min`, 20 call sites, Rethinking Voxels only.
  WebGPU core has no texture atomics. Workaround: move the voxel grid from an `iimage3D`
  into a storage *buffer*, where WGSL atomics are fully supported — a data-structure
  rewrite of the pack's voxelisation, not of its shaders.
- **Workgroup limits.** `shadowcomp` declares `8,8,8` (512 invocations) in BSL,
  Complementary *and* Rethinking against a 256 default, and Rethinking's shared-memory
  totals reach 38 KB against a 16 KB default at `MAX_LIGHT_COUNT = 512`. Re-tiling to
  8×8×4 with a z-loop is mechanical but edits the pack; the shared-memory overrun needs the
  quality tier pinned lower.

### 9.3 What the runtime does

`src/shaders/` implements the §7 contract on WebGPU:

- **~90 uniforms** in one shared std140 block, with the documented sentinels rather than
  zeros — `frameTimeCounter` wraps at 3600 s, `frameCounter` at 720719, `cameraPosition`
  every 30000 blocks, previous-frame matrices zero-filled on frame 1, and `entityId` 65535
  ("unlisted") rather than 0 ("no properties file"), because those mean different things.
- **colortex0-15 with main/alt ping-pong**, flipped after each pass that writes them, and
  the declared formats mapped through a substitution table that records every substitution.
  For this pack: 4 of 7 buffers are substituted, all of them 3-component promotions.
- **The program fallback graph**, so `gbuffers_terrain` resolves to `gbuffers_textured` in
  a pack that ships no terrain program — which is what Sildur's Lite does.
- **Pass order** `shadow → gbuffers(opaque) → deferred → gbuffers(translucent) →
  composite → final`, with composite-style stages skipped rather than substituted when
  absent.
- **The mesher emits the shaderpack attributes**: `mc_Entity.x` from the pack's own
  `block.properties` (53 rules here), `at_midBlock` in 1/64-block units, plus `vaUV2`
  lightmap coordinates; `mc_midTexCoord` and `at_tangent` are derived per quad at
  buffer-build time.

Two WebGPU frictions that §6 did not predict, both resolved:

- **Depth textures cannot be bound to `texture_2d<f32>`**, but packs declare
  `uniform sampler2D depthtex0;`. Resolved by blitting depth into an `r32float` copy after
  each stage that changes it, rather than rewriting every pack's depth reads.
- **`shadowtex0` is sampled both ways** — `sampler2D` in `gbuffers_textured`,
  `sampler2DShadow` in `deferred`. No single WebGPU binding serves both, so both a depth
  and an `r32float` copy are kept and the runtime picks per program from the reflected
  WGSL type.

### 9.4 Not verified on a GPU

**The runtime has not been executed.** No WebGPU device is reachable from this machine:
headless Chrome on macOS does not expose `navigator.gpu` (measured across four flag
combinations, both the bundled Chrome 152 and the system Chrome), headful Chrome cannot
attach to the window server from here, and the Node Dawn binding
(`@kmamal/gpu`) never resolves `requestAdapter` without an event pump it does not expose.

So §9.1's translation numbers are measured and §9.3's runtime is **written, type-checked
and lint-clean but unrun**. The honest status of a shaded screenshot is: not produced.
The path is `http://mcwebviewer.pow/?auto=1&shaders=sildurs-lite` in a browser that has
WebGPU; the page falls back to the WebGL renderer and reports the reason in the HUD when it
does not, and that fallback **is** verified — headless Chrome loads the bundle, reports
`this browser does not expose navigator.gpu`, and renders the world normally with no page
errors.

### 9.5 Known gaps in the runtime

- `shaders.properties` custom uniforms are parsed but **not evaluated**, so `framemod8`
  (`fmod(frameCounter, 8)`) and `BiomeTemp` (`temperature`) bind to zero. `framemod8` at 0
  makes the TAA jitter constant; the audit lists every uniform bound this way.
- `program.<name>.enabled` expressions are parsed but not evaluated, so conditional passes
  always run.
- No `setup`/`begin`/`prepare`/`shadowcomp` stages, and no compute. Sildur's Lite uses none.
- The shadow pass renders terrain only, and its orthographic frustum is centred on the
  world origin rather than on the camera.
- Entities and block entities are not drawn through the shader path; terrain only.
- The interleaved shaderpack vertex format is 120 bytes/vertex against the ordinary
  renderer's 48, so a full region costs roughly 2.5× the vertex memory.


---

## 10. Caveats

- **The 80.3% figure is a lower bound.** 12.0% of the corpus fails on my own transformer's
  limits (§5.4). Every fix I made moved programs into "pass" and none out.
- **Compilation is not execution.** A program reaching valid WGSL proves it is
  *expressible*; it does not prove it renders correctly. Nothing was executed on a GPU. Uniform
  values, texture bindings, blend state and pass ordering were not exercised.
- **One `#define` configuration per pack.** Packs have hundreds of settings; a different
  configuration selects different `#ifdef` branches and could surface constructs this run
  never compiled. The 6 `voxel_sampler`/`lightColorsRGB` failures are exactly this.
- **`shaders.properties` was parsed only for `image.*`.** Custom uniforms, `program.*.enabled`
  and profiles were read for the survey but not fed into the compile.
- **Shared-memory totals in §6.3 are upper bounds** (all `#ifdef` branches counted, worst
  `MAX_LIGHT_COUNT`).
- **naga 30.0.1 is one implementation.** Some failures (`Unknown decoration Restrict`,
  `unsupported storage class`, the SSBO-atomic `unreachable`) are naga frontend gaps, not
  WGSL limits. Tint may differ; it was not tested.
- **Four packs is a sample, not a census.** Chosen to span simple/mainstream/heavy, but
  Photon, Bliss, SEUS and Chocapic derivatives were not tested.
