#!/bin/sh
# Builds /srv/manifest.json and /srv/jars from whatever is mounted under /data, so one
# image serves any world + mod set without a rebuild.
#
#   MCWV_REGIONS  comma-separated region files to autoload (default: r.-1.0.mca)
#   MCWV_JARS     comma-separated mod jar names to serve instead of every jar in
#                 /data/mods. The full 128-mod set is ~450 MB and the browser fetches
#                 all of it on ?auto=1, so subsetting is usually what you want.
set -eu

mkdir -p /srv/jars
rm -f /srv/jars/*.jar 2>/dev/null || true

link_jar() {
  # Symlink rather than copy: the mounts are read-only and may be hundreds of MB.
  [ -e "$1" ] || return 0
  ln -sf "$1" "/srv/jars/$(basename "$1")"
  printf '%s\n' "$(basename "$1")"
}

# Vanilla client jar first — the app orders packs vanilla < mods < resource packs, and
# identifies the vanilla jar by a /client.*\.jar$/i filename.
# The harness leaves a `client-<ver>-deobf.jar` next to the real one. It is a 28 MB
# ASM-remapped copy with no `assets/` — serving it costs the browser a 28 MB fetch and
# contributes nothing, so it is skipped by name.
CLIENT_JARS=""
for f in /data/client/*.jar; do
  case "$f" in *-deobf.jar) continue ;; esac
  n=$(link_jar "$f") || true
  [ -n "${n:-}" ] && CLIENT_JARS="${CLIENT_JARS}${CLIENT_JARS:+,}${n}"
done

MOD_JARS=""
if [ -n "${MCWV_JARS:-}" ]; then
  for n in $(printf '%s' "$MCWV_JARS" | tr ',' ' '); do
    link_jar "/data/mods/$n" >/dev/null || true
    MOD_JARS="${MOD_JARS}${MOD_JARS:+,}${n}"
  done
else
  for f in /data/mods/*.jar; do
    n=$(link_jar "$f") || true
    [ -n "${n:-}" ] && MOD_JARS="${MOD_JARS}${MOD_JARS:+,}${n}"
  done
fi

JARS="${CLIENT_JARS}"
[ -n "$MOD_JARS" ] && JARS="${JARS}${JARS:+,}${MOD_JARS}"

REGIONS="${MCWV_REGIONS:-r.-1.0.mca}"
ENTITY_REGIONS=""
for r in $(printf '%s' "$REGIONS" | tr ',' ' '); do
  [ -f "/data/world/entities/$r" ] && \
    ENTITY_REGIONS="${ENTITY_REGIONS}${ENTITY_REGIONS:+,}$r"
done

json_list() {
  printf '%s' "$1" | awk -F, '{
    printf "[";
    for (i = 1; i <= NF; i++) { if ($i == "") continue; if (i > 1) printf ","; printf "\"%s\"", $i }
    printf "]"
  }'
}

printf '{"jars":%s,"regions":%s,"entityRegions":%s}\n' \
  "$(json_list "$JARS")" "$(json_list "$REGIONS")" "$(json_list "$ENTITY_REGIONS")" \
  > /srv/manifest.json

# Which live pipeline the browser uses. Written from env so the toggle needs a container
# restart at most, never a rebuild:
#   MCWV_SOURCE     bridge (default) | spacetime
#   MCWV_STDB_URI   SpacetimeDB base URL      (default http://mcspacetime.pow)
#   MCWV_STDB_DB    module/database name      (default mcspacetime)
# A single tab can still override with ?source=spacetime without touching this.
printf '{"source":"%s","stdbUri":"%s","database":"%s"}\n' \
  "${MCWV_SOURCE:-bridge}" \
  "${MCWV_STDB_URI:-http://mcspacetime.pow}" \
  "${MCWV_STDB_DB:-mcspacetime}" \
  > /srv/source.json
echo "mcwv: world source = ${MCWV_SOURCE:-bridge}"

if [ -f /data/client/baked/assets.json ]; then
  echo "mcwv: baked assets present ($(du -h /data/client/baked/assets.json | cut -f1)) — the browser will NOT fetch jars"
else
  echo "mcwv: WARNING no baked assets at /data/client/baked."
  echo "mcwv:   the browser will fall back to fetching every jar (~476 MB per load)."
  echo "mcwv:   fix: run 'npm run bake-assets' on the host, then restart this container."
fi

echo "mcwv: $(ls /srv/jars | wc -l) jars linked, regions=${REGIONS}"
if [ -z "$CLIENT_JARS" ]; then
  echo "mcwv: WARNING no vanilla client jar at /data/client — vanilla blocks will not render."
  echo "mcwv:   run 'npm run fetch-assets' on the host and mount ./.cache at /data/client:ro"
fi
