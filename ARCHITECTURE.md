# Architecture & Decisions

Findings from the research phase, the decisions they led to, and — importantly — what
was rejected and why. Measured numbers throughout come from the reference world
(`minecraft-create121/data/world`, Minecraft 1.21.1 NeoForge, 128 mods, DataVersion 3955).

---

## 1. Prior art: what we evaluated and what we used

| Project | License | Verdict | Reason |
|---|---|---|---|
| **misode/deepslate** | MIT | **Borrowed approach, did not depend** | The closest fit by far: browser-safe `.mca` reader, NBT, block-model renderer. But it has no paletted-container decoder (the one genuinely algorithmic bit), rejects LZ4 and `.mcc` external chunks outright, and its `ChunkBuilder` enumerates all ~98k blocks of a column per rebuild. We'd have patched all three. Its `StructureProvider` seam is a good design and we mirror it. |
| **PrismarineJS/prismarine-viewer** | MIT | **Borrowed approach** | Node/socket.io-shaped, pinned to `three@0.128` (2021). Its mesher/atlas scripts are worth reading; the package is not worth inheriting. |
| **prismarine-provider-anvil** | MIT | **Rejected** | The only Prismarine package that reads `.mca`, but it is hard-bound to Node `fs`/`zlib`, handles only gzip/zlib, and converts the string palette into numeric `stateId`s via `minecraft-data` — a lossy, version-coupled round-trip. The Anvil palette already gives us exactly the string key that blockstate JSON wants. |
| **minecraft-data** | MIT | **Deferred to stage 3** | Not needed for saves (palettes are string-based since 1.13). Becomes unavoidable for the realtime client, where chunk packets carry numeric palettes. |
| **node-minecraft-protocol** | BSD-3 | **Rejected in browser** | Opens raw TCP via node `net`. Browsers cannot open TCP at all — architectural, not a polyfill gap. The realtime stage needs a WebSocket↔TCP relay regardless of library choice. |
| **Querz/mcaselector** | MIT | **Used as a format reference** | Its `CompressionType` enum is the clearest statement anywhere of the compression scheme, including the signed-byte external-chunk encoding (`-128..-124`). |
| **Amulet-Core / Amulet-Map-Editor** | **Proprietary** | **Rejected** | LICENSE reads "All rights reserved. A licence must be purchased to use this software." Not safe to read as a reference for code we ship. It also still cannot decompress LZ4 chunks. |
| **zardoy/minecraft-web-client** | MIT | **Borrowed approach** | Closest existing browser world viewer; self-described "maintenance only", and depends on a *fork* of prismarine-provider-anvil — which corroborates that upstream does not work in a browser. |
| **unmined / Chunker / chunkbase** | closed / MIT | **Rejected** | 2D map output or format conversion; neither is a 3D world viewer. |

**Conclusion:** no open-source, maintained, browser-native, block-model-accurate 3D
world viewer for 1.21 exists. The reusable parts are ideas, not packages. We wrote the
reader, baker and mesher ourselves; the only runtime dependencies are `three` and
`fflate`.

---

## 2. Save-file reading

### Region format
Standard Anvil: 4 KiB location table, 4 KiB timestamps, 4 KiB-aligned chunk payloads
prefixed with `u32 length` + `u8 compression`.

Two things that bite implementations, both handled in `src/core/region.ts`:

- **Compression is per-chunk, not per-file.** Changing `region-file-compression` on a
  server does not rewrite existing chunks, so one `.mca` can mix schemes. We dispatch on
  the byte every time.
- **Minecraft's LZ4 is not the LZ4 frame format.** Mojang writes it with lz4-java's
  `LZ4BlockOutputStream`: a sequence of blocks each with a 21-byte header (`"LZ4Block"`
  magic, method/level token, compressed length, decompressed length, XXH32). Every
  off-the-shelf LZ4 package decodes the *frame* format (magic `0x184D2204`) and will
  reject this. Our first implementation made exactly this mistake; it now parses the
  container itself and explicitly rejects a real LZ4 frame rather than producing garbage.
- Bit `0x80` on the compression byte means the payload lives in an external
  `c.<x>.<z>.mcc` file. We raise a typed `ExternalChunkError` rather than returning a
  silently empty chunk.

### NBT
`src/core/nbt.ts`, zero dependencies. Two performance decisions:

- **`TAG_Long_Array` is exposed as `Uint32Array` hi/lo pairs, not `BigInt64Array`.**
  Block-state palette unpacking is the hot path and BigInt is roughly an order of
  magnitude too slow. Palette entries are ≤12 bits, so 32-bit integer math suffices;
  `LongBits.getBitsAt` handles the case where an entry straddles the two 32-bit halves.
- **Strings take an ASCII fast path.** Essentially every key and resource location in a
  save is ASCII; the full Java modified-UTF-8 decoder is only used when a high bit
  appears.

### Chunk decoding
1.18+ layout: no `Level` wrapper, per-section paletted `block_states`/`biomes`, vertical
range from `yPos`. Since 1.16, packed entries never straddle a *long* boundary — porting
pre-1.16 unpacking gives output that looks almost right, which is the worst failure mode.

**Measured:** 24,227 chunks across 3 dimensions in 12.1 s (~2,010 chunks/s), zero
failures, all DataVersion 3955.

