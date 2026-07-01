import { existsSync } from 'node:fs';
import { Command, Option } from 'commander';
import chalk from 'chalk';
import {
  buildCreateMessage,
  buildFeedbackMessage,
  checkSkillNameCollision,
  deriveSkillName,
  generateValidSkill,
  skillTargetFile,
  validateSkillName,
  writeSkillFileAtomic,
  type GeneratedSkill,
  type GenerationSession,
} from '../../lib/skills-create.js';
import { resolveProviderSelection } from '../../lib/providers/byok-config.js';
import { getStoredProviders, getDefaultProviderName } from '../../lib/config.js';
import type { Provider } from '../../lib/providers/types.js';
import type { AgentModelSlug } from '../../lib/agent/loop.js';
import { MODEL_DISPLAY } from '../../lib/models.js';
import { isAuthenticated } from '../../lib/auth.js';
import { isPromptCancelled, readSingleLineInput } from '../../lib/prompt.js';
import { EXIT_AUTH_ERROR, EXIT_USER_ERROR, SpycoreCliError } from '../../lib/errors.js';
import { getOutputOptions, info, json, success, warn } from '../../lib/output.js';

/**
 * `spycore skills create "<description>"` — generate a well-formed SKILL.md
 * from a one-line description, review it interactively (accept / reject /
 * edit-feedback-and-regenerate, like plan approval), and write it to the
 * user-global skills dir (or ./.spycore/skills/ with --project). The new
 * skill is immediately discoverable by every agent run via the catalog +
 * load_skill.
 *
 * Provider resolution and the login gate work EXACTLY like `spycore agent`:
 * saved config name / built-in type / configured default, and only the
 * SpyCore provider requires a SpyCore account. Generation itself is one
 * provider streamChat conversation (see lib/skills-create.ts for why this is
 * not a runAgent run).
 */

/** SpyCore model slugs `--model` accepts (same set as the agent command). */
const ALLOWED_SPYCORE_MODELS = ['charon', 'styx', 'hermes', 'minos'] as const;
/** Default generation model on the SpyCore provider (the workhorse; no triage —
 * complexity triage classifies coding tasks and doesn't apply to generation). */
const DEFAULT_SPYCORE_MODEL: AgentModelSlug = 'styx';

/** Preview cap: show the whole file up to this many lines, else head + count. */
const PREVIEW_FULL_LINES = 80;
const PREVIEW_HEAD_LINES = 40;

interface CreateCmdOpts {
  name?: string;
  project?: boolean;
  model?: string;
  provider?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  yes?: boolean;
}

/** Render the generated SKILL.md (head + line count when huge) to stderr. */
function renderPreview(content: string, targetFile: string): void {
  const lines = content.split('\n');
  const rule = chalk.dim('─'.repeat(60));
  process.stderr.write(`\n${chalk.bold('Generated SKILL.md')} ${chalk.dim(`(${lines.length} lines) → ${targetFile}`)}\n${rule}\n`);
  if (lines.length <= PREVIEW_FULL_LINES) {
    process.stderr.write(`${content}\n`);
  } else {
    process.stderr.write(`${lines.slice(0, PREVIEW_HEAD_LINES).join('\n')}\n`);
    process.stderr.write(chalk.dim(`… (+${lines.length - PREVIEW_HEAD_LINES} more lines — full file is written on accept)\n`));
  }
  process.stderr.write(`${rule}\n`);
}

