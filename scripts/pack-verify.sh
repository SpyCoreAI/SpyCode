#!/bin/sh
# Packed-artifact verification for the SpyCore CLI (F-2c-12).
#
#   scripts/pack-verify.sh
#
#  WHY THIS EXISTS. Source-build verification verifies a SOURCE BUILD: it
# tars the checkout, reinstalls from the lockfile, runs the bundler itself and
# then drives the built entry point by absolute path. Not one step of that
# touches the artifact a user receives. `npm install -g @spycore/cli` delivers
# a DIFFERENT thing - the `files` allowlist only, the `dependencies` set
# resolved fresh from the registry, and a shim on PATH that the harness never
# invokes.
#
#  A HARNESS THAT VERIFIES A DIFFERENT ARTIFACT THAN THE ONE THAT SHIPS is the
# class this project has already closed TWICE at the container level ("the image
# CI builds is not the image production runs"). This is the same defect one
# level down, at the package. Every control closed in eleven batches was
# unproven in the installed copy until this script executed it there.
#
# WHAT "EXERCISED" MEANS HERE - decided and stated, not left to the reader:
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
#  F-2c-32 - THE CERTIFIER IS NOW CERTIFIED, AND FOUR OF ITS CLAIMS WERE
# WIDER THAN ITS CHECKS.
# =============================================================================
#
# This script certifies acceptance property P3 - *the packed artifact is what a
# user receives* - and until this batch it had NO SELF-TEST AT ALL, so its
# certification was UNKNOWN: not sound, not broken. Four defects were then
# measured rather than supposed, each with a positive control firing first in
# the same invocation:
#
#    1. A PASS OVER ZERO CASES. The entry-point loop is `for e in $ENTRIES`.
#      A manifest declaring neither `main` nor `bin` yields an EMPTY `$ENTRIES`,
#      so the loop body never executes: measured `cases=0 bad=0`, silently. The
#      control fired first - with both declared it is `cases=2`, and with the
#      file removed `bad=1`. That is F-2c-31's F-I1 inside the instrument that
#      certifies the artifact. There is now a vacuity guard AND a CASE COUNTER,
#      and the verdict line refuses a PASS below a literal floor.
#
#    2. THE CORPUS WAS DERIVED FROM THE THING IT CERTIFIES. This script ran
#      `npm pack` and then inspected WHAT IT HAD JUST PACKED. Nothing compared
#      the member set against a declaration the script does not produce, so a
#      packing defect could only be caught if it happened to break one of the
#      three self-referential checks. The cure is the one this arc has now used
#      three times: RE-GROUND THE CORPUS OUTSIDE THE GENERATOR. The `files`
#      allowlist in package.json is exactly such a declaration - nothing else in
#      the repository reads it against the artifact - so the packed set is now
#      checked BOTH WAYS against it: no member outside it (plus npm's forced
#      set), and no entry in it that contributes nothing.
#
#    3. THE SOURCE-LEAK FILTER WAS ANCHORED AT `^`, so it saw only top-level
#      leaks. Measured, 6 of 6 nested forms shipped unflagged: `build/src/
#      index.ts`, `lib/tsconfig.json`, `build/.env`, `build/.env.production`,
#      `config/vitest.config.ts`, `sub/tests/secret.test.ts`. Now segment-aware.
#
#    4. AN EMPTY MEMBER LIST COUNTED AS ONE. `printf '%s\n' "" | wc -l` is 1,
#      so a tarball with no members reported `files=1` in the verdict line.
#
#  AND ONE MEASURED DEFECT IS FIXED HERE, IN THE FALLBACK.
# `with_deadline`'s fallback branch - the branch macOS takes, and macOS is the
# platform the `packed-artifact` CI job runs on - used to kill only the DIRECT
# child, so a payload that starts a grandchild ORPHANED it. Measured through
# the repository's own group-killing probe harness with both controls firing:
# control-yes=`yes`, no-grandchild=`no`, grandchild=`yes`. The fix is a node
# supervisor (this script already requires node): the child runs detached in
# its own process group and the supervisor SIGKILLs the whole group on
# deadline. `setsid` does not exist on Darwin and `set -m` job control is
# unavailable without a tty, so neither shell route could do it. Proven by
# the W-cases in the self-test below.
#
#  WHAT THIS SCRIPT CANNOT SEE, stated here rather than discovered later:
#   - It installs from a LOCAL tarball, so it proves nothing about the registry
#     copy of any published version. It verifies what THIS tree would ship.
#   - `npm pack --ignore-scripts` bypasses `prepack` and would ship whatever
#     `build/` happens to be in the tree. That bypass is measured and real; no
#     mechanism inside package.json can close it.
#   - Dependency resolution is live, so a result is only as reproducible as the
#     registry was at the moment it ran.
#   - Windows is not covered: this is `sh`, and native Windows is not a
#     supported target for the CLI.
#   -  The blocked-string scan uses `grep -I`, so a denied string inside a BINARY
#     packed member is invisible. No member is binary today; that is a property
#     of the current artifact, not of the check.
#   -  The `files` re-grounding (directions 1 and 2) proves the packed set
#     agrees with the DECLARATION. It cannot prove the declaration is the
#     right one - that is direction 3's job (the expected-set check in
#     section 2b, pinned again by `tests/pack-verification.test.ts` P1),
#     and the two are deliberately different questions.
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

