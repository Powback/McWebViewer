# McWebViewer

A browser Minecraft save-file viewer. Reads Anvil region files and renders them in
three.js with vanilla-accurate block models, biome tint, ambient occlusion and face
culling — including modded content, read straight from the mod jars.

No server component. No bundled game assets. Written against a real Minecraft 1.21.1
NeoForge world with 128 mods (Create 6.0.10, Create Aeronautics, ComputerCraft: Tweaked,
Applied Energistics 2, MineColonies).

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the research findings, the decisions and
their reasons, and an explicit list of what was rejected and why.

---

## What works

- **Custom NBT reader** — all tag types, gzip / zlib / uncompressed / LZ4, Java modified
  UTF-8. Zero dependencies.
- **Custom Anvil reader** — 1.21 chunk format: sections, block and biome palettes,
  heightmaps, block entities, light arrays, external `.mcc` chunks detected.
- **Asset pipeline** — reads the vanilla client jar, all 128 mod jars and resource packs
  as a precedence stack, exactly as Minecraft layers them.
- **Server-side asset bake** — blockstate resolution, model baking, PNG decoding and atlas
  packing all happen once on the server. The browser fetches a 224 KB bundle instead of
  476 MB of jars, and runs identical code from the mesher down.
- **Model baking** — blockstate `variants` and `multipart`, parent chains, `#texture`
  indirection, element rotation with `rescale`, variant `x`/`y` rotation, `uvlock`,
  position-hashed weighted variants, `render_type`, `cullface`, `tintindex`.
- **Derived, not hardcoded** — render layer and occlusion come from reading the sprite
  PNG's alpha channel, and block-entity blocks are detected structurally, so modded
  blocks are classified correctly without a per-mod table. See ARCHITECTURE.md §3.
- **Custom model loaders** — `neoforge:obj` (Create's crushing wheels, water wheels,
  bogeys), `neoforge:composite`, `computercraft:turtle`, with documented static fallbacks
  for `fusion:model` and `domum_ornamentum:materially_textured`.
- **Mesher** — face culling, vanilla directional shading, smooth lighting, per-vertex AO
  with vanilla's diagonal flip, three render layers with correct transparency ordering.
- **Renderer** — three.js, per-section BufferGeometry, frustum culling, distance-ordered
  chunk streaming on a per-frame time budget.
- **Biome tint** — data-driven from biome JSON + colormaps, works for modded biomes, and
  applied **per quad** via each face's `tintindex`, so a grass block's top and side overlay
  go green with the biome while its dirt sides stay brown.
- **Block-entity geometry** — chests, beds, signs, banners, skulls, decorated pots and
  shulker boxes, whose models vanilla builds in Java. Synthesized from constants read out
  of the client jar's class files. See ARCHITECTURE.md §5a.
- **Entity/mob geometry** — 426 models (5,957 cubes) extracted from the game and mod jars
  by a real JVM harness (`harness/`), covering 34 of the 37 entity types that previously
  drew nothing, modded mobs included. See ARCHITECTURE.md §5b.
- **Create contraptions** — decoded from entity NBT and rendered through the ordinary
  block pipeline under the entity transform, with no Create-specific geometry code.
- **Coverage audit** — a repeatable command that reports exactly what does and does not
  render.