---

## 3. Assets

### Everything is a zip
Mod jars, the vanilla client jar and resource packs are all zips with the same
`assets/<ns>/...` layout, so one reader (`ZipPack`) serves all three and `PackStack`
resolves them in Minecraft's own precedence order (vanilla < mods < resource packs).
**This is why modded support largely falls out for free rather than needing per-mod code.**

The unzip filter keeps only `.json`, `.png`, `.png.mcmeta`, `.obj`, `.mtl` plus
`data/**/worldgen/biome/*.json`. Inflating the `.class` files across 128 jars would cost
seconds and hundreds of megabytes for nothing.

### Vanilla assets are fetched, never redistributed
Block models and textures live inside `client.jar`, *not* in the asset index (that holds
sounds and lang files). Mojang's EULA prohibits redistributing game files, so:
`npm run fetch-assets` resolves `piston-meta` → the 1.21.1 client jar into a gitignored
`.cache/`, and the shipped app expects the user to supply their own jar by drag-and-drop.
Nothing Mojang-owned is ever bundled or served from our origin.

### Model baking
`src/assets/model.ts` follows vanilla's pipeline exactly. The details that decide whether
stairs and fences line up or look subtly wrong:

- The vertex corner table is transcribed from vanilla's `FaceInfo`, and default UVs from
  `BlockElement.uvsByFace`. Corner order must match UV order or every rotated face is
  scrambled.
- `elements` do **not** merge along the parent chain — the nearest definition wins
  outright. Only `textures` merges.
- Element `rotation.rescale` scales by `1/cos(angle)` on the two perpendicular axes.
- `uvlock` counter-rotates UVs per face so stair/fence tops don't spin with the variant.
- Weighted variants are chosen from a **position hash**, not `Math.random()` — otherwise
  the world shimmers on every re-mesh.
### Deriving from the game instead of hardcoding

`render_type` is a NeoForge extension; vanilla resolves the render layer in Java
(`ItemBlockRenderTypes`) and ships no data file for it. The usual workaround is a
hardcoded block-name table — which is wrong for every modded block, and is exactly the
kind of thing that silently rots.

We deleted that table. The layers encode an *alpha* property, and the PNGs answer it
directly, so `src/assets/png.ts` reads the alpha channel out of the sprite and
classifies it:

| sprite alpha | render layer |
|---|---|
| no alpha channel / no `tRNS` | `solid` |
| on/off only (0 or 255) | `cutout` |
| any intermediate value | `translucent` |

A mod's explicit `render_type` still wins when present. Verified against vanilla's own
choices: stone/dirt/planks → solid; glass → cutout; stained glass, tinted glass, ice →
translucent; leaves, torch, iron bars, cobweb, short grass → cutout.

**Occlusion is derived the same way, and separately.** Whether a block hides its
neighbour depends on the six textures of its full-cube element, *not* on its render
layer. Keying off the layer gets one of these two wrong whichever way you choose:
grass_block lands in `cutout` (it has a transparent overlay element) but must still
occlude; glass is geometrically a full cube but must not. Reading the cube element's own
textures gets both right.

Two more things are now structural rather than listed:

- **Block-entity blocks** (chests, beds, signs, banners, skulls, decorated pots) are
  detected by their blockstate resolving to models with no `elements` at all — the
  signature of a particle-only model whose geometry lives in a `BlockEntityRenderer`.
  The audit's hand-written list was deleted; the structural rule reproduces it exactly,
  and generalises to modded block entities for free.
- **Mods that re-register a vanilla block under their own namespace** with the original
  id as the path (EasyAnvils ships `easyanvils:minecraft/damaged_anvil` and *no assets
  at all*) fall back to the vanilla blockstate.

**What remains hardcoded, and why:** the grass/foliage/water tint table. `tintindex` in
the model says a face *is* tinted but not *by what*, and vanilla's `BlockColors` handlers
are Java with no data-file equivalent. There is genuinely nothing in the game files to
read here. The table is small, explicit and commented as such.

### Code standards
ESLint enforces `complexity ≤ 10`, `max-depth 4`, `max-params 5`,
`max-lines-per-function 80`. Geometry code drifts toward one enormous function with a
dozen special cases; the limits force those cases into named, individually readable
helpers. `npm run lint`.

### Biome tint is fully data-driven
Grass and foliage colour come from sampling `colormap/grass.png` / `foliage.png` with the
biome's temperature and downfall; water comes from `effects.water_color`. All three live
in the biome JSON, which ships in the jar for vanilla **and for modded biomes**. So
Terralith / Incendium / Nullscape biomes tint correctly with zero per-mod work — 172
biome definitions resolved in the reference world. The one approximation is
`grass_color_modifier: swamp`, which vanilla drives from noise per-position; we use its
dominant constant and say so in the code.

---

## 4. Meshing and rendering

**Face culling, not greedy meshing.** Greedy meshing only merges identical axis-aligned
full faces. That describes terrain but not stairs, fences, or Create machinery — so a
greedy mesher still needs the per-block path for everything interesting, and the marginal
win over culling alone is modest. Culling is where the reduction actually is. Fixing the
full-cube test (see below) alone removed 36% of triangles.