#  F-2c-32 - THE CASE COUNTER. `rc=0` IS NOT A MEASUREMENT.
#
# The verdict used to be `PACK-VERIFY PASS version=… files=… node=…` - three
# facts about the artifact and NOT ONE about how many checks ran. Combined with
# defect 1 above, a section that silently checked nothing still printed PASS.
# Every `ok`/`bad` now counts, and the verdict refuses a PASS below a floor
# pinned by a LITERAL - F-2c-31's F-I3 lesson: a floor compared only against
# itself is not a floor.
CHECKS=0
# TODAY'S MEASURED count on a green run: 20, measured 2026-11-09 on this
# manifest - 18 fixed checks + 1 per declared entry point, and the manifest
# declares 2 (main build/index.js and bin spycore). Raising the number of
# checks, or changing the entry-point count, raises this in the same commit;
# that is the R-6a rule applied to cases. R4-1 (phase 5 pass 4): the floor
# sat at 19 while the green run already counted 20, so exactly one dropped
# check still passed - a floor one below the measured count is not a floor.
CHECK_FLOOR=20

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
# GNU stat and BSD stat spell "permission bits" differently, and GNU `stat -f`
# means "filesystem status", not "format": probing the BSD form first prints
# the filesystem dump to stdout even though it exits non-zero, and that dump
# then pollutes the mode the fallback prints. Detect the flavour first, then
# ask for the mode in its own dialect; a missing file still reports `missing`.
filemode() {
  if stat --version >/dev/null 2>&1; then stat -c '%a' "$1" 2>/dev/null || echo missing;
  else stat -f '%Lp' "$1" 2>/dev/null || echo missing; fi
}

# SHA-256 of stdin, on any platform this script runs on. `shasum` is
# macOS/BSD; GNU/Linux carries `sha256sum`; a bare Windows shell has neither.
# The drift check below hashes build/ before and after packing - on a system
# with no hasher it silently compared two EMPTY strings and passed, because
# two empty strings are equal. So this helper NEVER emits an empty hash: with
# no hasher at all it fails hard with a clear message, and the call sites
# treat that failure as a pack-verify failure, not as a hash of "".
# The node branch is Buffer-based and binary-safe: chunks are concatenated as
# Buffers, so no encoding round-trip can mangle a byte.
hash_stdin() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  elif command -v node >/dev/null 2>&1; then
    node -e 'let b=[];process.stdin.on("data",c=>b.push(c)).on("end",()=>{process.stdout.write(require("crypto").createHash("sha256").update(Buffer.concat(b)).digest("hex"))})'
  else
    printf '%s\n' 'pack-verify: no SHA-256 tool found (shasum, sha256sum, or node) - cannot hash build/' >&2
    return 1
  fi
}

# Hash a build tree's file CONTENTS in canonical (sorted path) order.
# `find` yields files in readdir order, which is NOT a content order: tsup's
# `clean: true` deletes and recreates build/ on every prepack, and the
# recreated directory's readdir order differs - so the old
# `find … -exec cat {} +` concatenation changed hash while every file's bytes
# stayed identical, and the drift branch cried wolf on every clean rerun
# (R4-2, phase 5 pass 5). Sorting the paths first makes the hash a function
# of content only.
# The construction keeps the two properties the old form had: an EMPTY tree
# hashes empty input WITHOUT blocking - the read loop simply runs zero
# times, so `cat` is never invoked with no file arguments (a bare
# `xargs cat` would read stdin instead) - and it stays portable to macOS:
# no GNU-only `sort -z` / `xargs -r`, only POSIX `find`, `sort`, and a read
# loop. `LC_ALL=C` makes the order bytewise and locale-independent.
# Filenames under build/ are bundler-generated chunk names (no newlines),
# the same newline-delimited assumption the census (`list_members`) already
# makes. One implementation: both drift call sites and the self-test call
# this, never a transcribed copy.
build_hash() { # $1 = build dir
  find "$1" -type f | LC_ALL=C sort | while IFS= read -r f; do cat "$f"; done | hash_stdin
}

#  PORTABLE PER-COMMAND DEADLINE. This script runs on the HOST, and macOS
# ships no `timeout` and no `gtimeout` - the source-build harness runs its
# `timeout` calls INSIDE a Debian container, where the binary exists. Assuming
# it here made every smoke report FAIL for a missing binary rather than for
# its property, which is a control that cannot distinguish "blocked" from
# "never ran".
#
#  The fallback (the branch macOS takes) is a node supervisor - this script
# already requires node - because no shell route reaps the tree: the old
# pure-sh watchdog killed only the DIRECT child and orphaned grandchildren,
# `setsid` does not exist on Darwin, and `set -m` job control reports "set:
# can't access tty; job control turned off" without a tty. The child runs
# detached in its own process group; on deadline the supervisor SIGKILLs the
# whole group. Exit 124 on timeout (the `timeout` convention); a child's exit
# code is propagated, a signal death reports 128+signum as the shell would.
# (`node -e` puts the first argument at argv[1] - there is no script-path
# element as there is for a file - so the supervisor reads secs/cmd/args at
# 1/2/3+, not 2/3/4+.)
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="gtimeout"; fi

with_deadline() { # $1 = seconds, rest = command
  _secs="$1"; shift
  if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" "$_secs" "$@"; return $?; fi
  node -e 'const { spawn } = require("child_process"); const secs = Number(process.argv[1]); const cmd = process.argv[2]; const args = process.argv.slice(3); const child = spawn(cmd, args, { detached: true, stdio: "inherit" }); let timedOut = false; const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch (e) { try { child.kill("SIGKILL"); } catch (e2) {} } }, secs * 1000); child.on("error", (err) => { clearTimeout(timer); process.stderr.write("with_deadline: " + err.message + "\n"); process.exit(127); }); child.on("exit", (code, signal) => { clearTimeout(timer); if (timedOut) process.exit(124); if (signal) { const SIG = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 }; process.exit(128 + (SIG[signal] || 15)); } process.exit(code === null ? 1 : code); });' -- "$_secs" "$@"
}

# Wait for a readiness line to appear in a log file, bounded. $1 = log file,
# $2 = timeout in seconds. Returns 0 when the line appears, 1 on timeout.
# Polling (not a fixed sleep) is the point: the stub prints `[stub] up` when
# it is actually listening, and assuming a fixed delay is enough made a slow
# bind fail all three smoke checks with messages blaming the product (R4-6).
# The final grep covers the line landing during the last sleep.
wait_for_stub() { # $1 = log file, $2 = timeout seconds
  _w=0
  while [ "$_w" -lt "$2" ]; do
    if grep -qF '[stub] up' "$1" 2>/dev/null; then return 0; fi
    sleep 1
    _w=$((_w + 1))
  done
  grep -qF '[stub] up' "$1" 2>/dev/null
}

