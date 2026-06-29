import { request } from 'undici';
import { Command } from 'commander';
import { isAuthenticated } from '../lib/auth.js';
import { api } from '../lib/api.js';
import { resolveApiUrl } from '../lib/config.js';
import {
  fail,
  getOutputOptions,
  json,
  print,
  success,
  warn,
} from '../lib/output.js';
import { EXIT_NETWORK_ERROR, SpycoreCliError } from '../lib/errors.js';

interface HealthResp {
  status: 'ok' | string;
  uptime: number;
  timestamp: string;
  version: string;
  build: string;
}

interface WhoamiResp {
  email: string;
  planDisplay: string;
}

/**
 * `spycore ping` — verifies the API is reachable and (if logged in) that
 * the stored CLI token still works. Hits /api/health which is an
 * unwrapped JSON object (not the standard success envelope) so we issue
 * the request directly via undici instead of going through api.get.
 */
export function registerPingCommand(program: Command): void {
  program
    .command('ping')
    .description('Verify API reachability and (if logged in) authentication')
    .action(async () => {
      const parentOpts = program.opts<{ apiUrl?: string }>();
      const baseUrl = resolveApiUrl(parentOpts.apiUrl).replace(/\/$/, '');
      const healthUrl = `${baseUrl}/health`;

      const start = Date.now();
      let res;
      try {
        res = await request(healthUrl, {
          method: 'GET',
          headers: {
            'user-agent': '@spycore/cli',
            accept: 'application/json',
          },
        });
      } catch (err) {
        fail(
          new SpycoreCliError(
            `API unreachable: ${err instanceof Error ? err.message : String(err)}`,
            EXIT_NETWORK_ERROR,
            `Tried ${healthUrl}.`,
          ),
        );
      }
      const latencyMs = Date.now() - start;

      let health: HealthResp | null = null;
      try {
        health = (await res.body.json()) as HealthResp;
      } catch {
        // empty body — treat as failure below
      }
      if (res.statusCode !== 200 || !health || health.status !== 'ok') {
        fail(
          new SpycoreCliError(
            `API responded with HTTP ${res.statusCode}`,
            EXIT_NETWORK_ERROR,
          ),
        );
      }

      let authStatus: 'ok' | 'unauthenticated' | 'failed' = 'unauthenticated';
      let email: string | null = null;
      let planDisplay: string | null = null;

      if (await isAuthenticated()) {
        try {
          const me = await api.get<WhoamiResp>('/auth/cli/whoami', {
            apiUrlOverride: parentOpts.apiUrl,
          });
          authStatus = 'ok';
          email = me.email;
          planDisplay = me.planDisplay;
        } catch (err) {
          authStatus = 'failed';
          if (getOutputOptions().json) {
            // Don't fail hard in JSON mode — let the consumer see partial state.
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            warn(`Authenticated check failed: ${msg}`);
          }
        }
      }

      if (getOutputOptions().json) {
        json({
          api: {
            ok: true,
            url: baseUrl,
            latencyMs,
            version: health.version,
            build: health.build,
          },
          auth: {
            status: authStatus,
            email,
            planDisplay,
          },
        });
        return;
      }

      success(`API reachable: ${latencyMs}ms (${baseUrl})`);
      print(`  version: ${health.version}    build: ${health.build}`);

      if (authStatus === 'ok') {
        success(`Authenticated as ${email} (${planDisplay})`);
      } else if (authStatus === 'unauthenticated') {
        print('  Not logged in — run `spycore login` to authorize.');
      } else if (authStatus === 'failed') {
        // already warned above
        process.exitCode = 1;
      }
    });
}
