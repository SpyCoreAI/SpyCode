/**
 * The scripted runs behind the three golden pins (N1 fenced run, N2 native
 * run, N3 first-turn bytes).
 *
 * Each scenario builds its own workspace, drives `runAgent` once per case,
 * and returns everything observable about the run with machine paths replaced
 * by placeholders: the event stream as `onEvent` saw it, the `AgentResult`
 * (including its retained `events`), every request the provider received, the
 * approval requests and the persisted journal.
 *
 * The expected values are FROZEN fixture files captured from the unchanged
 * 0.9.1 source. They are declared change-detectors: for a refactor that must
 * not change behavior, "identical to before" is the oracle. A fixture is never
 * regenerated to make a red pin green; a red golden means behavior moved.
 *
 * The caller owns the config directory (`freshConfigDir()` before each test),
 * because the journal and the user skills live under it.
 */
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { runAgent, type AgentEvent, type AgentResult, type AgentRunState, type RunAgentOptions } from '../src/lib/agent/loop.js';
import { listSessions } from '../src/lib/agent/checkpoint.js';
import { getConfigPath } from '../src/lib/config.js';
import type { ApprovalRequest, RequestApproval } from '../src/lib/agent/approval.js';
import type { CommandRule, EffectiveCommandRules } from '../src/lib/agent/command-rules.js';
import type { CreateConversationParams } from '../src/lib/providers/types.js';
import {
  BYOK_ID,
  ScriptProvider,
  block,
  byTurn,
  engineJsonError,
  nativeCalls,
  removeDir,
  say,
  scrubPaths,
  scrubText,
  tempDir,
  type RecordedTurn,
  type ScriptStep,
} from './loop-pin-harness.js';

/** Everything observable about one run. */
export interface RunCapture {
  events: AgentEvent[];
  result: AgentResult;
  turns: RecordedTurn[];
  opened: CreateConversationParams[];
  approvals: ApprovalRequest[];
  runStates: AgentRunState[];
  journal: Array<{ task: string; changes: unknown[] }>;
}

const rule = (entry: string, kind: CommandRule['kind'], scope: CommandRule['scope']): CommandRule => ({
  entry,
  tokens: entry.split(' '),
  kind,
  scope,
});

/** Deny `touch`, allow `echo pin`. The denied command below is longer than the 80-char notice cut. */
export const GOLDEN_RULES: EffectiveCommandRules = {
  allow: [rule('echo pin', 'allow', 'project')],
  deny: [rule('touch', 'deny', 'user')],
};

export const LONG_DENIED_COMMAND = `touch pinned-denied-target-${'x'.repeat(72)}.txt`;

/** A small, fixed workspace: three readable files and one project skill the trust gate withholds. */
function seedWorkspace(cwd: string): void {
  writeFileSync(join(cwd, 'alpha.txt'), 'alpha line\n');
  writeFileSync(join(cwd, 'beta.txt'), 'beta one\nbeta two\n');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'gamma.ts'), 'export const gamma = 3;\n');
  mkdirSync(join(cwd, '.spycore', 'skills', 'pin-skill'), { recursive: true });
  writeFileSync(
    join(cwd, '.spycore', 'skills', 'pin-skill', 'SKILL.md'),
    '---\nname: pin-skill\ndescription: A project skill the trust gate withholds.\n---\nBody.\n',
  );
}

/** A user-global skill, so the prompt builders interpolate a non-empty skills section. */
export function seedUserSkill(): void {
  const dir = join(dirname(getConfigPath()), 'skills', 'pin-guide');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: pin-guide\ndescription: A user skill listed in the catalog.\n---\nGuide body.\n');
}

/**
 * `malformed` lists the invalid JSON texts the script feeds the parser; each
 * engine message they produce is replaced by `<ENGINE_JSON_ERROR_n>`.
 */
async function capture(
  cwd: string,
  provider: ScriptProvider,
  opts: Omit<RunAgentOptions, 'cwd' | 'provider' | 'onEvent' | 'onRunState' | 'requestApproval'>,
  malformed: string[] = [],
): Promise<RunCapture> {
  const events: AgentEvent[] = [];
  const approvals: ApprovalRequest[] = [];
  const runStates: AgentRunState[] = [];
  const approve: RequestApproval = (req) => {
    approvals.push(req);
    return Promise.resolve({ approved: true });
  };
  const result = await runAgent({
    ...opts,
    cwd,
    provider,
    requestApproval: approve,
    onEvent: (e) => events.push(e),
    onRunState: (s) => runStates.push({ ...s }),
  });
  const journal = listSessions(cwd).map((s) => ({ task: s.task, changes: s.changes }));
  const configDir = dirname(getConfigPath());
  const pathless = scrubPaths(
    { events, result, turns: provider.turns, opened: provider.opened, approvals, runStates, journal },
    { '<CWD>': cwd, '<CONFIG>': configDir },
  );
  return scrubText(
    pathless,
    malformed.map((text, i): [string, string] => [engineJsonError(text), `<ENGINE_JSON_ERROR_${i + 1}>`]),
  );
}

