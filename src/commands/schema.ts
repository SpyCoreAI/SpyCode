import { Command, Option } from 'commander';
import { COMMAND_SPEC, type CommandSpec, type OptionSpec } from '../lib/completion/spec.js';
import { getOutputOptions, json, print } from '../lib/output.js';

interface SchemaOpts {
  commands?: boolean;
  outputTypes?: boolean;
}

interface CliSchemaOption {
  name: string;
  short?: string;
  description?: string;
  takesValue: boolean;
  values?: readonly string[];
}

interface CliSchemaCommand {
  name: string;
  path: readonly string[];
  description: string;
  takesArgs: boolean;
  options: CliSchemaOption[];
  subcommands: CliSchemaCommand['name'][];
}

interface CliSchema {
  $schema: string;
  title: string;
  version: string;
  cli: {
    name: string;
    description: string;
  };
  commands: CliSchemaCommand[];
  outputTypes: Record<string, unknown>;
  exitCodes: Record<string, number>;
  envVars: Array<{ name: string; description: string }>;
}

/**
 * Output type definitions describing the JSON shapes the CLI returns in
 * `--json` mode. These mirror what the consuming commands assert on the
 * wire — keep them in sync with the resource types under `src/commands/**`
 * and the API's published schema declarations they ultimately consume.
 *
 * Identity protection: only brand labels (HERMES/MINOS/STYX/CHARON/
 * HEPHAESTUS) appear in any enum or example.
 */
const OUTPUT_TYPES: Record<string, unknown> = {
  /** `spycore whoami --json` — matches WhoamiResp in commands/auth/whoami.ts:16-25. */
  WhoamiResponse: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      email: { type: 'string', format: 'email' },
      name: { type: ['string', 'null'] },
      avatar: { type: ['string', 'null'] },
      plan: { type: 'string' },
      planDisplay: { type: 'string' },
      tokenId: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'email', 'plan', 'planDisplay', 'tokenId', 'createdAt'],
  },
  /** `spycore conversations list --json` row — matches conversationSchema on the server. */
  ConversationListItem: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      model: {
        type: 'string',
        description: 'Brand label (HERMES/MINOS/STYX/CHARON/HEPHAESTUS).',
      },
      pinned: { type: 'boolean' },
      archived: { type: 'boolean' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'title', 'model', 'createdAt', 'updatedAt'],
  },
  /** `spycore files list --json` row — matches fileSchema (post-Batch-1 b233726). */
  FileListItem: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      filename: { type: 'string' },
      mimeType: { type: 'string' },
      size: { type: 'integer', description: 'Bytes.' },
      url: {
        type: ['string', 'null'],
        description: '~30-minute presigned download URL; re-fetch to mint a fresh one.',
      },
      createdAt: { type: 'string', format: 'date-time' },
      expiresAt: { type: ['string', 'null'], format: 'date-time' },
    },
    required: ['id', 'filename', 'mimeType', 'size', 'createdAt'],
  },
  /** `spycore memory list --json` row — matches memorySchema on the server. */
  MemoryItem: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      category: { type: ['string', 'null'] },
      content: { type: 'string' },
      pinned: { type: 'boolean' },
      createdAt: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'content', 'createdAt'],
  },
  /** `spycore usage --json` — loose shape; bucket internals vary. */
  UsageReport: {
    type: 'object',
    properties: {
      allModels: { type: 'object' },
      hephaestus: { type: 'object' },
      perModel: { type: 'object' },
      plan: { type: 'string' },
    },
  },
  /**
   * `spycore chat --json` line — one event per JSON line. `type` is the
   * discriminator; this enum matches what the CLI emits in `--json` mode
   * (the server's auto-routing event is normalised to the neutral `routed`).
   */
  ChatStreamEvent: {
    type: 'object',
    description:
      'A single event line emitted by `spycore chat --json`. `type` discriminates the variant.',
    properties: {
      type: {
        type: 'string',
        enum: [
          'text',
          'thinking',
          'skills_activated',
          'routed',
          'auto_switched',
          'search_started',
          'search_completed',
          'search_failed',
          'image_generation_started',
          'image',
          'memory_created',
          'title',
          'usage',
          'finish_reason',
          'message_created',
          'error',
          'done',
        ],
      },
      content: { type: 'string', description: 'Present on text / thinking / title events.' },
      skills: { type: 'array', items: { type: 'string' } },
      message: { type: 'string', description: 'Present on error events.' },
    },
  },
};

