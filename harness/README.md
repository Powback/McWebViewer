# Entity geometry extraction harness

Pulls **real** entity model geometry out of Minecraft 1.21.1 and the server's mod jars,
offline, without ever booting a game client.

## Why this works

Vanilla entity models are declarative data, not drawing code. Every `EntityModel` subclass
exposes a static factory:

```java
public static LayerDefinition createBodyLayer() {
    MeshDefinition mesh = new MeshDefinition();
    mesh.getRoot().addOrReplaceChild("head",
        CubeListBuilder.create().texOffs(0, 0).addBox(-2, -6, -2, 4, 6, 3),
        PartPose.offset(0, 15, -4));
    return LayerDefinition.create(mesh, 64, 32);
}
```

That is pure CPU: no OpenGL, no `Minecraft.getInstance()`, no window, no login. So we call the
factories reflectively and walk the resulting `LayerDefinition → MeshDefinition → PartDefinition
→ CubeDefinition` tree. This is the same data JsonEM manipulates at runtime; we just read it
offline.

The one thing that *does* need care: `LayerDefinitions.createRoots()` transitively initialises
`RenderType → ItemRenderer → Items → Blocks → BuiltInRegistries`, which throws
`Not bootstrapped`. Calling `SharedConstants.tryDetectVersion()` then `Bootstrap.bootStrap()`
first fixes it, and both are headless.

## Requirements

- **JDK 21** — `brew install openjdk@21` (installs to `/opt/homebrew/opt/openjdk@21`).
  Verified with `openjdk 21.0.12.1`. Minecraft 1.21.1 declares `javaVersion.majorVersion: 21`.
- `python3` and `curl` (used only to fetch mappings/libraries).
- `../.cache/client-1.21.1.jar` and `../.cache/1.21.1.json` (already present).
- Read access to `/Users/macback/Projects/minecraft-create121/data/mods` (never written to).

No Gradle, no npm, no Docker, no running server.

## Run it

```sh
cd /Users/macback/Projects/McWebViewer/harness
./run.sh
```

The script is idempotent; the expensive step (deobfuscating the client jar) is skipped if
`../.cache/client-1.21.1-deobf.jar` already exists. Delete that file to force a rebuild.
End to end from a cold `.cache` it takes about two minutes, most of which is downloading
the 9.6 MB mappings file and ~50 library jars.

