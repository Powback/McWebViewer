# McWebViewer — parity inventory

What this browser client still gets wrong compared to a real modded Minecraft client, with a
measured count for each gap against the reference world (a 130-mod NeoForge 1.21.1 server,
~800 loaded chunks, ~700 live entities, 28.6M placed block cells).

**Read the three categories as genuinely different claims.** Blurring them is how an audit
starts lying:

- **Wrong here** — a real gap, with a count you can check.
- **Wrong in general, zero here** — handled by accident. These are **not** parity wins. A
  different world breaks them on the first frame.
- **Correct** — actually right, with the evidence that shows it.

Every number below was measured against the running world or extracted from the running
game. Nothing here is an estimate unless it says so.

---

## 1. Wrong here

### 1.1 Entities that do not draw — fixed; nothing reachable remains

**Root cause, one defect behind every symptom.** Both the entity extraction and the atlas
bake were driven by a *snapshot of which entity types the world contains* — a stale
`out/audit.json` for the extraction, a region scan for the bake. Which mobs a world contains
is not a property of the world; it is a property of the moment you looked. A type missing
from the snapshot got no texture in the atlas and drew nothing, unfixably at runtime.

Three inputs replaced a snapshot with something complete:

- **The bake** now covers every entity type the extraction knows (135, was 33), and the
  bundle records what it *has textures for* rather than what was scanned. That second half
  also stopped the baker thrashing: the staleness check compared scanned types against the
  live world, so the bundle was permanently stale and re-baked every 30 seconds.
- **The extractor's modded list** now comes from every entity a mod *declares*, read from its
  own `assets/<ns>/lang/en_us.json` — a mod must name its entities there or they have no name
  in-game, which makes it complete and offline. 141 ids, where the audit knew 37. The index
  went 135 rows to 270. This exposed a latent NPE that had been unreachable while every id
  happened to resolve: an unresolved entity has no renderer, and writing the index died on
  it, losing the whole file.
- **Variant-textured mobs** get their coats extracted from the running game. Cats and frogs
  work like wolves, but their variants are a built-in registry rather than a datapack, so
  there is no JSON to read. `geometryFor` also had to stop refusing a type whose index
  texture is null — otherwise a cat was rejected before any appearance rule could give it
  the right coat.

**Result, measured the same way as before**: `java-model` went from 102 to 66 of the live
census. 63 of those are `minecraft:item`, which draws through the dropped-item path, and the
remaining 3 are item frames, which draw through it too (see the correction below). **Nothing
in the live census is dark**, down from 39.

| | was | now |
|---|---|---|
| `friendsandfoes:glare` | 28 dark | drawn |
| `friendsandfoes:crab` | 5 dark | drawn |
| `minecraft:item_frame` | 3 dark | drawn — frame model and contents, see §3 |
| `minecraft:cat` | 2 dark | drawn, correct variant |
| `minecraft:cave_spider` | 1 dark | drawn |

**A correction, and then a correction to the correction.** The three `minecraft:item_frame`
classify as `java-model`, but `renderKind` short-circuits item frames before it consults
`classifyEntity`, so the framed stack was already drawing. I reported that as "the gap did
not exist" and filed the frame itself as too small to bother with, on the strength of the
sentence *"no entity model by design"*.

That sentence is true and does not imply what I used it for. An item frame has no
`EntityModel` **and an ordinary block model** — `blockstates/item_frame.json` selects
`block/item_frame` or `block/item_frame_map` by its `map` property, and vanilla's
`ItemFrameRenderer` draws it with `renderSingleBlock`. Every piece was already here: the
blockstate resolver, the mesher, the textures. Only the wiring was missing, and it is now
built (§3).

It is worth naming the shape of the error, because it is the second time: **a classification
label stood in for observed behaviour.** The same mistake produced "63 dark `minecraft:item`"
earlier, which draw perfectly well through the dropped-item path. A label answers "which code
path is this routed to", never "does anything appear on screen".

