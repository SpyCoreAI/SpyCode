/**
 * Canonical command spec — single source of truth for shell tab completion
 * and JSON Schema introspection.
 *
 * Authoring rules:
 *  - Every public command, subcommand, and flag must appear here.
 *  - Flags here MUST match the commander definitions in
 *    `src/commands/**`. `tests/completion.test.ts` enforces
 *    this contract programmatically — if you add or remove a real flag
 *    without updating this spec, the contract test will fail.
 *  - Identity protection: only public model labels (HERMES/MINOS/STYX/CHARON/
 *    HEPHAESTUS) are allowed as values. Never reference upstream provider
 *    names.
 *  - Keep this file pure data — no imports, no I/O — so generators can run
 *    without side effects.
 */

export interface OptionSpec {
  /** Long form, e.g. '--model'. Always include the leading dashes. */
  name: string;
  /** Short form, e.g. '-m'. Optional. */
  short?: string;
  /** One-line description. Shown in `--help` and zsh/fish completions. */
  description?: string;
  /** True if the option takes a value (e.g. `--model <slug>`). */
  takesValue?: boolean;
  /** Static value choices for completion. */
  values?: readonly string[];
}

export interface CommandSpec {
  name: string;
  description: string;
  /** Subcommands. Mutually exclusive with `args` for completion purposes. */
  subcommands?: readonly CommandSpec[];
  /** Flag definitions. */
  options?: readonly OptionSpec[];
  /** True if the command accepts positional arguments (e.g. `chat <message...>`). */
  takesArgs?: boolean;
}

/**
 * Global flags wired on the root program. Every command inherits these via
 * commander's option-inheritance, but ONLY the root advertises them — per
 * help / completion convention we don't repeat them on every subcommand.
 */
const GLOBAL_JSON_OPTION: OptionSpec = {
  name: '--json',
  description: 'Emit JSON for machine consumption',
};

/**
 * Models advertised for `chat --model` completion — mirrors CHAT_MODELS in
 * lib/models.ts (HERMES/MINOS/STYX/STYX_MAX/CHARON). HEPHAESTUS is image-only
 * (chat redirects it to `spycore image`), so it's excluded here to match
 * chat --help and the runtime block.
 */
export const CHAT_MODEL_VALUES = ['hermes', 'minos', 'styx', 'styx_max', 'charon'] as const;

/**
 * Graduated reasoning-effort levels for `chat --effort`. Mirrors EFFORT_LEVELS
 * in lib/effort.ts; kept as a local literal because this spec file stays
 * import-free. The level is clamped to the chosen model's supported set at send
 * time.
 */
export const EFFORT_VALUES = ['auto', 'low', 'medium', 'high', 'max'] as const;

/**
 * Agent loop is restricted to text models — HEPHAESTUS (image gen) is
 * deliberately excluded server-side and by the CLI's ALLOWED_AGENT_MODELS.
 */
export const AGENT_MODEL_VALUES = ['hermes', 'minos', 'styx', 'charon'] as const;

/**
 * Output formats accepted by the shared `--format` option. Mirrors
 * OUTPUT_FORMATS in lib/output-formats; kept as a local literal because this
 * spec file stays import-free.
 */
const FORMAT_VALUES = ['text', 'json', 'markdown', 'yaml'] as const;

const MEMORY_CATEGORY_VALUES = [
  'profile',
  'preferences',
  'context',
  'knowledge',
  'style',
  'custom',
] as const;

const FILE_PURPOSE_VALUES = ['chat', 'memory', 'image', 'pdf'] as const;

const IMAGE_STYLE_VALUES = ['low', 'medium', 'high'] as const;

const EXPORT_FORMAT_VALUES = ['markdown', 'json'] as const;

const SHELL_VALUES = ['bash', 'zsh', 'fish', 'powershell'] as const;