### Or step by step

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
CACHE=/Users/macback/Projects/McWebViewer/.cache
LIBS=$(ls $CACHE/libs/*.jar | tr '\n' ':')

# 1. mappings (url comes from downloads.client_mappings in 1.21.1.json)
curl -sL -o $CACHE/client-mappings-1.21.1.txt \
  https://piston-data.mojang.com/v1/objects/2244b6f072256667bcd9a73df124d6c58de77992/client.txt

# 2. compile
$JAVA_HOME/bin/javac -d build -cp "$CACHE/client-1.21.1-deobf.jar:$LIBS" src/mcextract/*.java

# 3. deobfuscate the client jar (only once)
$JAVA_HOME/bin/java -Xmx4g -cp "build:$LIBS" mcextract.RemapJar \
  $CACHE/client-1.21.1.jar $CACHE/client-mappings-1.21.1.txt $CACHE/client-1.21.1-deobf.jar

# 4. extract
$JAVA_HOME/bin/java -Xmx4g -cp "build:$CACHE/client-1.21.1-deobf.jar:$LIBS" mcextract.ExtractModels \
  --client $CACHE/client-1.21.1-deobf.jar --libs $CACHE/libs \
  --mods /Users/macback/Projects/minecraft-create121/data/mods \
  --audit ../out/audit.json --out out

# 5. optional glTF
$JAVA_HOME/bin/java -cp "build:$CACHE/libs/asm-9.7.jar" mcextract.EmitGltf \
  out/entity-models.json out/entity-models.gltf
```

## Why the jar gets deobfuscated first

The shipped client jar is obfuscated (`ChickenModel` is `fuz`). Reflecting through a name map
built from the ProGuard mappings would be enough for vanilla, but **mod jars are compiled
against official Mojang names** — NeoForge runs deobfuscated — so `MaulerEntityModel` cannot
link against `fuz`. `RemapJar` therefore rewrites the whole client jar to official names with
ASM (`ClassRemapper`), resolving member renames through the class hierarchy so that call sites
referencing an inherited member through a subclass owner still map correctly. Output:
`.cache/client-1.21.1-deobf.jar` (8269 classes, all 15248 resources including `assets/`
carried over, so texture existence can be verified from the same file).

`.cache/` is gitignored; nothing large lands in the repo.

## What it produces (`harness/out/`)

| File | Contents |
| --- | --- |
| `entity-models.json` | **the deliverable** — 426 models of geometry |
| `entity-index.json` | 135 entity types → model id, texture, renderer, how it was resolved |
| `painting-variants.json` | 50 painting variants → size in blocks + texture |
| `extract-report.json` | counts, per-jar tallies, coverage of the audit list, every failure |
| `entity-models.gltf` | optional; all 426 models as glTF 2.0 scenes, embedded base64 buffer |

`EmitGltf` takes an optional third argument to filter by model id prefix, e.g.
`… mcextract.EmitGltf out/entity-models.json /tmp/chicken.gltf "minecraft:chicken"`.
It converts model space to glTF metres with `x' = -x/16, y' = -y/16, z' = z/16` (the
`poseStack.scale(-1, -1, 1)` every entity renderer applies) and rebuilds the box UV unwrap
faithfully, including `mirror`. It deliberately does **not** apply the `+1.501` Y translation
`EntityRenderer` adds, so a chicken lands at y `-1.500 … -0.562`; add 1.5 to stand it on the
floor.

### `entity-models.json`

```jsonc
{
  "minecraft:chicken#main": {
    "texWidth": 64,
    "texHeight": 32,
    "parts": {
      "head": {
        "pos": [0, 15, -4],
        "rot": [0, 0, 0],
        "cubes": [
          { "from": [-2, -6, -2], "to": [2, 0, 1], "size": [4, 6, 3],
            "uv": [0, 0], "grow": 0, "growXYZ": [0, 0, 0], "mirror": false }
        ],
        "children": { }
      }
    }
  }
}
```

Model ids come in two shapes:

- `minecraft:chicken#main` — a `ModelLayerLocation` from the authoritative vanilla registry
  (`LayerDefinitions.createRoots()`). Prefer these.
- `class:com.faboslav.…MaulerEntityModel#getTexturedModelData` — found by scanning bytecode for
  static methods that return a `LayerDefinition`. This is how mod models are reached, and also
  how vanilla models get a second, class-keyed id.

Field notes:

- `pos` / `rot` are the `PartPose` translation and XYZ euler rotation in **radians**.
  Minecraft applies them Z, then Y, then X.
- `from` is the cube origin, `to` is `origin + size`, all in model units (1/16 block), Y **down**.
- `uv` is the `texOffs(u, v)` corner in texels on a `texWidth × texHeight` sheet, unwrapped in
  Minecraft's box layout: across `[west d][north w][east d][south w]`, down `[top d][sides h]`.
- `grow` is the `CubeDeformation` (armor layers use 0.5 / 1.0). It is a scalar for the common
  uniform case; `growXYZ` always carries the exact per-axis triple. Grow expands the box on
  **both** sides of each axis.
- `mirror` mirrors the X extents, which mirrors the U mapping.
- `uvScale` and `faces` appear only when non-default.
- The `LayerDefinition` root is an unnamed container, so its children are emitted as the
  top-level `parts`. If the root itself holds cubes they appear under `"__root__"`.

### `entity-index.json`

Per entity type: the renderer class, the model id, the texture, and `resolvedBy` — always check
that field before trusting a row. Values are `registry+bytecode` (authoritative),
`… + texture by filename heuristic`, `heuristic: …` (mod, renderer matched by name), or `manual`.

The entity → renderer link for vanilla is read out of `EntityRenderers` bytecode: each
`register(EntityType.X, XRenderer::new)` pairs a `GETSTATIC EntityType.X` with the renderer in
the `invokedynamic` bootstrap handle. Some registrations are lambdas rather than method
references (`ctx -> new MinecartRenderer<>(ctx, ModelLayers.MINECART)`); those are followed into
the lambda body for both the renderer class and the `ModelLayers` field. The entity id itself
comes from `BuiltInRegistries.ENTITY_TYPE.getKey(...)`, so it is exact.

## Extending it

- **Another Minecraft version**: change the four `1.21.1` paths in `run.sh`; the mappings URL is
  read out of the version JSON automatically.
- **More mods**: they are already all on the classpath. `scanForFactories` uses ASM without
  loading classes, so adding jars is cheap and cannot trigger stray static initialisers.
- **A model that fails to invoke**: check `extract-report.json → failures`. Most are mod classes
  whose `<clinit>` needs NeoForge, which is not in `data/mods`.

## Source layout

| File | Role |
| --- | --- |
| `src/mcextract/ProguardMappings.java` | parses Mojang `client.txt`, builds obf descriptors |
| `src/mcextract/RemapJar.java` | ASM rewrite of the client jar to official names |
| `src/mcextract/ExtractModels.java` | bootstrap, walk models, resolve entities, emit JSON |
| `src/mcextract/EmitGltf.java` | optional glTF 2.0 view of `entity-models.json` |
