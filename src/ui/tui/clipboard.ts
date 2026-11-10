/**
 * Best-effort clipboard copy for the "copy last reply" key (Ctrl+Y).
 *
 * No new dependencies: delegates to the platform helper (pbcopy / xclip /
 * xsel / clip). Returns false when no helper exists - the caller shows a
 * plain notice instead of failing. Never throws.
 */
import { execFileSync } from 'node:child_process';

export function copyToClipboard(text: string): boolean {
  try {
    if (process.platform === 'darwin') {
      execFileSync('pbcopy', { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
      return true;
    }
    if (process.platform === 'win32') {
      execFileSync('clip', { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
      return true;
    }
    // Linux / WSL: prefer xclip, fall back to xsel.
    try {
      execFileSync('xclip', ['-selection', 'clipboard'], {
        input: text,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      return true;
    } catch {
      execFileSync('xsel', ['--clipboard', '--input'], {
        input: text,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      return true;
    }
  } catch {
    return false;
  }
}