// ─────────────────────────── N1 · fenced run ───────────────────────────

/**
 * Turn 1: narration, three read-only calls (one batch), an approved write and
 * a command the deny rule refuses - in an untrusted workspace holding a project
 * skill. Turn 2: a malformed block. Turn 3: an empty reply. Turn 4: the final
 * answer.
 */
export async function goldenFencedRun(): Promise<RunCapture> {
  const cwd = tempDir('spycli-golden-fenced-');
  try {
    seedWorkspace(cwd);
    const turn1 = [
      'Looking around before writing.',
      block('read_file', { path: 'alpha.txt' }),
      block('list_dir', { path: '.' }),
      block('grep', { pattern: 'beta' }),
      block('write_file', { path: 'notes.txt', content: 'pinned\n' }),
      block('run_command', { command: LONG_DENIED_COMMAND }),
    ].join('\n');
    const broken = '{"tool": "read_file", "args": {"path":';
    const turn2 = `Retrying the read.\n\`\`\`spycore:tool\n${broken} \n\`\`\``;
    const provider = new ScriptProvider({
      id: BYOK_ID,
      script: byTurn([say(turn1), say(turn2), say(''), say('notes.txt now holds the pinned line.')]),
    });
    return await capture(
      cwd,
      provider,
      { task: 'Write the pinned note.', model: 'byok-model', maxTurns: 6, commandRules: GOLDEN_RULES },
      [broken],
    );
  } finally {
    removeDir(cwd);
  }
}

/** The same workspace, ending at `maxTurns` on a malformed turn. */
export async function goldenFencedTurnLimit(): Promise<RunCapture> {
  const cwd = tempDir('spycli-golden-limit-');
  try {
    seedWorkspace(cwd);
    const provider = new ScriptProvider({
      id: BYOK_ID,
      script: byTurn([
        say(block('read_file', { path: 'alpha.txt' })),
        say('Still trying.\n```spycore:tool\n{"tool": \n```'),
      ]),
    });
    return await capture(cwd, provider, { task: 'Read alpha.', model: 'byok-model', maxTurns: 2 }, ['{"tool":']);
  } finally {
    removeDir(cwd);
  }
}

// ─────────────────────────── N2 · native run ───────────────────────────

const BROKEN_NATIVE_ARGS = '{"path": "alpha.txt"';

/**
 * Turn 1: narration, a malformed-JSON call, a non-object call and a read-only
 * batch. Turn 2: a write, then more read-only calls than the per-turn cap
 * leaves room for - the cap fires and its note becomes the next message.
 * Turn 3: an empty reply (nudged). Turn 4: the final answer.
 */
export async function goldenNativeRun(): Promise<RunCapture> {
  const cwd = tempDir('spycli-golden-native-');
  try {
    seedWorkspace(cwd);
    const turns: ScriptStep[][] = [
      nativeCalls(
        [
          { id: 'c1', name: 'read_file', arguments: BROKEN_NATIVE_ARGS },
          { id: 'c2', name: 'read_file', arguments: '[1]' },
          { id: 'c3', name: 'read_file', arguments: '{"path":"alpha.txt"}' },
          { id: 'c4', name: 'list_dir', arguments: '' },
        ],
        'Checking the workspace.',
      ),
      nativeCalls([
        { id: 'c5', name: 'write_file', arguments: '{"path":"notes.txt","content":"pinned\\n"}' },
        { id: 'c6', name: 'read_file', arguments: '{"path":"beta.txt"}' },
        { id: 'c7', name: 'grep', arguments: '{"pattern":"beta"}' },
        { id: 'c8', name: 'list_dir', arguments: '{"path":"src"}' },
        { id: 'c9', name: 'read_file', arguments: '{"path":"src/gamma.ts"}' },
      ]),
      [{ type: 'usage', input: 1, output: 1 }, { type: 'done' }],
      say('Finished natively.'),
    ];
    const provider = new ScriptProvider({ id: 'spycore', native: true, script: byTurn(turns) });
    return await capture(
      cwd,
      provider,
      { task: 'Write the pinned note natively.', maxTurns: 6, maxToolCallsPerTurn: 4 },
      [BROKEN_NATIVE_ARGS],
    );
  } finally {
    removeDir(cwd);
  }
}

// ─────────────────────────── N3 · first-turn bytes ───────────────────────────

export interface FirstTurnCapture {
  system: string | undefined;
  message: string;
  attachments: string[] | undefined;
  events: AgentEvent[];
}

const COMBOS = [
  { name: 'fenced-execute-spycore', id: 'spycore', native: false, planMode: false },
  { name: 'fenced-plan-spycore', id: 'spycore', native: false, planMode: true },
  { name: 'fenced-execute-byok', id: BYOK_ID, native: false, planMode: false },
  { name: 'fenced-plan-byok', id: BYOK_ID, native: false, planMode: true },
  { name: 'native-execute-spycore', id: 'spycore', native: true, planMode: false },
  { name: 'native-plan-spycore', id: 'spycore', native: true, planMode: true },
] as const;