Lighting is baked into vertex colours, matching vanilla: fixed directional shade
(down 0.5, up 1.0, N/S 0.8, E/W 0.6), stored block/sky light, and per-vertex AO from the
three neighbours touching each corner, including vanilla's diagonal flip when AO is
asymmetric.

**Streaming.** Meshing a whole region up front costs ~18 s and produces ~3.7 M quads that
are underground and never seen. Instead a work queue sorted by distance to the camera is
drained against an 8 ms/frame budget, re-sorted when the camera moves far enough.

### Four bugs worth recording, because each looked like something else

1. **Solid terrain rendered pure black while leaves looked correct.** The tempting
   diagnosis was lighting or winding. It was `flipY`: the atlas is built in canvas
   coordinates (y down) and sprite rects derive from those, but three.js defaults
   `Texture.flipY = true`, mirroring every sprite's V into the atlas's unused lower half
   and sampling fully transparent texels. Leaves survived only because they skip AO and
   happened to sit near the mirror line. *Reversing the winding "to fix it" made the
   solid layer vanish entirely — which is how we proved the winding was right all along.*
2. **`isFullCube` required exactly one element.** Grass blocks — and every modded block
   with a decorative overlay element — are a full cube *plus* extra geometry, so they were
   treated as non-occluding and the world's hidden faces stayed in the mesh. 1.85 M → 1.17 M
   triangles once fixed.
3. **Contraption quads were silently dropped.** The atlas is built from sprites reachable
   from the *terrain* palette, but contraption blocks exist only inside entity NBT and
   never appear in a chunk section palette. Their sprites were absent, so every quad hit
   `if (!sprite) continue`. Entity-contributed states must be collected before the atlas
   is built.
4. **Variant `y` rotation was inverted, and terrain looked perfect anyway.** Vanilla's
   `BlockModelRotation` rotates by *minus* y degrees about +Y, so `y:90` carries +Z to
   −X; our positions carried it to +X while the direction table rotated the other way.
   Symmetric blocks (stone, dirt, planks) are unaffected, so nothing looked wrong — but
   every asymmetric block with a variant `y` (furnaces, ladders, stairs, chests) was
   mirrored, *and* its cullfaces pointed at the wrong neighbour, so culling misbehaved
   too. Found by cross-checking against vanilla's quaternion rather than by looking at
   the screen. `src/assets/model.test.ts` now pins positions and face directions to
   agree for all 4×4 rotations, which is the invariant that was broken.

---

## 5. Modded content — the strategy, and the evidence for it

The brief asked specifically about "bytecode extraction from Java". Here is the honest
answer, with numbers measured from the actual 128 jars.

### What the assets already give you — more than expected

| Measured across all 128 jars | Count |
|---|---|
| Model JSONs | 39,439 |
| Blockstates | 8,843 |
| Models declaring a custom `loader` | 8,367, across only **13 distinct loaders** |
| Concrete `BlockEntityRenderer`s | 254 |
| Concrete `EntityRenderer`s | 77 |
| Classes emitting raw vertices | **55** — and ~20 of those are pass-through wrappers |
| GeckoLib `.geo.json` files | **1** |

**Create 6.0.10 contains exactly two classes that emit raw vertices** (`ChainConveyorRenderer`
for catenary chains, `ShadowRenderHelper` for entity shadows) out of 2,692 classes.
Everything else is JSON or OBJ geometry plus a transform. Create's "partial models" — the
319 models referenced by no blockstate — are ordinary JSON in the jar, loaded by
`AllPartialModels`; 206 match string constants in that class directly. Create also ships
39 Wavefront `.obj` files behind `{"loader":"neoforge:obj"}`.

So for Create specifically, **the geometry is declarative; only the animation transform
lives in Java.** ComputerCraft turtles are likewise 100% JSON (`turtle_base.json` has
literal `elements`; the `computercraft:turtle` loader merely composites base + upgrades).

### Bytecode parsing: rejected for renderers, viable only for entity models
- **BlockEntityRenderers cannot be statically analysed, ever.** A BER branches on block
  state, tick time, fluid contents, neighbours and item stacks. The geometry *is* the
  control flow.
- **Entity models are a different story.** Of 99 `LayerDefinition`-returning methods in the
  vanilla client, 91 are straight-line constant-only `CubeListBuilder` chains; MineColonies
  scores 94/94. A concrete mini-interpreter would work. But it is obsoleted by a JsonEM-style
  runtime dump that produces the same JSON more reliably.
- **What bytecode parsing *is* good for** is mining string constants (partial-model paths,
  model layer names). That is cheap and we used it during research.
- Every JS bytecode *executor* (doppio, CheerpJ) is version-locked below Java 21 and cannot
  run 1.21.1 classes anyway.

### The recommendation: assets first, offline capture harness for the remainder
Not "assets for 95% and accept gaps" — assets as the **runtime**, and an offline JVM
capture harness as the **generator** that fills what assets cannot express.

The capture harness is not speculative: **it is already implemented, for 1.21.1 NeoForge,
inside a jar in this very modpack.** `guideme-21.1.17.jar` ships
`guideme/scene/export/MeshBuildingBufferSource.class` — a `MultiBufferSource.BufferSource`
subclass whose own class doc reads "a buffer source we pass into the standard renderer to
capture all rendered 3D data in buffers suitable for export", alongside `SceneExporter`,
`RenderTypeIntrospection` and `SpriteFinder` (which maps captured UVs back to atlas
sprites — the part you would underestimate). It is LGPL-3.0 and feeds a *browser* viewer.

