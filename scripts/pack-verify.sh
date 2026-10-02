#!/bin/sh
# Packed-artifact verification for the SpyCore CLI (F-2c-12).
#
#   packages/cli/scripts/pack-verify.sh
#
# ⭐⭐ WHY THIS EXISTS. `scripts/linux-verify.sh` verifies a SOURCE BUILD: it
# tars the checkout, reinstalls from the lockfile, runs `tsup` itself and then
# drives `build/index.js` by absolute path. Not one step of that touches the
# artifact a user receives. `npm install -g @spycore/cli` delivers a DIFFERENT
# thing — the `files` allowlist only, the `dependencies` set resolved fresh from
# the registry, and a shim on PATH that the harness never invokes.
#
# ⭐ A HARNESS THAT VERIFIES A DIFFERENT ARTIFACT THAN THE ONE THAT SHIPS is the
# class this project has already closed TWICE at the container level ("the image
# CI builds is not the image production runs"). This is the same defect one
# level down, at the package. Every control closed in eleven batches was
# unproven in the installed copy until this script executed it there.
#
# WHAT "EXERCISED" MEANS HERE — decided and stated, not left to the reader:
#   1. RESOLUTION  the shim npm puts on PATH resolves and starts.
#   2. IDENTITY    `--version` equals the manifest version.
#   3. FUNCTION    `--help` lists commands, and a full agent turn writes a file,
#                  reads it back and runs a command end to end.
#   4. SAFETY      the controls this arc built actually fire IN THE INSTALLED
#                  COPY: the catastrophic-command guard, the symlink escape
#                  block, and the 0600 config permission.
# (1) and (4) are touched by no other gate in the repository.
#
# =============================================================================
# ⭐⭐ F-2c-32 — THE CERTIFIER IS NOW CERTIFIED, AND FOUR OF ITS CLAIMS WERE
# WIDER THAN ITS CHECKS.
# =============================================================================
#
# This script certifies acceptance property P3 — *the packed artifact is what a
# user receives* — and until this batch it had NO SELF-TEST AT ALL, so its
# certification was UNKNOWN: not sound, not broken. Four defects were then
# measured rather than supposed, each with a positive control firing first in
# the same invocation:
#
#   ⭐⭐ 1. A PASS OVER ZERO CASES. The entry-point loop is `for e in $ENTRIES`.
#      A manifest declaring neither `main` nor `bin` yields an EMPTY `$ENTRIES`,
#      so the loop body never executes: measured `cases=0 bad=0`, silently. The
#      control fired first — with both declared it is `cases=2`, and with the
#      file removed `bad=1`. That is F-2c-31's F-I1 inside the instrument that
#      certifies the artifact. There is now a vacuity guard AND a CASE COUNTER,
#      and the verdict line refuses a PASS below a literal floor.
#
#   ⭐⭐ 2. THE CORPUS WAS DERIVED FROM THE THING IT CERTIFIES. This script ran
#      `npm pack` and then inspected WHAT IT HAD JUST PACKED. Nothing compared
#      the member set against a declaration the script does not produce, so a
#      packing defect could only be caught if it happened to break one of the
#      three self-referential checks. The cure is the one this arc has now used
#      three times: RE-GROUND THE CORPUS OUTSIDE THE GENERATOR. The `files`
#      allowlist in package.json is exactly such a declaration — nothing else in
#      the repository reads it against the artifact — so the packed set is now
#      checked BOTH WAYS against it: no member outside it (plus npm's forced
#      set), and no entry in it that contributes nothing.
#
#   ⭐ 3. THE SOURCE-LEAK FILTER WAS ANCHORED AT `^`, so it saw only top-level
#      leaks. Measured, 6 of 6 nested forms shipped unflagged: `build/src/
#      index.ts`, `lib/tsconfig.json`, `build/.env`, `build/.env.production`,
#      `config/vitest.config.ts`, `sub/tests/secret.test.ts`. Now segment-aware.
#
#   ⭐ 4. AN EMPTY MEMBER LIST COUNTED AS ONE. `printf '%s\n' "" | wc -l` is 1,
#      so a tarball with no members reported `files=1` in the verdict line.
#
# ⭐ AND ONE MEASURED DEFECT IS **NOT** FIXED HERE, WHICH IS SAID RATHER THAN
# IMPLIED. `with_deadline`'s fallback branch — the branch macOS takes, and macOS
# is the platform the `packed-artifact` CI job runs on — kills only the DIRECT
# child, so a payload that starts a grandchild ORPHANS it. Measured through the
# repository's own group-killing probe harness with both controls firing:
# control-yes=`yes`, no-grandchild=`no`, grandchild=`yes`. The fix is not one
# line: F-2c-31 measured that `setsid` DOES NOT EXIST ON DARWIN, so a shell
# child shares the caller's process group and `kill -- -$PGID` kills the caller.
# Destination SPY-297, which already carries this file in its probe population.
#
# ⭐ WHAT THIS SCRIPT CANNOT SEE, stated here rather than discovered later:
#   - It installs from a LOCAL tarball, so it proves nothing about the registry
#     copy of any published version. It verifies what THIS tree would ship.
#   - `npm pack --ignore-scripts` bypasses `prepack` and would ship whatever
#     `build/` happens to be in the tree. That bypass is measured and real; no
#     mechanism inside package.json can close it.
#   - Dependency resolution is live, so a result is only as reproducible as the
#     registry was at the moment it ran.
#   - Windows is not covered: this is `sh`, and native Windows is not a
#     supported target for the CLI.
#   - ⭐ The identity scan uses `grep -I`, so a denied string inside a BINARY
#     packed member is invisible. No member is binary today; that is a property
#     of the current artifact, not of the check.
#   - ⭐ The `files` re-grounding proves the packed set agrees with the
#     DECLARATION. It cannot prove the declaration is the right one — that is
#     `tests/pack-verification.test.ts` P1's job, and the two are deliberately
#     different questions.
#
# USAGE
#   sh scripts/pack-verify.sh              pack, install and exercise
#   sh scripts/pack-verify.sh --self-test  prove THIS script (pure: no pack, no
#                                          install, no network)
set -eu