# ═══════════════════════════════════════════════════════════════════════════
# THE PURE PREDICATES.
#
#  EXTRACTED SO THE SELF-TEST DRIVES THE SHIPPED CODE, NOT A COPY OF IT.
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

# The stage-2 census: every member of the extracted tarball, one per line.
# R4-5: this was `find . -type f`, which lists regular files ONLY - a symlink
# member was invisible to the count, the leak filter, and both directions of
# the `files` re-grounding. Symlinks are listed too (`-type l`), WITHOUT `-L`:
# find never follows a link, so a symlink loop (a link to `.`, or a pair of
# links to each other) is listed once and can never hang the census, and a
# link to a directory is listed, never descended into. A dangling link is
# still `-type l`, so it is listed even though its target is absent.
list_members() { # $1 = package dir
  ( cd "$1" && find . \( -type f -o -type l \) | sed 's|^\./||' | sort )
}

# Every entry point the MANIFEST declares - read from the manifest, never from a
# hand-list, so a new bin or a renamed main is covered without anyone
# remembering to update this script. `bin` is normalised first: npm accepts
# it as a STRING for a single binary ("bin": "bin/spycore.js"), and
# Object.values on a string yields its CHARACTERS (R4-6) - a valid manifest
# then reddened on a dozen single-character "entry points".
entry_points() { # $1 = package dir
  node -e '
const p = require(process.argv[1] + "/package.json");
const out = new Set();
if (p.main) out.add(String(p.main).replace(/^\.\//, ""));
const bins = typeof p.bin === "string" ? [p.bin] : Object.values(p.bin || {});
for (const v of bins) out.add(String(v).replace(/^\.\//, ""));
process.stdout.write([...out].join("\n"));
' "$1"
}

# The `files` allowlist - THE EXTERNAL DECLARATION this script does not produce.
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
#  SEGMENT-ANCHORED, not `^`-anchored. The `^` form saw only top-level leaks;
# 6 of 6 nested forms shipped unflagged, measured.
leak_members() { # $1 = members
  [ -n "$1" ] || return 0
  printf '%s\n' "$1" | grep -E '(^|/)(src|tests)/|(^|/)tsconfig[^/]*\.json$|(^|/)tsup\.config\.|(^|/)vitest\.config\.|(^|/)\.env|\.tsbuildinfo$' || true
}

build_file_count() { # $1 = members
  [ -n "$1" ] || { echo 0; return 0; }
  printf '%s\n' "$1" | grep -c '^build/' || true
}

#  THE RE-GROUNDING, DIRECTION 1 - a member the DECLARATION does not cover.
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
const bins = typeof p.bin === "string" ? [p.bin] : Object.values(p.bin || {});
for (const v of bins) forced.add(String(v).replace(/^\.\//, ""));
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

#  THE RE-GROUNDING, DIRECTION 2 - a DECLARED entry that contributes NOTHING.
# This is the direction that catches a file that silently stopped shipping. The
# six docs are the reason the blocked-string scan exists at all, and until this batch
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

#  THE RE-GROUNDING, DIRECTION 3 - the DECLARATION against the EXPECTED set.
# Directions 1 and 2 compare members against the declaration; neither can
# see an entry silently REMOVED from the declaration. Dropping SECURITY.md
# and THIRD-PARTY-LICENSES from `files[]` passed both silently (R4-1): the
# members would not even contain the two docs, so there was no signal
# anywhere, while the artifact shipped without its security policy and its
# legal notice. This compares the declaration against the expected set, so
# a removal fails loudly here. The set is pinned twice - here, and in
# tests/pack-verification.test.ts P1, which reads it from package.json -
# and the two must agree. An EXTRA entry is reported too: a new shipped
# file is a deliberate decision, and the expected set (here and in the
# test) is updated with it, not silently absorbed.
expected_files_drift() { # $1 = package dir
  node -e '
const p = require(process.argv[1] + "/package.json");
const expected = ["build", "bin", "README.md", "CHANGELOG.md", "LICENSE", "NOTICE", "THIRD-PARTY-LICENSES", "SECURITY.md"];
const files = (p.files || []).map(String)
  .map((s) => s.replace(/^\.\//, "").replace(/\/$/, ""));
const out = [];
for (const e of expected) if (!files.includes(e)) out.push("missing: " + e);
for (const f of files) if (!expected.includes(f)) out.push("extra: " + f);
process.stdout.write(out.join("\n"));
' "$1"
}

# The denylist's ERE lines, comments and blanks stripped - byte-for-byte the
# canonical consumer form (trim, then drop empty lines and `#`). The previous
# form did not TRIM, so an indented pattern would have been loaded with its
# leading whitespace and matched nothing. The supply itself is private (see
# stage 3): no pattern, count, or content of the list is stated anywhere in
# this repo, so this comment cannot drift from it again.
#
# Returns non-zero when the list is missing or strips to empty: FAIL CLOSED,
# because a clean scan over zero patterns is the most dangerous output here.
load_denylist() { # $1 = denylist path, $2 = destination
  [ -f "$1" ] || return 1
  sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$1" | grep -vE '^(#|$)' >"$2" || true
  [ -s "$2" ]
}

# grep's exit status, mapped to a verdict. 0 = hit, 1 = clean, 2 = read error.
#  2 IS NEVER CLEAN - a scanned path that cannot be read is a failure.
scan_verdict() { # $1 = grep rc
  case "$1" in
    0) echo hit ;;
    1) echo clean ;;
    *) echo error ;;
  esac
}

# A blocked-string hit report that can NEVER disclose what was matched.
# grep's output lines are `path:line:content`, and the content BY DEFINITION
# contains a denylisted string - printing it would publish exactly what the
# scan exists to keep out of public CI logs. GitHub secret-masking cannot help:
# the stored list holds regex patterns, not the literal matched text. So the
# report carries only the file path and the match count per file, sorted so
# the output is deterministic.
hit_report() { # $1 = grep -rEn output
  [ -n "$1" ] || return 0
  printf '%s\n' "$1" | sed -E 's/:[0-9]+:.*$//' | sort | uniq -c | awk '{ c=$1; $1=""; sub(/^ /, ""); printf "  %s match(es) in %s\n", c, $0 }'
}

# The PUBLIC pattern list for fork runs: generic secret FORMAT shapes, every
# one already public in this repo (src/lib/redact.ts documents them), never
# identity strings. A fork PR cannot receive the private denylist, so this is
# the only scan that can run there; it is PARTIAL by construction and the
# stage says so. Each pattern requires a full credential-shaped token after
# its prefix, so the pattern spellings as they appear in redact.ts itself do
# NOT match (a `[` follows the prefix there) - pinned by self-test D14.
public_patterns() { # $1 = destination
  cat >"$1" <<'EOF'
sk-[A-Za-z0-9_-]{20,}
ghp_[A-Za-z0-9]{16,}
gho_[A-Za-z0-9]{16,}
github_pat_[A-Za-z0-9_]{16,}
AKIA[0-9A-Z]{16}
-----BEGIN (RSA |EC |OPENSSH |DSA |ED25519 |ENCRYPTED )?PRIVATE KEY-----
EOF
  [ -s "$1" ]
}

# ═══════════════════════════════════════════════════════════════════════════
#  THE SELF-TEST - one control per INPUT FORM, in BOTH directions.
#
# The forms were ENUMERATED BEFORE these cases were written, which is the
# discipline whose absence made four instruments in this repository pass their
# own tests while blind to a form they meet in production.
#
# PURE by construction: no `npm pack`, no install, no network, no `node_modules`
# - it needs only `node`, `grep`, `sed` and a temp directory, so it is provable
# in the same stripped environment the security gate runs in.
# ═══════════════════════════════════════════════════════════════════════════
ST_RAN=0
ST_FAIL=0
st() { # $1 = name, $2 = actual, $3 = expected
  ST_RAN=$((ST_RAN + 1))
  if [ "$2" = "$3" ]; then
    printf '  ok   %s\n' "$1"
  else
    printf '  FAIL %s  - got [%s] want [%s]\n' "$1" "$2" "$3"
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
  st 'E3  a manifest declaring NEITHER main NOR bin derives ZERO entry points (the vacuity the guard below refuses)' \
    "$(entry_points "$T/none")" ''
  #  R4-6: npm accepts `bin` as a STRING for a single binary. Object.values
  # on a string yields its characters, so the old form derived a dozen
  # single-character "entry points" from a valid manifest and reddened it.
  mkdir -p "$T/strbin"
  printf '%s\n' '{"name":"x","main":"./build/index.js","bin":"bin/spycore.js","files":["build","bin"]}' >"$T/strbin/package.json"
  st 'E4  a STRING-form bin is ONE entry point, not one per character (R4-6)' \
    "$(printf '%s' "$(entry_points "$T/strbin")" | tr '\n' ' ')" 'build/index.js bin/spycore.js'

  # ── M-forms: the member count ────────────────────────────────────────────
  st 'M1 three members count as 3' "$(member_count 'a
b
c')" '3'
  st 'M2  ZERO members count as 0 (the shipped form said 1)' "$(member_count '')" '0'
  # ── M-forms continued: the census must see SYMLINK members (R4-5) ───────
  #  The shipped census was `find . -type f`, which lists regular files only:
  # a symlink member was invisible to the count, the leak filter, and both
  # directions of the re-grounding. The census lists `-type f` AND `-type l`,
  # without `-L`, so it never follows a link.
  mkdir -p "$T/members"
  : >"$T/members/real.js"
  ln -s real.js "$T/members/link.js"
  ln -s nowhere "$T/members/dangling.js"
  ln -s . "$T/members/loop"
  st 'M3 a symlink member IS listed by the census' "$(list_members "$T/members")" 'dangling.js
link.js
loop
real.js'
  st 'M4  a DANGLING symlink member is still listed (it ships, even though its target does not)' \
    "$(list_members "$T/members" | grep -c dangling.js)" '1'
  st 'M5  a symlink LOOP (link -> .) is listed once and does NOT hang the census' \
    "$(list_members "$T/members" | grep -c '^loop$')" '1'

  # ── L-forms: the source-leak filter ──────────────────────────────────────
  CLEAN='build/index.js
bin/spycore.js
package.json
README.md
THIRD-PARTY-LICENSES'
  st 'L1 a clean member set yields NO leaks' "$(leak_members "$CLEAN")" ''
  st 'L2 a top-level src/ member is flagged' "$(leak_members 'src/index.ts')" 'src/index.ts'
  st 'L3  a NESTED src/ member is flagged' "$(leak_members 'build/src/index.ts')" 'build/src/index.ts'
  st 'L4  a NESTED tsconfig is flagged' "$(leak_members 'lib/tsconfig.json')" 'lib/tsconfig.json'
  st 'L5  a NESTED .env is flagged' "$(leak_members 'build/.env.production')" 'build/.env.production'
  st 'L6  a NESTED tests/ member is flagged' "$(leak_members 'sub/tests/secret.test.ts')" 'sub/tests/secret.test.ts'
  st 'L7 a .tsbuildinfo anywhere is flagged' "$(leak_members 'build/app.tsbuildinfo')" 'build/app.tsbuildinfo'
  #  THE FALSE-POSITIVE DIRECTION, which the shipped filter never had a case
  # for. A legitimate member whose NAME merely contains the substring must not
  # be flagged, or the filter would redden a correct artifact.
  st 'L8  a member merely CONTAINING "src" is NOT flagged' "$(leak_members 'build/srcmap-helper.js')" ''
  st 'L9  a member merely CONTAINING "tests" is NOT flagged' "$(leak_members 'build/latest-check.js')" ''

  # ── B-forms: the build payload floor ─────────────────────────────────────
  st 'B1 build/ members are counted' "$(build_file_count 'build/a.js
build/b.js
bin/x.js')" '2'
  st 'B2  an empty member list yields ZERO build files (not a grep error)' "$(build_file_count '')" '0'
  st 'B3 a member set with no build/ yields 0' "$(build_file_count 'README.md')" '0'

  # ── A-forms: the EXTERNAL declaration, both directions ───────────────────
  MEM='build/index.js
bin/spycore.js
package.json
README.md'
  st 'A1  every member covered by `files` (or forced) yields NO uncovered' \
    "$(uncovered_members "$T/pkg" "$MEM")" ''
  st 'A2  a member OUTSIDE every `files` entry is reported' \
    "$(uncovered_members "$T/pkg" 'build/index.js
stowaway.txt')" 'stowaway.txt'
  st 'A3  npm FORCED members are not reported (package.json, README, LICENSE, bin targets)' \
    "$(uncovered_members "$T/pkg" 'package.json
LICENSE
bin/spycore.js')" ''
  st 'A4  every `files` entry contributing a member yields NO barren entries' \
    "$(barren_files_entries "$T/pkg" "$MEM")" ''
  st 'A5  a DECLARED entry that ships NOTHING is reported (a doc silently stopped shipping)' \
    "$(barren_files_entries "$T/pkg" 'build/index.js
bin/spycore.js')" 'README.md'
  st 'A6  a manifest with NO `files` array yields an empty allowlist (the vacuity the guard below refuses)' \
    "$(files_allowlist "$T/none")" ''
  st 'A7 the allowlist is read from the manifest, trailing slashes normalised' \
    "$(files_allowlist "$T/pkg" | tr '\n' ' ')" 'build bin README.md'
  #  R4-6, second site: the forced set in uncovered_members had the same
  # string-bin shape. A string-form bin target is npm-forced, so it must
  # not be reported as uncovered.
  st 'A8  a STRING-form bin target is in the forced set, not uncovered (R4-6)' \
    "$(uncovered_members "$T/strbin" 'build/index.js
bin/spycore.js
package.json')" ''

  # ── F-forms: the DECLARATION itself against the EXPECTED set (R4-1) ─────
  #  Directions 1 and 2 above cannot see a `files` entry silently REMOVED:
  # dropping SECURITY.md and THIRD-PARTY-LICENSES passed both. These cases
  # prove direction 3 sees exactly that removal - and that it also sees an
  # entry ADDED without updating the expected set.
  mkdir -p "$T/full"
  printf '%s\n' '{"name":"x","files":["build","bin","README.md","CHANGELOG.md","LICENSE","NOTICE","THIRD-PARTY-LICENSES","SECURITY.md"]}' >"$T/full/package.json"
  mkdir -p "$T/dropped"
  printf '%s\n' '{"name":"x","files":["build","bin","README.md","CHANGELOG.md","LICENSE","NOTICE"]}' >"$T/dropped/package.json"
  mkdir -p "$T/added"
  printf '%s\n' '{"name":"x","files":["build","bin","README.md","CHANGELOG.md","LICENSE","NOTICE","THIRD-PARTY-LICENSES","SECURITY.md","EXTRA.md"]}' >"$T/added/package.json"
  st 'F1  a declaration that DROPPED two docs reports both as missing (R4-1)' \
    "$(expected_files_drift "$T/dropped")" 'missing: THIRD-PARTY-LICENSES
missing: SECURITY.md'
  st 'F2  a declaration with an EXTRA entry reports it (R4-1)' \
    "$(expected_files_drift "$T/added")" 'extra: EXTRA.md'
  st 'F3  the exact expected declaration drifts NOWHERE (R4-1)' \
    "$(expected_files_drift "$T/full")" ''

  # ── D-forms: the denylist loader ─────────────────────────────────────────
  printf '%s\n' '# a comment' '' 'alpha' '   indented   ' '# another' 'beta' >"$T/deny.txt"
  if load_denylist "$T/deny.txt" "$T/pat.txt"; then _r=ok; else _r=refused; fi
  st 'D1 a real denylist loads' "$_r" 'ok'
  st 'D2 comments and blanks are stripped' "$(wc -l <"$T/pat.txt" | tr -d ' ')" '3'
  st 'D3  an INDENTED pattern is TRIMMED (the repository consumer form)' \
    "$(sed -n '2p' "$T/pat.txt")" 'indented'
  printf '%s\n' '# only comments' '' '   ' >"$T/empty.txt"
  if load_denylist "$T/empty.txt" "$T/pat2.txt"; then _r=ok; else _r=refused; fi
  st 'D4  a denylist that strips to EMPTY is REFUSED (fail closed)' "$_r" 'refused'
  if load_denylist "$T/nope-does-not-exist.txt" "$T/pat3.txt"; then _r=ok; else _r=refused; fi
  st 'D5  a MISSING denylist is REFUSED (fail closed)' "$_r" 'refused'
  st 'D6 grep rc=0 is a HIT' "$(scan_verdict 0)" 'hit'
  st 'D7 grep rc=1 is CLEAN' "$(scan_verdict 1)" 'clean'
  st 'D8  grep rc=2 is an ERROR, never CLEAN' "$(scan_verdict 2)" 'error'

  # ── H-forms: a hit report must NEVER print matched content ───────────────
  #  The matched line BY DEFINITION contains a denylisted string, so the
  # report carries only the file path and the match count per file.
  st 'D9  a hit report shows the path and count, never the matched line' \
    "$(hit_report 'build/index.js:12:const k = '"'"'SENTINEL_MATCHED_CONTENT_XYZ'"'"'
build/index.js:40:const j = '"'"'SENTINEL_MATCHED_CONTENT_XYZ'"'"'')" \
    '  2 match(es) in build/index.js'
  st 'D10  a hit report sorts per-file counts by path' \
    "$(hit_report 'build/z.js:1:aaa
build/a.js:2:bbb
build/z.js:9:ccc')" \
    '  1 match(es) in build/a.js
  2 match(es) in build/z.js'
  st 'D11  an empty hit report prints nothing' "$(hit_report '')" ''
  st 'D12  the public pattern list is non-empty' \
    "$(public_patterns "$T/pub.txt" && wc -l <"$T/pub.txt" | tr -d ' ')" '6'
  printf '%s\n' 'const k = "github_pat_abcdefghijklmnopqrstuv";' >"$T/pub-hit.txt"
  st 'D13  the public list catches a credential-shaped token' \
    "$(grep -rEnIi -f "$T/pub.txt" "$T/pub-hit.txt" >/dev/null 2>&1 && echo hit || echo miss)" 'hit'
  printf '%s\n' 'github_pat_[A-Za-z0-9_]{16,}' >"$T/pub-miss.txt"
  st 'D14  the public list does NOT match its own spelling in redact.ts (no false positive on the shipped code)' \
    "$(grep -rEnIi -f "$T/pub.txt" "$T/pub-miss.txt" >/dev/null 2>&1 && echo hit || echo miss)" 'miss'

  # ── HASH-forms: the stdin hasher (hash_stdin) ───────────────────────────
  #  The drift check compares a before/after hash of build/. Its failure mode
  # was silent: with no hasher, both hashes were EMPTY and equal. The vectors
  # below pin the hash itself; the fallback cases pin that each branch is
  # actually reachable; H5 pins that no branch at all FAILS rather than
  # returning an empty hash.
  st 'H1 sha256 of "abc" is the known vector' \
    "$(printf 'abc' | hash_stdin)" 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  st 'H2 sha256 of the empty input is the known vector' \
    "$(printf '' | hash_stdin)" 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  #  The node fallback, forced by a PATH holding ONLY node and cut: shasum
  # and sha256sum are unreachable there, so the vector can only come from
  # the node branch.
  mkdir -p "$T/hashbin"
  ln -sf "$(command -v node)" "$T/hashbin/node"
  ln -sf "$(command -v cut)" "$T/hashbin/cut"
  st 'H3 the node fallback produces the same vector with no hasher on PATH' \
    "$(printf 'abc' | PATH="$T/hashbin" hash_stdin)" 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  #  The sha256sum fallback, forced the same way - skipped honestly on
  # platforms (macOS) that do not ship sha256sum at all.
  if command -v sha256sum >/dev/null 2>&1; then
    mkdir -p "$T/hashbin2"
    ln -sf "$(command -v sha256sum)" "$T/hashbin2/sha256sum"
    ln -sf "$(command -v cut)" "$T/hashbin2/cut"
    st 'H4 the sha256sum fallback produces the same vector with no shasum/node on PATH' \
      "$(printf 'abc' | PATH="$T/hashbin2" hash_stdin)" 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  else
    st 'H4 sha256sum fallback (absent on this platform - skipped)' 'skipped' 'skipped'
  fi
  mkdir -p "$T/emptybin"
  if PATH="$T/emptybin" hash_stdin </dev/null >/dev/null 2>&1; then _r=ok; else _r=refused; fi
  st 'H5 no hasher at all is REFUSED (fail closed, never an empty hash)' "$_r" 'refused'

  # ── G-forms: the drift hash is order-independent (R4-2) ──────────────────
  #  `find` yields readdir order, and tsup's `clean: true` recreates build/
  #  on every prepack, so the same content hashed in readdir order changed
  #  across a rebuild and the drift branch cried wolf on a clean tree.
  #  build_hash sorts the paths first: two trees with the same files created
  #  in different orders must hash EQUAL (G1), a genuinely changed file must
  #  still hash DIFFERENT (G2 - the alarm still fires), and an empty tree
  #  must hash the empty input without blocking on stdin (G3). The G1
  #  fixture is a proven negative control: the OLD unsorted concatenation
  #  hashes these two creation orders differently on this machine.
  mkdir -p "$T/drift-a" "$T/drift-b"
  printf 'aaa' >"$T/drift-a/a.js"
  printf 'bbb' >"$T/drift-a/b.js"
  printf 'ccc' >"$T/drift-a/c.js"
  printf 'ccc' >"$T/drift-b/c.js"
  printf 'bbb' >"$T/drift-b/b.js"
  printf 'aaa' >"$T/drift-b/a.js"
  st 'G1 the drift hash is IDENTICAL for the same tree created in a different order (R4-2)' \
    "$(build_hash "$T/drift-a")" "$(build_hash "$T/drift-b")"
  mkdir -p "$T/drift-c"
  printf 'aaa' >"$T/drift-c/a.js"
  printf 'bbb' >"$T/drift-c/b.js"
  printf 'CHANGED' >"$T/drift-c/c.js"
  if [ "$(build_hash "$T/drift-a")" = "$(build_hash "$T/drift-c")" ]; then _r=same; else _r=differs; fi
  st 'G2 a genuinely CHANGED file still hashes DIFFERENT (the drift alarm still fires) (R4-2)' \
    "$_r" 'differs'
  mkdir -p "$T/drift-empty"
  st 'G3 an EMPTY build tree hashes the empty input (never blocks on stdin) (R4-2)' \
    "$(build_hash "$T/drift-empty")" 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

  # ── W-forms: the deadline fallback reaps the whole tree ─────────────────
  #  These force the FALLBACK branch (TIMEOUT_BIN="") - on Linux the GNU
  # branch would otherwise answer, and the cases would prove nothing about
  # the supervisor. W2 is the measured defect: the old pure-sh watchdog
  # killed only the direct child, so the grandchild wrote its marker after
  # the deadline. The marker is written at t=3s, past the 1s deadline; the
  # wait below runs to t=5s, so a surviving grandchild is observed, not
  # assumed absent.
  _saved_timeout_bin="$TIMEOUT_BIN"
  TIMEOUT_BIN=""
  # NOTE: the `_rc=0; with_deadline ... || _rc=$?` shape is load-bearing.
  # This script runs under `set -e`: a bare `with_deadline` returning
  # non-zero inside `$(...)` kills the subshell before `echo $?` runs, so
  # the case records an EMPTY actual instead of the exit code. The `||`
  # branch is the context in which set -e is suppressed.
  _rc=0
  with_deadline 1 sleep 30 || _rc=$?
  st 'W1 a direct child past its deadline exits 124' "$_rc" '124'
  printf '%s\n' '#!/bin/sh' '(sleep 3; touch "$1") & sleep 30' >"$T/w2-payload.sh"
  _rc=0
  with_deadline 1 sh "$T/w2-payload.sh" "$T/w2-marker" || _rc=$?
  sleep 4
  if [ -f "$T/w2-marker" ]; then _m=present; else _m=absent; fi
  _actual="rc=$_rc
$_m"
  st 'W2 a grandchild is reaped: its marker is never written' "$_actual" 'rc=124
absent'
  _rc=0
  with_deadline 5 true || _rc=$?
  st 'W3 a quick command exits 0 under the deadline' "$_rc" '0'
  _rc=0
  with_deadline 5 sh -c 'exit 7' || _rc=$?
  st 'W4 a non-zero exit propagates through the deadline' "$_rc" '7'
  TIMEOUT_BIN="$_saved_timeout_bin"

  # ── W-forms continued: the stub readiness wait (R4-6) ───────────────────
  #  A fixed `sleep 1` assumed the stub is always up in a second; a slow bind
  # then failed all three smoke checks with messages blaming the product. The
  # wait polls for the stub's own `[stub] up` line, bounded.
  : >"$T/stub.log"
  ( sleep 2; printf '[stub] up\n' >>"$T/stub.log" ) &
  _rc=0
  wait_for_stub "$T/stub.log" 5 || _rc=$?
  st 'W5 the readiness wait returns 0 when the stub comes up within the timeout' "$_rc" '0'
  : >"$T/stub-never.log"
  _rc=0
  wait_for_stub "$T/stub-never.log" 2 || _rc=$?
  st 'W6 the readiness wait FAILS (bounded) when the stub never comes up' "$_rc" '1'
  printf '[stub] up\n' >"$T/stub-ready.log"
  _rc=0
  wait_for_stub "$T/stub-ready.log" 5 || _rc=$?
  st 'W7 the readiness wait returns 0 at once when the line is already there' "$_rc" '0'

  # ── C-forms: the case counter itself ─────────────────────────────────────
  #  The counter is the mechanism that makes every case above falsifiable, so
  # it carries its own controls - otherwise the floor could be met by a counter
  # that does not count.
  _before="$CHECKS"
  ok 'counter control (this line is a real check)'
  st 'C1  ok() increments the case counter' "$((CHECKS - _before))" '1'
  _before="$CHECKS"
  FAIL_SAVED="$FAIL"
  bad 'counter control (deliberate, reverted below)'
  st 'C2  bad() increments the case counter too' "$((CHECKS - _before))" '1'
  FAIL="$FAIL_SAVED"
  st 'C3  the floor is a LITERAL, not a variable compared with itself' \
    "$([ "$CHECK_FLOOR" -eq 20 ] && echo pinned || echo loose)" 'pinned'

  printf 'pack-verify self-test: %s/%s\n' "$((ST_RAN - ST_FAIL))" "$ST_RAN"
  if [ "$ST_FAIL" -gt 0 ]; then
    printf '::error::pack-verify self-test FAILED (%s of %s)\n' "$ST_FAIL" "$ST_RAN"
    return 1
  fi
  #  A PASS MUST BE PROVED ABLE TO SEE A CASE. Without this the self-test
  # could be emptied and would still print a green summary - which is exactly
  # the three routes F-2c-31 measured one level up. The floor is TODAY'S
  # MEASURED case count (64, measured 2026-11-10): every st() call is
  # unconditional, so the count has no legitimate variation - re-pin it in the
  # same commit whenever a case is added. R4-1 (phase 5 pass 4): the floor sat
  # at 30 while 61 cases ran, so 31 cases could vanish before it tripped.
  # R4-2 (phase 5 pass 5): 3 G-form cases added for the sorted drift hash,
  # so the floor moves 61 -> 64, measured 2026-11-10.
  if [ "$ST_RAN" -lt 64 ]; then
    printf '::error::pack-verify self-test ran only %s case(s), floor 64\n' "$ST_RAN"
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
#  The pack step is itself a test of the anti-staleness mechanism: `prepack`
# runs the build, so a tree whose `build/` predates its `src/` cannot be packed
# stale. Measured before/after so the script REPORTS when it saved us.
BEFORE_HASH="(no pre-existing build)"
BUILD_EXISTED=0
if [ -d "$PKG_ROOT/build" ]; then
  BUILD_EXISTED=1
  BEFORE_HASH="$(build_hash "$PKG_ROOT/build")" || {
    say "PACK-VERIFY FAIL (stage: no SHA-256 tool available to hash build/)"
    exit 1
  }
fi

say "[pack-verify] stage: npm pack (runs prepack -> build)…"
( cd "$PKG_ROOT" && npm pack --pack-destination "$WORK" ) >"$WORK/pack.log" 2>&1 || {
  tail -20 "$WORK/pack.log"; say "PACK-VERIFY FAIL (stage: pack)"; exit 1
}
TARBALL="$(ls "$WORK"/*.tgz 2>/dev/null | head -1)"
[ -n "$TARBALL" ] || { say "PACK-VERIFY FAIL (stage: pack produced no tarball)"; exit 1; }
say "[pack-verify] tarball: $(basename "$TARBALL") ($(wc -c <"$TARBALL" | tr -d ' ') bytes)"

AFTER_HASH="$(build_hash "$PKG_ROOT/build")" || {
  say "PACK-VERIFY FAIL (stage: no SHA-256 tool available to hash build/)"
  exit 1
}
if [ "$BEFORE_HASH" = "$AFTER_HASH" ]; then
  ok "build/ was already current before packing"
elif [ "$BUILD_EXISTED" -eq 0 ]; then
  # R4-2: build/ never existed before packing (the normal CI path - the
  # audit job has no build step before this script), so there was no stale
  # tree for prepack to save us from. Saying DRIFT CAUGHT here cried wolf
  # on every green CI run; only a real pre-existing hash that changed is drift.
  ok "build/ did not exist before packing; prepack built it from scratch"
else
  say "[pack-verify]  DRIFT CAUGHT: build/ changed during prepack - the tree was STALE"
  say "[pack-verify]   before: $BEFORE_HASH"
  say "[pack-verify]   after : $AFTER_HASH"
  say "[pack-verify]   Without prepack this pack would have shipped the stale build."
  #  Counted either way, so the case total does not depend on which branch the
  # tree happens to take. A check whose existence depends on the answer is not a
  # check.
  ok "prepack rebuilt a stale build/ - the drift is reported above"
fi

EXTRACT="$WORK/extract"
mkdir -p "$EXTRACT"
tar -xzf "$TARBALL" -C "$EXTRACT"
PKGDIR="$EXTRACT/package"

# ─────────────────────── 2. THE PACKED FILE SET ─────────────────────────────
MEMBERS="$(list_members "$PKGDIR")"
COUNT="$(member_count "$MEMBERS")"
say "[pack-verify] tarball carries $COUNT member(s)"
if [ "$COUNT" -gt 0 ]; then ok "the tarball has $COUNT member(s)"; else bad "the tarball has NO members"; fi

ENTRIES="$(entry_points "$PKGDIR")"
#  THE VACUITY GUARD. Without it, a manifest declaring neither `main` nor
# `bin` runs the loop below ZERO times and reports nothing at all.
if [ -z "$ENTRIES" ]; then
  bad "the manifest declares NO entry point (no main, no bin) - the entry-point check would have run ZERO cases"
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
if [ "$BUILDFILES" -lt 5 ]; then bad "tarball carries only $BUILDFILES build/ files - the payload is missing"; else ok "$BUILDFILES build/ files"; fi

# ──  2b. THE EXTERNAL RE-GROUNDING ───────────────────────────────────────
# Everything above this line asks the tarball about itself. These two ask it
# about a DECLARATION THIS SCRIPT DOES NOT PRODUCE.
ALLOWLIST="$(files_allowlist "$PKGDIR")"
if [ -z "$ALLOWLIST" ]; then
  bad "the manifest declares NO \`files\` allowlist - the re-grounding below would have compared against nothing"
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

  DRIFT="$(expected_files_drift "$PKGDIR")"
  if [ -n "$DRIFT" ]; then
    bad "\`files\` declaration drifted from the expected set (an entry was removed, or a new one added without updating the expected set in scripts/pack-verify.sh and tests/pack-verification.test.ts):"; printf '%s\n' "$DRIFT"
  else
    ok "the \`files\` declaration matches the expected set (build, bin, six docs)"
  fi
fi

# ──────────── 3. RULE 8 - BLOCKED-STRING SCAN OF THE ARTIFACT ───────────────
#  The CI blocked-string check scans the built output only. The tarball ships
# further files (the docs, the bin shim and package.json) that no gate
# has ever scanned. This scans every member of what the world downloads.
#  The denylist is NEVER stored in this repo: it is supplied privately at
# scan time through IDENTITY_DENYLIST_FILE (a CI secret in automation, a
# private local file for a developer run). A missing or empty supply fails
# closed below - no supply, no clean verdict - so the stage can never
# silently pass for want of a list.
DENYLIST="${IDENTITY_DENYLIST_FILE:-}"
PATTERNS="$WORK/patterns.txt"
# Fork-safe path (precondition 1): GitHub does not give the private denylist
# secret to fork PRs, so the full scan cannot run there. When
# PACK_VERIFY_PUBLIC_ONLY=1 (wired in ci.yml only for fork PRs) and no private
# list is supplied, stage 3 runs the PUBLIC format scan above instead of
# failing the job - and says PARTIAL in plain words, so a fork run can never
# be mistaken for a clean full scan. The full scan still runs on internal
# branches and on push to main, where the secret is available. The guard is
# never weakened to make fork CI green: a hit in EITHER scan fails the job,
# and without the flag a missing list still fails closed below.
if load_denylist "$DENYLIST" "$PATTERNS"; then
  set +e
  HITS="$(grep -rEnIi -f "$PATTERNS" "$PKGDIR")"
  rc=$?
  set -e
  case "$(scan_verdict "$rc")" in
    hit)
      bad "blocked-string hit inside the packed artifact:"; hit_report "$HITS" ;;
    error)
      bad "blocked-string scan read error (grep exit $rc) - a scanned path is missing" ;;
    *)
      ok "blocked-string scan clean across all $COUNT packed files" ;;
  esac
elif [ "${PACK_VERIFY_PUBLIC_ONLY:-}" = "1" ] || [ "${PACK_VERIFY_PUBLIC_ONLY:-}" = "true" ]; then
  say "[pack-verify] PARTIAL identity scan: no private denylist in this run (fork PRs never receive the secret) - scanning with the public format list only. This does NOT certify the artifact free of denylisted identity strings; the full scan runs on internal branches and on merge to main."
  public_patterns "$PATTERNS"
  set +e
  HITS="$(grep -rEnIi -f "$PATTERNS" "$PKGDIR")"
  rc=$?
  set -e
  case "$(scan_verdict "$rc")" in
    hit)
      bad "PARTIAL scan hit: a generic secret format was found inside the packed artifact:"; hit_report "$HITS" ;;
    error)
      bad "PARTIAL scan read error (grep exit $rc) - a scanned path is missing" ;;
    *)
      ok "PARTIAL identity scan clean across all $COUNT packed files (public format list only - full scan runs on merge)" ;;
  esac
