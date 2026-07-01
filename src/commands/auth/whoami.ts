import { Command } from 'commander';
import { api } from '../../lib/api.js';
import { isAuthenticated } from '../../lib/auth.js';
import { getConfigStore } from '../../lib/config.js';
import {
  EXIT_AUTH_ERROR,
  SpycoreCliError,
} from '../../lib/errors.js';
import {
  fail,
  formatOption,
  json,
  print,
  resolveFormat,
  writeFormatted,
} from '../../lib/output.js';

interface WhoamiResp {
  id: string;
  email: string;
  name: string | null;
  avatar: string | null;
  plan: string;
  planDisplay: string;
  tokenId: string;
  createdAt: string;
}

export function registerWhoamiCommand(program: Command): void {
  program
    .command('whoami')
    .description('Show the account associated with the current CLI token')
    .addOption(formatOption())
    .action(async (opts: { format?: string }) => {
      if (!(await isAuthenticated())) {
        fail(
          new SpycoreCliError(
            'Not logged in.',
            EXIT_AUTH_ERROR,
            'Run `spycore login` to authorize this device.',
          ),
        );
      }

      const parentOpts = program.opts<{ apiUrl?: string }>();
      let me: WhoamiResp;
      try {
        me = await api.get<WhoamiResp>('/auth/cli/whoami', {
          apiUrlOverride: parentOpts.apiUrl,
        });
      } catch (err) {
        fail(err);
      }

      // Cache for offline-friendly behaviour later. Always refreshed on
      // success so a stale cache never lingers.
      getConfigStore().set('lastWhoami', {
        email: me.email,
        plan: me.plan,
        cachedAt: new Date().toISOString(),
      });

      const fmt = resolveFormat(opts.format);
      if (fmt === 'json') {
        json(me);
        return;
      }
      if (fmt !== 'text') {
        writeFormatted(me, fmt);
        return;
      }

      print(`Logged in as: ${me.email}`);
      if (me.name) print(`Name:         ${me.name}`);
      print(`Plan:         ${me.planDisplay}`);
      print(`Account ID:   ${me.id}`);
      print(`Token ID:     ${me.tokenId}`);
    });
}