export function registerCreate(group: Command): void {
  group
    .command('create <description...>')
    .description('Generate a new skill from a one-line description (review before it is written)')
    .addOption(new Option('--name <kebab-name>', 'Skill name (default: derived from the description)'))
    .addOption(
      new Option('--project', 'Write to ./.spycore/skills/ (this project only) instead of your user-global skills dir'),
    )
    .addOption(
      new Option(
        '-m, --model <model>',
        `Model (${ALLOWED_SPYCORE_MODELS.join('|')} for spycore; required for a non-spycore --provider)`,
      ),
    )
    .addOption(
      new Option(
        '--provider <name>',
        'Provider to use: a saved name or a built-in type (spycore, openai, anthropic, google). Omit to use your configured default (spycore if unset)',
      ),
    )
    .addOption(new Option('--base-url <url>', 'Base URL for a BYOK provider (defaults to the vendor API per type)'))
    .addOption(new Option('--api-key-env <var>', 'Env var holding the API key for a BYOK provider (defaults per type)'))
    .addOption(new Option('-y, --yes', 'Accept the generated skill without interactive review (CI use)'))
    .action(async (descArg: string[], opts: CreateCmdOpts, cmd: Command) => {
      // --api-url rides on the root program (group → program).
      const rootOpts = cmd.parent?.parent?.opts<{ apiUrl?: string }>() ?? {};
      const apiUrlOverride = rootOpts.apiUrl;
      const isJson = getOutputOptions().json;
      const cwd = process.cwd();

      const description = (descArg ?? []).join(' ').trim();
      if (description.length === 0) {
        throw new SpycoreCliError('A skill description is required.', EXIT_USER_ERROR);
      }

      // Provider selection is pure and runs FIRST (like `agent`) so an unknown
      // provider / BYOK-missing-model error surfaces before any login gate.
      const selection = resolveProviderSelection({
        providerFlag: opts.provider,
        baseUrl: opts.baseUrl,
        model: opts.model,
        apiKeyEnv: opts.apiKeyEnv,
        env: process.env,
        stored: getStoredProviders(),
        defaultProvider: getDefaultProviderName(),
      });

      // Resolve + validate the name, then check every collision source —
      // all local and free, BEFORE login or any network call.
      const explicitName = (opts.name ?? '').trim();
      const name = explicitName || deriveSkillName(description);
      if (name.length === 0) {
        throw new SpycoreCliError(
          'Could not derive a skill name from that description.',
          EXIT_USER_ERROR,
          'Pass --name <kebab-name> explicitly.',
        );
      }
      const nameProblem = validateSkillName(name);
      if (nameProblem) {
        throw new SpycoreCliError(
          `Invalid skill name "${name}": ${nameProblem}.`,
          EXIT_USER_ERROR,
          explicitName ? 'Fix the --name value.' : 'Pass --name <kebab-name> to choose one explicitly.',
        );
      }
      const collision = checkSkillNameCollision(name, cwd);
      if (collision) {
        throw new SpycoreCliError(
          `Cannot create skill "${name}": ${collision}.`,
          EXIT_USER_ERROR,
          'Pass --name to pick another name. Existing skills are never overwritten.',
        );
      }

      // SpyCore model slug validation (BYOK model ids pass through verbatim,
      // already validated inside resolveProviderSelection).
      let spycoreModel: AgentModelSlug = DEFAULT_SPYCORE_MODEL;
      if (selection.kind === 'spycore' && opts.model !== undefined) {
        const slug = String(opts.model).toLowerCase();
        if (!(ALLOWED_SPYCORE_MODELS as readonly string[]).includes(slug)) {
          throw new SpycoreCliError(
            `Unknown model: ${opts.model}`,
            EXIT_USER_ERROR,
            `Allowed: ${ALLOWED_SPYCORE_MODELS.join(', ')}`,
          );
        }
        spycoreModel = slug as AgentModelSlug;
      }

      // DECOUPLED login: ONLY the SpyCore provider needs a SpyCore account.
      if (selection.kind === 'spycore' && !(await isAuthenticated())) {
        throw new SpycoreCliError('Not logged in.', EXIT_AUTH_ERROR, 'Run `spycore login` to authenticate.');
      }

      // Model-call provider + identity-safe model line (lazy adapter imports).
      let provider: Provider;
      let model: string;
      let modelLine: string;
      if (selection.kind === 'byok') {
        const { createByokProvider } = await import('../../lib/providers/factory.js');
        provider = await createByokProvider(selection.config);
        model = selection.config.model;
        modelLine = selection.config.routingLine;
      } else {
        const { SpyCoreProvider } = await import('../../lib/providers/spycore.js');
        provider = new SpyCoreProvider();
        model = spycoreModel;
        modelLine = `Model: ${MODEL_DISPLAY[spycoreModel]}${opts.model !== undefined ? ' (--model)' : ''}`;
      }

      const targetFile = skillTargetFile(name, cwd, Boolean(opts.project));
      if (!isJson) {
        process.stderr.write(`${chalk.dim(modelLine)}\n`);
        process.stderr.write(`${chalk.dim(`Generating skill "${name}"…`)}\n`);
      }

      const session: GenerationSession = {
        provider,
        conversationId: await provider.createConversation({ model, apiUrlOverride }),
        model,
        apiUrlOverride,
      };
      const onStatus = (note: string): void => {
        if (!isJson) warn(note);
      };

      let gen: GeneratedSkill = await generateValidSkill(session, name, buildCreateMessage(name, description), {
        firstTurn: true,
        onStatus,
      });

      // ── Review: [a] accept · [r] reject · [e] one line of feedback →
      // regenerate (same conversation). --yes / --json / non-TTY auto-accept.
      const interactive =
        process.stdin.isTTY === true && process.stdout.isTTY === true && !opts.yes && !isJson;
      if (interactive) {
        try {
          review: for (;;) {
            renderPreview(gen.content, targetFile);
            const answer = (
              await readSingleLineInput(`${chalk.bold('[a]')} accept  ${chalk.bold('[r]')} reject  ${chalk.bold('[e]')} edit feedback › `)
            )
              .trim()
              .toLowerCase();
            switch (answer) {
              case 'a':
                break review;
              case 'r':
                info('Rejected — nothing was written.');
                return;
              case 'e': {
                const feedback = (await readSingleLineInput('feedback › ')).trim();
                if (feedback.length === 0) continue;
                process.stderr.write(`${chalk.dim('Regenerating with your feedback…')}\n`);
                gen = await generateValidSkill(session, name, buildFeedbackMessage(feedback), { onStatus });
                continue;
              }
              default:
                continue; // unrecognized key — re-prompt
            }
          }
        } catch (err) {
          if (isPromptCancelled(err)) {
            warn('Cancelled — nothing was written.');
            process.exitCode = 130;
            return;
          }
          throw err;
        }
      }

      // Race guard right before the write: never overwrite anything.
      if (existsSync(targetFile)) {
        throw new SpycoreCliError(
          `Refusing to write: ${targetFile} appeared while generating.`,
          EXIT_USER_ERROR,
          'Pass --name to pick another name.',
        );
      }
      writeSkillFileAtomic(targetFile, gen.content);

      if (isJson) {
        json({
          name,
          path: targetFile,
          source: opts.project ? 'project' : 'user',
          lines: gen.content.split('\n').length,
          retried: gen.retried,
        });
        return;
      }
      success(`Skill "${name}" created → ${targetFile}`);
      info('It is available to every agent run via load_skill (see `spycore skills list`).');
    });
}
