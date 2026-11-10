import { Command, Option } from 'commander';
import { EXIT_USER_ERROR, SpycoreCliError } from '../../lib/errors.js';
import { resolveModelSlug } from '../../lib/models.js';
import { MAX_PROMPT_LENGTH, validateSchedule } from './store.js';

export function registerCronAddCommand(program: Command): void {
  program
    .command('add')
    .description('Schedule a prompt to run on a cron schedule')
    .addOption(new Option('--prompt <text>', 'Prompt text to run on schedule').makeOptionMandatory())
    .addOption(
      new Option(
        '--schedule <expr>',
        'Cron schedule: 5 fields "minute hour day-of-month month day-of-week" (e.g. "0 9 * * MON")',
      ).makeOptionMandatory(),
    )
    .addOption(
      new Option(
        '--model <model>',
        'Model used to run the prompt (default: the configured default model)',
      ),
    )
    .action(async (opts: { prompt?: string; schedule?: string; model?: string }) => {
      const prompt = (opts.prompt ?? '').trim();
      if (prompt.length === 0) {
        throw new SpycoreCliError(
          'The prompt is empty.',
          EXIT_USER_ERROR,
          'Pass --prompt "..." with the prompt text.',
        );
      }
      if (prompt.length > MAX_PROMPT_LENGTH) {
        throw new SpycoreCliError(
          `Prompt exceeds the ${MAX_PROMPT_LENGTH} character limit (got ${prompt.length}).`,
          EXIT_USER_ERROR,
        );
      }
      // Validate first, so a bad schedule or model still reports its own
      // error rather than the not-implemented refusal below.
      validateSchedule(opts.schedule ?? '');
      if (opts.model !== undefined) resolveModelSlug(opts.model);

      // Automatic execution is NOT implemented: there is no daemon or
      // scheduler that runs stored prompts, so accepting the entry would
      // store a schedule that never fires and print success for it. Refuse
      // outright (nothing is stored) rather than record a promise the CLI
      // cannot keep. When execution lands, this guard goes away.
      throw new SpycoreCliError(
        'Scheduled prompts are not executed yet - automatic execution is not implemented.',
        EXIT_USER_ERROR,
        'Nothing was saved. Track the schedule yourself for now, or run the prompt with `spycore chat` / `spycore agent` when it is due.',
      );
    });
}
