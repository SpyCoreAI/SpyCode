import { spawn } from 'node:child_process';
import os from 'node:os';

/**
 * Open a URL in the user's default browser. Cross-platform with quiet
 * failure: returns false rather than throwing so the calling command can
 * fall back to printing the URL for the user to open manually.
 *
 * macOS uses `open`, Windows uses `explorer.exe`, Linux uses xdg-open.
 * We use `detached` + `unref` so the spawned helper process doesn't keep
 * the CLI alive after it exits.
 *
 * Windows deliberately does NOT go through `cmd.exe start`: libuv only
 * quotes argv elements containing space/tab/quote, so an `&` in the URL
 * (present in every OAuth authorize URL by construction) reached cmd.exe
 * unquoted as a command separator, and `%XX` sequences were expanded as
 * environment variables. explorer.exe takes the URL as one argv element
 * and hands it to the shell's URL handler with no command-line parsing,
 * so `&`, `%`, and friends ride verbatim.
 */
export function openInBrowser(url: string): boolean {
  // M1: validate the URL before spawning. Only http(s) URLs are allowed.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  let command: string;
  let args: string[];
  switch (os.platform()) {
    case 'darwin':
      command = 'open';
      args = [url];
      break;
    case 'win32':
      // explorer.exe opens the URL in the default browser (ShellExecute
      // semantics): no cmd.exe, no command separator, no % expansion.
      command = 'explorer.exe';
      args = [url];
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