**The axolotl format string is fixed.** `minecraft:entity/axolotl/axolotl_%s` was a format
string the renderer expands per variant, recorded by the extractor as if it were a file — one
permanently unfindable sprite in every atlas, and an axolotl that would draw nothing. Texture
collection now rejects any path containing `%`, and the axolotl's five variants are extracted
from the `Axolotl.Variant` enum (name for the texture stem, declared order for the id its NBT
stores) into the same variant table cats and frogs use. **The atlas now reports 0 missing
sprites**, down from 1 — a second template, `minecraft:entity/tracer_glow%d`, surfaced from a
mod renderer during the same fix and is covered by the same guard.

### 1.2 Modded collision shapes were never extracted

**Count:** `physics.json` holds 18,698 block-state rows and **zero** are modded — the
extraction harness boots vanilla through `Bootstrap` and never loads the 130 mods, so its
registry is 1,060 blocks. Against the live world: 820 of 943 placed states resolve to a real
`VoxelShape`; **123 fall back**, and all 123 are modded.

The impact is much smaller than that ratio suggests. 80 of the 123 are full cubes, where the
model-bounds fallback is exactly right (`create:crimsite` alone is 47,273 cells). Only **43
states / 924 cells** are non-cube, i.e. where the fallback can actually be wrong — 0.003% of
the world. The worst case is `computercraft:cable` (577 cells), given the full extent of the
connected pipe instead of a thin cross.

**Cost:** high — it needs NeoForge mod loading inside the extraction harness, which is a
different kind of problem from reading a jar. **Probably not worth it** at 924 cells, but it
is a genuine hole and would matter in a world built out of modded stairs and slabs.

### 1.3 Block-entity dynamic content — spawners fixed, the rest measured away

**Spawners: fixed, 47 of 47.** A spawner's block model is the cage and nothing else; the mob
inside is drawn by `SpawnerRenderer` from the block entity. Every one of this world's
spawners was an empty box — 32 `mob_spawner` (12 skeleton, 10 zombie, 8 cave spider, 2
spider) and 15 `trial_spawner` (9 bogged, 3 breeze, 2 husk, 1 cave spider). All seven mob
types resolve to extracted geometry and all seven textures were already in the atlas, thanks
to the §1.1 fix. The HUD now reports **48 spawner mobs** drawn.

The transform is disassembled out of the client rather than remembered — `SpawnerRenderer.
renderEntityInSpawner` is `translate(0.5,0.4,0.5)`, `Y rotation of spin×10`,
`translate(0,-0.2,0)`, `X rotation −30`, `scale 0.53125 ÷ max(w,h) when that exceeds 1` — and
`TrialSpawnerRenderer` calls the same method, so both cages behave identically. Only the Y
rotation changes per frame, so the tilt and scale are baked into one mesh per mob type and
each cage costs a single transform. Collision boxes for the scale rule are extracted from the
registry (130 types), so a modded mob in a modded spawner is sized correctly too.

**The rest of this entry measured away and was NOT built:**

| | placed | what the measurement found |
|---|---|---|
| `minecraft:vault` display item | 17 | **0 carry a `display_item`** — the layer would be invisible. Category 2 |
| `minecraft:decorated_pot` sherds | 30, 9 with sherds | those 9 arrays hold 36 faces of which **27 are plain brick**, so **9 decorated faces exist in the entire world**. Below the threshold for per-face substitution plus ~24 baked pattern textures |
| `minecolonies:scarecrow` | **1** | resolves to zero quads and needs a modded entity model, for one block |

### 1.4 Mob held items — fixed, 30 of 30

**Count corrected upward on re-measuring:** 30, not 22 — 23 skeletons with bows, 4 zombified
piglins with golden swords, 3 pillagers with crossbows. All in the main hand, none off-hand,
all three flat items with baked icons.

