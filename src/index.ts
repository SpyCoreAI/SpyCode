import { Command, Option } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { configureOutput, fail } from './lib/output.js';
import { registerVersionCommand } from './commands/version.js';
import { registerLoginCommand } from './commands/auth/login.js';
import { registerLogoutCommand } from './commands/auth/logout.js';
import { registerWhoamiCommand } from './commands/auth/whoami.js';
import { registerConfigCommand } from './commands/config/index.js';
import { registerPingCommand } from './commands/ping.js';
import { registerChatCommand } from './commands/chat.js';
import { registerConversationsCommand } from './commands/conversations/index.js';
import { registerFilesCommand } from './commands/files/index.js';
import { registerMemoryCommand } from './commands/memory/index.js';
import { registerUsageCommand } from './commands/usage.js';
import { registerImageCommand } from './commands/image.js';
import { registerAgentCommand } from './commands/agent.js';
import { registerProviderCommand } from './commands/provider/index.js';
import { registerSkillsCommand } from './commands/skills/index.js';
import { registerMcpCommand } from './commands/mcp/index.js';
import { registerAcpCommand } from './commands/acp.js';
import { registerRewindCommand } from './commands/rewind.js';
import { registerUpdateCommand } from './commands/update.js';
import { registerCompletionCommand } from './commands/completion.js';
import { registerSchemaCommand } from './commands/schema.js';
import { registerUiPreviewCommand } from './commands/ui-preview.js';
import { registerMdPreviewCommand } from './commands/md-preview.js';
import {
  flushUpdateBanner,
  maybeShowUpdateBanner,
} from './lib/update-banner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'),
) as { version: string };

const program = new Command();

program
  .name('spycore')
  .description('SpyCore AI command-line interface')
  .version(pkg.version, '-v, --version', 'Display CLI version')
  .addOption(
    new Option('--api-url <url>', 'API base URL (overrides config + env)'),
  )
  .addOption(new Option('--json', 'Output JSON for machine consumption'))
  .addOption(new Option('--no-color', 'Disable colored output'))
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts<{ json?: boolean; color?: boolean }>();
    configureOutput({
      json: Boolean(opts.json),
      color: opts.color !== false,
    });
  });

registerVersionCommand(program, pkg.version);
registerLoginCommand(program);
registerLogoutCommand(program);
registerWhoamiCommand(program);
registerPingCommand(program);
registerConfigCommand(program);
registerChatCommand(program);
registerConversationsCommand(program);
registerFilesCommand(program);
registerMemoryCommand(program);
registerUsageCommand(program);
registerImageCommand(program);
registerAgentCommand(program);
registerProviderCommand(program);
registerSkillsCommand(program);
registerMcpCommand(program);
registerAcpCommand(program);
registerRewindCommand(program);
registerUpdateCommand(program, pkg.version);
registerCompletionCommand(program);
registerSchemaCommand(program, pkg.version);

// Hidden, dev-only commands (excluded from --help) to preview the TUI design
// system and the Markdown rendering layer.
registerUiPreviewCommand(program);
registerMdPreviewCommand(program);

// v1 platform stance (see SECURITY.md): macOS + Linux are supported; Windows
// is supported via WSL. Native Windows is untested — the sandbox + process-
// group semantics differ, so surface that once per invocation on stderr.
if (process.platform === 'win32') {
  process.stderr.write(
    'spycore: native Windows is untested in this release — use WSL. (macOS/Linux are the supported platforms.)\n',
  );
}

// Fire-and-forget background update check. Result is awaited briefly at
// process exit so the banner never garbles command output. Skipped inside
// the `update` subcommand itself and in JSON / non-TTY modes.
const subcommand = process.argv[2];
const updateBannerPromise =
  subcommand &&
  subcommand !== 'update' &&
  // acp serves a protocol on stdio — no banner, no background update fetch.
  subcommand !== 'acp' &&
  subcommand !== '__ui-preview' &&
  subcommand !== '__md-preview'
    ? maybeShowUpdateBanner({ currentVersion: pkg.version })
    : Promise.resolve();

program.exitOverride();

async function flushBannerWithTimeout(): Promise<void> {
  try {
    await Promise.race([
      updateBannerPromise,
      new Promise((resolve) => setTimeout(resolve, 250)),
    ]);
  } catch {
    // ignore
  }
  flushUpdateBanner();
}

try {
  await program.parseAsync(process.argv);
  await flushBannerWithTimeout();
} catch (err: unknown) {
  // commander throws CommanderError on --help/--version (exitCode 0) and on
  // user input errors (exitCode 1). Don't render those as red ✗ errors.
  // SpycoreCliError uses a numeric `code` (the exit code), so we MUST
  // string-check before calling .startsWith — otherwise calling on a number
  // throws TypeError and the original error gets lost.
  const e = err as { code?: unknown; exitCode?: number; message?: string };
  const codeStr = typeof e.code === 'string' ? e.code : '';
  if (codeStr.startsWith('commander.help') || codeStr === 'commander.version') {
    await flushBannerWithTimeout();
    process.exit(0);
  }
  if (typeof e.exitCode === 'number') {
    await flushBannerWithTimeout();
    process.exit(e.exitCode);
  }
  fail(err);
}
