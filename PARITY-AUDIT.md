# Parity audit — what a faithful modded client does, and what this does

Written 2026-09-11 against the working tree at `6551fc1`. Every claim below has a
`file:line` next to it so it can be checked rather than believed. Where I could not check
something I say so instead of asserting it.

The brief was six questions:

1. generic mod support (how much is hardcoded?)
2. clientside character controller with zero input delay
3. clientside block-breaking progress
4. entity sync ("I don't see mobs moving")
5. inventory, crafting, recipes, off-hand item rendering
6. animations and sounds

Short answers, then the evidence.

| # | area | state | the binding constraint |
|---|---|---|---|
| 1 | generic mod support | **mostly already done** — better than the brief assumed | not mod-specific code; it is vanilla behaviour that has no data file |
| 2 | zero-delay movement | **absent** at audit time → **built in this pass** (§8) | nothing structural; it was buildable client-side, and was built |
| 3 | block-break progress | **absent**; its data blocker is now removed (§8a) | needed block hardness, which is Java-side — now extracted |
| 4 | entity sync | **was ≥2 s disk flush** → **packet-rate path built and wired** (§8c) | was the save-file data source; now switchable to a real protocol client |
| 5 | inventory / recipes / off-hand | **read-only inventory only**; recipes and off-hand absent | recipes are in the jars and deliberately filtered out |
| 6 | animations and sounds | **animation now live** (§8d, §8e); sound still absent | animated textures and mob gait done; audio is still a from-scratch subsystem |

---

## 0. The architecture, because every answer below follows from it

This is **not** a client. No packet ever reaches the browser from Minecraft. There is no
server-side plugin or mod written for this project. Three processes:

```
browser ──WS /live──► nginx ──► mcwv-bridge:8080 ──RCON(2 TCP conns)──► mc:25575
   │                                 └──HTTP──► hq:4400 (turtle labels, monitor text)
   │                                 └──tail──► /data/mclogs/latest.log (chat receive)
   └──HTTP GET + Range──► nginx ──► /data/world/region/*.mca, entities/*.mca, level.dat
```

- The bridge is **WebSocket only** — there is no HTTP API on it
  (`bridge/src/index.mjs:179`, `bridge/Dockerfile:8`, proxied at `docker/nginx.conf:69-83`).
- **The world never crosses the socket.** Blocks are read by the browser straight out of
  the region files over HTTP Range requests (`docker/nginx.conf:110-114`,
  `src/app/chunk-stream.ts`). The socket only ever says *"the server flushed, re-read
  them"* (`bridge/src/observer.mjs:588-599`).
- The only write this project makes to the game is one `save-all flush`
  (`bridge/src/observer.mjs:590`), off by default, guarded hard (§4).
- Playing is a **fake player driven by chat commands** over RCON — SiliconeDolls'
  `player <name> move forward` dialect, 20 commands, at `bridge/src/fake-player.mjs:56-74`.

Two reasons a real protocol client was rejected, both correct and both recorded at
`README.md:924-945`: NeoForge's `NetworkComponentNegotiator` disconnects a client that
does not speak all 130 mods' required payloads, and modded block **state** ids are never
transmitted (`neoforge:registry_sync` carries registry-object ids only), so a JS client
would decode every chunk wrong.

**The consequence that drives §2–§6:** everything the browser knows arrives either at the
RCON poll rate (1–10 Hz, one `data get` per field) or at the disk-flush rate (≥2 s). There
is no per-tick channel in the system at all.

---

## 1. Generic mod support — the brief's premise is largely wrong, in a good way

> "Create is currently specially hardcoded; the user wants to understand how much else is
> hardcoded."

I went looking for that and it is mostly not there. **The asset pipeline is genuinely
data-driven and already reads all 130 mod jars.**

### What is already generic

- Mod jars are read as plain zips and stacked in Minecraft's own precedence order —
  builtin < vanilla client jar < mod jars < resource packs (`src/assets/pack.ts:82-119`).
  Loaded from a `mods/` directory on three paths: the bake tool
  (`src/tools/bake-assets.ts:86-105`), the audit tool (`src/tools/audit.ts:50-64`), and
  the dev server → browser (`vite.config.ts:53-56,83-86` → `src/app/main.ts:207-225`).
- Real blockstate JSON and model JSON: `variants` + `multipart`, parent chains, `#texture`
  indirection, element rotation with `rescale`, variant `x`/`y`, `uvlock`, position-hashed
  weighted variants, `render_type`, `cullface`, `tintindex` — all in `src/assets/model.ts`
  (671 lines), no block names anywhere in it.
- **Every** item model in the whole stack is enumerated by glob, so modded items bake
  automatically (`src/server/item-bake.ts:73-76,124-131`).
- Render layer and occlusion are **derived from the sprite PNG's alpha channel**, not from
  a list of transparent blocks (`src/render/registry.ts:99-103,334-338`). There is no
  `const GLASS = new Set([...])` in this repo. That is the single best decision in it.
- "Is this a block-entity block" is structural — *a model with no `elements` at all*
  (`src/render/registry.ts:348-353`) — not a name list.
- A monitor is *any* block state with a cardinal `facing` and a `state` matching
  `/^[lrud]{1,4}$/` (`src/app/monitor-panels.ts:42,62-65`). A turtle is *any* block entity
  carrying `LeftUpgrade`/`RightUpgrade` (`src/render/turtle-upgrades.ts:72-79`). Neither
  names a mod.
- Entity geometry is **extracted by reflection** from the real jars by a JVM harness
  (`harness/src/mcextract/ExtractModels.java`) — 426 models, zero per-mob code, zero
  mod-namespace literals in `harness/src`.
- Biome tint is read from `data/**/worldgen/biome/*.json` + the colormap PNGs, so modded
  biomes tint correctly (`src/render/biome.ts:71-74`).

### What is actually mod-specific

Fifty-three mod-namespace literals exist in `src/` + `bridge/src/`; most are comments.
**Seventeen are load-bearing**, and the honest list is short:

| file:line | what |
|---|---|
| `src/assets/loaders.ts:63-67` | custom-model-loader table: `neoforge:obj`, `neoforge:composite`, `computercraft:turtle`, `fusion:model`, `domum_ornamentum:materially_textured`. Keyed by the loader id **the model JSON itself declares** — data in, table out. Unknown loaders fall back to vanilla `elements` and are *counted* (`loaders.ts:70-72`), not silently dropped. |
| `src/render/entities.ts:118-190` | **Create's contraption NBT schema** — `Contraption.Blocks.{Palette,BlockList}`, `Pos` packed as `BlockPos.asLong`. This is the one genuinely Create-specific thing in the repo. |
| `src/render/entities.ts:68-70` | three modded entity ids marked `unhandled`: `create:super_glue`, `simulated:honey_glue`, `aeronauticsdiscovery:pin`. The **only** modded entity ids named for behaviour. |
| `src/app/computer-registry.ts:53-57` | hard `computercraft:` gate for turtle/computer classification |
| `bridge/src/computers.mjs:140` | the `computercraft dump` RCON command |
| `bridge/src/fake-player.mjs:56-74` | SiliconeDolls' command dialect — **overridable wholesale** via `MCWV_FAKEPLAYER_COMMANDS` (`bridge/src/index.mjs:83,96-104`) |

Note what Create's entry does *not* do: once the block palette is decoded, the blocks go
through the ordinary registry + atlas + mesher path (`src/render/entities.ts:233-268`).
**There is no Create-specific geometry code.** And contraption *entities* are matched
structurally — `id.includes('contraption')` (`src/render/entities.ts:74-76`) — so every
Create addon's contraption type works without a line of its own.

### The hardcoding that actually matters is *vanilla*, not modded

These are places where Minecraft defines behaviour in Java and ships no data file, so
there is nothing to be generic *from*:

| file:line | what | size | modded blocks? |
|---|---|---|---|
| `src/app/nav-world.ts:28-48,58-66` | **collision shapes** — 38 passable ids + 27 suffixes + 19 avoid ids | largest list in the repo | fails *safe* (unknown ⇒ solid), documented at `nav-world.ts:14-18` |
| `src/render/ber-models.ts:1027-1043` | block-entity geometry: 7 hand-authored builders → **127 vanilla block names** | 1065 lines | **none** — `berModel()` hard-rejects any non-`minecraft:` namespace (`:1039-1043`) |
| `src/render/registry.ts:55-64` | biome-tint sets (grass 8 ids, foliage, water 3 ids) | small | `_leaves` suffix rule covers modded leaves |
| `src/render/registry.ts:86-116` | air states, fluid states | small | no |

**So: the top blocker to generic mod support is not Create. It is that modded blocks with
Java-built block-entity renderers get no geometry** (`ber-models.ts` is namespace-gated),
and that collision shapes were a guess for every block. Both have the same general fix —
extend the existing JVM harness (`harness/`), which already proves the technique works for
entity models.

**Half of that was done in this pass.** `harness/src/mcextract/ExtractPhysics.java` now
extracts `BlockBehaviour`'s collision shapes and hardness for every block the booted
registry holds (§8a). The catch, stated plainly: the harness boots **vanilla, not
NeoForge**, so mod blocks are never registered and the exact tier covers vanilla only.
Modded blocks fall to a new derived tier — bounds of the mod's own baked model — and then
to the old heuristic, and `block-shapes.ts` *measures* which tier is carrying the work
rather than assuming. `BlockEntityRenderer` geometry for modded blocks is untouched and
remains the largest single item.

### One cheap, concrete miss

`src/assets/pack.ts:65-80` (`defaultFilter`) inflates only `assets/**/*.{json,png,mcmeta,obj,mtl}`
plus two `data/` carve-outs. It therefore **drops every recipe and every sound file in
every jar**. Measured, not assumed:

```
create-1.21.1-6.0.10.jar:  3063 files under data/**/recipe/
create-1.21.1-6.0.10.jar:    38 .ogg files
client-1.21.1.jar:            0 .ogg files, no sounds.json
```

So the recipes for §5 are sitting in the jars, one filter line away. Mod **sounds** are
too. Vanilla sounds are not — they are not in the client jar at all; they come from
Mojang's hashed asset index, which `scripts/fetch-assets.mjs` does not fetch (it only
pulls the client jar, and its own comment at `:5-6` says the index holds "sounds and lang
files").

---

## 2. Client-side character controller — absent, and this is the most buildable gap

**Today there is no input prediction of any kind.** Stated outright in the source at
`src/app/live-controls.ts:11-14`:

> "the server decides where the player ends up and the camera follows what it reports, so
> there is no client-side prediction and therefore nothing to rubber-band."

The full path for one W keypress (`bridge/src/fake-player.mjs`, `bridge/src/observer.mjs`):

1. keydown → intent sent **on change only** (`src/app/live-controls.ts:596-602`)
2. WebSocket → `observer.control()` (`bridge/src/index.mjs:255`, `observer.mjs:308-319`)
3. → `player <name> move forward` on a **dedicated** RCON connection
   (`fake-player.mjs:58`, `observer.mjs:578-581`) so a 1–7 s flush cannot delay a keypress
4. server drains RCON on the tick thread — measured p50 3–6 ms, **p95 26–50 ms**
   (`README.md:868-880`)
5. the browser learns the result only on the next `Pos` poll — **every 100 ms**
   (`MCWV_SELF_MS`, `observer.mjs:50-51,437-447`)
6. camera converges onto it (`src/app/live-view.ts:936-961`)

**≈100–200 ms of input latency**, and none of it is masked.

What *does* exist is **smoothing of server truth**, which is a different thing and is easy
to mistake for prediction: each `self` sample yields a velocity, the camera dead-reckons
along it capped at `MAX_EXTRAPOLATE_S = 0.25` (`src/app/live-view.ts:64`) and converges at
`CONVERGE_RATE = 18` (`:66`). That hides the *sampling gap*; it does nothing about the
*round trip*, because it can only extrapolate motion the server has already started.

Yaw and pitch are already fully client-side and instant (`src/app/live-controls.ts:11-14`,
`live-view.ts` never takes rotation from the server for the camera) — only **translation**
waits on the server.