The idea works because **every renderer — vanilla, Create, AE2, MineColonies — must funnel
through `VertexConsumer`.** You do not need to understand the Java; you intercept the one
chokepoint. Two implementation notes from the research: supply a *non-flushing*
`MultiBufferSource` (vanilla's flushes mid-render on `RenderType` change), and force-disable
Flywheel instancing during capture, since Flywheel bypasses `VertexConsumer`.

**Where the GL boundary actually is:** model baking is pure CPU (`ModelBakery` already runs
on background workers), and `BER.render`/`EntityRenderer.render` write into `ByteBufferBuilder`
with no GL calls. The boundary is `RenderType#draw`. Booting the client, however, does
require a window — `Minecraft`'s constructor hard-calls `glfwCreateWindow`.

**Honest constraint, stated plainly: this harness cannot be run on this machine.** There is
no JVM installed, and the local Minecraft install is a *server* — `libraries/` contains only
`server-1.21.1-…jar`, which has no `net.minecraft.client` renderer classes at all. macOS has
no Xvfb/EGL path either. Running it means a windowed client on a desktop session, or Xvfb +
Mesa llvmpipe in a Linux VM. That is a real cost and it is why the harness is specified here
rather than shipped.

### Rejected: decompile-and-port
254 BERs + 77 entity renderers + 127 `CubeListBuilder` model classes, hand-translated to
TypeScript, re-broken by every mod update. Months of work, permanently stale, and strictly
less coverage than the capture harness.

### Shaderpack reuse: measured, and my first answer was wrong

An earlier draft of this document rejected shaderpack reuse outright. That verdict was
built from a capability table rather than an experiment, and the experiment contradicts
it. The full method, matrix and failure taxonomy are in **[SHADERPACKS.md](./SHADERPACKS.md)**.

Four real packs (Sildur's Vibrant Lite 2.01, BSL v10.1.3, Complementary Reimagined
r5.8.1, Rethinking Voxels r0.1-beta9) were downloaded, run through a reimplementation of
the Iris preprocessor (include resolution, define injection, `DRAWBUFFERS` parsing,
`colortexNFormat` scraping), and compiled **GLSL → SPIR-V → WGSL** with glslang 16.5.0
and naga-cli 30.0.1.

**Result: 607 of 756 programs (80.3%) produce valid WGSL. Of the 149 failures, exactly
3 — 0.40%, all one file — are inherent to WebGPU** (Rethinking Voxels' `shadow.gsh`, a
geometry shader, copied per dimension). Everything else is a mechanical rewrite or an
artifact of the transformer used for the test. The gbuffers path — the one that actually
draws the world — is **93%**, and 96–98% for three of the four packs.

Two specific things the first answer got wrong:

- *"`maxColorAttachmentBytesPerSample` (32 B) cannot hold eight `RGBA16F` targets."*
  Arithmetically true and completely vacuous: **no pack binds eight `RGBA16F`.** The
  measured worst case is BSL at six attachments totalling exactly 32 bytes. Nothing in
  the corpus exceeds the limit.
- *"No compute, no SSBOs, no image load/store, no `textureGather`."* Those are **WebGL2**
  limitations that I carried into the WebGPU paragraph. WebGPU has all four — and
  `textureGather` appears **zero** times across all four packs. There is also zero
  tessellation, zero fp64 and zero layered rendering in the corpus.

What the first answer got right: raw `#version 120` never compiles (measured: 0 of 756
at zero uplift), and the bulk of the work is the *runtime contract* — ~200 uniforms, the
colortex allocation and format table, the program fallback graph, the shadow pass, and
the `mc_Entity` / `mc_midTexCoord` / `at_tangent` / `at_midBlock` attributes that the
**chunk mesher** must emit — not the shader translation.

The real obstacles, which the capability table missed entirely, are narrower and more
specific: non-renderable formats (BSL's `RGBA16`, `*_SNORM` gbuffers in the other two),
10 compute shaders declaring more than 256 invocations per workgroup, Rethinking Voxels
wanting 29–39 KB of shared memory against WebGPU's 16 KB, Complementary's upper SSBO
tiers at 193–773 MB against the 128 MiB default (its lowest two tiers fit), and image
atomics, which have no WebGPU equivalent and would need moving to storage buffers.

**Revised judgement:** a WebGPU implementation of the Iris pipeline could run a
meaningful subset of real packs — Sildur's-class almost entirely, BSL and Complementary
with some passes degraded — and the 80.3% figure is a *lower* bound, since 12% of the
corpus failed on the test transformer's own limits rather than WebGPU's. It remains a
large project, and it is a host-implementation project rather than a shader-porting one.
But "not viable" was not supportable, and I should not have written it.

---

## 5b. Entity geometry: extracted from the jars with a real JVM

The brief's premise was that entity geometry needs a running client. It does not — and
this is the single most useful thing found. Vanilla and most modded entity models are
**declarative data built by static factory methods**: `public static LayerDefinition
createBodyLayer()` assembles a `MeshDefinition`/`PartDefinition` tree via
`CubeListBuilder.create().texOffs(u,v).addBox(...)`. That is pure CPU — no OpenGL, no
`Minecraft.getInstance()`, no display, no account, no mod loader.

`harness/` does exactly that: JDK 21, the official Mojang ProGuard mappings, an ASM pass
that deobfuscates the client jar (necessary because **mod jars are compiled against
Mojang names and cannot link against `fuz`** — this one step is what made the modded
entity types reachable), then reflection over every class exposing a `LayerDefinition`
factory.

**Measured: 222 factories found, 213 invoked, 426 models, 5,957 cubes** — vanilla
100/99, MineColonies 95/94, Friends&Foes 8/8, and singles from AE2, Comforts, Wizards,
Create Submarine. The 10 failures are all understood and recorded in
`extract-report.json`: 5 mod classes want NeoForge classes that are not on the classpath,
2 want Registrate, 2 are JsonEM mixin accessors, and `MaleDruidModel` hits an
`IllegalAccessError` on a constructor NeoForge patches to public at runtime.

**The coordinate transform is the part that is easy to get subtly wrong.**
`LivingEntityRenderer.render` composes `mulPose(YP.rotationDegrees(180 - yBodyRot))`,
`scale(-1,-1,1)`, `translate(0,-1.501,0)`, and `ModelPart.Cube` divides by 16, giving

```
(x, y, z) model units -> (-x/16, 1.5 - y/16, z/16), then yaw by (180 - Rotation[0])
```

The tempting simplification `(x/16, (24-y)/16, z/16)` differs by exactly 180° of yaw and
leaves **every mob facing backwards** — which is invisible on symmetric models and
obvious on none of them until you check. It was caught by rendering a cow at yaw 314.7°
and a creeper at 180.9° from a known camera and confirming which one shows its face.

Result: **34 of the 37 previously-unrenderable entity types now draw**, including the
modded ones, from geometry that was never JSON.

## 5a. Block-entity geometry: authored, not guessed

~15 vanilla blocks (chests, beds, signs, banners, skulls, decorated pots, shulker boxes)
ship a *particle-only* model — their geometry is built in Java by a `BlockEntityRenderer`.
In the reference world that is 57 distinct block states rendering as nothing.

`src/render/ber-models.ts` closes that gap by synthesizing those models as ordinary
`RawModel`s, so they flow through the existing baker unchanged. The numbers are not from
memory: with no JVM available, the constants were read out of `client-1.21.1.jar` by
parsing the class files' constant pools and walking the `ldc` sequences of the relevant
layer-definition methods. Every value is commented with the obfuscated class it came from
(`ghf` ChestModel, `ggw` BedModel, `ggu` BannerModel, `ghn` SignRenderer, and so on).

That process corrected two things that would have been wrong from memory:
- vanilla's `ModelPart.Cube` unwrap puts **`down` in the first u-slot and `west` (not
  `east`) at `u … u+d`**, with `up`'s v running backwards — verified against the actual
  pixels of `chest/normal.png`, whose lid underside and planked top land in the slots the
  corrected unwrap predicts;
- chest `type=left`/`right` were resolved by finding which face slot is *blank* in
  `normal_left.png` / `normal_right.png` (the blank slot is the seam), not guessed.

Rather than hand-deriving the corner→UV permutation per face, the builder matches vanilla's
vertex order against our `FACE_CORNERS` geometrically and solves for `(uv, rotation)`,
emitting a face only when all four corners match exactly. Any face that appears is
therefore per-corner identical to vanilla.

Documented approximations (all commented in-file): banner and shulker dye tints are not
applied (no per-block tint channel yet), pot sherds use the plain side sprite,
piglin/dragon heads use the generic head box, hanging-sign diagonal chains use the
axis-aligned plate, and animation state (chest lid angle, banner wobble) is dropped.

This is the pragmatic complement to the capture harness, not a replacement for it: it
covers vanilla's fixed set cheaply and exactly, while the harness is what scales to
arbitrary modded block entities.

## 6. Known gaps and approximations

Stated explicitly rather than buried:

- **3 entity types still draw nothing**: `minecraft:item`, `minecraft:item_frame`,
  `minecraft:painting`. None has a `LayerDefinition` — items render an item model, item
  frames render a block model, and paintings are a flat quad from the `PAINTING_VARIANT`
  registry (the harness extracted all 50 variants with sizes and textures; they are just
  not wired up). Plus 3 billboard-style modded entities (`create:super_glue`,
  `aeronauticsdiscovery:pin`, `simulated:honey_glue`).
- **Entities render in bind pose.** `setupAnim` is not replayed, so a spider's legs stay
  horizontal and a llama's chest cubes are always visible. Secondary layers (sheep fur,
  armour, saddles) are separate `LayerDefinition`s and are not drawn.