The hand is **derived from the model, not hardcoded**. Vanilla's `ItemInHandLayer` does
`model.translateToHand(arm)` followed by a fixed chain, and `handOffset` replays that against
whatever the extraction says the arm part is — so a modded humanoid with its arm elsewhere
still gets its item in the right place. For the vanilla humanoid it works out to
(0.375, 0.75, −0.125): an arm's length below a shoulder at 1.375, which is the number that
proves the root flip and the rotation order are right. A model with no arm — a spider, a bee —
holds nothing, as vanilla does.

The item rides the billboard path dropped items already use, because the item atlas is
canvas-backed rather than part of the block atlas. HUD reports **30 held**.

**The caveat is gone.** Held items are no longer camera-facing sprites: `render/world-items.ts`
draws them as oriented quads in world space, so the item model's own `display` rotation
applies in full alongside the body's yaw. A golden sword now carries `item/handheld`'s
55-degree roll and sits diagonally in the fist instead of lying flat — visible in
`out/held2.png` against `out/held.png` from before. Dropped items keep the sprite path, which
is correct for them.

### 1.5 Ambient particles — built for vanilla, unreachable for mods

The user was told this could not be made generic and asked for it anyway. That is a
legitimate trade and it was theirs to make; what follows is the honest shape of what they got.

**Built:** torch and soul-torch flame and smoke (49 placed), wall torches with their flame
offset by facing, lit campfires and soul campfires (14), bubble columns both ways (456), lit
candles in all seventeen colours (11), spore blossoms (38). About **560 emitting blocks**.

**Still unreachable, and this is the part that must not get lost:** `Block.animateTick` is
imperative Java. 107 of the game's blocks override it, every one would have to have its
bytecode understood individually, and a modded block's could do anything at all. The emitter
table is therefore **vanilla-only by construction**, and it is keyed on EXACT block names so
that `somemod:torch` emits nothing rather than borrowing `minecraft:torch`'s flame — wrong
particles are worse than none, and a test asserts that boundary rather than trusting it.

**Three corrections to my own earlier figure.** I had reported 39,104 emitting cells, of
which 38,174 were lava, and worried about the frame cost. Checking against the extraction
rather than my own list: `magma_block` and `spawner` do not override `animateTick` at all, and
**neither does `lava`** — lava's particles come from the FLUID, which a Block-only extraction
never walks. The real figure is about 560 blocks, and the frame-time concern evaporated with
the 38,174.

**What is measured rather than chosen.** The emission rate is not a number anyone picked:
`ClientLevel.animateTick` samples 667 positions a tick within 16 blocks and another 667 within
32, triangularly distributed around the camera, and calls `animateTick` on whatever is there.
Replicating that gives vanilla's rates for free AND makes the cost independent of how many
emitters the world holds — 456 bubble columns cost exactly what four do. The campfire's
`nextInt(10)` gate, smoke's `0.96` friction, its `8/(rand*0.8+0.2)` lifetime and its
`nextFloat() * 0.3` colour all come from the bytecode. Per-particle drift beyond those is
approximated and is marked as such in the module.

Two things the definitions corrected that a sensible guess got wrong: `smoke` frames run
**descending** (`generic_7` down to `generic_0`), so a puff shrinks as it rises — listed the
other way it grows, and reads as steam; and `falling_spore_blossom` uses `drip_fall`, not a
texture named after the block.

**Memory.** A fixed pool of 4,000, allocated once, geometry never reallocated. When it is
full new particles are DROPPED and the drop is counted, so a climbing `dropped` says the
ceiling is what is limiting the effect. Measured near emitters: 3–12 live, 0 dropped,
2.45 ms/frame render-only.

### 1.6 SpacetimeDB entity appearance — wired, with two named limits

The mirror now publishes `entity.appearance`: raw `SynchedEntityData` scalars as
`{"<index>": value}`, deliberately uninterpreted. Measured on the replica: **42 entities, 39
carrying a blob** — the 3 without are `minecraft:item`, which is the documented none case.