### Why this is tractable

Everything a local controller needs is already in the browser:

- `World.getState(x,y,z)` — the full voxel world, already streamed (`src/render/world.ts:48`)
- `navWorld(world)` — a cached `air | solid | avoid` oracle keyed by state id
  (`src/app/nav-world.ts:90`), already used by the pathfinder
- the held-key set and look angles (`src/app/live-controls.ts`)
- an authoritative position stream at 10 Hz to reconcile against

The one thing that does **not** exist is per-block collision *boxes* — `nav-world` is
whole-cell, so a predicted body will clip slabs and stairs differently from the server.
That is a real fidelity limit and the reconciliation has to absorb it.

**Implemented in this pass — see §8.**

---

## 3. Block-breaking progress — absent, and blocked on data that is not in any jar

Zero hits for `destroy_stage`, `breakProgress`, `destroySpeed` or `hardness` anywhere in
`src/` or `bridge/src/`. What exists instead: the left button is a **hold**, forwarded as
`{t:'dig', down}` → `player <name> attack continue` (`bridge/src/fake-player.mjs:71`), and
the comment at `src/app/live-controls.ts:341-343` says why — *"The server decides how long
the block takes to break — hardness, tool, efficiency, haste — so the browser's only job is
to say when the button is down and when it is up."*

To render the overlay clientside you need three things:

| need | available? |
|---|---|
| the 10 `destroy_stage_N.png` textures | **yes** — confirmed present in `.cache/client-1.21.1.jar` |
| a crack quad over the targeted block | **yes** — `voxelCast` already returns the target (`src/app/raycast.ts:32`) and `ber-overlays.ts` already paints per-face quads |
| **block hardness** | **was no, now YES** — extracted in this pass (§8a). `physics.json` carries `getDestroySpeed` for all 26,684 vanilla states: stone 1.5, obsidian 50, bedrock -1. |
| **tool speed** (tier, efficiency, haste) | **still no** — the bridge reads only stack ids and counts (`bridge/src/player-state.mjs:25-32`), and item tool tiers were not extracted. This is what is left. |

Mining-time also needs the held tool's tier and efficiency/haste, which the bridge does not
read (`player-state.mjs` reads only `Inventory` stack ids and counts, not components).

At audit time this was "not a small clientside job — extend the harness to dump a
`block → destroyTime` table". **That half is now done** (§8a): the harness extension exists,
ran, and shipped. What remains is one more extraction pass for item tool tiers plus the
crack overlay itself, which moves this from "blocked on data that does not exist as data"
to the top of the ranked list in §9.

Cheap honest interim: draw the crack overlay on the targeted block **without** a progress
rate — it tells you *what you are mining*, which is information you currently do not have,
without inventing a duration. That respects the repo's "never draw a number the server did
not give us" rule (`src/app/play-hud.ts:9-11`).

---

## 4. Entity sync — "I don't see mobs moving" is a real and correctly-described symptom

Mobs **are** synced. They are just synced off the disk.

- Mobs, animals, villagers, dropped items and falling blocks are read from the parallel
  `entities/*.mca` region files (`docker/nginx.conf:118-121`, `src/app/live-entities.ts`).
- They refresh **only when the `reload` push arrives** (`src/app/live-view.ts:1000-1013`),
  which fires after each `save-all flush`.
- The flush is `MCWV_FLUSH_MS = 5000` by default with a **hard floor of 2000 ms**
  (`bridge/src/flush-timer.mjs:38-40`), doubling to a ceiling of **120 s** on any flush
  slower than 1 s (`:42,48,146-157`) and needing 5 consecutive fast flushes to recover
  (`:50,159-165`).
- Between refreshes each entity interpolates and is then **held** — STALE for mobs (30 s),
  expired for items (700 ms) (`src/app/live-entities.ts:50-51`).

So a mob is *repositioned with a short slide every ≥2 s and then frozen*. That reads on
screen exactly as "not moving". Two further multipliers the user is probably also seeing:

- **A mob in a non-ticking chunk does not move at all**, because its AI is not running —
  `simulation-distance=10` in `data/server.properties`, and nothing forceloads the area
  around the *camera*.
- **Bind pose.** `setupAnim` is never replayed (`ARCHITECTURE.md:510-513`), so even a mob
  that is repositioned does not animate — a walking cow slides with rigid legs.

Live **players** and **turtles** are much better: players come from RCON at 1 Hz
(`observer.mjs:39-40`) and turtles from `computercraft dump` at 1 Hz
(`bridge/src/computers.mjs:27-28,140`), both interpolated with a capped extrapolation and
an explicit stale flag (`src/app/player-tracks.ts:87,309`). The driven bot is at 10 Hz.

**The binding constraint is the data source, not the renderer.** Entities cannot go faster
than the flush because there is no other channel that carries them. Which leads to the
single most important finding in this audit:

### The answer is a real protocol client, not a server-side script

An earlier draft of this audit proposed a KubeJS script writing entity state to a file. That
is **superseded and was not built** — a better pipeline already existed next door and had
simply never been wired in.

`../mcspacetime` is a headless Minecraft 1.21.1 (protocol 767) client written in Rust that
joins the server over the **native Minecraft protocol** — no RCON, no server-side mod, no
KubeJS — and mirrors what it sees into SpacetimeDB as live queryable rows. Because it is a
real client, it receives entity packets as they happen instead of reading a disk snapshot,
which removes the exact constraint this section identifies.

It also solves the thing `README.md:924-945` calls fatal for a JS protocol client: modded
block-state ids are never transmitted, so a wire-only client decodes every chunk wrong.
mcspacetime carries a KubeJS-dumped `blockstates.json` (344,003 states) and re-flattens it
in the live registry order at connect time.

**Wired into this viewer in this pass — see §8c.** What it does *not* change: a
ComputerCraft terminal's contents are not on the Minecraft wire at all, so `screen.json`
remains the source for monitor text in both modes.

## 5. Inventory, crafting, recipes, off-hand