/**
 * Process-env vars the CLI actually reads. Verified via
 * `grep -r process.env src`. SPYCORE_TEST_CWD is intentionally
 * unlisted (it is an internal test hook, not a public knob).
 */
const ENV_VARS: CliSchema['envVars'] = [
  { name: 'SPYCORE_TOKEN', description: 'spycli_-prefixed auth token; bypasses the keychain / config file.' },
  { name: 'SPYCORE_API_URL', description: 'Override the API base URL (also `spycore config set apiUrl`).' },
  { name: 'SPYCORE_CONFIG_DIR', description: 'Override the OS-default config directory.' },
  { name: 'SPYCORE_NO_COLOR', description: 'Disable ANSI colour output (NO_COLOR is also honoured).' },
  { name: 'SPYCORE_NO_UPDATE_CHECK', description: 'Set to 1 to skip the daily update check.' },
];

const EXIT_CODES = {
  SUCCESS: 0,
  USER_ERROR: 1,
  AUTH_ERROR: 2,
  NETWORK_ERROR: 3,
  SERVER_ERROR: 4,
};

function buildSchema(version: string): CliSchema {
  const commands = flattenCommands(COMMAND_SPEC, []);
  return {
    $schema: 'https://json-schema.org/draft-07/schema#',
    title: 'SpyCore CLI',
    version,
    cli: {
      name: COMMAND_SPEC.name,
      description: COMMAND_SPEC.description,
    },
    commands,
    outputTypes: OUTPUT_TYPES,
    exitCodes: EXIT_CODES,
    envVars: ENV_VARS,
  };
}

function flattenCommands(
  spec: CommandSpec,
  prefix: readonly string[],
): CliSchemaCommand[] {
  const out: CliSchemaCommand[] = [];
  const path = spec === COMMAND_SPEC ? prefix : [...prefix, spec.name];
  if (spec !== COMMAND_SPEC) {
    out.push({
      name: spec.name,
      path,
      description: spec.description,
      takesArgs: Boolean(spec.takesArgs),
      options: (spec.options ?? []).map(toSchemaOption),
      subcommands: (spec.subcommands ?? []).map((s) => s.name),
    });
  }
  for (const sub of spec.subcommands ?? []) {
    out.push(...flattenCommands(sub, path));
  }
  return out;
}

function toSchemaOption(opt: OptionSpec): CliSchemaOption {
  const result: CliSchemaOption = {
    name: opt.name,
    takesValue: Boolean(opt.takesValue),
  };
  if (opt.short !== undefined) result.short = opt.short;
  if (opt.description !== undefined) result.description = opt.description;
  if (opt.values !== undefined) result.values = opt.values;
  return result;
}

export function registerSchemaCommand(program: Command, version: string): void {
  program
    .command('schema')
    .description(
      'Print a JSON Schema describing the CLI surface (commands, options, output types)',
    )
    .addOption(new Option('--commands', 'Only emit the command tree'))
    .addOption(
      new Option('--output-types', 'Only emit output type definitions'),
    )
    .action((opts: SchemaOpts) => {
      const full = buildSchema(version);
      const isJson = getOutputOptions().json;

      if (opts.commands) {
        if (isJson) {
          json({ commands: full.commands });
        } else {
          for (const cmd of full.commands) {
            const flagSummary = cmd.options
              .map((o) => o.name)
              .join(', ');
            print(
              `${[cmd.name, ...cmd.path.slice(1)].join(' ')}` +
                (flagSummary ? `   [${flagSummary}]` : ''),
            );
          }
        }
        return;
      }

      if (opts.outputTypes) {
        if (isJson) {
          json({ outputTypes: full.outputTypes });
        } else {
          for (const [name, def] of Object.entries(full.outputTypes)) {
            print(`# ${name}`);
            print(JSON.stringify(def, null, 2));
            print('');
          }
        }
        return;
      }

      if (isJson) {
        json(full);
      } else {
        print(`SpyCore CLI ${full.version} — JSON Schema introspection`);
        print(`  ${full.commands.length} commands, ${
          Object.keys(full.outputTypes).length
        } output types`);
        print('');
        print('Run with --json for the full schema:');
        print('  spycore schema --json');
        print('Or scope it:');
        print('  spycore schema --commands --json');
        print('  spycore schema --output-types --json');
      }
    });
}