**The finding that makes this non-trivial: the indices are a property of the PACK, not of
Minecraft.** Two mods add fields to `LivingEntity`, so every subclass index shifts by two —
sheep wool colour is **19** here, not the 17 every protocol reference lists. A copied vanilla
index table would be wrong in the quiet way: it would read a neighbouring field and render a
plausible wrong colour.

So the rules are written in VANILLA indices with the offset applied in one place, settable,
defaulting to the measured +2. **It cannot be derived offline** — the shift comes from
mixin-injected fields in the running server's class hierarchy, and the extraction harness
boots vanilla without mods, so it would confidently report the wrong answer. The measurement
procedure lives next to the constant: summon a mob with known NBT, read the column back, and
subtract vanilla's index. That is the same shape of answer as `animateTick` being imperative
Java — measured, written down with its procedure, re-measurable in a minute.

**It is an adapter, not a second set of rules.** Metadata is translated into the NBT shape
`appearanceOf` already reads, so the sheep-wool, villager-robe, horse-coat and cat-coat logic
is shared by both sources and they can only differ in what they are fed.

Two wire semantics the tests pin down:

- **Absent means DEFAULT, not unknown.** The server sends only what differs from the class
  defaults, so a white sheep has no colour field at all — and white is the common case.
- **Item-shaped entities carry nothing.** The walk stops at `ItemStack`, a data-component
  patch since 1.20.5 that no generic reader can measure. Dropped items and item frames keep
  the bridge path's behaviour rather than being faked.

**Two limits, both stated rather than papered over:**

- **A wolf keeps its default coat.** Its variant is a datapack registry, which the mirror does
  not carry, so there is no way to turn index 24's int into a name. Its collar is reachable
  and is read.
- **Registry ints need the registry.** Villager type and profession, cat and frog coats all
  arrive as network ids, so the extraction now emits each registry entry's `getId` alongside
  its texture. That was necessary rather than decorative: `minecraft:calico` is **id 5** while
  sitting fourth in iteration order, so inferring the id from position would have been wrong
  for most of the table.

### 1.7 Eleven item icons — unreachable: the mods do not ship the textures

**Count:** 11 of 11,974 baked item icons, and it is one cause, as suspected.

Every one of the eleven is an item model that names a texture **no jar in the pack contains**:
`advancedperipherals:item/ar_goggles`, `create_optical:item/zinc_coil` and
`incomplete_zinc_coil`, seven `createpropulsion:item/*_lens`-family textures, and
`garnished:item/venerable_delicacy`. Checked against all 130 jars, not sampled — every one
absent. `create_optical` ships `copper_coil.png` and `golden_coil.png` but not the zinc pair,
which is the signature of a mod release that forgot files rather than of anything this
renderer does.

The real Minecraft client shows its missing-texture checkerboard for these too. There is no
texture to load, so this is **unreachable** — and the viewer already degrades better than
vanilla: `item-bake.ts` drops an icon whose sprite never made the atlas, and the item is
drawn as its name instead, which its own comment argues is more useful than a grey square
that could be anything.

## 2. Wrong in general, zero here

**None of these is a parity win.** Each is untested code or an unimplemented feature that
this particular world happens not to exercise. A different world breaks them immediately.