else
  bad "identity denylist not supplied (IDENTITY_DENYLIST_FILE missing or empty) - refusing to report a clean scan"
fi

# ─────────────────────── 4. INSTALL AS A USER WOULD ─────────────────────────
# --prefix keeps this out of the real global root. `npm install -g` resolves the
# `dependencies` set FRESH FROM THE REGISTRY - deliberately not the lockfile,
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

#  (1b) THE ENTRY POINT RESOLVES IN THE INSTALLED COPY - a different
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

# (3) FUNCTION - a real command
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
# R4-6: wait for the stub's own readiness line, bounded - a bare `sleep 1`
# assumed one second is always enough, and on a slow bind all three smoke
# checks then failed with messages blaming the product. A stub that never
# comes up is a HARNESS failure, and it is said so here, before any smoke
# check runs against a dead port.
if ! wait_for_stub "$WORK/stub.log" 10; then
  bad "stub server did not print '[stub] up' within 10s (harness failure - no smoke check ran; see $WORK/stub.log)"
  kill "$STUB_PID" 2>/dev/null || true
  STUB_PID=""
  say "PACK-VERIFY FAIL (stage: stub readiness)"
  exit 1
fi

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
#  A PASS MUST BE PROVED ABLE TO SEE A CASE. `rc=0` over a section that
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