export const COMMAND_SPEC: CommandSpec = {
  name: 'spycore',
  description: 'SpyCore AI command-line interface',
  options: [
    { name: '--api-url', description: 'API base URL', takesValue: true },
    GLOBAL_JSON_OPTION,
    { name: '--no-color', description: 'Disable colored output' },
    { name: '--version', short: '-v', description: 'Display CLI version' },
    { name: '--help', short: '-h', description: 'Show help' },
  ],
  subcommands: [
    {
      name: 'version',
      description: 'Show CLI version, Node version, and platform info',
    },
    {
      name: 'login',
      description: 'Authorize this device by approving in the browser',
      options: [
        {
          name: '--name',
          short: '-n',
          description: 'Friendly device label (defaults to the OS hostname)',
          takesValue: true,
        },
        {
          name: '--no-open',
          description: 'Do not auto-launch the browser; just print the URL',
        },
      ],
    },
    {
      name: 'logout',
      description: 'Revoke the current CLI token and clear local state',
    },
    {
      name: 'whoami',
      description: 'Show the account associated with the current CLI token',
      options: [
        { name: '--format', takesValue: true, values: FORMAT_VALUES, description: 'Output format' },
      ],
    },
    {
      name: 'ping',
      description: 'Verify API reachability and (if logged in) authentication',
    },
    {
      name: 'config',
      description: 'Manage CLI configuration (api url, default model, etc.)',
      subcommands: [
        {
          name: 'get',
          description: 'Print one config value (secrets redacted)',
          takesArgs: true,
          options: [
            { name: '--reveal', description: 'Reveal a secret value instead of redacting it' },
          ],
        },
        { name: 'set', description: 'Set a config value', takesArgs: true },
        { name: 'unset', description: 'Remove a config value', takesArgs: true },
        {
          name: 'list',
          description: 'Print every config value (secrets redacted)',
          options: [
            { name: '--format', takesValue: true, values: FORMAT_VALUES, description: 'Output format' },
          ],
        },
        {
          name: 'reset',
          description: 'Clear ALL config values (does not revoke your token)',
          options: [
            { name: '--yes', short: '-y', description: 'Skip confirmation prompt' },
          ],
        },
      ],
    },
    {
      name: 'chat',
      description: 'Send a message and stream the assistant reply',
      takesArgs: true,
      options: [
        {
          name: '--model',
          short: '-m',
          description: 'Model to use',
          takesValue: true,
          values: CHAT_MODEL_VALUES,
        },
        {
          name: '--effort',
          description: 'Reasoning effort (clamped per model)',
          takesValue: true,
          values: EFFORT_VALUES,
        },
        {
          name: '--conversation',
          short: '-c',
          description: 'Continue an existing conversation',
          takesValue: true,
        },
        { name: '--new', description: 'Force a new conversation' },
        { name: '--resume', description: 'Continue the most recent conversation from this device' },
        { name: '--no-stream', description: 'Buffer the full reply before printing (no progressive output)' },
        { name: '--stdin', description: 'Read message body from stdin (for piping)' },
        { name: '--raw', description: 'Skip markdown rendering — output plain assistant text' },
      ],
    },
    {
      name: 'conversations',
      description: 'List, view, delete, and export conversations',
      subcommands: [
        {
          name: 'list',
          description: 'List your recent conversations',
          options: [
            { name: '--page', takesValue: true, description: 'Server page number (1-indexed, 20 rows per page)' },
            { name: '--limit', takesValue: true, description: 'Client-side cap on rows printed (1-20)' },
            { name: '--format', takesValue: true, values: FORMAT_VALUES, description: 'Output format' },
          ],
        },
        {
          name: 'show',
          description: 'Print the message history of a conversation',
          takesArgs: true,
          options: [
            { name: '--limit', takesValue: true, description: 'Max messages to print (most recent N)' },
            { name: '--raw', description: 'Skip markdown rendering — print plain text' },
          ],
        },
        {
          name: 'delete',
          description: 'Permanently delete a conversation and its messages',
          takesArgs: true,
          options: [
            { name: '--yes', short: '-y', description: 'Skip the confirmation prompt' },
          ],
        },
        {
          name: 'export',
          description: 'Export a conversation as markdown or JSON',
          takesArgs: true,
          options: [
            {
              name: '--format',
              description: 'Output format',
              takesValue: true,
              values: EXPORT_FORMAT_VALUES,
            },
            { name: '--output', short: '-o', takesValue: true, description: 'Write to file instead of stdout' },
          ],
        },
      ],
    },
    {
      name: 'files',
      description: 'List, upload, download, and delete files',
      subcommands: [
        {
          name: 'list',
          description: 'List your uploaded files',
          options: [
            { name: '--page', takesValue: true, description: 'Server page number (1-indexed)' },
            { name: '--limit', takesValue: true, description: 'How many to fetch (1-200)' },
            { name: '--filter', takesValue: true, description: 'Filter by type' },
            { name: '--format', takesValue: true, values: FORMAT_VALUES, description: 'Output format' },
          ],
        },
        {
          name: 'show',
          description: 'Show metadata (and a small preview) for a file',
          takesArgs: true,
        },
        {
          name: 'upload',
          description: 'Upload a file (use "-" to read from stdin)',
          takesArgs: true,
          options: [
            { name: '--name', short: '-n', takesValue: true, description: 'Override the remote filename' },
            {
              name: '--purpose',
              short: '-p',
              takesValue: true,
              values: FILE_PURPOSE_VALUES,
              description: 'Category hint sent to the server',
            },
            { name: '--mime', takesValue: true, description: 'Override the MIME type sent in the multipart part' },
          ],
        },
        {
          name: 'download',
          description: 'Download a file to disk',
          takesArgs: true,
          options: [
            { name: '--output', short: '-o', takesValue: true, description: 'Local path (defaults to the original filename)' },
            { name: '--force', short: '-f', description: 'Overwrite an existing file at the destination' },
          ],
        },
        {
          name: 'delete',
          description: 'Delete an uploaded file',
          takesArgs: true,
          options: [
            { name: '--yes', short: '-y', description: 'Skip the confirmation prompt' },
          ],
        },
      ],
    },
    {
      name: 'memory',
      description: 'List, view, add, and delete memories',
      subcommands: [
        {
          name: 'list',
          description: 'List your memories',
          options: [
            {
              name: '--category',
              takesValue: true,
              values: MEMORY_CATEGORY_VALUES,
              description: 'Filter by memory category',
            },
            { name: '--limit', takesValue: true, description: 'Max rows to print (1-200)' },
          ],
        },
        {
          name: 'show',
          description: 'Show a memory',
          takesArgs: true,
        },
        {
          name: 'add',
          description: 'Add a memory',
          takesArgs: true,
          options: [
            {
              name: '--category',
              short: '-c',
              takesValue: true,
              values: MEMORY_CATEGORY_VALUES,
              description: 'Memory category',
            },
            { name: '--pinned', description: 'Pin the memory so it always loads in context' },
          ],
        },
        {
          name: 'delete',
          description: 'Delete a memory (use --all to clear everything)',
          takesArgs: true,
          options: [
            { name: '--yes', short: '-y', description: 'Skip the confirmation prompt' },
            { name: '--all', description: 'Delete every memory (irreversible)' },
          ],
        },
      ],
    },
    {
      name: 'usage',
      description: 'Show your message and image quota',
      options: [
        { name: '--week', description: 'Only print the weekly cap' },
        { name: '--rolling', description: 'Only print the 5-hour rolling window' },
        { name: '--format', takesValue: true, values: FORMAT_VALUES, description: 'Output format' },
      ],
    },
    {
      name: 'image',
      description: 'Generate an image with Hephaestus and save it to disk',
      takesArgs: true,
      options: [
        { name: '--output', short: '-o', takesValue: true, description: 'Local path for the saved image' },
        {
          name: '--style',
          takesValue: true,
          values: IMAGE_STYLE_VALUES,
          description: 'Generation style hint',
        },
        { name: '--count', short: '-c', takesValue: true, description: 'How many images to generate (currently 1)' },
      ],
    },
    {
      name: 'agent',
      description: 'Run a bounded multi-step agent loop with tool execution',
      takesArgs: true,
      options: [
        {
          name: '--model',
          short: '-m',
          takesValue: true,
          values: AGENT_MODEL_VALUES,
          description: 'Agent reasoning model (required for a non-spycore provider)',
        },
        {
          name: '--provider',
          takesValue: true,
          values: ['spycore', 'openai', 'anthropic', 'google'],
          description: 'Model provider: the SpyCore backend, a saved name, or a built-in BYOK type',
        },
        { name: '--base-url', takesValue: true, description: 'Base URL for a BYOK provider (defaults per type)' },
        { name: '--api-key-env', takesValue: true, description: 'Env var holding the API key for a BYOK provider' },
        { name: '--max-turns', takesValue: true, description: 'Maximum tool calls before stopping' },
        { name: '--yes', short: '-y', description: 'Skip writeFile confirmations' },
      ],
    },
    {
      name: 'provider',
      description: 'Save and manage your own model providers (OpenAI-compatible, Anthropic, or Google AI endpoints)',
      subcommands: [
        {
          name: 'add',
          description: 'Save a named model provider',
          takesArgs: true,
          options: [
            { name: '--type', takesValue: true, values: ['openai', 'anthropic', 'google'], description: 'Provider type' },
            { name: '--base-url', takesValue: true, description: 'Base URL of the endpoint (defaults per type)' },
            { name: '--model', takesValue: true, description: 'Default model id for this provider' },
            { name: '--api-key-env', takesValue: true, description: 'Env var holding the API key (preferred)' },
            { name: '--api-key', takesValue: true, description: 'Inline API key (written to disk; prefer --api-key-env)' },
          ],
        },
        { name: 'list', description: 'List saved providers (keys masked)' },
        { name: 'remove', description: 'Delete a saved provider', takesArgs: true },
        { name: 'use', description: 'Set the default provider (or "spycore" to reset to built-in)', takesArgs: true },
        {
          name: 'test',
          description: 'Make one minimal request through a saved provider',
          takesArgs: true,
          options: [{ name: '--model', takesValue: true, description: 'Model to test with' }],
        },
      ],
    },
    {
      name: 'skills',
      description: 'List, create and sync local agent skills (SKILL.md guides the agent can load)',
      subcommands: [
        { name: 'list', description: 'List installed agent skills (project + user-global)' },
        { name: 'show', description: "Print a skill's full instructions", takesArgs: true },
        {
          name: 'sync',
          description: 'Download the official skill catalog (requires login)',
          options: [{ name: '--force', description: 'Re-download every official skill even when unchanged' }],
        },
        {
          name: 'create',
          description: 'Generate a new skill from a one-line description',
          takesArgs: true,
          options: [
            { name: '--name', takesValue: true, description: 'Skill name (default: derived from the description)' },
            { name: '--project', description: 'Write to ./.spycore/skills/ instead of user-global' },
            { name: '--model', short: '-m', takesValue: true, description: 'Model to generate with' },
            { name: '--provider', takesValue: true, description: 'Provider: a saved name or built-in type' },
            { name: '--base-url', takesValue: true, description: 'Base URL for a BYOK provider' },
            { name: '--api-key-env', takesValue: true, description: 'Env var holding the API key for a BYOK provider' },
            { name: '--yes', short: '-y', description: 'Accept without interactive review' },
          ],
        },
        {
          name: 'remove',
          description: 'Remove a user-created or project skill',
          takesArgs: true,
          options: [{ name: '--yes', short: '-y', description: 'Remove without asking for confirmation' }],
        },
      ],
    },
    {
      name: 'update',
      description: 'Check for a newer @spycore/cli release and show how to upgrade',
      options: [
        {
          name: '--check',
          description: 'Only check (default behaviour) — exits 0 if up-to-date, 1 if update available',
        },
      ],
    },
    {
      name: 'completion',
      description: 'Print a shell tab-completion script (bash | zsh | fish | powershell)',
      subcommands: SHELL_VALUES.map((shell) => ({
        name: shell,
        description: `Print ${shell} completion script to stdout`,
      })),
    },
    {
      name: 'schema',
      description: 'Print a JSON Schema describing the CLI surface (commands, options, output types)',
      options: [
        { name: '--commands', description: 'Only emit the command tree' },
        { name: '--output-types', description: 'Only emit output type definitions' },
      ],
    },
  ],
};

/** Walk the spec, yielding every command path (e.g. ['conversations', 'list']). */
export function* walkCommands(
  spec: CommandSpec = COMMAND_SPEC,
  prefix: string[] = [],
): Generator<{ path: string[]; cmd: CommandSpec }> {
  const path = spec === COMMAND_SPEC ? prefix : [...prefix, spec.name];
  if (spec !== COMMAND_SPEC) yield { path, cmd: spec };
  for (const sub of spec.subcommands ?? []) {
    yield* walkCommands(sub, path);
  }
}

/** Look up a command by its dotted path, returning the spec or undefined. */
export function findCommand(path: readonly string[]): CommandSpec | undefined {
  let node: CommandSpec | undefined = COMMAND_SPEC;
  for (const segment of path) {
    if (!node?.subcommands) return undefined;
    node = node.subcommands.find((s) => s.name === segment);
    if (!node) return undefined;
  }
  return node;
}