| thing | state | evidence |
|---|---|---|
| hotbar + inventory display | **works, read-only** | `src/app/play-hud.ts`, fed by `{t:'inventory'}` at 0.5 Hz (`bridge/src/player-state.mjs:98`, `observer.mjs:473`) |
| container (chest) contents | **works, read-only** | `data get block x y z` (`player-state.mjs:131`) on right-click |
| item icons | **works, fully generic** | every item model in every jar is baked (`src/server/item-bake.ts:73-76`) |
| **moving items between slots** | **impossible over this transport** | SiliconeDolls has no inventory command; slot moves are container-GUI clicks a fake player cannot issue (`README.md:896-903`) |
| **crafting** | **absent** | zero hits for `crafting` in `src/` or `bridge/src/` |
| **recipes** | **absent** — and filtered out at the door | `src/assets/pack.ts:65-80` drops all of `data/**/recipe/`; 3063 of them in the Create jar alone |
| **off-hand (left hand) rendering** | **absent** | `Offhand` is never read — `player-state.mjs:25-32` reads Health, foodLevel, XpLevel, XpP, SelectedItemSlot, DeathTime and nothing else |
| **first-person held item / arm** | **absent** | no view-model, no arm geometry anywhere in `src/render/` |

Note the hotbar HUD is DOM, not WebGL (`src/app/play-hud.ts:3-7`) — a deliberate and good
call, but it means "render the held item in the world" is genuinely new work, not a tweak.

---

## 6. Animations and sounds

**Sounds: entirely absent.** No `AudioContext`, no `.ogg` handling, no audio file anywhere
in `src/`. The three grep hits for "sound" are the English word in comments. Nothing is
half-built; this is a from-scratch subsystem.

**Animations: bind pose only.**

- Entity `setupAnim` is not replayed — a spider's legs stay horizontal
  (`ARCHITECTURE.md:510-513`). Live players slide rather than stride and always wear the
  default Steve skin (`src/render/player-model.ts:20-26`).
- Secondary layers (sheep fur, armour, saddles) are separate `LayerDefinition`s and are not
  drawn at all.
- Block-entity animation — a chest's lid angle, a banner's dye layers — is not drawn;
  geometry only (`ARCHITECTURE.md:1020-1026`).
- **Animated textures upload every frame but the mesher only samples frame 0**
  (`ARCHITECTURE.md:517`) — no UV scrolling. This one is small and visible: every Create
  belt, fluid and blaze burner is a still frame right now.
- Create contraption **motion** is not re-meshed per flush, so a spinning bearing is drawn
  where the last save left it (`ARCHITECTURE.md:1042-1047`).
- Particles are not rendered and structurally cannot be from this data source — they are
  client-side transient effects with no persistent representation (`ARCHITECTURE.md:1004-1008`).

---

## 7. What the audit tooling already tells you

`npm run audit` (`src/tools/audit.ts`) scans the real world inventory and classifies every
block state and entity id by how it got geometry, with a `provenance` field on each
(`src/render/registry.ts:43`). That is the right instrument and it already exists; any work
below should be measured with it rather than by eye.

---

## 8. What was changed in this pass

Two things, and the second turned out to be the important one.

### 8a. The game's own constants and collision shapes, extracted

`harness/src/mcextract/ExtractPhysics.java` (new). The harness already deobfuscates the
client jar and boots the real game far enough to call into it — `SharedConstants
.tryDetectVersion()` + `Bootstrap.bootStrap()` at `harness/src/mcextract/ExtractModels.java:100-101`
— which is how this project gets real entity geometry. That same boot makes the **block
registry live**, so the new extractor simply asks the game:

```
state.getCollisionShape(EmptyBlockGetter.INSTANCE, BlockPos.ZERO).toAabbs()
state.getDestroySpeed(EmptyBlockGetter.INSTANCE, BlockPos.ZERO)
Player.createAttributes().build().getValue(Attributes.GRAVITY)        ... and friends
LivingEntity.SPEED_MODIFIER_SPRINTING                                 (amount + operation)
```

Run, verified, and installed at `public/physics.json` (2.5 MB, ~100 KB gzipped — nginx
already gzips `application/json`, `docker/nginx.conf:6-9`). What it produced:

```
1060 blocks, 26,684 states -> 320 distinct collision shapes, 18,683 rows
gravity 0.08/tick²   jumpStrength 0.42/tick   stepHeight 0.6
width 0.6  height 1.8  eyeHeight 1.62  sneakingSpeed 0.3
sprintModifier 0.3 ADD_MULTIPLIED_TOTAL   blockInteractionRange 4.5
```

Spot-checked against independently known facts and now guarded by tests: stone 1.5,
obsidian 50, bedrock -1 (unbreakable), a bottom slab `[0,0,0,1,0.5,1]`, a stair two boxes,
torch and water no collision at all.

**Two real findings fell out of it:**

- **Reach was wrong.** `live-controls.ts` raycast used a hardcoded `maxDist = 5`; the game's
  `BLOCK_INTERACTION_RANGE` is **4.5**. The crosshair targeted blocks half a block beyond
  what the server would accept, and such a click was sent, acked, and silently did nothing.
  Now driven from the extracted value.
- **`movementSpeed` is not a speed.** It extracts as 0.1, an *attribute* that vanilla feeds
  through `getFrictionInfluencedSpeed`; ×20 gives 2 blocks/s and a player plainly walks
  faster. So horizontal speed is the one thing still measured rather than computed — see
  below. Worth recording, because using it directly would have looked principled and been
  wrong.