PKG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
PREFIX="$WORK/prefix"
STUB_PORT="${PACK_VERIFY_PORT:-8917}"
STUB_PID=""
FAIL=0

# ⭐⭐ F-2c-32 — THE CASE COUNTER. `rc=0` IS NOT A MEASUREMENT.
#
# The verdict used to be `PACK-VERIFY PASS version=… files=… node=…` — three
# facts about the artifact and NOT ONE about how many checks ran. Combined with
# defect 1 above, a section that silently checked nothing still printed PASS.
# Every `ok`/`bad` now counts, and the verdict refuses a PASS below a floor
# pinned by a LITERAL — F-2c-31's F-I3 lesson: a floor compared only against
# itself is not a floor.
CHECKS=0
# TODAY'S MEASURED count on a green run. Raising the number of checks raises
# this in the same commit; that is the R-6a rule applied to cases.
CHECK_FLOOR=19

cleanup() {
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
  rm -rf "$WORK"
  return 0
}
trap cleanup EXIT INT TERM

say() { printf '%s\n' "$*"; }
bad() { say "[pack-verify] FAIL: $*"; FAIL=1; CHECKS=$((CHECKS + 1)); }
ok()  { say "[pack-verify] ok: $*"; CHECKS=$((CHECKS + 1)); }

# `stat` is not portable: BSD wants -f %Lp, GNU wants -c %a.
filemode() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null || echo missing; }

# ⭐ PORTABLE PER-COMMAND DEADLINE. This script runs on the HOST, and macOS
# ships no `timeout` and no `gtimeout` — unlike linux-verify.sh, whose
# `timeout` calls all happen INSIDE a Debian container. Assuming it here made
# every smoke report FAIL for a missing binary rather than for its property,
# which is a control that cannot distinguish "blocked" from "never ran".
# Same pure-sh watchdog shape linux-verify.sh already uses on the host side.
#
# ⭐ THE FALLBACK BRANCH ORPHANS A GRANDCHILD — measured, see the header. Not
# fixed here; SPY-297.
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="gtimeout"; fi

with_deadline() { # $1 = seconds, rest = command
  _secs="$1"; shift
  if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" "$_secs" "$@"; return $?; fi
  "$@" &
  _cmd=$!
  ( sleep "$_secs"; kill -9 "$_cmd" 2>/dev/null ) >/dev/null 2>&1 &
  _killer=$!
  _st=0
  wait "$_cmd" || _st=$?
  kill "$_killer" 2>/dev/null || true
  return "$_st"
}

# ═══════════════════════════════════════════════════════════════════════════
# THE PURE PREDICATES.
#
# ⭐⭐ EXTRACTED SO THE SELF-TEST DRIVES THE SHIPPED CODE, NOT A COPY OF IT.
# F-2c-31's M13 was a mutation that survived because the case called the TOOL
# directly while the real run used a different path; and F-2c-31's M10b was a
# case that TRANSCRIBED the pipeline it was meant to test and asserted its own
# copy. Both are avoided the same way: there is exactly one implementation, the
# real run calls it, and the self-test calls the same one with synthetic input.
# ═══════════════════════════════════════════════════════════════════════════

# How many members a newline-separated list carries. An EMPTY list is 0.
member_count() {
  if [ -z "$1" ]; then echo 0; else printf '%s\n' "$1" | wc -l | tr -d ' '; fi
}

