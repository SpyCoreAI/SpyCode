import { Command } from 'commander';
import { api } from '../../lib/api.js';
import { clearToken, getToken } from '../../lib/auth.js';
import { getOutputOptions, json, success, warn } from '../../lib/output.js';

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
          success('No active token - nothing to revoke');
        }
        return;
      }

      // Clear the local copy FIRST. The old order called the server first
      // and failed out before clearToken() on any revoke error, so the
      // local token stayed valid and later commands still ran logged in.
      // The server revoke is best-effort after that: a failure warns but
      // never resurrects the local session.
      //
      // The revoke itself must still authenticate: clearToken() empties
      // the store getToken() reads, so the call below carries the token
      // captured above explicitly (authToken). Without it the revoke went
      // out with no Authorization header, the server 401'd it on every
      // logout, and the server-side session stayed live.
      await clearToken();
      let revokeError: string | null = null;
      try {
        await api.post('/auth/cli/logout', {
          apiUrlOverride: parentOpts.apiUrl,
          authToken: token,
          // R3-18: the server answers a successful revoke with a bare
          // `{success:true}` (no `data` key) - a payload-less success.
          allowEmptyData: true,
        });
      } catch (err) {
        revokeError = err instanceof Error ? err.message : 'Server revoke failed';
      }

      // getToken() prefers SPYCORE_TOKEN over the keychain/file, and
      // clearToken() only clears the keychain + file - it cannot unset an
      // environment variable. Say so plainly instead of reporting success
      // while the env token keeps authenticating every command.
      const envTokenStillActive = Boolean(
        process.env.SPYCORE_TOKEN && process.env.SPYCORE_TOKEN.length > 0,
      );
      const envNote = envTokenStillActive
        ? 'SPYCORE_TOKEN is still set in this environment - you are still authenticated until it is unset.'
        : null;

      if (getOutputOptions().json) {
        const messages: string[] = [];
        if (revokeError) messages.push(`${revokeError}; local token cleared`);
        if (envNote) messages.push(envNote);
        json({
          status: revokeError ? 'partial' : 'ok',
          ...(messages.length > 0 ? { message: messages.join(' ') } : {}),
          ...(envTokenStillActive ? { envTokenActive: true } : {}),
        });
        return;
      }
      if (revokeError) {
        warn(`Server revoke failed (${revokeError}) - local token cleared anyway.`);
      }
      success('Logged out');
      if (envNote) warn(envNote);
    });
}
