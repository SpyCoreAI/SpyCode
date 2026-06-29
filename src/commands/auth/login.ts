import os from 'node:os';
import { Command } from 'commander';
import ora from 'ora';
import { api } from '../../lib/api.js';
import { setToken } from '../../lib/auth.js';
import { openInBrowser } from '../../lib/browser.js';
import {
  fail,
  getOutputOptions,
  info,
  json,
  print,
  success,
  warn,
} from '../../lib/output.js';
import { EXIT_AUTH_ERROR, SpycoreCliError } from '../../lib/errors.js';

interface LoginInitResp {
  pollToken: string;
  approveUrl: string;
  expiresAt: string;
}

interface PollResp {
  status: 'pending' | 'approved' | 'denied' | 'expired';
  token: string | null;
  email: string | null;
}

const POLL_INTERVAL_MS = 2_000;
const POLL_DEADLINE_MS = 5 * 60 * 1000;

function defaultDeviceName(): string {
  try {
    return os.hostname() || 'spycore-cli';
  } catch {
    return 'spycore-cli';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description('Authorize this device by approving in the browser')
    .option(
      '-n, --name <name>',
      'Friendly device label (defaults to the OS hostname)',
    )
    .option('--no-open', 'Do not auto-launch the browser; just print the URL')
    .action(async (opts: { name?: string; open?: boolean }) => {
      const parentOpts = program.opts<{ apiUrl?: string }>();
      const name = (opts.name ?? defaultDeviceName()).slice(0, 100);
      const apiUrlOverride = parentOpts.apiUrl;

      let init: LoginInitResp;
      try {
        init = await api.post<LoginInitResp>('/auth/cli/login', {
          apiUrlOverride,
          anonymous: true,
          body: { name },
        });
      } catch (err) {
        fail(err);
      }

      if (getOutputOptions().json) {
        // Stream JSON status updates so scripts can react. We emit one
        // 'pending' line, then the final 'approved'/'denied'/'expired'.
        json({ status: 'pending', approveUrl: init.approveUrl });
      } else {
        info(`Open this URL in your browser to authorize "${name}":`);
        print(`  ${init.approveUrl}`);
        if (opts.open !== false) {
          const launched = openInBrowser(init.approveUrl);
          if (!launched) {
            warn('Could not auto-launch a browser. Open the URL manually.');
          }
        }
      }

      const spinner = !getOutputOptions().json && process.stdout.isTTY
        ? ora('Waiting for browser confirmation…').start()
        : null;

      const deadline = Date.now() + POLL_DEADLINE_MS;
      let outcome: PollResp | null = null;
      try {
        while (Date.now() < deadline) {
          await sleep(POLL_INTERVAL_MS);
          const poll = await api
            .get<PollResp>(
              `/auth/cli/poll/${encodeURIComponent(init.pollToken)}`,
              { apiUrlOverride, anonymous: true },
            )
            .catch((err) => {
              spinner?.stop();
              fail(err);
            });
          if (poll.status !== 'pending') {
            outcome = poll;
            break;
          }
        }
      } catch (err) {
        spinner?.stop();
        fail(err);
      }

      spinner?.stop();

      if (!outcome || outcome.status === 'expired') {
        fail(
          new SpycoreCliError(
            'Login expired before the browser approval came through.',
            EXIT_AUTH_ERROR,
            'Try `spycore login` again.',
          ),
        );
      }
      if (outcome.status === 'denied') {
        fail(
          new SpycoreCliError(
            'Login was denied in the browser.',
            EXIT_AUTH_ERROR,
          ),
        );
      }
      if (outcome.status !== 'approved' || !outcome.token) {
        fail(
          new SpycoreCliError(
            `Unexpected login status: ${outcome.status}`,
            EXIT_AUTH_ERROR,
          ),
        );
      }

      await setToken(outcome.token);

      if (getOutputOptions().json) {
        json({ status: 'approved', email: outcome.email });
      } else {
        success(`Logged in as ${outcome.email ?? 'your account'}`);
      }
    });
}