- **Live mode** — an RCON bridge draws players at ~1 Hz and re-reads changed chunks after
  a **guarded** `save-all flush` (off by default, only while a viewer is connected, 2 s
  floor, self-backing-off). Only the sections that actually differ are re-meshed. See
  [Live mode](#live-mode--watching-a-running-server).
- **Play from the browser** — a Join button spawns a server-side fake player you drive
  with WASD and the mouse. Needs SiliconeDolls on the server; off by default, and the
  button stays disabled with the server's own reason when it cannot work. See
  [Playing from the browser](#playing-from-the-browser).

## What does not work yet

Stated plainly; see ARCHITECTURE.md §6.

- **3 entity types** (`item`, `item_frame`, `painting`) plus 3 modded billboard entities
  still draw nothing — none has a `LayerDefinition` to extract. See ARCHITECTURE.md §6.
- **Entities render in bind pose** — no `setupAnim`, so a spider's legs stay horizontal;
  no secondary layers (sheep fur, armour, saddles). Live players are drawn the same way,
  and always with the default Steve skin.
- **Live mode sees blocks, not entities.** Mobs and items are read from the save files at
  load and are not refreshed; a turtle moving shows up (it is a block), a cow walking does
  not. Live *players* come from RCON and do update.
- **Click-to-move in isometric mode is steering, not pathfinding.** The bridge's command
  set has no goto in it, so the character faces the point and holds forward. It jumps at a
  step it cannot walk over and gives up after four seconds of no progress, but it will not
  walk around a tree. See [Isometric mode](#isometric-mode).
- **Playing from the browser is off by default** and needs a server-side mod
  (SiliconeDolls). It is installed on the reference server, so the Join button works
  there; on a server without it, the button stays disabled and says why rather than
  accepting input it cannot honour. See
  [Playing from the browser](#playing-from-the-browser).
- **Fluid geometry** — water and lava are identified but not yet meshed (vanilla renders
  them procedurally, not from models).
- **Modded block entities** with Java-built geometry are detected and reported, but only
  vanilla's set is synthesized.
- Animated texture scrolling and mipmaps.
- **Shaderpacks: translated and wired, but never run on a GPU.** Sildur's Vibrant Lite
  reaches 21/21 programs in WGSL and the Iris runtime contract is implemented on WebGPU,
  but no WebGPU device is reachable from this machine, so the render path is unverified.
  See [SHADERPACKS.md](./SHADERPACKS.md) §9.

---

## Setup

```bash
npm install
npm run fetch-assets     # downloads the 1.21.1 client jar into .cache/ (gitignored)
npm run bake-assets      # bakes the world's assets once — see below
npm run dev              # http://localhost:5180
```

### Bake the assets first

`npm run bake-assets` reads the jars and the world **once, on the server**, and writes a
small bundle to `.cache/baked/`. Without it the browser falls back to fetching every jar
and redoing the whole asset pipeline on each load — for the reference set that is **476 MB
and ~55 s**; with it, **224 KB and first geometry in 2.4 s**.

```bash
npm run bake-assets -- --regions r.-1.0.mca      # one region
npm run bake-assets                              # every region in the world
```

Re-run it when the mod set changes, or when the world gains block states it did not have
(the bundle covers the states present at bake time; anything newer renders as nothing and
is counted in `unresolved`). The bake is ~1 s for a region, so re-running it is cheap.

`fetch-assets` pulls the client jar from Mojang's `piston-meta` the same way the launcher
does. It is cached locally and **never redistributed** — block models and textures are
Mojang's, and the app expects you to supply your own copy.

### Loading a world

**Drag and drop** onto the page:
- the vanilla client jar (for vanilla blocks),
- any mod jars (for modded blocks),
- one or more `.mca` region files from `<world>/region/`,
- optionally `.mca` files from `<world>/entities/` and any resource-pack `.zip`s.

**Dev shortcut:** `http://localhost:5180/?auto=1` loads the reference world and mod set
through a read-only mount configured in `vite.config.ts`. Override with:

```bash
MCWV_REF=/path/to/server/data MCWV_REGIONS=r.0.0.mca,r.0.1.mca npm run dev
```

Add `&at=x,y,z,dist` to place the camera for a reproducible screenshot.

Controls, desktop: click to capture the pointer, `WASD` + `Space`/`Shift`, scroll to change
speed, `Ctrl` to sprint.

Controls, touch: drag on the **right** half of the screen to look, drag on the **left** half
as a virtual stick to move. There is no separate up/down control — movement follows the
camera, so look up and push forward to climb.

While *playing* (not just flying), touch also gets an on-screen pad — MINE (press and
hold), PLACE, JUMP, INV — and `V` or the **Isometric** button switches to the top-down RTS
camera. See [Playing on a phone](#playing-on-a-phone) and [Isometric mode](#isometric-mode).

### Shaderpacks

```bash
npm run build-shaderpack -- .cache/shaderpacks/sildurs-lite    # once, per pack
```

Then add `&shaders=sildurs-lite` to the URL. **This needs a browser with WebGPU** — the page
falls back to the ordinary renderer and says why in the HUD when it does not have one. The
bundle is served from the read-only `.cache` mount and is never baked into the image: it is a
derived work of the pack, and packs like Sildur's forbid redistribution.

See [SHADERPACKS.md](./SHADERPACKS.md) §9 for what works, the three failures inherent to
WebGPU, and what is not verified.

### Live mode — watching a running server

`?live` keeps the save-file renderer exactly as it is and adds two things a static read
cannot give you: **where the players are right now**, and **blocks changing as they
change** — turtles stepping, pistons firing, doors opening.

```
browser  <--WebSocket-->  bridge  --RCON-->  Minecraft server
   |                                              |
   +------------- HTTP: region files <------------+   (flushed on a guarded timer)
```

The bridge (`bridge/`) is a **read-only observer**. It issues three commands and no
others: `list`, `data get entity <name> Pos|Rotation|Dimension`, and `save-all flush`.
It accepts nothing from the browser — there is no control surface to get wrong.

```bash
docker compose up -d --build
```

Then **http://mcwebviewer.pow/?live** (add `&at=x,y,z,dist` to aim the camera). The
bridge's socket is proxied at `/live` on the same origin, so there is no second hostname
and no cross-origin WebSocket. `?live=ws://elsewhere:8080` overrides it.

You fly with the ordinary controls. Live mode does not drive anything in the world.

#### Live players

Polled at 1 Hz (`MCWV_POLL_MS`, floor 500 ms), drawn with the extracted player model.
Two honest limits: everyone is **Steve** — fetching real skins would mean the page
calling Mojang for every player it sees, which a LAN-only viewer should not do — and
they render in **bind pose**, like every other entity here, so a walking player slides
rather than strides.

#### Live block changes — and what they cost the server

Minecraft only writes chunks to disk when it saves, so seeing a turtle move means asking
it to: `save-all flush`, then re-reading the region files. **That command runs on the
server's tick thread**, which on the reference server is also the thread a ComputerCraft
turtle fleet depends on. That fleet has already been destroyed once by a server that
could not tick. So this is a trade of **server tick budget for viewer latency**, and it
is configured as one:

| variable | default | what it does |
|---|---|---|
| `MCWV_FLUSH_ENABLE` | **`0` — off** | Nothing flushes until you set this to `1`. Live players still work; block changes do not. |
| `MCWV_FLUSH_MS` | `5000` | Flush cadence. **Clamped to a hard floor of 2000 ms** — a lower value is silently raised, because the cost lands on the server, not on the viewer. |
| `MCWV_FLUSH_SLOW_MS` | `1000` | A flush slower than this means the server is struggling. The interval **doubles** and says so in the log, up to 120 s, and eases back only after five consecutive fast flushes. |

Two further guards are not configurable:

- **Only while somebody is watching.** The timer is armed by the first WebSocket client
  and disarmed by the last. Zero viewers means zero flushes, and the first flush comes
  one full interval *after* a client connects, so a browser in a reconnect loop cannot
  become a flush loop.
- **Never overlapping.** A flush still in flight when the next is due is skipped, not
  stacked.

Put `MCWV_FLUSH_ENABLE=1` in `.env` next to `docker-compose.yaml` to turn it on.

**What this actually does on the reference server.** An idle `save-all flush` answers in
~130 ms, but the first flush after a quiet period — and any flush while the host is busy —
takes 1–7 s. So the 1 s default trips routinely and the cadence walks out to 20–40 s
within a few minutes. That is the guard working, not a bug: a server taking seven seconds
to save is a server you should be asking less often, not more.

If you want a 5 s cadence to actually hold, raise the threshold rather than removing it —
`MCWV_FLUSH_SLOW_MS=8000` — and understand you are choosing to keep flushing through a
server that is visibly slow to save. On a box that also runs a turtle fleet, that is a
real decision. The bridge logs every back-off, so `docker logs mcwv-bridge` tells you what
the server has actually been doing.

#### How little it re-reads

A region file is 5–15 MB and the reference world meshes 1,360 sections. Re-fetching and
re-meshing all of that every 5 s would not be a live view. Instead
(`src/app/region-sync.ts`):

1. an HTTP **Range request for bytes 0–8191** reads the region header, whose timestamp
   table already says which of the 1024 chunks the server rewrote;
2. a second Range request fetches **only those chunks' sectors**;
3. `diffSections` compares the decoded sections against what is loaded, so a turtle
   stepping one block re-meshes **1–2 sections**, plus their neighbours because face
   culling reads across section boundaries.

Measured on the deployed viewer: an idle poll costs **8 KB**, and a poll that found
changes re-meshed 17–55 sections in **23–174 ms**.

#### RCON reachability, without touching the server

The reference server has `enable-rcon=true` on port 25575, but **does not publish that
port to the host** — from the Mac it is `ECONNREFUSED`. Publishing it would mean editing
and restarting `minecraft-create121`, which is not on the table.

Instead the bridge joins the Minecraft stack's own Docker network
(`minecraft-create121_default`, declared `external` in `docker-compose.yaml`) and reaches
RCON at `mc:25575`. That is a change to *this* project's container only: nothing about
the Minecraft server, its config, or its uptime is touched.

### Playing from the browser

`?live` gives you a **Join** button. Press it and the server spawns a fake player you
drive: WASD, mouse-look, click to dig, right-click to place, number keys for the hotbar.
The camera follows wherever the server says the bot is. Press Escape then **Leave** to
despawn it; it also despawns automatically when the last viewer disconnects.

This needs a server-side mod, and **the reference server now has it**:

| mod | why | side |
|---|---|---|
| [SiliconeDolls](https://modrinth.com/mod/silicone-dolls) | provides `/player <name> …` | `server` |
| [RollingGate](https://modrinth.com/mod/rolling-gate) | SiliconeDolls' required dependency | `server` |

Both are pinned `side = "server"` in the packwiz manifest, so the client `.mrpack` does
not carry them and there is no client/server drift — drift being what produced the
`levelz` packet-decode crash on the old 1.20.1 server.

```bash
cd pack && packwiz modrinth add silicone-dolls && packwiz modrinth export -o pack.mrpack
docker compose up -d --force-recreate mc          # ~2m40s, full server restart
```

Then in this project's `.env`:

```
MCWV_FAKEPLAYER_ENABLE=1     # DEFAULT OFF
MCWV_BOT_NAME=WebViewer
```

> **The RCON password is regenerated when itzg rebuilds `data/`.** A `--force-recreate`
> that re-resolves the modpack rewrites `server.properties`, so `MCWV_RCON_PASSWORD` in
> `.env` will be stale and the bridge will log `rcon auth failed (bad password)`. Copy the
> new `rcon.password` across after any pack change.

#### Nothing spawns until you ask

The flag only permits an *attempt*. No fake player is created when the bridge starts — a
bot standing in the world because a container booted is a bot nobody asked for. The first
**Join** press is also the capability probe: a server without the mod answers `Unknown or
incomplete command`, and the bridge then latches the control path off, **refuses every
subsequent control message**, and the browser binds no controls at all and prints the
server's own words under a disabled button.

That gate is the point. An earlier version bound WASD, mouse-look, dig and place
unconditionally, so on a server without the mod the page looked playable, accepted input,
and silently dropped it. "Controls that do nothing" is a worse failure than "no controls",
because only one of the two tells you what is wrong.

If RCON drops while a bot is joined, the despawn cannot be delivered — so on reconnect the
bridge reconciles: with no viewers watching, a surviving bot is despawned. It never
re-spawns one, because a connection blip is not a reason to put a player into a live
server.

#### SiliconeDolls is not fabric-carpet

Three differences, all verified against the live server rather than taken from
documentation, and **all three fail quietly**:

| | fabric-carpet | SiliconeDolls |
|---|---|---|
| stop moving | `player X move` | `player X stop` — a bare `move` is rejected |
| hotbar | slots 0–8 | slots **1**–8; `hotbar 0` errors, `hotbar 9` is "Invalid slot" |
| absolute look | `player X look <yaw> <pitch>` | **does not exist** — `look` takes only `at <pos>` or a compass direction |

The last one matters most. `turn` is *relative* on both mods, and the browser has an
absolute yaw. So the bridge keeps a model of the bot's rotation, sends the delta, and
re-anchors that model from the real `Rotation` on every 1 Hz player poll — so a dropped
turn cannot make the view drift for more than a second.

#### And the trap under all of that: three.js yaw is not Minecraft yaw

A three.js camera at yaw 0 looks down **-Z**. Minecraft's yaw 0 faces **+Z**. The
conversion is `minecraftYaw = 180 - browserYawDegrees`, *not* `-browserYawDegrees` — the
same 180° the renderer already handles in `entityYawDeg()` when it *draws* a player.

Getting it wrong is completely silent, and it shipped that way: the body faced the reverse
of the camera, so **W walked backwards, A strafed right, and the crosshair pointed at the
block behind you**. Nothing errored. Measured against the live server — camera facing
`(0,0,-1)`, `W` moved the bot `+3.7` on Z, a dot product of `-1.000`. It is now one
exported `mcRotation()` in `bridge/src/fake-player.mjs`, and the test asserts *direction
vectors* rather than angles, because two wrong sides can agree on a number and cannot
agree on a heading.

The bot also spawns facing whatever the server chose, so the browser pushes its look the
moment controls bind. Without that, a player who pressed W before touching the mouse
walked off on an unrelated heading even with the conversion right.

#### The one line to read when the controls do nothing

Live mode prints an input diagnostic in the HUD, always on:

```
input: mode=first pad=no bound=yes lock=yes fine=yes touch=0 keys=forward raw=14 try=9 sent=9 drop=0 ack=input 0.2s driving
```

Every layer a keystroke has to survive, counted separately, because they all fail the same
silent way and the only thing that tells them apart is which counter stopped moving:

| field | what a bad value means |
|---|---|
| `mode` | which camera owns the screen, `first` or `iso`; `iso(bound)` means the isometric input path is attached |
| `pad` | whether the on-screen action pad is up — `no` on a phone means MINE, PLACE and JUMP have no button |
| `bound` | `no` — Join has not succeeded; there are no listeners at all |
| `lock` | `no` — no pointer lock; drag-to-look is in use (still playable) |
| `fine` | `no` — a touch device, so `raw=0` is expected, not a fault |
| `touch` | touch points seen; the same fact from the other side |
| `keys` | what is held right now, key names and stick alike |
| `raw` | keydowns the window saw **at all**. `0` while you press keys means the page does not have the keyboard, and nothing downstream can fix it |
| `try` | intents built and handed to the socket |
| `sent` | frames that actually went out on the wire |
| `drop` | intents refused because the bridge has not said a bot is joined |
| `ack` | the last frame the **bridge** said it handled, its age, and whether it could act (`driving` / `IDLE`) |

`raw` climbing while `try` does not is a filter bug in the browser. `try` climbing while
`sent` does not is the join gate. `sent` climbing with no `ack` is the socket or the bridge.
`ack ... IDLE` is the bridge receiving input it is not in a position to act on. A refused
pointer lock appends `POINTER LOCK REFUSED: <the browser's own words>`.

This exists because "the controls do nothing" was reported from a real browser that no
headless harness could reproduce, three separate times, for three different reasons.

#### Control gets its own RCON connection

`save-all flush` takes 1–7 s on this server and **blocks the connection it runs on for the
whole of it** — RCON is one request per connection at a time, by protocol. With a single
pipe, a Join or a keypress issued while a flush was in flight queued behind it and often
exceeded the 8 s command timeout. The symptom was brutal and looked like something else
entirely: you pressed Join, nothing spawned, and the only way to play was to turn live
block updates off.

So the bridge opens **two** RCON connections: one for polling and flushing, one used only
for control. Vanilla's RCON server handles each connection on its own thread with its own
buffer, so this is not the pipelining hazard that two in-flight commands on *one*
connection are (see below). Measured after the change, with flushing on and the cadence at
its 5 s worst case: **five consecutive Joins landed in 51–55 ms**. They now genuinely
coexist, and `MCWV_FLUSH_ENABLE=0` is no longer the price of being able to play.

If the second connection cannot be opened, control falls back to the shared pipe and says
so in the log — degraded control beats none.

A Join that still fails is *not* a verdict about the mod, so it no longer latches the
control path off: the button stays enabled, says what happened, and pressing it again
works. A server that actually *answers* `Unknown or incomplete command` still latches,
permanently, which is the guarantee that matters.

#### The overshoot that removing the queue created

Giving control its own connection made the rotation poll and a `turn` command genuinely
concurrent — and that exposed a bug the shared pipe had been hiding. `turn` is relative, so
the bridge models the bot's rotation and re-anchors it from a `data get … Rotation` each
poll. If that read was **issued before a turn and answered after it**, it describes the bot
*before* the turn. Anchoring to it rewinds the model, and because the browser holds an
**absolute** angle, the next look computes the same delta again and the server applies it
twice.

Measured, as a unit test: **the bot turned 180° for a 90° target**, then oscillated. That is
what "turning and hitting disagree" mostly was — not round-trip lag, arithmetic.

Each turn now bumps a sequence number, and a rotation read carries the value it saw when it
was *issued*. A mismatch means the answer raced a turn, and it is discarded rather than
merged; the next poll is at most 500 ms away and the model is exactly right in between
unless a command really was dropped. A read that did *not* race a turn is still applied, so
a genuinely dropped `turn` is still corrected — both directions have a test.

With that fixed, the look throttle came down from 100 ms to **50 ms**, which is the
server's own tick and the floor that matters, since RCON commands drain on the tick thread.
Halving it was only safe once control stopped sharing a pipe with the 10 Hz position poll
and a 1–7 s flush.

#### A dead tab must stop counting as a viewer

nginx proxies this socket with `proxy_read_timeout 3600s`, so a browser killed without a
close handshake leaves the upstream connection established for up to an hour. The bridge
counted that as a viewer, and the flush timer's whole safety property — *zero viewers means
zero flushes* — quietly stopped holding. Observed: `flush.running` was true with no browser
anywhere and only the RCON socket left in the container.

The bridge now pings every viewer every 30 s and drops any that misses two rounds.

#### Playing on a phone

The Join button has always been sized for a thumb, and the fly camera has always had touch
controls — but the *playing* controls did not. Pointer lock does not exist on touch and
there is no keyboard, so every control the play path bound was one a phone cannot produce:
tapping Join gave a HUD and a view that no gesture could move or turn.

Touch now uses the same layout as the fly camera, so the gesture you learn watching still
works playing: **left half is a movement stick, right half is a look drag.** The stick
resolves to one direction past a dead zone rather than a blend, because `move forward` and
`move left` are separate stateful commands on the server and only one can run at a time.

**Jump, mine and place needed buttons.** The stick and the look drag covered walking and
turning, and every remaining verb was still bound to `Space`, the left mouse button and the
right mouse button — none of which a phone can produce. Driven on an emulated iPhone
against the live bridge, a tap, a 1.2 s hold and a two-finger tap each put **zero** intents
on the wire, while the same session's stick and look drag produced `input` and `look`
normally. The gestures were not subtly wrong; the verbs were never bound.

So there is now an on-screen pad — MINE, PLACE, JUMP, INV — bottom-right, where a right
thumb reaches without fighting the stick (left half), the hotbar (bottom centre) or chat
(bottom left). It appears only on a device that needs it: `(pointer: coarse)` or a non-zero
`maxTouchPoints`, plus a fallback that reveals it the moment a real touch lands, because
that media query is a good guess and not a guarantee.

**MINE is a hold, not a tap.** Minecraft breaks blocks over time and the *server* owns that
timer, so the button reports its edges and nothing else; a tap handler would send both
inside one frame and never break anything harder than a torch. Its release is bound on the
window rather than on the button, because a finger that slides off before lifting delivers
its `touchend` somewhere else entirely. A crosshair marks what MINE and PLACE are aiming
at — without one, "mining does not work" is usually "mining works and you were aiming at
the sky".

A phone also gets no `mouseup` and no `pointerlockchange`, which were the only two things
that used to stop a dig. Backgrounding the tab or locking the screen mid-hold now releases
it too; otherwise the bot mines until somebody notices.

#### Isometric mode

An alternative camera, toggled with the **Isometric** button (or `V`), for looking at your
character rather than out of its eyes: fixed 35.3° pitch and 45° azimuth, tap the ground to
walk there, drag to pan, pinch or scroll to zoom.

It is a narrowed perspective camera (26° FOV at ~44 blocks), not an orthographic one.
`Viewer` owns a single `PerspectiveCamera` and the meshing queue, the shaderpack path and
`FlyControls` are all typed on it; swapping the projection would touch all of that to
change how one mode looks. The field of view is put back exactly on the way out.

**Nothing may hide the character.** Only what is genuinely between the camera and the
character is faded out, decided per fragment: a fragment goes only if it is *both* inside a
small disc around the character's screen position *and* nearer to the camera than the
character is. The disc is specified in blocks at the character's own depth, so the hole
stays the size of the character at every zoom level, and it fades across a ring with a
screen-space dither rather than ending at a hard edge.

**The first version of this cut by HEIGHT and it was wrong.** It clipped the world at
`playerY + 3` with one global plane. That made the character visible — measured with the
camera at its most-blocked azimuth, 10 solid blocks on the sightline: **0 pixels of the
character reached the screen before, 2601 after** — and shipping on that measurement is the
mistake, because it only asked whether the character came back and never whether anything
else went away. Two things had:

- A height removes every block above it *everywhere*, occluding or not. You saw through
  walls that were never in the way and the world read as roofless rather than cut open.
- The height tracked the player's Y, so a single step up moved the cut for the entire
  scene. Walls in the distance jumped up and down as you walked, worst on stairs and
  hillsides.

Neither is fixable by choosing a better height: a height does not know where the camera is,
and "is this in the way" is a question about the camera. So the question changed rather than
the number. `src/render/viewer-reveal.test.ts` pins the half that got missed — a 12-block
wall beside the character stays fully drawn, a roof 20 blocks away keeps its roof, the floor
underfoot is not punched through, and the same distant wall is checked with the character at
three different heights and does not change.

`V` toggles the mode as well as the button, because on a desktop the button is unreachable
exactly when you want it — playing in first person means the canvas holds the pointer lock,
and a locked pointer is captured by the canvas, so a click on the button never arrives.

#### Nothing here requires pointer lock

Mining and placing used to be gated on it, which silently removed both on any browser that
refuses the lock — and browsers refuse it more often than you would think (a click not
counted as a user gesture, a permissions policy, an embedded frame, a user who just pressed
Escape). Observed here in Chrome: `WrongDocumentError: the root document of this element is
not valid for pointer lock`.

Without the lock, the left button resolves drag-versus-click: hold still and it mines, move
past a few pixels and it takes the dig back and turns the view instead. Right-click always
uses. The HUD says `lock=no` so you know which mode you are in.

Defaults now match SiliconeDolls. For fabric-carpet, override:

```
MCWV_FAKEPLAYER_COMMANDS={"moveStop":"player {name} move"}
```

#### One more thing that will bite you: RCON cannot be pipelined

Vanilla's `RconClient` handles one request per pass over a fixed buffer. Send two commands
without waiting for the first reply, both land in one TCP segment, and the server
mis-parses the second and **closes the connection**.

The player poll issues three `data get`s per player, so this only appeared the moment
there was a player to poll — the bridge worked perfectly with an empty server and then
dropped RCON every few seconds once a bot joined. `RconClient.command()` now serialises
every command behind the last; callers may still use `Promise.all`, it just never puts two
packets on the wire at once. There is a test that fails if that regresses.

#### What the control surface actually covers

| | how | verified |
|---|---|---|
| move / jump / sneak / sprint | `player X move …`, sent on intent CHANGE | yes |
| look | tracked model + relative `turn` deltas | yes |
| **break blocks** | hold left mouse, or hold **MINE** on the touch pad -> `attack continue`; the SERVER owns the timing (hardness, tool, haste) | yes — placed a block and mined it back out |
| **place / use** | right mouse, or **PLACE** on the touch pad -> `use once`; doors, buttons, levers, chests, eating all the same verb | yes — inventory 64 -> 63 |
| hotbar | number keys or click a slot | yes (slots 1-8; see below) |
| **inventory** | `data get entity X Inventory`, rendered with baked item icons | yes, READ-ONLY |
| **containers** | right-click reads the block's own NBT (`data get block`) | yes — barrel contents |
| health / hunger / XP | `data get` at 2 Hz | yes |
| death / respawn | the mod disconnects the bot on death; **R** re-spawns it | death observed; respawn wired |
| **chat** | send via `execute as X run say`; receive by tailing the server log | yes, both directions |

Item icons come from a separate bake (`items.png` + `items.json`, ~550 KB, **live mode
only** — the `?auto=1` bundle stays at 221 KB). Flat items blit from an item atlas; block
items are composited as isometric cubes from the block atlas the renderer already has.

#### Latency: what was measured and what was chosen

The bot's position is polled at **10 Hz** (`MCWV_SELF_MS`, floor 50 ms), vitals at 2 Hz,
inventory at 0.5 Hz. Input is sent immediately on change, never on a tick.

Interleaved measurement against the live server, alternating idle and 10 Hz arms so the
server's own load drift hits both equally:

| | median ms/tick | round-trip |
|---|---|---|
| idle, round 1 | 36.4 | — |
| 10 Hz, round 1 | 26.0 | p50 6.5 ms, p95 50.2 ms |
| idle, round 2 | 24.6 | — |
| 10 Hz, round 2 | 18.8 | p50 3.0 ms, p95 25.9 ms |

**The polling cost is below this server's own noise floor** — the 10 Hz arm measured
*faster* than the idle arm before it, in both rounds. The binding constraint is not tick
budget, it is round-trip: p95 lands at ~one tick (50 ms) because RCON commands are drained
on the tick thread. Polling faster than that only queues, which is why 10 Hz was chosen
rather than 20.

The client hides the sampling gap with **dead reckoning**: each sample yields a velocity,
the camera extrapolates along it between samples and converges onto the next real one.
Extrapolation is capped at 250 ms — roughly two poll intervals — so a stalled bridge makes
the camera coast to a stop rather than fly through a wall. Yaw and pitch stay entirely
client-side, because the browser generates them and round-tripping them would add a full
poll of lag to turning your head.

#### The ceiling — what a command-driven player cannot do

These are limits of the mechanism, not missing work:

- **Moving items between slots.** SiliconeDolls has no inventory command (`player X
  inventory` -> `Invalid command`), and slot-to-slot moves are container GUI clicks, which
  a fake player has no way to issue. The inventory and chest panels are therefore
  READ-ONLY, and say so on screen. `/item replace` would work but it is a creative-mode
  admin command, not a player action, so it is not wired up.
- **Hotbar slot 9.** The mod accepts `hotbar 1`-`8` and answers `Invalid slot` for 9.
- **Combat timing.** Attacks land, but every input costs a round trip (p95 ~50 ms) on top
  of a 100 ms position sample. There is no critical-hit timing, no sprint reset, no shield
  parry, and you cannot react to a creeper. `attack continue` also keeps mining THROUGH a
  block into whatever is behind it.
- **Anything needing 20 tps input** — parkour, precise jumps, MLG water buckets, redstone
  timing. Movement is `move forward` until `stop`; there is no per-tick velocity control.
- **Turning and hitting still disagree during a genuinely fast flick**, because your view
  rotates locally the instant you move the mouse while the bot's facing is one round trip
  behind. This used to be much worse than a round trip and that part was a bug, not a
  limit — see below. Measured now against the live server: **0.1–0.4° during a continuous
  sweep, 0.2° once you stop**. An instantaneous 50° flick still reads tens of degrees off
  for the one sample it takes to land.
- **Death disconnects the bot** rather than showing a respawn screen — that is the mod's
  behaviour, and R re-spawns it as a fresh player.

For those, the honest answer remains **streaming a real client** (Sunshine + a web
Moonlight client, or Selkies): it has none of these limits because it *is* the game, and
it renders all 148 mods. This path is genuinely good for building, exploring, hauling and
watching the fleet; it is not a combat client and cannot be made into one over RCON.

#### What was removed, and why

The **mineflayer** backend is gone. It works against vanilla servers and cannot work
against this one, for two independent reasons:

1. NeoForge replaces the configuration phase. `NetworkComponentNegotiator.negotiate()`
   drops any server payload marked `.optional()` and disconnects the client if a required
   one remains. `PayloadRegistrar` defaults to *required*, so a non-NeoForge client is
   admitted only if all 128 mods opted in. None do.
2. Even past that, **modded block state IDs are never transmitted.** NeoForge's
   `neoforge:registry_sync` carries a `RegistrySnapshot` of registry-object ids only — no
   per-block state counts or property sets. State ids come from flattening
   `(block in registry order) × getPossibleStates()`, and the second factor lives in
   compiled Java. A JS client cannot rebuild the mapping, so every chunk decodes wrong.

Reading the save files instead is strictly better for fidelity: they are string-keyed, so
every modded block renders exactly.

**If you want a real, full-fidelity modded client in a browser**, the answer is not a
protocol reimplementation — it is streaming an actual client (Sunshine + a web Moonlight
client, or Selkies). That runs all 128 mods because it *is* the game.

### Running it as a service

```bash
npm run fetch-assets          # once, puts the client jar in ./.cache
npm run bake-assets           # once, and after any mod/world change
docker compose up -d --build
```

The container serves `.cache/baked/` at `/baked/` from the same read-only mount. It logs
whether a bake is present at startup; if it is not, the page still works but falls back to
the 476 MB jar path.

Then **http://mcwebviewer.pow/?auto=1** (dns-sync creates the Pi-hole record from the
Traefik label; give it a few seconds on first start).

Deliberately LAN-only — no `powback.com` router. The container serves Mojang's client
jar and each mod's assets to the browser, which is fine on your own LAN and is *not*
fine published to the internet. All three volume mounts are `:ro`; the world is a live
server world and nothing here may write to it.

Which regions load is decided by the **bake** (`--regions`), not by `MCWV_REGIONS` — the
client reads the region list out of the bundle. `MCWV_REGIONS` and `MCWV_JARS` now only
affect the legacy jar fallback.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Production bundle |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint, including cyclomatic-complexity limits |
| `npm test` | Unit tests — renderer (palette bit-packing, NBT tags, variant rotation, region sync) **and** bridge (the flush guard, RCON output parsing) |
| `npm run scan -- <worldDir>` | World inventory: every distinct block state, block entity and entity type, with counts |
| `npm run audit` | **Coverage audit** — what renders, by which path, and what does not |
| `npm run bake-assets` | Bake the world's assets server-side into `.cache/baked/` (see Setup) |
| `npm run build-shaderpack -- <packDir\|zip>` | Translate a shaderpack to WGSL (needs `glslangValidator` + `naga`); writes a bundle into `.cache/` |
| `npm run shader-audit -- .cache/shaderpacks/*.bundle.json` | **Shader coverage** — per pack, per pass: translated / skipped, each skip with a reason and class |
| `npm run render-proof` | Headless Chrome: loads the reference world, measures fps, writes `out/render.png`. Add `--url '...&at=x,y,z,dist'` to aim the camera |
| `npx tsx src/tools/contraption-test.ts` | Decodes Create contraptions from the world and dumps their block sets |

---

## Measured results

Against the reference world on a Mac Studio M4 Max, headless Chrome (ANGLE/Metal),
1600×1000.

**World scan** — 24,227 chunks across 3 dimensions in 12.1 s (~2,010 chunks/s), zero
chunk failures. 1,265 distinct block states, 415 distinct block names, 28 block-entity
types, 43 entity types, 54 biomes.

**Render** — one region (`r.-1.0.mca`), 1,024 chunks, 129 asset packs:

| | |
|---|---|
| Sections meshed | 1,360 |
| Triangles on screen | 1,175,510 |
| Draw calls | 1,754 |
| Atlas | 285 sprites, 0 missing |
| Biomes resolved | 172 |
| Entities loaded | 252 (1 contraption drawn, 9 blocks) |
| Unresolved states | **0** |
| fps (rAF, vsync-capped) | 60.2, 1% low 36.5 |
| **render-only, wide view (1.18 M tris)** | **4.2–6.4 ms/frame → 155–236 fps** |
| render-only, interior view (329 k tris) | 2.6 ms/frame → 392 fps |

Two fps numbers because only one of them means anything. The rAF loop is vsync-capped, so
60 is a ceiling, not a measurement. The render-only figure times `renderer.render()` over
the same scene and is the real headroom. The wide-view range is across repeated runs on a
machine that was not otherwise idle — treat 155 fps as the conservative figure. Both ends
clear the 60–120 fps target with room for the geometry the entity path will add.

Note the reference world is a **live server world**; its region files are rewritten while
the server runs, so distinct-state and entity counts drift by a few between runs. The
stable invariants (129 packs, 1,360 sections, 0 missing sprites, 0 unresolved states)
match exactly across runs.

**Coverage** (`npm run audit`) against the full world inventory:

| path | states | |
|---|---|---|
| asset (blockstate → model JSON) | 1,190 | 94.1% |
| asset via custom loader | 1 | 0.1% |
| fluid (classified, geometry pending) | 15 | 1.2% |
| air | 2 | 0.2% |
| block-entity, synthesized geometry | 57 | 4.5% |
| block-entity, no geometry | 0 | 0.0% |
| **unhandled (renders as nothing)** | **0** | **0.0%** |
| **→ rendered** | **1,265** | **100%** |

Entities: 43 distinct types — **37 rendered (86%)**: 34 from extracted Java geometry,
1 Create contraption, 1 block-model, 1 intentionally invisible. **6 not rendered**:
`item`, `item_frame`, `painting` (no `LayerDefinition` exists) and 3 modded billboard
entities. The audit prints that split every run rather than averaging it away.

---

## Layout

```
src/
  core/       nbt.ts, region.ts, chunk.ts      — save-file reading, no rendering deps
  assets/     pack.ts, model.ts, loaders.ts    — jars, blockstate/model baking
  render/     registry.ts  block state -> geometry + occlusion
              atlas.ts     sprite packing
              biome.ts     colormap tint
              mesher.ts    section -> vertex buffers
              entities.ts  entity classification + Create contraptions
              world.ts     chunk storage, global palette
              viewer.ts    three.js
  app/        main.ts, controls.ts
  tools/      scan-world.ts, audit.ts, render-proof.ts, contraption-test.ts
```

`src/core/**` has no browser or rendering dependencies and runs unchanged in Node, which
is what lets the audit and scan tools share exactly the code the browser uses.

---

## Licensing

Project code is yours to license as you see fit. It bundles no Minecraft assets.

- **Vanilla assets** are fetched at runtime from Mojang or supplied by the user. Mojang's
  EULA and Usage Guidelines prohibit redistributing game files — do not bundle
  `client.jar` contents into a deployed build or serve them from your own origin.
- **Mod assets** follow each mod's own licence. A mod being MIT-licensed for *code* does
  not mean its art is; check per mod before redistributing anything.

## Reference world

`/Users/macback/Projects/minecraft-create121/data/world` is treated as **read-only**.
The dev mount in `vite.config.ts` is GET-only and refuses paths outside the two
configured directories. Nothing in this project writes to the world or touches the
running server.
