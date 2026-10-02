import { Command } from 'commander';
import { api } from '../../lib/api.js';
import { clearToken, getToken } from '../../lib/auth.js';
import { fail, getOutputOptions, json, success } from '../../lib/output.js';

export function registerLogoutCommand(program: Command): void {
  program
    .command('logout')
    .description('Revoke the current CLI token and clear local state')
    .action(async () => {
      const parentOpts = program.opts<{ apiUrl?: string }>();
      const token = await getToken();

      if (!token) {
        if (getOutputOptions().json) {
          json({ status: 'noop', message: 'No active token' });
        } else {
          success('No active token — nothing to revoke');
        }
        return;
      }

      // Defensively clear the local copy first. If the server call fails
      // (network blip, expired token, server already revoked it) we still
      // want subsequent commands to behave like the user is logged out.
      try {
        await api.post('/auth/cli/logout', { apiUrlOverride: parentOpts.apiUrl });
      } catch (err) {
        // Don't surface failure as a hard error — just warn in non-JSON
        // mode and continue with the local clear.
        if (getOutputOptions().json) {
          json({
            status: 'partial',
            message:
              err instanceof Error
                ? err.message
                : 'Server revoke failed; local token cleared',
          });
          await clearToken();
          return;
        }
        fail(err);
      }

      await clearToken();
      if (getOutputOptions().json) {
        json({ status: 'ok' });
      } else {
        success('Logged out');
      }
    });
}
