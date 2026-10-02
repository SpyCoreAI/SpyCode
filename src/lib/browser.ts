import { spawn } from 'node:child_process';
import os from 'node:os';

/**
 * Open a URL in the user's default browser. Cross-platform with quiet
 * failure: returns false rather than throwing so the calling command can
 * fall back to printing the URL for the user to open manually.
 *
 * macOS uses `open`, Windows uses cmd.exe's `start`, Linux uses xdg-open.
 * We use `detached` + `unref` so the spawned helper process doesn't keep
 * the CLI alive after it exits.
 */
export function openInBrowser(url: string): boolean {
  let command: string;
  let args: string[];
  switch (os.platform()) {
    case 'darwin':
      command = 'open';
      args = [url];
      break;
    case 'win32':
      command = 'cmd.exe';
      // The empty string after /c "start" is the window title; required so
      // a URL with spaces/quotes isn't misparsed as the title.
      args = ['/c', 'start', '', url];
      break;
    default:
      command = 'xdg-open';
      args = [url];
      break;
  }

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {
      // No-op: caller will see the false return and fall back.
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
