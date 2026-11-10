/**
 * ⭐⭐ THE PUBLISHED 0.6.0 CATASTROPHIC SCREEN — A FROZEN BASELINE. DO NOT EDIT.
 *
 * Extracted VERBATIM from
 *   24da8bf3550086e8f0cbd7e28b70071cc55e6de0:packages/cli/src/lib/agent/tools.ts
 * lines 1147–1271. That commit is the publish point of `@spycore/cli@0.6.0` —
 * the artifact users actually have installed — so this file is not "an old
 * copy of the screen", it is A MEASUREMENT INSTRUMENT: the thing every future
 * version of the screen must be at least as strong as.
 *
 * ⭐ WHY IT EXISTS. F-2c-24 measured the rewritten screen at HEAD and found it
 * blocking 20 of 20 catastrophic forms — a clean, reassuring number. Measured
 * as a DIFFERENTIAL against this baseline, the same tree was letting through
 * more than a thousand inputs the published version refused, behind prefixes
 * that read as ordinary lines. Presence of a control is not strength of a
 * control, and strength is only meaningful RELATIVE TO WHAT USERS RUN.
 *
 * ⭐⭐ EDITING THIS FILE IS THE ONE WAY TO MAKE `screen-differential.test.ts`
 * PASS DISHONESTLY, so its bytes are pinned by sha256 in that test. If you
 * change anything below, that pin goes red before the differential does.
 *
 * It is `tests/`-resident and therefore manifest-excluded: it never ships.
 */

// ── BEGIN VERBATIM 24da8bf3550086e8f0cbd7e28b70071cc55e6de0 ──
/**
 * A SMALL safety net (NOT a sandbox): hard-block obviously catastrophic
 * commands BEFORE the approval prompt, so even --yes cannot run them. The real
 * protections are the cwd, the approval prompt, and the timeout; OS-level
 * sandboxing is a later phase. Returns a reason string, or null when allowed.
 * Deliberately not exhaustive — it only covers the obvious destroyers (and may
 * over-match, e.g. inside an echo string, which is acceptable for a safety net).
 */
export function matchesCatastrophic(command: string): string | null {
  return matchCatastrophicInner(command, 0);
}

/**
 * Pull the payload strings out of common shell-wrapper forms (`sh -c "…"`,
 * `bash -c '…'`, bare-word payloads) so the matcher can scan INSIDE them.
 * A wrapper must not defeat the net (red-team vector D); deeper obfuscation
 * (base64 | sh, $IFS splicing, eval chains) is out of scope by design — the
 * approval prompt remains the primary control.
 */