| Gap | Measured here | What would expose it |
|---|---|---|
| Mob armour layers | **0 of ~702** entities wear any | one armoured zombie |
| Wolf and cat collars | **0 of 33** are tamed; vanilla draws the collar only when tame | one tamed wolf |
| Horse saddle and armour | **0 of 6** equines carry either | one saddled horse |
| Donkey / mule chests | **0 of 1** | one chested donkey |
| Sign text | **124 signs, 0 with any text** | one written sign |
| Campfire items | **14 campfires, 0 with items** | one cooking campfire |
| Lectern books | **2 lecterns, 0 with books** | one book |
| Modded fluids | **0** — every one of the 9,246 fluid states in this pack is vanilla water or lava | a mod with a placeable fluid |
| Modded particle emitters | **0 placed** | any animated modded block |
| Create block entities | **0 placed** — no shafts, cogs, belts or tanks anywhere in the loaded world | any Create contraption at rest |
| Block containers promoted to the global palette | **max 110 states** across 16,804 sections, threshold 256 — headroom 146 | a dense modded build |
| Baby mobs | not distinguished | a baby villager, which should wear no rank badge |
| Vault display items | **0 of 17** vaults carry a `display_item` | one vault that has been unlocked |
| Off-hand items on mobs | **0 of 801** entities hold anything in the off hand | one mob with a shield |
| Decorated pot sherds | 9 decorated faces in the whole world, 27 of 36 sherd slots plain brick | a pot-heavy build |

### The palette-width gap — fixed for both containers, and inferred rather than configured

`core/chunk.ts` used `ceillog2(palette length)` for a container's bits-per-entry. Vanilla
promotes a container whose own palette outgrows its width limit to the **global** palette,
written at `ceillog2(registry size)` — the same palette indices at a wider stride. A reader
using only the first rule reads the right values from the wrong bit offsets and produces
plausible rubbish rather than an error.

**Looking for it properly turned up a second instance with a far lower threshold.** The rule
applies to the biome container too, and a biome container's own palette tops out at *three
bits*:

| container | own palette limit | promotes past | this world's maximum |
|---|---|---|---|
| block states | 8 bits | **256 states** | 110 — headroom 146 |
| biomes | 3 bits | **8 biomes** | **7 — headroom 1** |

The block case is comfortably far off. The biome case is **one biome away from firing in
this world**, and would have corrupted the biome of every cell in the affected section.

Both are now implemented and tested against the writing side: `mcspacetime`'s world
downloader implements `block_bits`/`biome_bits` to match vanilla exactly (its files have to
load in the real game), and this reader now mirrors it. The decisive test packs 300 states at
the global width and shows the naive read corrupting **more than 3,000 of 4,096 cells**,
then reads every one correctly once the registry size is supplied.

**The registry size turned out not to be needed.** There is no offline source for a modded
server's block-state count — the extraction harness boots without mods and reports vanilla's
26,684, while the real figure here is 344,003 and lives only in the server's own tables. A
reader that must be told the number therefore stays broken on exactly the worlds that trip
the rule. So the width is **inferred from the file** instead:

- The `data` array's length narrows it. Minecraft never lets an entry straddle a long, so
  `longs = ceil(entries / floor(64 / bits))` — which maps 13..16 bits onto 1024 longs, 17..21
  onto 1366, 22..32 onto 2048. A handful of candidates, not one.
- The palette then picks between them. Every value in a promoted container is still an index
  into the section's own palette, so a candidate that decodes any index past the end of the
  palette is wrong. With 4,096 entries and a few hundred palette entries, a wrong width
  misaligns immediately. When two candidates both decode cleanly the answer is genuinely
  ambiguous and the reader declines rather than guessing — a wrong width is corruption that
  looks like terrain.

`setRegistrySizes` is still honoured and takes precedence where a caller knows the number;
the biome size (**172**, so 8 bits) is counted from the packs' own `worldgen/biome`
definitions and travels in the bundle.

---

## 3. Correct

With what shows it, not merely an absence of complaints.

