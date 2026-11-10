import { describe, expect, test } from 'vitest';
import { matchesCatastrophic } from '../src/lib/agent/tools.js';

/**
 * H5 - the sensitive-file screen covered only `~/.ssh`, shell init files
 * and `/etc/passwd|shadow|sudoers`. Redirects and `tee` to credential
 * paths (`~/.aws/credentials`, `~/.gnupg/*`, `~/.npmrc`, `~/.netrc`,
 * any `.env` file) sailed through - and `run_command` is exempt from the
 * secret guard, so this screen is the only control on them.
 */
describe('sensitive-file screen covers credential paths', () => {
  const blocked = (c: string): boolean => matchesCatastrophic(c) !== null;

  test('redirects and tee to credential files are refused', () => {
    for (const c of [
      'echo x > ~/.aws/credentials',
      'echo x > $HOME/.aws/credentials',
      'echo x > ${HOME}/.aws/credentials',
      'echo x >> ~/.aws/credentials',
      'tee ~/.aws/credentials',
      'echo x > ~/.gnupg/private-keys-v1.d/key',
      'echo x > ~/.gnupg/pubring.kbx',
      'tee ~/.gnupg/gpg.conf',
      'echo x > ~/.npmrc',
      'echo x > ~/.netrc',
      'tee ~/.npmrc',
      'echo x > $HOME/.netrc',
      'echo x > .env',
      'echo x > .env.local',
      'echo x > .env.production',
      'echo x > config/.env',
      'echo x > /app/.env',
      'tee .env',
      'echo x > ~/.env',
    ]) {
      expect(blocked(c), c).toBe(true);
    }
  });

  test('reads and ordinary files stay allowed', () => {
    for (const c of [
      'cat ~/.aws/credentials',
      'cat .env',
      'echo x > notes.txt',
      'echo x > notes.env',
      'echo x > .envrc',
      'echo x > .environment',
      'echo x > ~/.aws/config',
      'echo x > ~/.gnupg-backup.tar',
      'echo x > my.npmrc',
    ]) {
      expect(blocked(c), c).toBe(false);
    }
  });

  test('the pre-existing sensitive set is unchanged', () => {
    for (const c of [
      'echo x > ~/.ssh/authorized_keys',
      'echo x > ~/.bashrc',
      'echo x > /etc/passwd',
      'tee /etc/shadow',
    ]) {
      expect(blocked(c), c).toBe(true);
    }
  });
});