const VARIANTS: Record<string, Partial<RunAgentOptions>> = {
  full: {
    projectContext: '<spycode-context>\nPROJECT CONTEXT BLOCK\n</spycode-context>',
    attachedContext: '--- attached: notes.md ---\nATTACHED FILE BLOCK\n--- end ---',
    approvedPlan: '1. Step one.\n2. Step two.',
    planEdited: true,
    planFeedback: 'Smaller steps, please.',
    attachments: ['file_a', 'file_b'],
  },
  whitespace: {
    projectContext: '   \n',
    attachedContext: ' \t ',
    approvedPlan: '\n\t',
    planEdited: true,
    planFeedback: '  ',
    attachments: [],
  },
  unedited: {
    approvedPlan: 'Plan text.',
    planEdited: false,
    planFeedback: 'Shorter.',
  },
};

/** An oversized project-context block: past the 32,000-char wire cap on its own. */
const OVERSIZED_CONTEXT = Array.from({ length: 1_200 }, (_, i) => `context line ${String(i).padStart(4, '0')} ${'.'.repeat(20)}`).join('\n');

async function firstTurn(
  cwd: string,
  combo: { id: 'spycore' | typeof BYOK_ID; native: boolean; planMode: boolean },
  extra: Partial<RunAgentOptions>,
): Promise<FirstTurnCapture> {
  const provider = new ScriptProvider({ id: combo.id, native: combo.native, script: byTurn([say('Final.')]) });
  const events: AgentEvent[] = [];
  await runAgent({
    task: 'Do the pinned task.',
    cwd,
    provider,
    maxTurns: 7,
    planMode: combo.planMode,
    ...(combo.id === 'spycore' ? {} : { model: 'byok-model' }),
    ...extra,
    onEvent: (e) => events.push(e),
  });
  const t = provider.turns[0]!;
  return {
    system: t.system,
    message: t.message,
    attachments: t.attachments,
    events: events.filter((e) => e.type === 'context_clamped'),
  };
}

/**
 * The working directory is interpolated into the system prompt, and the wire
 * clamp cuts the project context by what the prompt leaves over - so the bytes
 * the clamp keeps depend on the LENGTH of the path. The first-turn matrix runs
 * in a directory padded to a fixed length, which makes the clamped bytes the
 * same on every machine once the path itself is replaced by a placeholder.
 */
const FIXED_CWD_LENGTH = 160;

/** Every case of the first-turn matrix, keyed by name. */
export async function goldenFirstTurns(): Promise<Record<string, FirstTurnCapture>> {
  const root = tempDir('spycli-golden-first-');
  const pad = FIXED_CWD_LENGTH - root.length - 1;
  if (pad < 1) throw new Error(`temp root too long for the fixed-length workspace (${root.length} chars)`);
  const cwd = join(root, 'w'.repeat(pad));
  mkdirSync(cwd);
  try {
    seedUserSkill();
    const out: Record<string, FirstTurnCapture> = {};
    for (const combo of COMBOS) {
      for (const [variant, extra] of Object.entries(VARIANTS)) {
        out[`${combo.name}/${variant}`] = await firstTurn(cwd, combo, extra);
      }
    }
    out['clamp/spycore'] = await firstTurn(cwd, COMBOS[0], { projectContext: OVERSIZED_CONTEXT });
    out['clamp/byok-unclamped'] = await firstTurn(cwd, COMBOS[2], { projectContext: OVERSIZED_CONTEXT });
    return scrubPaths(out, { '<CWD>': cwd });
  } finally {
    removeDir(root);
  }
}

// ─────────────────────────── fixture encoding ───────────────────────────

/**
 * Long strings repeat across cases (the same system prompt in many runs), so a
 * fixture stores each distinct long string once, by content hash, and the cases
 * refer to it. `decodeGolden(encodeGolden(x))` is `x` exactly.
 */
const LONG = 400;
const REF = '@@golden-ref:';

export function encodeGolden(value: unknown): { strings: Record<string, string>; value: unknown } {
  const strings: Record<string, string> = {};
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string' && v.length >= LONG) {
      const key = createHash('sha256').update(v).digest('hex').slice(0, 16);
      strings[key] = v;
      return `${REF}${key}`;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return { strings, value: walk(value) };
}

export function decodeGolden(encoded: { strings: Record<string, string>; value: unknown }): unknown {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string' && v.startsWith(REF)) {
      const s = encoded.strings[v.slice(REF.length)];
      if (s === undefined) throw new Error(`golden fixture is missing string ${v.slice(REF.length)}`);
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(encoded.value);
}

/**
 * Round-trip through JSON exactly as the fixture file does, so `undefined`
 * fields compare the way they were stored (dropped from objects).
 */
export function asStored<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}