| Area | Evidence |
|---|---|
| **Fluids** — water, lava, waterlogged blocks, kelp | 503,185 placed cells now render where none did before. The height rule reproduces all 9,246 fluid states measured out of the running game with 0 mismatches; 28 behavioural tests run the real mesher |
| **Block states** | 1,026 baked, **0 unresolved** |
| **Atlas** | 567 sprites, **0 missing** |
| **Vanilla collision + hardness** | 820 of 943 placed states resolve to real `VoxelShape`s extracted from the running game; 18,698 rows covering 26,684 states |
| **Sheep wool** | 28 of 28, colours extracted via `Sheep.getColor(DyeColor)` and re-derived from `physics.json` on every test run |
| **Wolf coats** | 27 of 31 were wrong; now read from `data/<ns>/wolf_variant/*.json`, so a modded variant works with no code change |
| **Horse coats and markings** | 5 of 5, from the two bytes of `Variant` |
| **Villager robes** | 7 of 7 — biome robe, profession robe and rank badge, following vanilla's own exceptions |
| **Domum Ornamentum materials** | 28 of 28 blocks, 3,528 quads, now the wood the block entity names |
| **Face lighting** | quads follow their `cullface` rather than their facing, matching vanilla's split; plants beside walls no longer render at 5% brightness |
| **Paletted containers** | Vanilla's global-palette promotion is implemented for blocks *and* biomes, verified against the `mcspacetime` writer; 8 tests including a 300-state section that the old rule corrupted on >3,000 of 4,096 cells |
| **Biome registry size** | 172, counted from the packs and carried in the bundle, so a promoted biome container reads correctly |
| **Entity texture coverage** | the atlas carries every one of the 135 entity types the extraction knows, not the 33 a scan happened to see — a mob that spawns after the bake is no longer invisible. Costs 1024² -> 2048², **4 MB -> 16 MB of GPU texture**, which is a deliberate trade and worth knowing on a viewer that has hit memory limits |
| **Spawner mobs** | 47 cages that were empty boxes now turn their mob; transform disassembled from `SpawnerRenderer`, collision boxes extracted for the scale rule; HUD reports 48 drawn; 19 tests |
| **Mob held items** | 30 of 30 — 23 bows, 4 golden swords, 3 crossbows, placed at a hand derived from each model's own arm part; 11 tests |
| **Tests** | 690 + 114 passing, 0 failing; `tsc --noEmit` clean |

---

## 3a. Assumptions tested against real data

Three assumptions in the monitor work were stated in the code before live data existed. One
survived; two did not, and both would have been invisible failures rather than errors.

| assumption | verdict |
|---|---|
| `block_width`/`block_height` of 0 means "not yet known", not a zero-sized panel | **survived** — the live rows report 3x4 and 3x5, and 0 does occur |
| the top-left cell is the screen's clear colour, because CC clears to the current pair | **wrong** — MapServer's corner is digit `4`, its yellow TITLE. This made the whole-screen fallback yellow and reported 99.6% of cells as non-default when the truth is 0.19%. Now the modal digit, which a title cannot outvote |
| the row's `x,y,z` is the panel's top-left, matching `LiveMonitor` | **wrong** — it is the BOTTOM-left. Proven from the data, not a screenshot: three panels share the wall at x=71, z=33 at y 67 (3x1), 68 (1x1) and 69 (3x2), and only a bottom-origin reading stacks them without overlap. Untranslated, every panel hung a full panel-height too low |

A fourth thing surfaced that was not an assumption at all: **the generated SpacetimeDB
bindings were stale**, carrying neither the `monitor` table nor `entity.appearance`. Both
features were therefore inert in the running viewer while their unit tests passed — the
adapters were correct and nothing was feeding them. Regenerated from the module wasm.

## 4. The traps that recurred

The transferable part. Meet these before the task list.

### The atlas trap — caught us four times

`destroy_stage` overlays, fluid surfaces, entity layer textures, Domum materials. The shape
is always identical: **a texture that no block state or entity index references never reaches
the bake**, because the atlas is built by walking what the world names. The symptom is worse
than a missing texture — an unbaked sprite samples whatever sits at atlas (0,0) rather than
failing, so the geometry draws in the wrong colours with no error anywhere.

Any new geometry that introduces a texture must also add it to the bake. Ask "what names this
sprite?" and if the answer is "my new code", it is not in the atlas.

### Measure before building — four candidates died on contact