function extractWrapperPayloads(command: string): string[] {
  const out: string[] = [];
  const re = /\b(?:sh|bash|zsh|dash|ksh)\s+(?:[^|;&"']*\s)?-c\s+("((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const dq = m[2];
    const sq = m[3];
    const bare = m[4];
    if (typeof dq === 'string') out.push(dq.replace(/\\(.)/g, '$1'));
    else if (typeof sq === 'string') out.push(sq);
    else if (typeof bare === 'string') out.push(bare);
  }
  return out;
}

function matchCatastrophicInner(command: string, depth: number): string | null {
  const c = command.replace(/\s+/g, ' ').trim();
  const lc = c.toLowerCase();

  // Fork bomb, any spacing: :(){ :|:& };:
  if (c.replace(/\s+/g, '').includes(':(){:|:&};:')) return 'fork bomb';

  // rm with BOTH recursive and force flags … A quote, command separator, OR a
  // PATH SEPARATOR before the word counts as a boundary, so `"rm" -rf /`,
  // `sh -c "rm -rf /"`, and pathed invocations (`/bin/rm`, `/usr/bin/rm`) all
  // match — we key on the basename `rm`, not on the leading path (CL3).
  const padded = ` ${lc} `;
  const hasRm = /[\s;&|("'/]rm['"]?\s/.test(padded);
  const recursive = /\s-{1,2}[a-z]*r/.test(lc) || /--recursive\b/.test(lc);
  const force = /\s-{1,2}[a-z]*f/.test(lc) || /--force\b/.test(lc);
  if (hasRm && recursive && force) {
    if (/--no-preserve-root/.test(lc)) return 'rm --no-preserve-root';
    // … aimed at the filesystem root or HOME. The target may be quote-wrapped
    // (`rm -rf "/"`), and the HOME var may be braced (`${HOME}`) and preceded
    // by a quote / `=` / `:` / path separator (`rm -rf "$HOME"`) — CL4.
    const rootOrTilde = /[\s]["']?(\/|\/\*|~|~\/)(\s|$|\*|\/|['"])/.test(padded);
    const homeVar = /[\s"'=:/]\$\{?home\}?(\s|$|\*|\/|['"])/.test(padded);
    if (rootOrTilde || homeVar) return 'rm -rf on / ~ or $HOME';
    // … aimed at a top-level system directory
    if (/[\s]\/(usr|etc|bin|sbin|var|lib|boot|sys|dev|root|opt)(\/\S*)?(\s|$)/.test(padded)) {
      return 'rm -rf on a system directory';
    }
  }

  // Format a filesystem
  if (/\bmkfs(\.\w+)?\b/.test(lc)) return 'mkfs (format filesystem)';

  // Write a raw block device with dd
  if (/\bdd\b[^\n]*\bof=\/dev\/(sd|hd|disk|rdisk|nvme|vd)/.test(lc)) return 'dd to a block device';

  // Redirect/overwrite a raw block device
  if (/>\s*\/dev\/(sd|hd|disk|rdisk|nvme|vd)/.test(lc)) return 'overwrite a block device';

  // Pipe a network download straight into a shell (curl … | sh) — remote code
  // execution. curl/wget/fetch piped to sh/bash/zsh/dash/ksh, optional sudo.
  if (/\b(?:curl|wget|fetch)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh)\b/.test(lc)) {
    return 'pipe a network download into a shell';
  }

  // `find … -delete` or `find … -exec rm …` aimed at the filesystem root, HOME,
  // or a system directory — a whole-tree wipe the rm net (basename-keyed) misses.
  if (/\bfind\b/.test(lc)) {
    const findDestroys = /\s-delete\b/.test(lc) || /\s-exec\b[^\n]*\brm\b/.test(lc);
    const rootOrTilde = /[\s]["']?(\/|\/\*|~|~\/)(\s|$|\*|\/|['"])/.test(padded);
    const homeVar = /[\s"'=:/]\$\{?home\}?(\s|$|\*|\/|['"])/.test(padded);
    const systemDir = /[\s]\/(usr|etc|bin|sbin|var|lib|boot|sys|dev|root|opt)(\/\S*)?(\s|$)/.test(padded);
    if (findDestroys && (rootOrTilde || homeVar || systemDir)) {
      return 'find -delete/-exec rm on / ~ or a system directory';
    }
  }

  // Recursive chmod/chown/chgrp aimed at / ~ $HOME or a system directory —
  // wrecks permissions/ownership tree-wide (e.g. `chmod -R 777 ~`).
  if (
    /\b(?:chmod|chown|chgrp)\b/.test(lc) &&
    (/\s-{1,2}[a-z]*r/.test(lc) || /--recursive\b/.test(lc))
  ) {
    const rootOrTilde = /[\s]["']?(\/|\/\*|~|~\/)(\s|$|\*|\/|['"])/.test(padded);
    const homeVar = /[\s"'=:/]\$\{?home\}?(\s|$|\*|\/|['"])/.test(padded);
    const systemDir = /[\s]\/(usr|etc|bin|sbin|var|lib|boot|sys|dev|root|opt)(\/\S*)?(\s|$)/.test(padded);
    if (rootOrTilde || homeVar || systemDir) {
      return 'recursive chmod/chown on / ~ or a system directory';
    }
  }

  // Redirect (overwrite/append) or tee onto an SSH, shell-init, or system auth
  // file — key injection or account lockout (`> ~/.ssh/authorized_keys`,
  // `: > ~/.bashrc`, `echo … > /etc/passwd`, `tee /etc/shadow`).
  if (
    /(?:>{1,2}|\btee\b(?:\s+-\S+)*)\s*["']?(?:(?:~|\$\{?home\}?)\/\.(?:ssh\b|ssh\/|bash_profile|bash_login|bashrc|zshrc|zshenv|zprofile|profile|inputrc)|\/etc\/(?:passwd|shadow|sudoers))/i.test(
      c,
    )
  ) {
    return 'overwrite a sensitive credential/shell-init/system file';
  }

  // Scan inside sh/bash/zsh -c payloads (bounded recursion for nesting).
  if (depth < 3) {
    for (const payload of extractWrapperPayloads(c)) {
      const hit = matchCatastrophicInner(payload, depth + 1);
      if (hit) return hit;
    }
  }

  return null;
}
// ── END VERBATIM ──

export { matchesCatastrophic as matchesCatastrophic060 };
