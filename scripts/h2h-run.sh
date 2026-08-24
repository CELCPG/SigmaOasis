#!/usr/bin/env bash
#
# Run a list of head-to-head tasks against ONE arm, into one per-arm directory.
#
#   bash scripts/h2h-run.sh --arm B-current --model qwen3.8-9b V1 TH2 TTU1
#   bash scripts/h2h-run.sh --arm A-baseline --app ../oasis-baseline --model qwen3.8-9b V1 TH2
#
# The prompt for each task comes from docs/head-to-head/tasks.json; the settings,
# packs, fixtures and driver actions come from docs/head-to-head/task-setup.json,
# which is that file's prose setup written so a machine can execute it. Each task
# lands in <out>/<arm>/<taskId>-<timestamp>/.
#
# Arms differ only in --app. Everything else — prompts, settings, fixtures,
# actions, the driver — is the same code driving both, which is the whole point.
set -uo pipefail
cd "$(dirname "$0")/.."

ARM=""
APP=""
MODEL=""
OUT=".h2h-runs"
VARIANT=""
PORT=9333
DRY=0
TASKS_FILE="docs/head-to-head/tasks.json"
SETUP_FILE="docs/head-to-head/task-setup.json"
IDS=()

usage() {
  cat >&2 <<'EOF'
usage: bash scripts/h2h-run.sh --arm <label> --model <id> [options] <taskId> [taskId ...]

  --arm <label>      arm name; names the output subdirectory and the run sidecar
  --model <id>       model id, loaded in LM Studio
  --app <dir>        build to drive (default: this repo). This is what makes an A/B
  --out <dir>        run root (default: .h2h-runs); runs land in <out>/<arm>/
  --variant <name>   apply a named variant from task-setup.json (e.g. light, dark)
  --port <n>         CDP port (default 9333)
  --tasks <file>     task set (default docs/head-to-head/tasks.json)
  --setup <file>     machine-readable setup (default docs/head-to-head/task-setup.json)
  --dry-run          print the h2h-capture command for each task and stop
  all                as a task id, expands to every task in the set
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --arm) ARM="$2"; shift 2 ;;
    --app) APP="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --variant) VARIANT="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --tasks) TASKS_FILE="$2"; shift 2 ;;
    --setup) SETUP_FILE="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) echo "error: unknown option $1" >&2; usage; exit 2 ;;
    *) IDS+=("$1"); shift ;;
  esac
done