- **Sign text**: 124 signs placed, **0 with any text**. A sign-text renderer would have been
  100% invisible in this world.
- **"23% of entities are unhandled"**: that figure was `create:super_glue` and
  `aeronauticsdiscovery:pin`, which I called "invisible marker entities vanilla does not draw
  either". Half right, and worth splitting now that the renderers have been disassembled:
  `SuperGlueRenderer.shouldRender` is `iconst_0; ireturn` — Create never draws the glue
  entity at all — while `PinEntityRenderer.shouldRender` is CONDITIONAL, drawing only while
  the player holds the mod's pin wand, behind a substantial render method. Nothing appears in
  ordinary viewing, which is what this viewer does, but "absent" and "conditional" are
  different claims and only one of them was true of both.
- **Mob armour and collars**: the obvious first thing to build for secondary entity layers,
  and 0 of ~702 entities and 0 of 33 wolves would have shown it.
- **Create block entities**: assumed to be the bulk of this world's interesting geometry.
  Measured: **none placed at all.**

A count against the live world costs minutes and has redirected or cancelled roughly half the
work proposed in this project.

### Extract, do not remember

The sheep wool table was first written from the dye colours. The test that re-derives it from
the extraction **rejected 15 of the 16**: vanilla darkens wool by about 0.75, and white wool
is 0.9020 grey rather than the dye's `0xf9fffe`. The same discipline caught fluid levels 8–15
being *falling fluid at full height* rather than progressively thinner, which would have made
every waterfall a sliver.

### Pick the instrument that can actually answer the question

Two wrong turns worth naming. Hunting the three.js scene graph for a named mesh, when a unit
test over the vertex buffer answered the same question deterministically. And pixel-diffing
two screenshots to decide whether a coplanar overlay z-fights — the villagers are live mobs
and moved between runs, so that diff would have "proved" whatever they did. The honest
measurement was reading `depthFunc` off the live materials: every one reports `3`
(`LessEqualDepth`), so a coplanar overlay submitted later wins the depth test and no geometry
nudge was needed.

---

## 4a. A deployment hazard worth knowing about

The served bundle is produced by a **baker sidecar running a built image**, not from the
working tree. It re-scans every 30 seconds and re-bakes whenever the live world contains
something the bundle lacks, overwriting `.cache/baked` with output from whatever code was in
the image at build time.

So a bake run from an up-to-date working tree is **reverted within minutes** unless the
baker's image has been rebuilt too. Measured: 275 re-bakes, six in one 25-minute window, and
the live bundle at the time of writing was missing every entity-layer sprite added that
evening — sheep wool, wolf coats, villager robes — while the working tree had them all.

Two things follow. Anyone verifying a rendering change against the live viewer should check
`generated` in the served `assets.json` before believing a negative result. And anyone
shipping a change to the bake must rebuild the baker image, not merely re-run the bake.

**The sidecar also sees less of the repo than you do.** Its image carries `src/` and
`public/` and mounts `.cache`, the world and the mods — but not `harness/`. A bake step that
reads an extraction output from `harness/out/` works perfectly from the tree and silently
produces nothing in the sidecar, so the field just disappears from every bundle the baker
writes. The existing convention is the fix: extraction outputs the bake needs are copied to
`public/` (`public/entity-index.json`, `public/physics.json`) and read from there.

The entity-type fix in §1.1 removes the most common *trigger* for the re-bake loop, which
makes the window much wider, but it does not remove the hazard.

---

## 5. What is left, and what is unreachable

**§1 is empty of reachable work.** Everything that could be built has been. What remains is
listed below with the reason it cannot be, and one item that belongs to a different repo.

### Unreachable by construction

These are not unfinished. The data required does not exist, and no amount of effort creates
it.