# Every entry point the MANIFEST declares — read from the manifest, never from a
# hand-list, so a new bin or a renamed main is covered without anyone
# remembering to update this script.
entry_points() { # $1 = package dir
  node -e '
const p = require(process.argv[1] + "/package.json");
const out = new Set();
if (p.main) out.add(String(p.main).replace(/^\.\//, ""));
for (const v of Object.values(p.bin || {})) out.add(String(v).replace(/^\.\//, ""));
process.stdout.write([...out].join("\n"));
' "$1"
}

# The `files` allowlist — THE EXTERNAL DECLARATION this script does not produce.
files_allowlist() { # $1 = package dir
  node -e '
const p = require(process.argv[1] + "/package.json");
process.stdout.write((p.files || []).map(String)
  .map((s) => s.replace(/^\.\//, "").replace(/\/$/, "")).join("\n"));
' "$1"
}

# Nothing from the source tree may ship. A published package that carries its
# own tests or tsconfig is leaking build-time surface to users.
#
# ⭐ SEGMENT-ANCHORED, not `^`-anchored. The `^` form saw only top-level leaks;
# 6 of 6 nested forms shipped unflagged, measured.
leak_members() { # $1 = members
  [ -n "$1" ] || return 0
  printf '%s\n' "$1" | grep -E '(^|/)(src|tests)/|(^|/)tsconfig[^/]*\.json$|(^|/)tsup\.config\.|(^|/)vitest\.config\.|(^|/)\.env|\.tsbuildinfo$' || true
}

build_file_count() { # $1 = members
  [ -n "$1" ] || { echo 0; return 0; }
  printf '%s\n' "$1" | grep -c '^build/' || true
}

# ⭐⭐ THE RE-GROUNDING, DIRECTION 1 — a member the DECLARATION does not cover.
# npm force-includes `package.json`, `README*`, `LICENSE*`/`LICENCE*` and every
# file referenced by `bin` regardless of the allowlist; it does NOT do so for
# `main`. That asymmetry was measured at F-2c-12 and is encoded here rather than
# assumed.
uncovered_members() { # $1 = package dir, $2 = members
  printf '%s\n' "$2" | node -e '
const p = require(process.argv[1] + "/package.json");
const files = (p.files || []).map(String)
  .map((s) => s.replace(/^\.\//, "").replace(/\/$/, ""));
const forced = new Set(["package.json"]);
for (const v of Object.values(p.bin || {})) forced.add(String(v).replace(/^\.\//, ""));
let s = "";
process.stdin.on("data", (c) => { s += c; }).on("end", () => {
  const members = s.split("\n").filter(Boolean);
  const out = members.filter((m) =>
    !forced.has(m) &&
    !/^README(\..+)?$/i.test(m) &&
    !/^LICEN[CS]E(\..+)?$/i.test(m) &&
    !files.some((f) => m === f || m.startsWith(f + "/")));
  process.stdout.write(out.join("\n"));
});
' "$1"
}

# ⭐⭐ THE RE-GROUNDING, DIRECTION 2 — a DECLARED entry that contributes NOTHING.
# This is the direction that catches a file that silently stopped shipping. The
# six docs are the reason the identity scan exists at all, and until this batch
# nothing asserted that any of them was in the tarball: a shrinking scan would
# have gone on reporting "clean across all N packed files".
barren_files_entries() { # $1 = package dir, $2 = members
  printf '%s\n' "$2" | node -e '
const p = require(process.argv[1] + "/package.json");
const files = (p.files || []).map(String)
  .map((s) => s.replace(/^\.\//, "").replace(/\/$/, ""));
let s = "";
process.stdin.on("data", (c) => { s += c; }).on("end", () => {
  const members = s.split("\n").filter(Boolean);
  const out = files.filter((f) => !members.some((m) => m === f || m.startsWith(f + "/")));
  process.stdout.write(out.join("\n"));
});
' "$1"
}

# The denylist's ERE lines, comments and blanks stripped — ⭐ BYTE-FOR-BYTE the
# repository's own consumer form (`identity-denylist.test.ts`'s
# `denylistPatterns()`: trim, then drop empty and `#`). The previous form did
# not TRIM, so an indented pattern would have been loaded with its leading
# whitespace and matched nothing. No denylist line is indented today — the two
# loaders are byte-identical at this HEAD, 50 patterns each — so this closes a
# latent divergence rather than a live one, and that distinction is the point.
#
# Returns non-zero when the list is missing or strips to empty: FAIL CLOSED,
# because a clean scan over zero patterns is the most dangerous output here.
load_denylist() { # $1 = denylist path, $2 = destination
  [ -f "$1" ] || return 1
  sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$1" | grep -vE '^(#|$)' >"$2" || true
  [ -s "$2" ]
}

# grep's exit status, mapped to a verdict. 0 = hit, 1 = clean, 2 = read error.
# ⭐ 2 IS NEVER CLEAN — a scanned path that cannot be read is a failure.
scan_verdict() { # $1 = grep rc
  case "$1" in
    0) echo hit ;;
    1) echo clean ;;
    *) echo error ;;
  esac
}

# ═══════════════════════════════════════════════════════════════════════════
# ⭐⭐ THE SELF-TEST — one control per INPUT FORM, in BOTH directions.
#
# The forms were ENUMERATED BEFORE these cases were written, which is the
# discipline whose absence made four instruments in this repository pass their
# own tests while blind to a form they meet in production.
#
# PURE by construction: no `npm pack`, no install, no network, no `node_modules`
# — it needs only `node`, `grep`, `sed` and a temp directory, so it is provable
# in the same stripped environment the security gate runs in.
# ═══════════════════════════════════════════════════════════════════════════
ST_RAN=0
ST_FAIL=0
st() { # $1 = name, $2 = actual, $3 = expected
  ST_RAN=$((ST_RAN + 1))
  if [ "$2" = "$3" ]; then
    printf '  ok   %s\n' "$1"
  else
    printf '  FAIL %s  — got [%s] want [%s]\n' "$1" "$2" "$3"
    ST_FAIL=$((ST_FAIL + 1))
  fi
}

self_test() {
  T="$WORK/st"
  mkdir -p "$T"

  # ── E-forms: the entry-point declaration ─────────────────────────────────
  mkdir -p "$T/pkg/build" "$T/pkg/bin"
  printf '%s\n' '{"name":"x","main":"./build/index.js","bin":{"spycore":"bin/spycore.js"},"files":["build","bin","README.md"]}' >"$T/pkg/package.json"
  : >"$T/pkg/build/index.js"
  : >"$T/pkg/bin/spycore.js"
  : >"$T/pkg/README.md"
  E="$(entry_points "$T/pkg")"
  st 'E1 main and bin are BOTH derived from the manifest' "$(printf '%s' "$E" | tr '\n' ' ')" 'build/index.js bin/spycore.js'
  st 'E2 a leading ./ is stripped' "$(printf '%s\n' "$E" | head -1)" 'build/index.js'
  mkdir -p "$T/none"
  printf '%s\n' '{"name":"x"}' >"$T/none/package.json"
  st 'E3 ⭐⭐ a manifest declaring NEITHER main NOR bin derives ZERO entry points (the vacuity the guard below refuses)' \
    "$(entry_points "$T/none")" ''

  # ── M-forms: the member count ────────────────────────────────────────────
  st 'M1 three members count as 3' "$(member_count 'a
b
c')" '3'
  st 'M2 ⭐ ZERO members count as 0 (the shipped form said 1)' "$(member_count '')" '0'

  # ── L-forms: the source-leak filter ──────────────────────────────────────
  CLEAN='build/index.js
bin/spycore.js
package.json
README.md
THIRD-PARTY-LICENSES'
  st 'L1 a clean member set yields NO leaks' "$(leak_members "$CLEAN")" ''
  st 'L2 a top-level src/ member is flagged' "$(leak_members 'src/index.ts')" 'src/index.ts'
  st 'L3 ⭐ a NESTED src/ member is flagged' "$(leak_members 'build/src/index.ts')" 'build/src/index.ts'
  st 'L4 ⭐ a NESTED tsconfig is flagged' "$(leak_members 'lib/tsconfig.json')" 'lib/tsconfig.json'
  st 'L5 ⭐ a NESTED .env is flagged' "$(leak_members 'build/.env.production')" 'build/.env.production'
  st 'L6 ⭐ a NESTED tests/ member is flagged' "$(leak_members 'sub/tests/secret.test.ts')" 'sub/tests/secret.test.ts'
  st 'L7 a .tsbuildinfo anywhere is flagged' "$(leak_members 'build/app.tsbuildinfo')" 'build/app.tsbuildinfo'
  # ⭐ THE FALSE-POSITIVE DIRECTION, which the shipped filter never had a case
  # for. A legitimate member whose NAME merely contains the substring must not
  # be flagged, or the filter would redden a correct artifact.
  st 'L8 ⭐ a member merely CONTAINING "src" is NOT flagged' "$(leak_members 'build/srcmap-helper.js')" ''
  st 'L9 ⭐ a member merely CONTAINING "tests" is NOT flagged' "$(leak_members 'build/latest-check.js')" ''

  # ── B-forms: the build payload floor ─────────────────────────────────────
  st 'B1 build/ members are counted' "$(build_file_count 'build/a.js
build/b.js
bin/x.js')" '2'
  st 'B2 ⭐ an empty member list yields ZERO build files (not a grep error)' "$(build_file_count '')" '0'
  st 'B3 a member set with no build/ yields 0' "$(build_file_count 'README.md')" '0'

  # ── A-forms: the EXTERNAL declaration, both directions ───────────────────
  MEM='build/index.js
bin/spycore.js
package.json
README.md'
  st 'A1 ⭐⭐ every member covered by `files` (or forced) yields NO uncovered' \
    "$(uncovered_members "$T/pkg" "$MEM")" ''
  st 'A2 ⭐⭐ a member OUTSIDE every `files` entry is reported' \
    "$(uncovered_members "$T/pkg" 'build/index.js
stowaway.txt')" 'stowaway.txt'
  st 'A3 ⭐ npm FORCED members are not reported (package.json, README, LICENSE, bin targets)' \
    "$(uncovered_members "$T/pkg" 'package.json
LICENSE
bin/spycore.js')" ''
  st 'A4 ⭐⭐ every `files` entry contributing a member yields NO barren entries' \
    "$(barren_files_entries "$T/pkg" "$MEM")" ''
  st 'A5 ⭐⭐ a DECLARED entry that ships NOTHING is reported (a doc silently stopped shipping)' \
    "$(barren_files_entries "$T/pkg" 'build/index.js
bin/spycore.js')" 'README.md'
  st 'A6 ⭐ a manifest with NO `files` array yields an empty allowlist (the vacuity the guard below refuses)' \
    "$(files_allowlist "$T/none")" ''
  st 'A7 the allowlist is read from the manifest, trailing slashes normalised' \
    "$(files_allowlist "$T/pkg" | tr '\n' ' ')" 'build bin README.md'

  # ── D-forms: the denylist loader ─────────────────────────────────────────
  printf '%s\n' '# a comment' '' 'alpha' '   indented   ' '# another' 'beta' >"$T/deny.txt"
  if load_denylist "$T/deny.txt" "$T/pat.txt"; then _r=ok; else _r=refused; fi
  st 'D1 a real denylist loads' "$_r" 'ok'
  st 'D2 comments and blanks are stripped' "$(wc -l <"$T/pat.txt" | tr -d ' ')" '3'
  st 'D3 ⭐ an INDENTED pattern is TRIMMED (the repository consumer form)' \
    "$(sed -n '2p' "$T/pat.txt")" 'indented'
  printf '%s\n' '# only comments' '' '   ' >"$T/empty.txt"
  if load_denylist "$T/empty.txt" "$T/pat2.txt"; then _r=ok; else _r=refused; fi
  st 'D4 ⭐⭐ a denylist that strips to EMPTY is REFUSED (fail closed)' "$_r" 'refused'
  if load_denylist "$T/nope-does-not-exist.txt" "$T/pat3.txt"; then _r=ok; else _r=refused; fi
  st 'D5 ⭐⭐ a MISSING denylist is REFUSED (fail closed)' "$_r" 'refused'
  st 'D6 grep rc=0 is a HIT' "$(scan_verdict 0)" 'hit'
  st 'D7 grep rc=1 is CLEAN' "$(scan_verdict 1)" 'clean'
  st 'D8 ⭐⭐ grep rc=2 is an ERROR, never CLEAN' "$(scan_verdict 2)" 'error'

  # ── C-forms: the case counter itself ─────────────────────────────────────
  # ⭐ The counter is the mechanism that makes every case above falsifiable, so
  # it carries its own controls — otherwise the floor could be met by a counter
  # that does not count.
  _before="$CHECKS"
  ok 'counter control (this line is a real check)'
  st 'C1 ⭐ ok() increments the case counter' "$((CHECKS - _before))" '1'
  _before="$CHECKS"
  FAIL_SAVED="$FAIL"
  bad 'counter control (deliberate, reverted below)'
  st 'C2 ⭐ bad() increments the case counter too' "$((CHECKS - _before))" '1'
  FAIL="$FAIL_SAVED"
  st 'C3 ⭐⭐ the floor is a LITERAL, not a variable compared with itself' \
    "$([ "$CHECK_FLOOR" -ge 19 ] && echo pinned || echo loose)" 'pinned'

  printf 'pack-verify self-test: %s/%s\n' "$((ST_RAN - ST_FAIL))" "$ST_RAN"
  if [ "$ST_FAIL" -gt 0 ]; then
    printf '::error::pack-verify self-test FAILED (%s of %s)\n' "$ST_FAIL" "$ST_RAN"
    return 1
  fi
  # ⭐ A PASS MUST BE PROVED ABLE TO SEE A CASE. Without this the self-test
  # could be emptied and would still print a green summary — which is exactly
  # the three routes F-2c-31 measured one level up.
  if [ "$ST_RAN" -lt 30 ]; then
    printf '::error::pack-verify self-test ran only %s case(s), floor 30\n' "$ST_RAN"
    return 1
  fi
  return 0
}

if [ "${1:-}" = "--self-test" ]; then
  _st_rc=0
  self_test || _st_rc=$?
  exit "$_st_rc"
fi

VERSION="$(node -p "require('$PKG_ROOT/package.json').version")"
say "[pack-verify] package @spycore/cli version=$VERSION node=$(node -v)"

# ─────────────────────── 1. PACK (this exercises prepack) ───────────────────
# ⭐ The pack step is itself a test of the anti-staleness mechanism: `prepack`
# runs the build, so a tree whose `build/` predates its `src/` cannot be packed
# stale. Measured before/after so the script REPORTS when it saved us.
BEFORE_HASH="(no pre-existing build)"
if [ -d "$PKG_ROOT/build" ]; then
  BEFORE_HASH="$(find "$PKG_ROOT/build" -type f -exec cat {} + | shasum -a 256 | cut -d' ' -f1)"
fi

say "[pack-verify] stage: npm pack (runs prepack -> build)…"
( cd "$PKG_ROOT" && npm pack --pack-destination "$WORK" ) >"$WORK/pack.log" 2>&1 || {
  tail -20 "$WORK/pack.log"; say "PACK-VERIFY FAIL (stage: pack)"; exit 1
}
TARBALL="$(ls "$WORK"/*.tgz 2>/dev/null | head -1)"
[ -n "$TARBALL" ] || { say "PACK-VERIFY FAIL (stage: pack produced no tarball)"; exit 1; }
say "[pack-verify] tarball: $(basename "$TARBALL") ($(wc -c <"$TARBALL" | tr -d ' ') bytes)"

AFTER_HASH="$(find "$PKG_ROOT/build" -type f -exec cat {} + | shasum -a 256 | cut -d' ' -f1)"
if [ "$BEFORE_HASH" = "$AFTER_HASH" ]; then
  ok "build/ was already current before packing"
else
  say "[pack-verify] ⭐ DRIFT CAUGHT: build/ changed during prepack — the tree was STALE"
  say "[pack-verify]   before: $BEFORE_HASH"
  say "[pack-verify]   after : $AFTER_HASH"
  say "[pack-verify]   Without prepack this pack would have shipped the stale build."
  # ⭐ Counted either way, so the case total does not depend on which branch the
  # tree happens to take. A check whose existence depends on the answer is not a
  # check.
  ok "prepack rebuilt a stale build/ — the drift is reported above"
fi

EXTRACT="$WORK/extract"
mkdir -p "$EXTRACT"
tar -xzf "$TARBALL" -C "$EXTRACT"
PKGDIR="$EXTRACT/package"

# ─────────────────────── 2. THE PACKED FILE SET ─────────────────────────────
MEMBERS="$(cd "$PKGDIR" && find . -type f | sed 's|^\./||' | sort)"
COUNT="$(member_count "$MEMBERS")"
say "[pack-verify] tarball carries $COUNT files"
if [ "$COUNT" -gt 0 ]; then ok "the tarball has $COUNT member(s)"; else bad "the tarball has NO members"; fi

ENTRIES="$(entry_points "$PKGDIR")"
# ⭐⭐ THE VACUITY GUARD. Without it, a manifest declaring neither `main` nor
# `bin` runs the loop below ZERO times and reports nothing at all.
if [ -z "$ENTRIES" ]; then
  bad "the manifest declares NO entry point (no main, no bin) — the entry-point check would have run ZERO cases"
else
  ok "the manifest declares $(member_count "$ENTRIES") entry point(s)"
  for e in $ENTRIES; do
    if [ -f "$PKGDIR/$e" ]; then ok "entry point present: $e"; else bad "declared entry point MISSING from tarball: $e"; fi
  done
fi

LEAKS="$(leak_members "$MEMBERS")"
if [ -n "$LEAKS" ]; then
  bad "source-tree files leaked into the tarball:"; printf '%s\n' "$LEAKS"
else
  ok "no src/tests/tsconfig/tsup/vitest/.env members (at any depth)"
fi

BUILDFILES="$(build_file_count "$MEMBERS")"
if [ "$BUILDFILES" -lt 5 ]; then bad "tarball carries only $BUILDFILES build/ files — the payload is missing"; else ok "$BUILDFILES build/ files"; fi

# ── ⭐⭐ 2b. THE EXTERNAL RE-GROUNDING ───────────────────────────────────────
# Everything above this line asks the tarball about itself. These two ask it
# about a DECLARATION THIS SCRIPT DOES NOT PRODUCE.
ALLOWLIST="$(files_allowlist "$PKGDIR")"
if [ -z "$ALLOWLIST" ]; then
  bad "the manifest declares NO \`files\` allowlist — the re-grounding below would have compared against nothing"
else
  ok "the \`files\` allowlist declares $(member_count "$ALLOWLIST") entr(y/ies)"

  UNCOVERED="$(uncovered_members "$PKGDIR" "$MEMBERS")"
  if [ -n "$UNCOVERED" ]; then
    bad "packed members that the \`files\` declaration does not cover:"; printf '%s\n' "$UNCOVERED" | head -20
  else
    ok "every packed member is covered by \`files\` or npm's forced set"
  fi

  BARREN="$(barren_files_entries "$PKGDIR" "$MEMBERS")"
  if [ -n "$BARREN" ]; then
    bad "\`files\` entries that shipped NOTHING (a declared file stopped shipping):"; printf '%s\n' "$BARREN"
  else
    ok "every \`files\` entry contributes at least one packed member"
  fi
fi

# ─────────────────────── 3. RULE 8 — IDENTITY SCAN OF THE ARTIFACT ──────────
# ⭐ The CI identity check scans `packages/cli/build` only. The tarball ships
# EIGHT further files (the six docs, the bin shim and package.json) that no gate
# has ever scanned. This scans every member of what the world downloads.
DENYLIST="$PKG_ROOT/../../.github/identity-denylist.txt"
PATTERNS="$WORK/patterns.txt"
if load_denylist "$DENYLIST" "$PATTERNS"; then
  set +e
  HITS="$(grep -rEnIi -f "$PATTERNS" "$PKGDIR")"
  rc=$?
  set -e
  case "$(scan_verdict "$rc")" in
    hit)
      bad "identity denylist hit inside the packed artifact:"; printf '%s\n' "$HITS" | head -20 ;;
    error)
      bad "identity scan read error (grep exit $rc) — a scanned path is missing" ;;
    *)
      ok "identity scan clean across all $COUNT packed files ($(wc -l <"$PATTERNS" | tr -d ' ') patterns)" ;;
  esac
else
  bad "identity denylist missing or empty at $DENYLIST — refusing to report a clean scan"
fi

# ─────────────────────── 4. INSTALL AS A USER WOULD ─────────────────────────
# --prefix keeps this out of the real global root. `npm install -g` resolves the
# `dependencies` set FRESH FROM THE REGISTRY — deliberately not the lockfile,
# because that is what a user gets.
say "[pack-verify] stage: npm install -g into an isolated prefix…"
mkdir -p "$PREFIX"
npm install -g --prefix "$PREFIX" "$TARBALL" >"$WORK/install.log" 2>&1 || {
  tail -20 "$WORK/install.log"; say "PACK-VERIFY FAIL (stage: install)"; exit 1
}
grep -E 'added [0-9]+ package' "$WORK/install.log" | tail -1 || true

PATH="$PREFIX/bin:$PATH"
export PATH
SPYCORE_NO_UPDATE_CHECK=1
export SPYCORE_NO_UPDATE_CHECK

# (1) RESOLUTION
if command -v spycore >/dev/null 2>&1; then ok "shim resolves on PATH: $(command -v spycore)"; else bad "spycore does not resolve on PATH after install"; fi

# ⭐⭐ (1b) THE ENTRY POINT RESOLVES IN THE INSTALLED COPY — a different
# derivation from the tarball, because npm produced it rather than this script.
# `main` is the one entry point npm does NOT force-include, so it is exactly the
# one that can go missing silently.
INSTALLED_ROOT=""
for _c in "$PREFIX/lib/node_modules/@spycore/cli" "$PREFIX/node_modules/@spycore/cli"; do
  if [ -f "$_c/package.json" ]; then INSTALLED_ROOT="$_c"; break; fi
done
if [ -z "$INSTALLED_ROOT" ]; then
  bad "the installed package root was not found under $PREFIX"
else
  MAIN_REL="$(node -p "String(require('$INSTALLED_ROOT/package.json').main || '').replace(/^\.\//, '')")"
  if [ -z "$MAIN_REL" ]; then
    bad "the INSTALLED manifest declares no main"
  elif [ -s "$INSTALLED_ROOT/$MAIN_REL" ]; then
    ok "the declared main resolves in the INSTALLED copy: $MAIN_REL"
  else
    bad "the declared main does NOT resolve in the INSTALLED copy: $MAIN_REL"
  fi
fi

# (2) IDENTITY
INSTALLED_VERSION="$(spycore --version 2>/dev/null | tr -d '\r\n ' || echo '')"
if [ "$INSTALLED_VERSION" = "$VERSION" ]; then ok "--version reports $INSTALLED_VERSION"; else bad "--version reported '$INSTALLED_VERSION', manifest says '$VERSION'"; fi

# (3) FUNCTION — a real command
if spycore --help >"$WORK/help.txt" 2>&1; then
  HELPLINES="$(wc -l <"$WORK/help.txt" | tr -d ' ')"
  if [ "$HELPLINES" -gt 20 ]; then ok "--help produced $HELPLINES lines"; else bad "--help produced only $HELPLINES lines"; fi
else
  bad "--help exited non-zero"
fi

# ─────────────────────── 5. THE SAFETY CONTROLS, IN THE INSTALLED COPY ──────
cat >"$WORK/stub.mjs" <<STUB
import { createServer } from 'node:http';
const block = (tool, args) => '\`\`\`spycore:tool\n' + JSON.stringify({ tool, args }) + '\n\`\`\`';
const SCENARIOS = {
  'SMOKE-MULTI': [
    block('write_file', { path: 'hello.txt', content: 'HELLO PACK\n' }),
    block('read_file', { path: 'hello.txt' }),
    block('run_command', { command: 'ls -la' }),
    'All three tools ran. DONE-MULTI.',
  ],
  'SMOKE-SYMLINK': [block('read_file', { path: 'link.txt' }), 'Read was blocked. DONE-SYMLINK.'],
  'SMOKE-GUARD': [block('run_command', { command: 'sh -c "rm -rf /"' }), 'Guard blocked it. DONE-GUARD.'],
};
createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    let reply = 'done';
    try {
      const body = JSON.parse(b);
      const users = body.messages.filter((m) => m.role === 'user');
      const first = users[0]?.content ?? '';
      const key = Object.keys(SCENARIOS).find((k) => first.includes(k));
      reply = key ? SCENARIOS[key][Math.min(users.length - 1, SCENARIOS[key].length - 1)] : 'no scenario';
    } catch { /* default reply */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
}).listen($STUB_PORT, '127.0.0.1', () => console.log('[stub] up'));
STUB
node "$WORK/stub.mjs" >"$WORK/stub.log" 2>&1 &
STUB_PID=$!
sleep 1

SPYCORE_CONFIG_DIR="$WORK/config"
export SPYCORE_CONFIG_DIR
mkdir -p "$SPYCORE_CONFIG_DIR"

# The agent flags are repeated per invocation rather than held in a variable:
# unquoted expansion does NOT word-split in every shell this may be run from,
# and a single mangled argument would make a control look absent when it is
# merely unreached.
run_agent() { # $1 = prompt, $2 = logfile, $3 = cwd
  ( cd "$3" && with_deadline 120 spycore agent "$1" \
      --provider openai --base-url "http://127.0.0.1:$STUB_PORT/v1" \
      --model stub --yes --no-plan ) >"$2" 2>&1 || true
}

S1="$WORK/s1"; mkdir -p "$S1"
run_agent "SMOKE-MULTI please" "$WORK/smoke-multi.log" "$S1"
if [ "$(cat "$S1/hello.txt" 2>/dev/null)" = "HELLO PACK" ] && grep -q "DONE-MULTI" "$WORK/smoke-multi.log"; then
  ok "smoke multi-tool (write -> read -> run_command) in the INSTALLED copy"
else
  bad "smoke multi-tool"; tail -10 "$WORK/smoke-multi.log"
fi

S2="$WORK/s2"; mkdir -p "$S2"
echo OUTSIDE >"$WORK/outside.txt"
ln -s "$WORK/outside.txt" "$S2/link.txt"
run_agent "SMOKE-SYMLINK please" "$WORK/smoke-symlink.log" "$S2"
if grep -q "escapes the working directory via a symlink" "$WORK/smoke-symlink.log"; then
  ok "smoke symlink-escape BLOCKED in the INSTALLED copy"
else
  bad "smoke symlink-escape"; tail -10 "$WORK/smoke-symlink.log"
fi

S3="$WORK/s3"; mkdir -p "$S3"
run_agent "SMOKE-GUARD please" "$WORK/smoke-guard.log" "$S3"
if grep -qi "catastrophic" "$WORK/smoke-guard.log"; then
  ok "smoke catastrophic-guard BLOCKED in the INSTALLED copy (despite --yes)"
else
  bad "smoke catastrophic-guard"; tail -10 "$WORK/smoke-guard.log"
fi

with_deadline 60 spycore mcp add permcheck -- node /nonexistent.js >/dev/null 2>&1 || true
MODE="$(filemode "$SPYCORE_CONFIG_DIR/config.json")"
if [ "$MODE" = "600" ]; then ok "smoke config-0600 (mode=$MODE) in the INSTALLED copy"; else bad "smoke config-0600 (mode=$MODE)"; fi

kill "$STUB_PID" 2>/dev/null || true
STUB_PID=""

# ─────────────────────── verdict ────────────────────────────────────────────
# ⭐⭐ A PASS MUST BE PROVED ABLE TO SEE A CASE. `rc=0` over a section that
# silently checked nothing is the failure mode this whole batch exists to close.
if [ "$CHECKS" -lt "$CHECK_FLOOR" ]; then
  say "[pack-verify] ::error:: only $CHECKS check(s) ran, floor $CHECK_FLOOR."
  say "[pack-verify] ::error:: A section stopped checking. rc=0 is not a measurement."
  FAIL=1
fi

if [ "$FAIL" = "0" ]; then
  say "PACK-VERIFY PASS version=$VERSION files=$COUNT checks=$CHECKS/$CHECK_FLOOR node=$(node -v)"
else
  say "PACK-VERIFY FAIL version=$VERSION files=$COUNT checks=$CHECKS/$CHECK_FLOOR node=$(node -v)"
  exit 1
fi