- Modded block entities with Java geometry are classified correctly by the audit but are
  not synthesized — only vanilla's set is. The capture harness is the general fix.
- Animated textures upload every frame but the mesher only uses frame 0 — no UV scrolling yet.
- No mipmaps (NEAREST filtering only). Faithful up close, shimmery at distance.
- `grass_color_modifier: swamp` uses a constant instead of vanilla's positional noise.
- Fluids are classified and excluded from the unhandled count but do not yet generate
  geometry — vanilla's `LiquidBlockRenderer` (corner-height interpolation, flow UVs) is
  not implemented.
- Contraption rotation applies `Angle` about `Axis`, which is right for bearing-style
  contraptions; carriages follow a spline and would need more.
- `Contraption.Anchor` decoding does not match observed values, so it is range-checked and
  dropped rather than reported wrongly. It is informational only — rendering uses `Pos`.

---

## 7. Live view and remote control (stage 3)

Two separate questions that get conflated. Live *view* is easy and needs no accounts.
Live *control of a player* is gated by authentication, not by anything technical.

### Live view — three options, ranked by cost

**1. Poll the region files (+ RCON `save-all flush`).** No accounts, no protocol work,
and it reuses everything already built. The catch is that a running server buffers chunks
in memory and only writes them on autosave, so the files lag reality; RCON (already
enabled on this server, port 25575) can force a flush. Gives a near-live view at, say,
30–60 s granularity. Entities live in `entities/*.mca` and flush the same way. Cheapest
possible answer, and genuinely useful for a map view.