`src/app/block-shapes.ts` (new) turns that into the collision oracle, in three tiers, and
the order is the design: **exact** (the extracted table, all vanilla) → **derived** (the
mod's own baked model bounds, which is how everything else modded works here) →
**guess** (the old `nav-world.ts` name heuristic). `coverage()` reports which tier is
carrying the work so the fallback rate is visible rather than assumed.

### 8b. Client-side movement prediction, on those constants

`src/app/predict.ts` (new) runs the motion locally the instant a key goes down, with a
0.6 × 1.8 body swept per axis against the real shapes, real gravity and jump, and vanilla's
0.6 step-up — so a slab is a step, a stair is a stair, and a full block still needs a jump.
`src/app/live-view.ts` now draws the predicted position and *reconciles* toward the
server's dead-reckoned one, instead of drawing the server's and calling that a camera.

Three decisions worth recording:

1. **Reconciliation is a decaying offset, not rollback-and-replay.** Textbook rollback is
   wrong here: the server is not replaying our input timeline, it is running a *stateful*
   `player X move forward` until `stop` (`bridge/src/fake-player.mjs:283-298`). There is no
   per-tick input to acknowledge and nothing to replay against. So the body is pulled
   toward the server's estimate at a deliberately slow rate, with a hard resync past 2.5
   blocks for teleports and knockback. The lead exists exactly during the round trip —
   which is the latency being hidden — and is ~0 in steady state.
2. **Speed is measured from the server, for the reason above.** `observe()` watches how
   fast the server actually moved us while one direction was held, and converges on that.
   A potion, a soul-sand block, an armour attribute or a mod all land in the measurement
   for free. The extraction supplies the ×1.3 and ×0.3 around it.
3. **The disagreement is on screen.** The HUD prints `predict: drift=… speed=… phys=game/exact`
   — or `phys=FALLBACK/heuristic` when `physics.json` did not load. Per this repo's rule
   that the screen must never quietly lie, "the local collision model is wrong about some
   modded block" shows up as persistent drift rather than as an unexplained shudder.

### 8c. The world data source is now a toggle, and entities can come from a real client

**`bridge` remains the default and is untouched.** `spacetime` is additive.

| file | what |
|---|---|
| `src/app/world-source.ts` | resolves the source: `?source=` on the URL beats `/dev/source.json` beats the built-in `bridge`. Pure and tested in both directions — a typo in the deployed env must never move anyone off the working path. |
| `src/app/spacetime-entities.ts` | entity rows → the same `EntitySample`s the save-file path produces |
| `src/app/live-entities.ts` | new `ingestExternal()` — the one seam |
| `src/module_bindings/` | generated by `spacetimedb-cli generate --lang typescript` from the module's wasm (`npm run gen-bindings`) |
| `src/app/spacetime-terrain.ts` | section bit-unpacking and state naming (pure, 18 tests) |
| `src/app/spacetime-sections.ts` | sections -> `World.addLiveSection` -> the existing re-mesh |
| `src/tools/spacetime-proof.ts` | the end-to-end check below (`npm run spacetime-proof`) |
| `docker/entrypoint.sh`, `docker/nginx.conf`, `vite.config.ts`, `docker-compose.yaml` | serve `/dev/source.json` from `MCWV_SOURCE` / `MCWV_STDB_URI` / `MCWV_STDB_DB`, exactly as `/dev/manifest.json` already works — so switching needs a container restart at most, never a rebuild |

Two decisions worth recording:

1. **The official SDK, not a hand-rolled client.** The first attempt at this was a
   dependency-free JSON-WebSocket reader, on the reasoning that this repo hand-rolls its NBT,
   Anvil and RCON readers. That was wrong, and the u64 result below is why: the JSON path
   needs `JSON.parse` source-text revivers to keep bit-packed section words exact, while the
   SDK's BSATN encoding carries them as `bigint` natively. `spacetimedb@2.10.0` matches the
   running server (`clockworklabs/spacetime:v2.10.0`) and the CLI exactly.
2. **The source swaps where samples come FROM, never the renderer.** Both paths feed the same
   `LiveEntities`, so interpolation, meshes, billboards, name tags and item icons are the
   identical code in both modes. A forked renderer is how one of two paths quietly rots.

**Terrain goes through the same seam.** A `chunk_section` row is already the Anvil paletted
layout, so once unpacked and named it goes into `World.addLiveSection` — the entry point the
save-file live path already used — and is marked dirty through the same `invalidatedSections`,
so `pump()` re-meshes it without knowing where it came from.

Two problems had to be solved for that, and both are worth recording:

- **The `u64` words must stay exact.** Section data is bit-packed 64-bit words; measured on a
  real section, **341 of 342 exceeded 2^53**. Anything that routes them through a JavaScript
  number corrupts the terrain silently. This is the single strongest argument for the SDK:
  BSATN hands them over as `bigint`, and `unpackSection` splits each into 32-bit halves so no
  whole word ever enters a double.
- **`block_state.properties` omits properties at their DEFAULT value** — Minecraft's command
  spelling, so `minecraft:oak_stairs` means `facing=north,half=bottom,shape=straight,
  waterlogged=false`. The renderer needs the opposite (every property, sorted) and its
  `matchVariantKey` requires a property to be PRESENT, so an unfilled key matches no variant
  and the block draws as nothing. `deriveDefaults` recovers them exactly and without a table:
  for a block, the values the database ever spells out are precisely its NON-defaults, so the
  one value left in the property's domain is the default. The domain comes from the baked
  bundle's own canonical keys — which is better than the blockstate JSON would have been,
  because the browser has the bundle and not the jars, and because the bundle is already
  canonical. **This matters: 56% of the block states in use in the dev world are modded**, so
  a vanilla-only default table would have left over half the world unnamed.

Honest limits of the spacetime path:

- A dropped item's stack and a falling block's state are not resolved (the row carries the
  spawn-data varint, and resolving it means joining a 344,003-row table a browser should not
  subscribe to), so those two kinds draw as their generic type. The save-file path resolves both.
- Default recovery needs the bundle to cover a property's domain. Measured cross-world
  (bundle baked from the LIVE world, sections from the dev replica), **174 of 217 palette ids
  named to keys the renderer can render**. The 43 misses are states genuinely absent from that
  bake (`minecraft:fire` combinations) plus one property whose domain the bundle under-samples
  (a CC monitor's `state`), and they surface through the existing "NOT IN BAKE" HUD counter
  rather than silently. On a matched world the figure is much higher; a re-bake is the fix.
- Biomes, lighting and block entities still come from the save files. The live path already
  renders fully lit (`World.addLiveSection` takes no light arrays), which is pre-existing.

### 8d. Animated textures (list item 1)

Every animated texture was frozen on frame 0 — every Create belt, every fluid, every fire.

A vanilla animated texture is a vertical strip of frames in the atlas, and the mesher already
maps each quad into frame 0's rect, so playing it is one add on `uv.y`. The new per-vertex
`anim` attribute carries `(frames, frametimeTicks, vStep)` and the vertex shader offsets by
`floor(mod(tick / frametime, frames)) * vStep`.

Per-vertex rather than per-material deliberately: a chunk mixes still stone, flowing water and
a belt, and splitting materials per sprite would multiply draw calls by the number of animated
textures on screen. A still texture has `frames == 1`, which makes the term exactly zero, so
still geometry pays nothing and needs no second shader program.

The clock is in TICKS (`performance.now() / 50`) because that is the unit `.mcmeta` states
`frametime` in — comparing like with like, so `frametime: 2` advances every 2 ticks as in game.

**Verified in a browser:** 99,256 animated vertices across 6,006 meshes, max 32 frames
(water/fire), **zero shader or GL errors**. This world's bake holds 28 animated sprites —
`minecraft:water_still` (32 frames), fire, kelp, seagrass, plus `ae2:`, `advancedperipherals:`
and `minecolonies:` ones, so the path is generic across mods by construction.

### 8e. Entity animation (list item 2)

Mobs were drawn in bind pose: a cow slid across the ground with rigid legs, a spider's legs
stayed horizontal.

**What is exact and what is not, stated plainly.** Vanilla animates in `EntityModel.setupAnim`
— compiled Java, one implementation per model. Unlike model GEOMETRY (declarative data the
harness extracts exactly), that cannot be read out of the jar. So the ANGLES here are a generic
approximation keyed on part NAMES; the maths that applies them is exact. `setupAnim` works by
setting `part.xRot/yRot/zRot`, which are precisely the rotations `partMatrix` already applies,
so a posed part pivots about its own origin and carries its children with it, with no
special-casing.

Matching on names is generic across mods for the same reason the harness's extraction was:
every `LayerDefinition` is built from the same `PartDefinition` keys (`head`, `leg0`..`leg3`,
`right_arm`, `wing`), which mods copy. An unrecognised part is `static` — it keeps exactly the
pose the extracted geometry gave it, so the worst case is the bind pose it already had rather
than a limb rotating through the body.

Two details that make it read right: gait phase is driven by DISTANCE TRAVELLED, not elapsed
time, so a slow walk takes slow steps and a standing mob does not march on the spot; and
amplitude scales with speed, so a mob that stops settles back to bind pose. A teleport or a
multi-second sample gap is rejected rather than counted as a stride — which matters because
positions arrive at packet rate from SpacetimeDB and at flush rate from the save files.

Cost is contained: part trees are baked once per type, poses are quantised to a twentieth of a
radian and the posed mesh cached against that, and a mob below walking speed shares the
per-type rest mesh and rebuilds nothing at all.

**The invariant that matters most is tested against the real extracted models:** posing with
zero rotation reproduces the existing rest pose exactly, quad for quad and float for float, for
cow, chicken, spider and creeper. Without that, switching animation on would shift every mob
and look like an animation bug rather than a transform-chain one.

**Not done here:** secondary layers (sheep fur, armour, saddles) are separate `LayerDefinition`s
and are still not drawn; and part shading is left at the rest pose, so a swung limb keeps its
original face shade.

### Verified

- `npm run test` — **281 + 108 pass, 0 fail** (was 241 + 108; 40 new tests).
- `npx tsc --noEmit` — clean.
- `npm run lint` — back to the **pre-existing** single error (`main.ts:392`, untouched by
  this work). Two complexity violations this work introduced were refactored out.
- `npx vite build` — clean; `physics.json` ships in `dist/`.
- **Deployed and checked end-to-end**: `docker compose build/up -d mcwebviewer`, then from
  inside the bridge container `GET http://mcwebviewer/physics.json` → `200`,
  `content-encoding: gzip`, `version 1.21.1`, `320 shapes`, `18683 rows`. `/`,
  `/entity-models.json` and `/baked/assets.json` still `200`, and `/dev/source.json` →
  `{"source":"bridge",...}` — the deployed default is unchanged. The Minecraft server was
  never touched (`mc-create121` up 3 days, healthy).
- **The spacetime path, against the DEV REPLICA only** (`mcspacetime-devserver`, offline
  mode, :25566 — the live server was never a target). Rust client rebuilt from inside
  `client/` as required; it joined and stayed in. `npm run spacetime-proof` reported:

  ```
  TERRAIN: 17 chunks, 408 sections
    section (5,0,3) bits=5 palette=17 words=342 nonAir=4096
    palette resolves to: minecraft:dirt, minecraft:deepslate, minecraft:infested_deepslate,
                         minecraft:stone, minecraft:gravel, minecraft:andesite
    U64 fidelity: 341/342 words exceed 2^53; typeof word = bigint  => no loss
  LIVE EDITS: 20 block_change rows across 4 distinct positions
    (69,64,43) -> state 4276   <= a one-off edit      # setblock diamond_block
    (69,65,43) -> state 522    <= a one-off edit      # setblock lapis_block
  ENTITY MOTION: 39 position updates in 18s across 2 type(s): minecraft:wolf, ...
    the flush path would have managed at most 9
  ```

  State ids resolve back correctly: `4276 -> minecraft:diamond_block`,
  `522 -> minecraft:lapis_block` — exactly the two blocks placed.
- **In a real browser** (headless Chrome against the dev server with
  `MCWV_SOURCE=spacetime`): `source: spacetime (mcspacetime @ …) [url]`,
  `spacetime: connected`, `spacetime: entity subscription applied`, HUD
  `spacetime: 5 entities moves=18`, and **no page errors**. The SDK lands in its own
  112 kB chunk (27.7 kB gzipped) behind a dynamic import, so the bridge path does not
  download it.
- The new tests run the real `public/physics.json`, not a fixture, so a broken
  regeneration fails loudly instead of degrading movement quietly.

**Not verified:** the predictor against a live joined bot. That would spawn a player into
the running world, so it was left as a deliberate choice rather than done unasked. The HUD
drift number is the instrument for it and it is one Join away.

---

### 8f. Fluids (water and lava) — half a million blocks that rendered as nothing

`registry.ts` returned `quads: []` for every fluid state and the mesher believed it, so the
world had no water and no lava. Measured on the live world: **503,185 fluid cells were
loaded and none of them drew** — 453k water sources, 36k lava, 3.3k falling water, plus
2,911 kelp and 1,196 seagrass standing in holes.

The failure mode is why it survived: a fluid legitimately has no `elements` in its model
JSON, because vanilla draws it in `LiquidBlockRenderer` from code. Nothing in the asset
pipeline could report anything missing, and `unresolved states: 0` stayed honest the whole
time. There was nothing to find until someone looked at an ocean.

**The heights are measured, not derived from the property name.** `ExtractFluids` in the
harness reads `BlockState.getFluidState()` for all 26,684 states and emits the 9,246 that
carry a fluid. The rule `amount = level < 8 ? 8 - level : 8`, `height = amount / 9`
reproduces every one exactly. The measurement corrected the obvious reading: **`level` 8..15
is FALLING fluid at FULL height**, not progressively lower than level 7 — writing the
plausible formula would have made every waterfall a sliver.

Three things the data forced that a vanilla-shaped guess would have missed:

- **9,182 of the 9,246 fluid states are `waterlogged=true`.** A flooded stair needs BOTH its
  own model and the water inside it, so the mesher emits the fluid as a separate synthetic
  state — otherwise the water inherits the host block's cutout layer (no blending) and its
  absent tint (white water).
- **Kelp and seagrass hold water and say so nowhere in their block state.** `ALWAYS_FLOODED`
  covers them, derived from the extraction rather than listed by hand.
- **No mod in this 130-mod pack adds a placeable fluid.** Measured: every fluid in the game
  is `minecraft:water` or `minecraft:lava`. `fluids.test.ts` re-derives the recognised set
  from `physics.json` on every run, so a mod that adds one fails the test instead of quietly
  rendering a hole.

The four sprites (`water_still`, `water_flow`, `lava_still`, `lava_flow`) had to be forced
into the bake, exactly as `destroy_stage` did and for exactly the same reason: nothing
references them through a block state, so the collector never found them. `water_still` is
32 frames and rides the existing `anim` vertex attribute, so it flows.

Corner heights are averaged over the four cells meeting at each corner, which is what makes
a shoreline slope instead of terrace. 28 behavioural tests run the real `meshSection` over
hand-built sections: a lone water cell emits 6 faces, a 4x4 pool emits 48 not 96 (the 24
internal adjacencies hide a face on each side), a 5-deep column emits one surface not five,
and a waterlogged fence out-quads a dry one.

Files: `src/render/fluids.ts` (new), `src/render/fluids.test.ts` (new),
`src/render/mesher.ts` (`emitFluid`), `src/tools/bake-assets.ts` (`FLUID_SPRITES`),
`harness/src/mcextract/ExtractPhysics.java` (`extractFluids`).

### 8g. Secondary entity layers — measured first, which changed what got built

Vanilla builds a mob from a base model plus a stack of `RenderLayer`s. The extraction
captured base models only (`entity-index.json` lists `allModels: ["minecraft:sheep#main"]`),
so every mob rendered as its bare body.

**The measurement reordered the work and cancelled most of it.** Counted against the live
world's 713 entities:

| layer | affected | built |
|---|---|---|
| sheep wool | **28 of 28** sheep, none sheared | yes |
| wolf coat | **27 of 31** wolves are woods/chestnut, all drawn pale | yes |
| horse coat | **5 of 5**, all drawn white | yes |
| mob armour | **0 of 713** | no |
| wolf / cat collars | **0 of 33** are tamed | no |
| horse saddle + armour | **0 of 6** | no |
| donkey chest | **0 of 1** | no |

Armour and collars were the obvious things to build and would have been completely
invisible. A sheep with no wool is *indistinguishable from a sheared one*, which is exactly
why 28 broken sheep looked like 28 ordinary sheep and nobody reported it.

**Two things the data contradicted:**

- **The sheep tint is not the dye table.** White wool is 0.9020 grey where white dye is
  `0xf9fffe`, and every other colour is the dye scaled by ~0.75 — vanilla darkens wool so a
  sheep does not blow out. The first draft of `SHEEP_RGB` used the dye values and the test
  that re-derives it from `physics.json` rejected 15 of the 16. Extracted via
  `Sheep.getColor(DyeColor)` in `ExtractPhysics.extractDyes`.
- **A wolf's coat cannot be derived from its variant name.** `minecraft:pale`'s wild texture
  is `entity/wolf/wolf`, not `wolf_pale` — the convention breaks on vanilla's own default
  before any mod is involved. So the coat is read from `data/<ns>/wolf_variant/<name>.json`,
  which also means a mod that adds a variant works with no code change. The browser has no
  packs, so the table is baked into the bundle as an optional `entityVariants` field.

The layer textures had to be forced into the bake — `spriteIds` returns one texture per
entity TYPE, so a layer's texture is named by nothing and never reaches the atlas. Third
time for this trap after `destroy_stage` and the fluid sprites, and the symptom is always
the same: geometry sampling a sprite that is not there, with no error anywhere. A layer
whose texture is missing is now skipped rather than drawn.

Meshes are cached by APPEARANCE rather than by type, or a world of sheep would all be one
colour. `appearance.key` is `''` for a mob with nothing special about it, so the ordinary
case still meshes once for the whole world.

Files: `src/render/entity-layers.ts` (new), `src/render/entity-layers.test.ts` (new, 25
tests), `src/render/entity-geometry.ts` (layered `buildEntityQuads` / `buildPosedParts`),
`src/render/served-assets.ts`, `src/app/entity-tracks.ts`, `src/app/live-entities.ts`,
`src/tools/bake-assets.ts`, `src/assets/pack.ts` (`VARIANT_PATH`), `src/server/asset-format.ts`,
`harness/src/mcextract/ExtractPhysics.java` (`extractDyes`).

### 8h. Materials from block entities, and the rest of the entity layers

**Domum Ornamentum.** One block — `domum_ornamentum:plain` — stands in for every wood and
stone in the game, and which one it IS lives in the block entity as `textureData`. Measured:
28 placed blocks, all carrying `{oak_planks -> birch_planks, dark_oak_planks ->
birch_planks}`, all drawing in oak. At 126 quads each that is **3,528 quads of the wrong
wood**.

`render/retexture.ts` names no mod. The rule is "a block entity carrying a texture map
retextures the block it sits in", which is the shape Domum's and MineColonies' whole family
uses; the block entity's `id` is never consulted. Two things it gets right by going through
the registry rather than guessing: the map's VALUE is a block id, not a texture, so
`minecraft:birch_planks` resolves through that block's own model (a modded material whose
texture is not at `block/<name>` still works); and an unresolvable material leaves the
template texture rather than sampling atlas (0,0).

The substitution happens in the mesher, not the registry, because a `RenderableState` is
shared by every cell with that state and two Domum blocks of the same state are routinely
different materials. It is keyed per section like `hiddenIn`, so a section with no such
block entity pays nothing.

The materials had to be added to the bake as STATES — the world holds
`domum_ornamentum:plain`, not the birch planks it is made of, so nothing referenced the
sprite. **Fourth outing** for this trap after `destroy_stage`, fluid surfaces and entity
layers.

**Villager robes and horse markings.** Both are the same model as the body with a
mostly-transparent texture drawn over it, which is why they were held back: the worry was
z-fighting, and an inflate would have been a guess. Settled by measurement instead —
**every material in the live scene reports `depthFunc: 3` (`LessEqualDepth`)**, three.js's
default, so exactly-coplanar geometry submitted later wins the depth test. That is precisely
how vanilla layers them, and no inflate is needed. 7 villagers (5 unemployed, so the biome
robe matters more than the profession one), 5 horses, all now correct.

### 8i. Particles — measured, not built, and here is the number

107 of the game's blocks override `animateTick`, which is exactly "does this block emit
ambient particles?" — asked of the class rather than a list, so it covers mods. Placed in
the live world: **598,096 cells**, which is the misleading figure. Split by whether the
emitter's condition actually holds:

- **39,104 cells emitting** — and 38,174 of those are lava, nearly all of it deep
  underground and never on screen. The ones a person would notice are 49 torches, 14
  campfires, 38 spore blossoms, 35 spawners, 456 bubble columns, 324 magma.
- **28,552 cells whose condition is false** — unlit redstone ore (28,479), unlit furnaces,
  inactive sculk sensors. Vanilla draws nothing for these either.
- **~568,000 cells effectively never emit**: gravel and sand (421k + 37k) only animate when
  the block below is air and they are about to fall; leaves (110k) only drip when it is
  raining.

**Not built, and the reason is a kind, not a count.** `animateTick` is imperative Java, not
declarative data. A `VoxelShape` can be read out of the game and a model is JSON, but "which
particle, where, how often" exists only as a method body. There is no generic extraction, so
covering mods is impossible in principle and the only option is per-block vanilla code —
about ten emitters for the visible cases. That is exactly the vanilla-only hardcoding this
audit exists to object to, and the largest contributor is invisible underground. Recorded
here so the decision is on the record rather than a silent omission.

## 9. Ranked next steps, by impact ÷ effort

1. **Block-break progress is now unblocked** (§3). The hardness half is done and shipped —
   `physics.json` carries `getDestroySpeed` for every vanilla state, and the 10
   `destroy_stage_N.png` textures are confirmed present in the client jar. What is still
   missing is the *tool* half: the mining-speed formula needs the held item's tier and its
   efficiency/haste, and the bridge currently reads only stack ids and counts
   (`bridge/src/player-state.mjs:25-32`). One more extraction pass (item → tool tier +
   mineable tags) plus the crack overlay finishes it. **Highest value now.**
2. **Finish the spacetime path: biomes, lighting, block entities.** Terrain and entities are
   done (§8c) — 490 sections rendered in a browser with zero unnamed cells — but biome tint,
   light arrays and block entities still come from the save files, so the `save-all flush`
   has not yet been removed from the block path. `chunk_section` already carries the biome
   container in the same layout, and `block_entity` already carries the CC:T fields the
   viewer wants, so both are wiring rather than research. Lighting is the real gap: the
   module does not carry light arrays, and the live path renders fully lit.
3. **Extract collision shapes for MODDED blocks.** The harness boots vanilla, so tier 1
   covers vanilla only and mod blocks land on tier 2/3. `coverage()` now measures how often
   that happens — measure before building. The real fix is loading mod blocks through
   NeoForge, which is a much larger job than this pass was.
4. **Animated-texture UV scrolling.** Small, self-contained, instantly visible on every
   Create machine in the world (`ARCHITECTURE.md:517`).
5. **Recipes.** Widen `src/assets/pack.ts:65-80` to keep `data/**/recipe/*.json` (3063 in
   the Create jar alone, currently dropped at the door), or dump the resolved
   `RecipeManager` via KubeJS — better, since it includes runtime modifications.
6. **`setupAnim` replay for walk cycles.** The harness already extracts the part hierarchy;
   a generic limb swing driven by horizontal speed covers most of what the eye reads as
   "alive" without reimplementing every mob.
7. **Sounds.** Vanilla `.ogg`s are not in the client jar (checked: 0 of them) — they need
   Mojang's asset index, which `scripts/fetch-assets.mjs` does not fetch. Mod sounds are in
   the jars and dropped by the same filter as the recipes.
8. **Off-hand and first-person held item.** Needs `Offhand` added to the vitals read and a
   WebGL view-model. Cosmetic next to the above.

## 10. What I did not get to

- §3, §5 and §6 remain as audited — no implementation beyond unblocking §3's data half.
- Modded blocks still do not get exact collision (tier 2/3). Slabs, stairs, fences, walls,
  doors, trapdoors, carpets and panes are now exact for vanilla, which is most of what a
  player actually walks on in this world.
- No KubeJS script was installed: that is a change to the Minecraft server's data
  directory rather than to this repo, and it deserves to be a deliberate decision.
- Fluid movement (swimming, lava slowdown) is not modelled; water has no collision box, so
  the predictor falls into it and the reconciliation carries the rest.
