import { describe, expect, test } from 'vitest';
import { matchesCatastrophic } from '../src/lib/agent/command-screen.js';

/**
 * R1-1 - the catastrophic screen was bypassed two ways: an expansion head
 * behind a non-wrapper prefix (`arch -arm64 $(echo)rm -rf /`) was never
 * resolved because `candidateArgvs` stripped expansions only off the
 * primary head, and inside a substitution interior neither the suffix nor
 * the expansion-strip readings were offered at all
 * (`echo $(arch -arm64 rm -rf /)`, `echo $($(echo)rm -rf /)`). Every
 * bypass below must be refused; the mention controls must stay permitted -
 * `echo` only carries the destructive command as data.
 */
describe('R1-1 expansion heads behind prefixes and inside substitutions', () => {
  const blocked = (c: string): boolean => matchesCatastrophic(c) !== null;

  test('expansion head behind a non-wrapper prefix is blocked', () => {
    for (const c of [
      'arch -arm64 $(echo)rm -rf /',
      'ssh-agent $(echo)rm -rf /',
      'arch -arm64 ${EMPTY}rm -rf /',
    ]) {
      expect(blocked(c), c).toBe(true);
    }
  });

  test('non-wrapper prefix and expansion head inside a substitution are blocked', () => {
    for (const c of [
      'echo $(arch -arm64 rm -rf /)',
      'echo $($(echo)rm -rf /)',
      // the same shape behind every other censused launcher: the nested
      // gate keys on the launcher HEAD, not on the two names in the finding.
      'echo $(sandbox-exec -p x rm -rf /)',
      'echo $(ssh-agent rm -rf /)',
      'echo $(screen -D -m rm -rf /)',
      'echo $(systemd-run --scope rm -rf /)',
      'echo $(strace -f rm -rf /)',
      'echo $(pkexec rm -rf /)',
      // a wrapper in front of the launcher still lifts: sudo runs arch,
      // arch runs rm.
      'echo $(sudo arch -arm64 rm -rf /)',
      // an expansion in front of the launcher head resolves to it.
      'echo $($(echo)arch -arm64 rm -rf /)',
    ]) {
      expect(blocked(c), c).toBe(true);
    }
  });

  test('a mention under an unlisted head stays a mention', () => {
    // The differential's head-axis INERT half: a data command the screen
    // has never heard of is still a data command - `mynote`, `printf`,
    // `logger` - and the glued continuation head `aecho` (a\ + LF welds
    // `a` onto `echo`, so no command runs at all). The first repair
    // inverted the nested gate and refused all of these; the corrected
    // gate lifts the suppression only for a censused LAUNCHER head or an
    // expansion-strip of the head itself.
    for (const c of [
      'echo "$(mynote rm -rf /)"',
      'echo "$(printf %s rm -rf /)"',
      'echo "$(logger rm -rf /)"',
      'echo "$(a\\\necho rm -rf /)"',
      'git commit -m "$(mynote rm -rf /)"',
      'grep -r "$(logger rm -rf /)" docs/',
      // a launcher name as a DATA word, not the head, is still a mention.
      'echo "$(echo arch rm -rf /)"',
      'echo "$(echo sandbox-exec rm -rf /)"',
    ]) {
      expect(blocked(c), c).toBe(false);
    }
  });

  test('the pre-existing controls still hold', () => {
    for (const c of ['rm -rf /', '$(echo)rm -rf /', 'arch -arm64 rm -rf /', 'echo $(rm -rf /)']) {
      expect(blocked(c), c).toBe(true);
    }
  });

  test('a mention stays a mention: echo carries the command as data', () => {
    for (const c of [
      'echo "$(echo rm -rf /)"',
      'echo $(echo rm -rf /)',
      'git commit -m "$(echo rm -rf /)"',
      'printf "$(echo rm -rf /)"',
    ]) {
      expect(blocked(c), c).toBe(false);
    }
  });
});