**2. A headless bot as a camera.** A Node service runs `mineflayer`, holds the TCP
connection, and streams chunk and entity packets to the browser over WebSocket. This is
exactly `prismarine-viewer`'s architecture and gives true real-time view including other
players moving. Costs **one** Minecraft account. This is the recommended path.

**3. A server-side NeoForge mod pushing deltas over WebSocket.** Best fidelity and lowest
latency — no second protocol client, no bot occupying a player slot. Costs writing and
installing a mod, and a server restart.

### Remote control — the blocker is NeoForge, not `online-mode`

An earlier draft of this document said the constraint was authentication. That was
wrong, and the correction matters: **a protocol-level client cannot join this server at
all**, regardless of accounts.

**Blocker 1 — the configuration phase.** NeoForge patches
`ServerConfigurationPacketListenerImpl.startConfiguration()` to send
`ModdedNetworkQueryPayload` (channel id `neoforge:register`) and a ping, and withholds
everything vanilla until the pong arrives. A client that does not identify as NeoForge
falls into `NetworkRegistry.initializeOtherConnection()`, which negotiates the server's
registered payloads against an empty client list:
`NetworkComponentNegotiator.negotiate()` discards components marked `.optional()` and
fails if any required one remains. `PayloadRegistrar` defaults to *required*. So a
vanilla/JS client is admitted **iff every payload registered by every mod opted into
optional** — true for some server-side-only packs, false for this one.

Forging the query reply is theoretically possible but needs every mod's channel id and
registrar version, then servicing `SyncRegistries`, `CommonVersionTask`,
`CommonRegisterTask`, `SyncConfig`, `RegistryDataMapNegotiation`, `CheckExtensibleEnums`
and `CheckFeatureFlags` — invalidated by any mod update.

**Blocker 2 — modded block state ids are unrecoverable, and this one is fatal.**
`neoforge:registry_sync` sends a `RegistrySnapshot`, which is an
`Int2ObjectSortedMap<Identifier> ids` plus aliases: registry-object ids only. It says
`1729 -> create:mechanical_press`; it does not say that block has 8 states or what its
properties are. NeoForge assigns state ids in `NeoForgeRegistryCallbacks.BlockCallbacks.onBake()`
by flattening `(block in registry-id order) × getPossibleStates()`. The second factor is
compiled Java in the mod jar. So even with a perfect registry-sync parser every prefix
sum is wrong, and vanilla blocks are shifted too because modded blocks interleave.
`prismarine-viewer` and `minecraft-web-client` inherit exactly this problem.

So the mineflayer backend was **removed**, not kept behind a flag. It could never work
against this pack, and a backend that cannot work is worse than no backend: it invites
someone to spend an evening finding out what this section already knows.

### What actually works here: RCON as a READ-ONLY observer, save files for the view

The first version of this tier drove a server-side **fake player** over RCON, with
`/player <name> spawn|move|turn|attack`. That is fabric-carpet's syntax, backed by
`EntityPlayerMPFake.createFake()` — `PlayerList.placeNewPlayer` with a
`FakeClientConnection` and an offline UUID, which yields a first-class player that ticks,
loads chunks and is seen as real by Create, AE2 and MineColonies. On NeoForge 1.21.1 the
equivalents are SiliconeDolls and Carpet: NeoForged.

**SiliconeDolls is now installed on the reference server** (with its dependency
RollingGate, both pinned `side = "server"` so the client pack does not carry them), and the
path works: pressing Join in the browser spawns a player, WASD moves it, and the camera
follows. Before that it was not installed and every one of those commands failed at
runtime. (NeoForge's own `net.neoforged.neoforge.common.util.FakePlayer` is *not* this —
it is an attribution token with a stubbed connection, never added to the `PlayerList`, so
it does not tick and is not visible. It would not have helped.)

Three things only showed up by running it against the real server, and all three fail
silently rather than loudly:

1. **SiliconeDolls is not carpet-compatible.** `move` with no direction is rejected (it
   stops with `stop`), the hotbar is 1-based, and there is no absolute-angle look — `turn`
   is relative and `look` takes only `at <pos>` or a compass direction. So the bridge
   models the bot's rotation, sends deltas, and re-anchors from the real `Rotation` each
   poll.