[ -n "$ARM" ] || { echo "error: --arm is required" >&2; usage; exit 2; }
[ -n "$MODEL" ] || { echo "error: --model is required" >&2; usage; exit 2; }
[ ${#IDS[@]} -gt 0 ] || { echo "error: no task ids given" >&2; usage; exit 2; }

ELECTRON_MAC="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
ELECTRON_LINUX="node_modules/electron/dist/electron"
if command -v node >/dev/null 2>&1; then NODE=(node)
elif [ -x "$ELECTRON_MAC" ]; then NODE=(env ELECTRON_RUN_AS_NODE=1 "$ELECTRON_MAC")
elif [ -x "$ELECTRON_LINUX" ]; then NODE=(env ELECTRON_RUN_AS_NODE=1 "$ELECTRON_LINUX")
else echo "error: no node and no bundled Electron" >&2; exit 1; fi

if [ "${IDS[0]}" = "all" ]; then
  ALL_IDS=$("${NODE[@]}" -e '
    const fs = require("fs")
    for (const task of JSON.parse(fs.readFileSync(process.argv[1], "utf8")).tasks) console.log(task.id)
  ' "$TASKS_FILE") || { echo "error: could not read $TASKS_FILE" >&2; exit 1; }
  IDS=()
  while IFS= read -r line; do [ -n "$line" ] && IDS+=("$line"); done <<< "$ALL_IDS"
fi

ARM_DIR="$OUT/$ARM"
mkdir -p "$ARM_DIR"
WORK="$ARM_DIR/.setup"
mkdir -p "$WORK"

FAILED=()
INVALID=()
OK=()

for ID in "${IDS[@]}"; do
  # One node call emits everything the capture needs for this task: the prompt
  # verbatim from tasks.json, and the setup pieces as separate files so each can
  # be handed to the harness as its own flag.
  if ! "${NODE[@]}" -e '
    const fs = require("fs"), path = require("path")
    const [tasksFile, setupFile, id, variant, work] = process.argv.slice(1)
    const tasks = JSON.parse(fs.readFileSync(tasksFile, "utf8"))
    const setups = JSON.parse(fs.readFileSync(setupFile, "utf8"))
    const task = tasks.tasks.find((t) => t.id === id)
    if (!task) { console.error(`no task "${id}" in ${tasksFile}`); process.exit(3) }
    const setup = setups.tasks[id]
    if (!setup) { console.error(`no setup for "${id}" in ${setupFile}`); process.exit(3) }
    if (setup.supported === false) {
      console.error(`task "${id}" is marked unsupported: ${setup.note || "no reason given"}`)
      process.exit(4)
    }
    // A variant is a shallow-per-key deep merge over the base setup, used for
    // "the same task in light and in dark theme".
    const merge = (a, b) => {
      const out = { ...a }
      for (const [k, v] of Object.entries(b || {})) {
        out[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k])
          ? merge(a[k], v)
          : v
      }
      return out
    }
    const eff = variant && setup.variants && setup.variants[variant] ? merge(setup, setup.variants[variant]) : setup
    const w = (name, value) => {
      const p = path.join(work, `${id}.${name}.json`)
      fs.writeFileSync(p, JSON.stringify(value, null, 2))
      return p
    }
    const flags = []
    fs.writeFileSync(path.join(work, `${id}.prompt.txt`), task.prompt)
    flags.push("--prompt-file", path.join(work, `${id}.prompt.txt`))
    if (eff.settings) flags.push("--settings", w("settings", eff.settings))
    if (eff.packs && eff.packs.length) flags.push("--packs", eff.packs.join(","))
    if (eff.preActions) flags.push("--pre-actions", w("pre-actions", eff.preActions))
    if (eff.actions) flags.push("--actions", w("actions", eff.actions))
    if (eff.searchFixture) flags.push("--search-fixture", w("search-fixture", eff.searchFixture))
    if (eff.lmFixture) flags.push("--lm-fixture", w("lm-fixture", eff.lmFixture))
    if (eff.window) flags.push("--window", eff.window)
    if (eff.timeoutMs) flags.push("--timeout", String(eff.timeoutMs))
    if (eff.noShots) flags.push("--no-shots")
    fs.writeFileSync(path.join(work, `${id}.flags`), flags.join("\n") + "\n")
  ' "$TASKS_FILE" "$SETUP_FILE" "$ID" "$VARIANT" "$WORK"; then
    echo "== $ID: SKIPPED (setup)" >&2
    FAILED+=("$ID(setup)")
    continue
  fi

  FLAGS=()
  while IFS= read -r line; do [ -n "$line" ] && FLAGS+=("$line"); done < "$WORK/$ID.flags"

  LABEL="$ID"
  [ -n "$VARIANT" ] && LABEL="$ID-$VARIANT"

  echo
  echo "=== $ARM / $LABEL ==============================================="
  CMD=(bash scripts/h2h-capture.sh --model "$MODEL" --task-id "$LABEL" --arm "$ARM"
       --out "$ARM_DIR" --port "$PORT" "${FLAGS[@]}")
  [ -n "$APP" ] && CMD+=(--app "$APP")

  if [ "$DRY" = "1" ]; then
    printf '%q ' "${CMD[@]}"; echo
    continue
  fi

  "${CMD[@]}"
  STATUS=$?
  if [ "$STATUS" = "0" ]; then OK+=("$LABEL")
  elif [ "$STATUS" = "3" ]; then INVALID+=("$LABEL")
  else FAILED+=("$LABEL"); fi
done

echo
echo "=== $ARM summary ================================================"
echo "captured : ${OK[*]:-none}"
echo "INVALID  : ${INVALID[*]:-none}"
echo "failed   : ${FAILED[*]:-none}"
echo "runs in  : $ARM_DIR"
[ ${#FAILED[@]} -eq 0 ] && [ ${#INVALID[@]} -eq 0 ]
