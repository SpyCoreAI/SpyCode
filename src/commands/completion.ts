import { Command } from 'commander';
import { generateBashCompletion } from '../lib/completion/bash.js';
import { generateZshCompletion } from '../lib/completion/zsh.js';
import { generateFishCompletion } from '../lib/completion/fish.js';
import { generatePowerShellCompletion } from '../lib/completion/powershell.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../lib/errors.js';

/**
 * `spycore completion <shell>` — print a shell tab-completion script to
 * stdout. Install instructions go to stderr so:
 *
 *   eval "$(spycore completion bash)"
 *
 * works without leaking the comment block into the eval'd payload.
 */
const SHELLS = ['bash', 'zsh', 'fish', 'powershell'] as const;
type Shell = (typeof SHELLS)[number];

const HINTS: Record<Shell, string> = {
  bash: '# Add to ~/.bashrc:\n#   eval "$(spycore completion bash)"',
  zsh:
    '# Save to a directory in $fpath, e.g.:\n' +
    '#   spycore completion zsh > "${fpath[1]}/_spycore"\n' +
    '# Then re-run compinit:\n' +
    '#   rm -f ~/.zcompdump && compinit',
  fish:
    '# Drop into fish completions:\n' +
    '#   spycore completion fish > ~/.config/fish/completions/spycore.fish',
  powershell:
    '# Append to your PowerShell profile:\n' +
    '#   spycore completion powershell >> $PROFILE\n' +
    '#   . $PROFILE  # reload',
};

const GENERATORS: Record<Shell, () => string> = {
  bash: generateBashCompletion,
  zsh: generateZshCompletion,
  fish: generateFishCompletion,
  powershell: generatePowerShellCompletion,
};

export function registerCompletionCommand(program: Command): void {
  const completion = program
    .command('completion')
    .description('Print a shell tab-completion script (bash | zsh | fish | powershell)');

  for (const shell of SHELLS) {
    completion
      .command(shell)
      .description(`Print ${shell} completion script to stdout`)
      .action(() => emit(shell));
  }

  completion.action(() => {
    throw new SpycoreCliError(
      'Usage: spycore completion <bash|zsh|fish|powershell>',
      EXIT_USER_ERROR,
      'Run with a shell name, e.g. `spycore completion bash`.',
    );
  });
}

function emit(shell: Shell): void {
  process.stderr.write(`${HINTS[shell]}\n`);
  process.stdout.write(`${GENERATORS[shell]()}\n`);
}