2. **`list` lower-cases the name.** `/player WebViewer spawn` produces a player the roster
   reports as `webviewer`. A case-sensitive match never fires, and presents only as "the
   camera does not follow".
3. **Vanilla RCON cannot be pipelined.** Its `RconClient` handles one request per pass
   over a fixed buffer; two commands in one TCP segment make it mis-parse and close the
   socket. The player poll issues three `data get`s per player, so this appeared *only
   once there was a player to poll* — the bridge was rock solid on an empty server and
   dropped RCON every few seconds the moment a bot joined. `RconClient.command()` now
   serialises; there is a test that fails if that regresses.
4. **The same 180° of yaw as the entity transform above, made a second time.** The browser
   sends three.js angles, where a camera at yaw 0 looks down **-Z**; Minecraft's yaw 0
   faces **+Z**. Solving the two facing vectors for one heading gives `Y = 180 - y`, which
   is exactly what `entityYawDeg()` has always used to *draw* a player — but the bridge's
   `look()` converted with `Y = -y`, so the body it *drove* faced the reverse of the
   camera. Every direction was mirrored: W walked backwards, A strafed right, and the
   crosshair pointed at the block behind you. Nothing failed; the world simply disagreed.
   Measured on the live server: camera facing `(0,0,-1)`, `W` moved the bot `+3.7` on Z —
   a dot product of `-1.000`. Now one exported `mcRotation()` owns the conversion and the
   test asserts direction vectors rather than numbers, because "is it `-y` or `180 - y`"
   is a question two wrong sides can agree on and a heading cannot.

   The other half of it: the bot spawns facing whatever the server chose, and the browser
   only spoke on the first mouse *move*. So even with the conversion right, a player who
   pressed W before touching the mouse walked off on an unrelated heading. `LiveControls`
   now pushes its look the moment controls bind.
5. **One RCON connection is not enough once anything is allowed to be slow.** `save-all
   flush` takes 1–7 s and blocks its connection for all of it, so a Join or a keypress
   queued behind one and exceeded the 8 s command timeout. Playing and live block updates
   appeared to be mutually exclusive; they were not, they were sharing a pipe. Control now
   has its own connection — vanilla handles each on its own thread with its own buffer, so
   this is not the pipelining hazard that two in-flight commands on *one* connection are.
   Five consecutive Joins with flushing at its 5 s worst case: 51–55 ms.
6. **Every control the play path bound was one a phone cannot produce.** Pointer lock does
   not exist on touch and there is no keyboard, so tapping Join on a phone gave a HUD and a
   frozen view — while the *fly* camera had had touch controls all along. The play path now
   has the same two gestures.
7. **Pointer lock is not guaranteed, and mining and placing were gated on it.** Chrome
   refused it here with `WrongDocumentError`. A refused lock therefore removed the entire
   mouse: no look, no mine, no place. Look falls back to drag; mine and place no longer ask
   about the lock at all, and an unlocked left press resolves drag-versus-click.
8. **Space activates a focused button, and Space is jump.** Clicking Join leaves it
   focused, so the first jump re-pressed Leave and despawned the bot. It presents as "I
   cannot jump". The button hands the keyboard back on click.
9. **Removing the queue created a race.** With control on its own connection, the rotation
   poll and a `turn` genuinely overlap. A read issued before a turn and answered after it
   describes the bot *before* it; anchoring the model to that rewinds it, and since the
   browser holds an ABSOLUTE angle the next look re-sends a delta the server already
   applied. Measured as a unit test: **180° of turning for a 90° target**, then oscillation
   — which is what most of "turning and hitting disagree" actually was. Turns now carry a
   sequence number and a read that raced one is discarded; a read that did not is still
   applied, so a dropped turn is still corrected. Measured after: 0.1–0.4° of disagreement
   during a continuous sweep, 0.2° settled.

   Worth stating plainly, because it generalises: **fixing head-of-line blocking converts
   ordering you were relying on into ordering you have to establish.** The shared pipe was
   not making the model correct, it was making the race rare.

Every one of 4–8 presented identically — "the controls do nothing" — and none of them was
reproducible on a headless harness. That is why live mode now prints an input diagnostic
that counts each layer between a keypress and the server separately; see the README. The
lesson is the one this file keeps relearning: when a failure is silent, the fix is not only
to correct it but to make its absence *visible*.

The path is kept, but it is **off by default and it proves itself before it is trusted**
(`bridge/src/fake-player.mjs`). `MCWV_FAKEPLAYER_ENABLE=1` only permits an attempt; on
start the bridge issues the spawn command once and reads the reply. A Brigadier server
without the mod answers `Unknown or incomplete command`, and the control path then marks
itself unavailable, refuses every subsequent control message, and reports the server's own
words to the browser — which binds no controls at all and puts the reason in the HUD.

That gate is the design, not a detail. The version before it bound WASD, mouse-look, dig
and place unconditionally, so on this server the page looked playable, accepted input, and
silently dropped it. "Controls that do nothing" is a worse failure than "no controls",
because only one of them tells you what is wrong. Verified both ways against the live
server: with the real command it reports UNAVAILABLE and the fly camera keeps the input;
with the templates pointed at a command the server does have, controls bind, the HUD reads
`PLAYING as WebViewer`, and intents reach the wire on change only.

Underneath that, what a stock server can be asked for without installing anything:

| what | how | cost |
|---|---|---|
| live players | `list`, then `data get entity <name> Pos\|Rotation\|Dimension` | 4 cheap commands/s |
| live blocks | `save-all flush`, then re-read the region files | **a save on the tick thread** |

With the control path off — the default, and the reference server's state — the bridge
accepts no commands from the browser, the camera is local, and the only write the whole
system makes to the server is `save-all flush`.

#### RCON reachability without touching the server

`enable-rcon=true`, port 25575 — but the Minecraft compose file does not publish that
port, so from the host it is `ECONNREFUSED`. Publishing it means editing and restarting a
server a turtle fleet lives in.

Instead the bridge container joins the Minecraft stack's own Docker network
(`minecraft-create121_default`, declared `external`) and dials `mc:25575`. The change is
entirely on this project's side; the Minecraft server's config, image and uptime are
untouched. Verified by `nc -z mc 25575` from a throwaway container on that network, then
by a real RCON auth + `list`.

#### The flush is the dangerous part, and it is treated that way

`save-all flush` runs on the server tick thread. On this server that thread is also what
ComputerCraft computers tick on, and the settlement has already been lost once to a host
under load: the tick thread stopped getting scheduled, the watchdog fired at exactly
60,000,000 µs, and CC:T killed a long-running computer mid-write. A fixed-cadence flush
held through a struggling server is a way to reproduce that.

`bridge/src/flush-timer.mjs` therefore encodes five properties, each with a test:

1. **off unless `MCWV_FLUSH_ENABLE=1`** — the default configuration never flushes;
2. **only while a viewer is connected**, armed by the first WebSocket client and disarmed
   by the last, with the first flush one full interval *after* connect so a reconnect loop
   cannot become a flush loop;
3. **a hard 2 s floor** that configuration cannot lower;
4. **self-backing-off** — a flush slower than `MCWV_FLUSH_SLOW_MS` (or one that fails)
   doubles the interval and logs it, up to 120 s;
5. **slow recovery** — the interval halves back only after five consecutive fast flushes,
   so an intermittently slow server settles at the slower cadence instead of oscillating.

Measured on the reference server: an idle `save-all flush` answers in ~130 ms, the first
flush after a quiet period in 1–3.5 s. The back-off fires on that first one routinely,
which is the intended behaviour, not a bug.

#### Re-reading the world without re-reading the world

A region file is 5–15 MB and the reference region meshes ~1,360 sections. Re-fetching and
re-meshing it every few seconds is not a live view.

The Anvil header does the first cut for free: bytes `[4096, 8192)` are a per-chunk
timestamp table that Minecraft rewrites on every save. So an HTTP **Range request for the
first 8 KB** identifies the handful of changed chunks, and a second Range request fetches
only their sectors (`parseRegionHeader` / `decodeChunkPayload` in `src/core/region.ts`).
The location table is compared as well as the timestamp, because two saves inside one
second share a timestamp but rarely share a sector layout.

The second cut is `diffSections`: a chunk column has ~24 sections and a turtle stepping
one block changes one or two of them. Both the old and new columns are interned into the
same global palette, so comparing the `Uint16Array`s is a comparison of block states.
Changed sections plus their six neighbours (face culling reads across section boundaries)
go into a dirty set that is drained on a per-frame budget.

Measured on the deployed viewer: an idle poll costs 8 KB; a poll that found changes
re-meshed 17–55 sections in 23–174 ms.

#### The honest limits

Granularity is the flush interval, so this is seconds, not 20 tps. **Only blocks update** —
mobs and items are read from the entity regions at load and never refreshed, so a turtle
moving appears and a cow walking does not. Live players come from RCON and do update, but
in bind pose and always as Steve. And a full-fidelity modded client in a browser remains a
*streaming* problem (Sunshine + a web Moonlight client, or Selkies), not a protocol one.

### What the current code already gives this

The renderer is fed by a `World` holding a global palette, and `meshSection(cx, cy, cz)`
is independent of where the chunks came from. A live path replaces "read a region file"
with "apply a chunk packet" and marks sections dirty; the mesher already emits plain
typed arrays, so moving it into a worker is a transfer-list change, not a rewrite.

### Principal risks

- **Numeric palettes return, and they are mod-specific.** Network chunk packets are not
  string-keyed, so a registry mapping becomes a hard dependency — and with 128 mods the
  vanilla `minecraft-data` table is useless. The real registry is sent during login and
  must be captured from there.
- ~~**Incremental re-meshing does not exist yet.**~~ Resolved: `diffSections` +
  `invalidatedSections` in `src/app/region-sync.ts` re-mesh only the sections that
  differ, plus their culling neighbours.
- **A bot occupies a player slot** (`max-players=20`) and is visible in-game — it is a
  real player, not an invisible observer. This applies only when the fake-player path is
  enabled AND the mod is present; with it off, the observer joins nothing and is invisible.
- **The flush costs the server, not the viewer.** Everything about the live block path is
  paid on the Minecraft tick thread. That is why the guard in `flush-timer.mjs` is the
  most heavily tested code in this repo.
- **Modded packets are opaque.** Create, AE2 and CC:T all send custom payloads; anything
  needing their client state (contraption motion, turtle animation) is per-mod protocol
  work with no shared spec.