- **Ambient particles for MODDED blocks.** The vanilla emitters are now built (§1.5, §3) —
  the user was told the limitation and chose the trade. What was unreachable remains exactly
  so: `Block.animateTick` is imperative Java, 107 blocks override it, and a modded block's
  could do anything. There is no generic extraction, so a modded emitter produces nothing and
  always will. The emitter table is keyed on exact vanilla block names specifically so a
  modded block cannot silently inherit a vanilla emitter — **the boundary is enforced in code
  and asserted in a test**, not left to convention.
- **Modded collision shapes.** `getPossibleStates()` and every `VoxelShape` live in compiled
  mod code behind NeoForge's loader. The harness boots vanilla through `Bootstrap`, so its
  registry is 1,060 blocks and 26,684 states where the real server has 344,003. Reaching them
  means running NeoForge's mod loading inside the harness, a different kind of problem from
  reading a jar. Measured impact: **924 cells of 28.6 million**, so it is unreachable *and*
  not worth reaching.
- **Eleven item icons** (§1.7). The mods ship item models naming textures they do not
  include — verified against all 130 jars, every one absent. The real client shows its
  missing-texture checkerboard for these too; this viewer draws the item's name instead.

### Spanned two repos, and is done

- **The SpacetimeDB appearance gap** (§1.6) is closed on both sides. `mcspacetime`'s `entity`
  table carries an `appearance` column holding the raw `SynchedEntityData` scalars as JSON,
  deliberately uninterpreted; this viewer translates them into the NBT shape `appearanceOf`
  already reads, so both sources share one set of rules and can only differ in what they are
  fed. Mobs now render the same in spacetime mode as on the bridge.

  **The finding worth carrying forward:** this pack's metadata indices are shifted **+2** from
  vanilla, because two mods inject fields into `LivingEntity` and every subclass index moves.
  Sheep wool is index 19 here, not the 17 every protocol reference lists. It **cannot be
  derived** -- the shift lives in the running server's class hierarchy, and an extraction
  harness that boots vanilla without mods reports the wrong answer confidently. So the rules
  are written in vanilla indices with the offset applied in one settable place, and the
  measurement procedure (summon with known NBT, read the column back, subtract) sits beside
  the constant. The next pack is a one-number change.

### Deliberately not built, with the number that decided it

Listed in §2 and §1.3 rather than here, but named so nothing looks quietly dropped: vault
display items (0 of 17 carry one), decorated pot sherds (9 decorated faces in the whole
world), and the single `minecolonies:scarecrow`.

Two things in this list are implemented but unverifiable here and stay category 2 until a
world exercises them: `glow_item_frame` (0 placed) and the framed-map model (0 frames hold a
map). An item frame's `ItemRotation` is likewise handled, and all three frames here use 0.

### Every remaining classification claim, re-checked against behaviour

After the item-frame mistake, each surviving label was checked against what actually draws
rather than what it is called:

| label | count | does it draw? |
|---|---|---|
| `java-model` `minecraft:item` | 63 | **yes** — dropped-item billboard path |
| `java-model` `minecraft:item_frame` | 3 | **yes**, now with its frame too |
| `block-model` `minecraft:falling_block` | 56 | **yes** — all 56 carry a `BlockState` (gravel) |
| `contraption` | 24 | **yes** — 24 drawn, 216 blocks |
| `invisible` `minecraft:marker` | 3 | correctly nothing |
| `invisible` `create:super_glue` | 69 | correctly nothing — renderer returns false unconditionally |
| `unhandled` `aeronauticsdiscovery:pin` | 140 | nothing, and vanilla draws nothing either unless the viewer holds the mod's pin wand |

### What "100% parity" honestly means here

Every block state in the reference world renders — 0 unresolved of 1,028. Every sprite the
atlas is asked for is present — 0 missing of 684. Every entity in the live census draws.
Fluids, entity layers, spawner mobs, held items with their real orientations, block-entity
materials, and vanilla's paletted-container promotion rule for both blocks and biomes are all
in. What is left is two things that cannot be reached from data that exists, eleven textures
their own mods never shipped, and one schema change in another repository.
