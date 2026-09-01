#!/usr/bin/env bash
# Extract real Minecraft entity model geometry offline. See README.md.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="$HERE/../.cache"
MODS="${MODS:-/Users/macback/Projects/minecraft-create121/data/mods}"
AUDIT="${AUDIT:-$HERE/../out/audit.json}"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"
JAVA="$JAVA_HOME/bin/java"
JAVAC="$JAVA_HOME/bin/javac"

VERSION_JSON="$CACHE/1.21.1.json"
CLIENT_JAR="$CACHE/client-1.21.1.jar"
MAPPINGS="$CACHE/client-mappings-1.21.1.txt"
DEOBF_JAR="$CACHE/client-1.21.1-deobf.jar"

step() { printf '\n=== %s ===\n' "$1"; }

step "0. prerequisites"
"$JAVA" -version
[ -f "$CLIENT_JAR" ] || { echo "missing $CLIENT_JAR"; exit 1; }
[ -f "$VERSION_JSON" ] || { echo "missing $VERSION_JSON"; exit 1; }

step "1. Mojang client mappings"
if [ ! -f "$MAPPINGS" ]; then
  URL=$(python3 -c "import json;print(json.load(open('$VERSION_JSON'))['downloads']['client_mappings']['url'])")
  curl -sL -o "$MAPPINGS" "$URL"
fi
ls -la "$MAPPINGS"

step "2. client libraries"
mkdir -p "$CACHE/libs"
python3 - "$VERSION_JSON" "$CACHE/libs" <<'PY'
import json, os, sys, urllib.request, concurrent.futures
vj, out = sys.argv[1], sys.argv[2]
jobs = []
for l in json.load(open(vj))['libraries']:
    p = l['name'].split(':')
    if len(p) > 3 and any(k in p[3] for k in ('natives', 'linux', 'windows', 'macos')):
        continue
    a = l.get('downloads', {}).get('artifact')
    if not a:
        continue
    fn = os.path.join(out, os.path.basename(a['path']))
    if os.path.exists(fn) and os.path.getsize(fn) == a['size']:
        continue
    jobs.append((a['url'], fn))
with concurrent.futures.ThreadPoolExecutor(8) as ex:
    list(ex.map(lambda j: urllib.request.urlretrieve(j[0], j[1]), jobs))
print(f'{len(jobs)} downloaded, {len(os.listdir(out))} jars present')
PY
for a in asm asm-commons asm-tree; do
  [ -f "$CACHE/libs/$a-9.7.jar" ] || curl -sfL -o "$CACHE/libs/$a-9.7.jar" \
    "https://repo1.maven.org/maven2/org/ow2/asm/$a/9.7/$a-9.7.jar"
done

LIBS=$(ls "$CACHE"/libs/*.jar | tr '\n' ':')

step "3. deobfuscate the client jar"
rm -rf "$HERE/build" && mkdir -p "$HERE/build"
if [ ! -f "$DEOBF_JAR" ]; then
  # RemapJar only needs ASM, so it compiles before the deobfuscated Minecraft classes exist
  "$JAVAC" -nowarn -d "$HERE/build" -cp "$LIBS" \
    "$HERE/src/mcextract/ProguardMappings.java" "$HERE/src/mcextract/RemapJar.java"
  "$JAVA" -Xmx4g -cp "$HERE/build:$LIBS" mcextract.RemapJar "$CLIENT_JAR" "$MAPPINGS" "$DEOBF_JAR"
else
  echo "already present: $DEOBF_JAR"
fi

step "4. compile"
"$JAVAC" -nowarn -d "$HERE/build" -cp "$DEOBF_JAR:$LIBS" "$HERE"/src/mcextract/*.java 2>&1 | grep -v '^Note:' || true

step "5. extract"
mkdir -p "$HERE/out"
"$JAVA" -Xmx4g -Dlog4j2.configurationFile="$HERE/log4j2.xml" -cp "$HERE/build:$DEOBF_JAR:$LIBS" mcextract.ExtractModels \
  --client "$DEOBF_JAR" --libs "$CACHE/libs" --mods "$MODS" --audit "$AUDIT" --out "$HERE/out" \
  2>&1 | grep 'extract\]'

step "6. glTF (optional)"
"$JAVA" -cp "$HERE/build:$CACHE/libs/asm-9.7.jar" mcextract.EmitGltf \
  "$HERE/out/entity-models.json" "$HERE/out/entity-models.gltf"

step "done"
ls -la "$HERE/out"
