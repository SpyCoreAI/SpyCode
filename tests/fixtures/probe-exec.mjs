#!/usr/bin/env node
// =============================================================================
// THE EXECUTION-PROBE HARNESS — F-2c-31 §2.
//
// ⭐⭐ WHY THIS FILE EXISTS. F-2c-30's carrier probe ran every payload with
// `spawnSync(shell, ['-c', script], { timeout, killSignal: 'SIGKILL' })`. That
// deadline kills the DIRECT CHILD ONLY. A payload whose whole point is to start
// something else — `trap '…' EXIT`, `caffeinate -i sleep 300`, `nohup … &` — has
// its shell killed and its GRANDCHILD ORPHANED, and the orphan keeps running.
// Three probe processes were left alive on a developer machine for hours that
// way. They were harmless; they were also invisible to the probe that made them.
//
// ⭐ THIS IS THE CLASS THE PRODUCT CLOSED TWO BATCHES AGO (F-2c-2: `unref`, not
// `destroy`), now required of the instruments — which is the right order round,
// because an instrument that leaks processes is measuring with a dirty hand.
//
// ⭐⭐ AND IT HAS TO BE A SEPARATE PROCESS, for a reason that is a property of
// this host rather than a preference:
//   · killing a process GROUP requires the child to BE in its own group;
//   · a child only gets its own group from `setsid(2)`, which Node exposes as
//     `spawn(..., { detached: true })` — and `spawnSync` cannot use it, because
//     there is no moment between spawn and wait in which to send the signal;
//   · `setsid` THE BINARY DOES NOT EXIST ON DARWIN, so the shell route is closed
//     too. Measured: a backgrounded shell child shares the caller's process
//     group, so `kill -- -$PGID` — the documented way to kill "the child's
//     group" — KILLS THE CALLER. It did, twice, rc=144.
// So the probe is an async Node program invoked synchronously by the test.
//
// USAGE
//   node probe-exec.mjs <shell> <deadlineMs> <script>
//   node probe-exec.mjs --self-test
//
// STDOUT is exactly one word — the verdict — so the caller cannot misread it:
//   yes       the payload ran (the sentinel exists)
//   no        the payload did not run, and the probe reached a verdict
//   deadline  ⭐ THE DEADLINE WAS REACHED: an ABSENCE OF EVIDENCE, NOT A
//             REFUTATION. Three outcomes, never two. A tightened deadline once
//             turned a real carrier into a reported non-carrier, and that
//             correction is permanent.
//   error     the probe could not run at all (missing shell, spawn failure)
// =============================================================================
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SENTINEL = 'VICTIM';
/** the prefix every probe sandbox carries, so a sweep can find a survivor */
export const PROBE_PREFIX = 'spycore-probe-';

/**
 * Run one payload safely. Resolves to `{ verdict, dir, cleaned }`.
 *
 * THE THREE SAFETY PROPERTIES, all enforced here rather than at the call site:
 *  1. a DEADLINE, and the kill goes to the process GROUP (negative pid);
 *  2. the payload sees ONLY its own directory — cwd, `HOME` and `TMPDIR` all
 *     point into it, so it can neither read nor dirty the repository or $HOME;
 *  3. the sandbox is removed and its removal is CHECKED, not assumed.
 */
export async function probeOnce(shell, script, deadlineMs) {
  if (!existsSync(shell)) return { verdict: 'error', reason: `no such shell: ${shell}` };
  const dir = mkdtempSync(join(tmpdir(), PROBE_PREFIX));
  let child;
  let timer;
  let hitDeadline = false;
  try {
    child = spawn(shell, ['-c', script], {
      cwd: dir,
      detached: true, // ⭐ setsid(2): its OWN process group, which is the precondition
      stdio: 'ignore',
      env: { PATH: process.env.PATH ?? '', HOME: dir, TMPDIR: dir, LC_ALL: 'C' },
    });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return { verdict: 'error', reason: e.message };
  }
  const pid = child.pid;
  const killGroup = (sig) => { try { if (pid) process.kill(-pid, sig); } catch { /* already gone */ } };
  try {
    await new Promise((resolve) => {
      child.on('exit', resolve);
      child.on('error', resolve);
      timer = setTimeout(() => {
        hitDeadline = true;
        killGroup('SIGTERM');
        // ⭐ TERM then KILL: a payload that traps TERM must still die. `trap` is
        // itself one of the carriers this probe exists to measure, so a payload
        // that ignores TERM is not hypothetical here.
        setTimeout(() => { killGroup('SIGKILL'); resolve(undefined); }, 250);
      }, deadlineMs);
    });
  } finally {
    clearTimeout(timer);
    // ⭐⭐ THE GROUP IS KILLED ON EVERY PATH, INCLUDING A CLEAN EXIT. The direct
    // child exiting says NOTHING about its grandchildren — that is the entire
    // defect this file closes, so the belt-and-braces kill is the point and not
    // defensiveness.
    killGroup('SIGKILL');
  }
  // ⭐ the sentinel is checked AFTER a deadline too: the payload may well have
  // run before the kill, and that is an execution.
  const ran = existsSync(join(dir, SENTINEL));
  rmSync(dir, { recursive: true, force: true });
  return {
    verdict: ran ? 'yes' : hitDeadline ? 'deadline' : 'no',
    dir,
    cleaned: !existsSync(dir), // ⭐ removal is CHECKED, never assumed
  };
}

/** how many processes currently reference `needle` in their argv */
function psCount(needle) {
  return new Promise((resolve) => {
    const p = spawn('/bin/ps', ['-axo', 'pid,pgid,command'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let s = '';
    p.stdout.on('data', (d) => { s += d; });
    p.on('error', () => resolve(-1));
    p.on('exit', () => resolve(s.split('\n').filter((l) => l.includes(needle) && !l.includes('-axo')).length));
  });
}

async function selfTest() {
  let ran = 0; let fail = 0;
  const ck = (n, ok, d = '') => { ran++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? '  — ' + d : ''}`); if (!ok) fail++; };

  // ── the three outcomes, each its own case ──────────────────────────────────
  const a = await probeOnce('/bin/sh', `: > ${SENTINEL}`, 5000);
  ck('P1 a payload that RUNS reports `yes`', a.verdict === 'yes', a.verdict);
  const b = await probeOnce('/bin/sh', 'true', 5000);
  ck('P2 a payload that does NOT run the sentinel reports `no`', b.verdict === 'no', b.verdict);
  const c = await probeOnce('/bin/sh', 'sleep 30', 800);
  ck('P3 ⭐⭐ a payload over the DEADLINE reports `deadline`, never `no`', c.verdict === 'deadline', c.verdict);
  const d = await probeOnce('/nonexistent/shell-xyzzy', 'true', 800);
  ck('P4 a missing shell reports `error`, not a refutation', d.verdict === 'error', d.verdict);
  // ⭐ THE DISTINCTION, AS ITS OWN CASE: a payload that runs the sentinel and
  // THEN hangs is a `yes`. A deadline is not permitted to overwrite evidence.
  const e = await probeOnce('/bin/sh', `: > ${SENTINEL}; sleep 30`, 900);
  ck('P5 ⭐⭐ a SLOW carrier is still a carrier (sentinel beats deadline)', e.verdict === 'yes', e.verdict);

  // ── the sandbox ───────────────────────────────────────────────────────────
  ck('P6 the sandbox is removed and its removal is CHECKED', a.cleaned === true && e.cleaned === true);
  // ⭐ P7's FIRST SPELLING WAS MY OWN BROKEN CASE. It compared `"$HOME"` with
  // `"$PWD"`, and on darwin `mkdtemp` returns `/var/folders/…` while `pwd`
  // reports the symlink-resolved `/private/var/folders/…` — so the case failed on
  // a path-resolution artefact, not on the property. The property is *reachability*,
  // so it is now tested by REACHING: a write through `$HOME` must land in the
  // sandbox, and the same for `$TMPDIR`.
  const f = await probeOnce('/bin/sh',
    `: > "$HOME/via-home"; : > "$TMPDIR/via-tmpdir"; test -f via-home && test -f via-tmpdir && : > ${SENTINEL}`, 5000);
  ck('P7 ⭐ HOME and TMPDIR both RESOLVE INTO the sandbox (a write through either lands there)',
    f.verdict === 'yes', f.verdict);

  // ── ⭐⭐ THE GROUP KILL, PROVED AGAINST A GRANDCHILD ───────────────────────
  // The whole reason this file exists. A payload that starts a background
  // grandchild and then hangs: killing only the direct child leaves the
  // grandchild alive, which is what happened for hours.
  const marker = `${PROBE_PREFIX}grandchild-probe`;
  const before = await psCount(marker);
  const g = await probeOnce('/bin/sh', `/bin/sh -c 'sleep 25; : > ${marker}' & sleep 25`, 900);
  ck('P8 the grandchild payload reaches its deadline', g.verdict === 'deadline', g.verdict);
  await new Promise((r) => setTimeout(r, 900)); // ⭐ settle: a DYING process still lists in ps
  const after = await psCount(marker);
  ck('P9 ⭐⭐ the GROUP kill reaches the GRANDCHILD (0 survivors)',
    after <= before, `before=${before} after=${after}`);

  // ⭐⭐ P12 — THE CLEAN-EXIT LEAK, AND IT IS THE REALISTIC ONE.
  //
  // This case exists because a mutation found its absence. Deleting the
  // belt-and-braces group kill on the CLEAN path left P1–P11 all green: P8/P9 go
  // through the DEADLINE path, which kills the group from its own timeout, so
  // the `finally` kill was load-bearing for no control at all — R21 again, and
  // caught by mutation rather than by review.
  //
  // ⭐ And the uncovered path is the DANGEROUS one. `nohup cmd &`, `trap … EXIT`
  // and `caffeinate -i cmd &` all make the shell exit IMMEDIATELY while the
  // grandchild keeps running: no deadline is ever reached, so nothing would have
  // killed it. That is the exact shape that left three processes alive for hours.
  const fastMarker = `${PROBE_PREFIX}fastexit-probe`;
  const h = await probeOnce('/bin/sh', `/bin/sh -c 'sleep 20; : > ${fastMarker}' & : > ${SENTINEL}`, 8000);
  ck('P12a the fast-exit payload completes well inside its deadline', h.verdict === 'yes', h.verdict);
  await new Promise((r) => setTimeout(r, 900));
  const fastAlive = await psCount(fastMarker);
  ck('P12b ⭐⭐ a payload that exits CLEANLY still has its grandchild reaped (0 survivors)',
    fastAlive === 0, `${fastAlive} survivor(s) — the clean-exit path leaks`);

  // ⭐ AND THE CONTROL THAT MAKES P9 MEAN ANYTHING: without a group kill the
  // grandchild survives. Proved by doing exactly that — kill the direct child
  // only — and requiring the survivor to be VISIBLE.
  const ctlMarker = `${PROBE_PREFIX}ctl-grandchild`;
  const ctlDir = mkdtempSync(join(tmpdir(), PROBE_PREFIX));
  const ctl = spawn('/bin/sh', ['-c', `/bin/sh -c 'sleep 6; : > ${ctlMarker}' & sleep 6`], {
    cwd: ctlDir, detached: true, stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 700));
  const ctlBefore = await psCount(ctlMarker);
  try { if (ctl.pid) process.kill(ctl.pid, 'SIGKILL'); } catch { /* gone */ } // DIRECT CHILD ONLY
  await new Promise((r) => setTimeout(r, 700));
  const ctlAfter = await psCount(ctlMarker);
  ck('P10 ⭐⭐ CONTROL: killing the DIRECT CHILD ONLY leaves the grandchild ALIVE',
    ctlBefore >= 1 && ctlAfter >= 1, `before=${ctlBefore} after=${ctlAfter}`);
  // clean the control up properly, by group
  try { if (ctl.pid) process.kill(-ctl.pid, 'SIGKILL'); } catch { /* gone */ }
  await new Promise((r) => setTimeout(r, 700));
  const ctlEnd = await psCount(ctlMarker);
  ck('P11 ⭐ and the control is then cleaned up by GROUP (0 survivors)', ctlEnd === 0, `${ctlEnd}`);
  rmSync(ctlDir, { recursive: true, force: true });

  console.log('');
  if (ran === 0) { console.log('::error::ZERO probe cases ran — failing closed'); return 1; }
  console.log(`probe-exec self-test: ${ran - fail}/${ran}`);
  if (fail) console.log(`::error::SELF-TEST FAILED (${fail})`);
  return fail === 0 ? 0 : 1;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--self-test')) {
  process.exit(await selfTest());
}
if (argv.length >= 3) {
  const [shell, deadline, script] = argv;
  const r = await probeOnce(shell, script, Number(deadline));
  process.stdout.write(r.verdict);
  process.exit(0);
}
