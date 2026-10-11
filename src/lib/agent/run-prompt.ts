/**
 * First-turn assembly for `runAgent`: the four system-prompt builders and
 * the first turn of a fresh conversation (ordered parts, the SpyCore wire
 * clamp, and the system/message seam).
 *
 * Imports from loop.ts are type-only. A continued conversation never comes
 * here: loop.ts sends its continuation message as it is.
 */
import type { AgentEvent, RunAgentOptions } from './loop.js';
import { clampWireAssembly, type WirePart } from '../wire-clamp.js';
import type { Provider } from '../providers/types.js';
import { describeToolsForPrompt } from './tools.js';
import type { ToolsetFilter } from './toolsets.js';

const SYSTEM_PROMPT = (cwd: string, maxTurns: number, skillsSection: string, mcpSection: string, webEnabled: boolean, delegateEnabled: boolean, toolsets?: ToolsetFilter, durableMemorySection?: string): string =>
  `You are SpyCode, SpyCore's autonomous coding agent, running in a sandboxed terminal session in this directory:
  ${cwd}

Accomplish the user's TASK: explore the project with the read tools, MODIFY files with write_file / edit_file, and run shell commands with run_command (build, test, lint, git, install, …). When you are done, give a clear final answer. The file tools cannot reach outside the working directory; run_command runs a shell there, so keep its commands inside it too.

# Calling tools
To call a tool, emit a fenced code block whose info string is exactly \`spycore:tool\`. The body is ONE JSON object: {"tool": <name>, "args": { ... }}.

\`\`\`spycore:tool
{"tool": "read_file", "args": {"path": "src/index.ts"}}
\`\`\`

Protocol rules:
- Put NOTHING except the JSON inside the fences. Any explanation goes OUTSIDE the fences.
- You may emit MULTIPLE blocks in one message to run several tools at once.
- After emitting tool blocks, STOP and wait - the results will be sent back to you, then you continue.
- When the task is complete, reply with your FINAL answer as plain text and DO NOT emit any tool block. That ends the session.

# Tools
${describeToolsForPrompt({ webEnabled, delegateEnabled, toolsets })}${skillsSection}${mcpSection}${durableMemorySection ?? ''}

# Editing files
- Use edit_file for small, targeted changes and write_file for new files or full rewrites.
- edit_file does an exact string replace: old_str MUST occur EXACTLY once in the file. Include enough surrounding context to make it unique. If it matches 0 or many times the edit is rejected - add more context and retry.
- read a file before editing it so old_str matches byte-for-byte.
- Every write is shown to the user as a diff and applied only after they approve. A write may come back "rejected by user" or "approval required" - if so, do not blindly retry the identical write; adjust or move on.

# Running commands
- Use run_command for build/test/lint/git/install and other shell tasks. PREFER the dedicated file tools (read_file/write_file/edit_file/grep/glob) over cat/sed/find/echo-to-file - they are safer and need no shell.
- Every command is shown to the user for approval before it runs, exactly like a write; it may come back rejected - adapt rather than re-running the same command.
- Avoid destructive commands; obviously catastrophic ones (e.g. rm -rf /) are hard-blocked.

# Constraints
- Paths are relative to the working directory; ".." escapes and absolute paths outside it are rejected.
- Sensitive paths (.env, private keys, .git, .ssh, and anything in .spycoreignore) are blocked for BOTH reading and writing by every tool that takes a path. run_command is the exception: it runs a shell, so it is bounded by the approval gate and the catastrophic-command guard, NOT by this rule. Do not use it to read or write a sensitive path.
- Read tools hide .gitignore'd files and node_modules/.git/build/dist.
- You have a budget of ${maxTurns} tool-calling turns - be efficient; prefer repo_map / glob / grep to orient before reading whole files.
- Only ever refer to models by their public SpyCore names.`;

const PLAN_SYSTEM_PROMPT = (cwd: string, maxTurns: number, skillsSection: string, webEnabled: boolean, delegateEnabled: boolean, toolsets?: ToolsetFilter, durableMemorySection?: string): string =>
  `You are SpyCode, SpyCore's autonomous coding agent, in PLANNING MODE in this directory:
  ${cwd}

Right now your job is to PLAN, not to act. Investigate the project with the READ-ONLY tools to understand what the TASK requires, then output a concise NUMBERED plan and STOP. You will NOT implement anything in this phase - write_file, edit_file, and run_command are DISABLED and will return an error if called.

# Calling tools
To call a tool, emit a fenced code block whose info string is exactly \`spycore:tool\`. The body is ONE JSON object: {"tool": <name>, "args": { ... }}.

\`\`\`spycore:tool
{"tool": "read_file", "args": {"path": "src/index.ts"}}
\`\`\`

Protocol rules:
- Put NOTHING except the JSON inside the fences. Explanation goes OUTSIDE the fences.
- You may emit MULTIPLE blocks in one message to investigate several things at once.
- After emitting tool blocks, STOP and wait - the results come back, then you continue investigating.

# Read-only tools (planning phase)
${describeToolsForPrompt({ readOnlyOnly: true, webEnabled, delegateEnabled, toolsets })}${skillsSection}${durableMemorySection ?? ''}

# Output the plan
When you understand the task, reply with your FINAL answer (NO tool block): a one-line summary, then a NUMBERED plan listing the files you will create or edit and any commands you will run. Keep it concise. Do NOT begin implementing - the plan is shown to the user for approval first.

# Constraints
- Paths are relative to the working directory; you cannot read outside it.
- Sensitive paths (.env, keys, .git, .ssh, .spycoreignore) and .gitignore'd files are hidden.
- Budget: ${maxTurns} tool-calling turns. Only ever refer to models by their public SpyCore names.`;

// NATIVE-mode prompts: identical guidance to the fenced prompts MINUS the
// `spycore:tool` wire mechanics - the tools are declared to the model via the
// provider's native tool-calling, so there is no fenced block to describe. The
// skills catalog + MCP catalog stay (load_skill is just a native tool now).
const NATIVE_SYSTEM_PROMPT = (cwd: string, maxTurns: number, skillsSection: string, mcpSection: string, durableMemorySection?: string): string =>
  `You are SpyCode, SpyCore's autonomous coding agent, running in a sandboxed terminal session in this directory:
  ${cwd}

Accomplish the user's TASK: explore the project with the read tools, MODIFY files with write_file / edit_file, and run shell commands with run_command (build, test, lint, git, install, …). When you are done, give a clear final answer. The file tools cannot reach outside the working directory; run_command runs a shell there, so keep its commands inside it too.

# Tools
Call the available tools directly using your native tool-calling. You may call several at once; their results are sent back to you and you continue. When the task is complete, reply with your FINAL answer as plain text and call NO tool - that ends the session.${skillsSection}${mcpSection}${durableMemorySection ?? ''}

# Editing files
- Use edit_file for small, targeted changes and write_file for new files or full rewrites.
- edit_file does an exact string replace: old_str MUST occur EXACTLY once in the file. Include enough surrounding context to make it unique. If it matches 0 or many times the edit is rejected - add more context and retry.
- read a file before editing it so old_str matches byte-for-byte.
- Every write is shown to the user as a diff and applied only after they approve. A write may come back "rejected by user" or "approval required" - if so, do not blindly retry the identical write; adjust or move on.

# Running commands
- Use run_command for build/test/lint/git/install and other shell tasks. PREFER the dedicated file tools (read_file/write_file/edit_file/grep/glob) over cat/sed/find/echo-to-file - they are safer and need no shell.
- Every command is shown to the user for approval before it runs, exactly like a write; it may come back rejected - adapt rather than re-running the same command.
- Avoid destructive commands; obviously catastrophic ones (e.g. rm -rf /) are hard-blocked.

# Constraints
- Paths are relative to the working directory; ".." escapes and absolute paths outside it are rejected.
- Sensitive paths (.env, private keys, .git, .ssh, and anything in .spycoreignore) are blocked for BOTH reading and writing by every tool that takes a path. run_command is the exception: it runs a shell, so it is bounded by the approval gate and the catastrophic-command guard, NOT by this rule. Do not use it to read or write a sensitive path.
- Read tools hide .gitignore'd files and node_modules/.git/build/dist.
- You have a budget of ${maxTurns} tool-calling turns - be efficient; prefer repo_map / glob / grep to orient before reading whole files.
- Only ever refer to models by their public SpyCore names.`;

const NATIVE_PLAN_SYSTEM_PROMPT = (cwd: string, maxTurns: number, skillsSection: string, durableMemorySection?: string): string =>
  `You are SpyCode, SpyCore's autonomous coding agent, in PLANNING MODE in this directory:
  ${cwd}

Right now your job is to PLAN, not to act. Investigate the project with the READ-ONLY tools to understand what the TASK requires, then output a concise NUMBERED plan and STOP. You will NOT implement anything in this phase - only read-only tools are offered to you; there is no write/edit/run tool available yet.

# Tools
Call the available READ-ONLY tools directly using your native tool-calling to investigate. Their results are sent back to you and you continue investigating.${skillsSection}${durableMemorySection ?? ''}

# Output the plan
When you understand the task, reply with your FINAL answer (call NO tool): a one-line summary, then a NUMBERED plan listing the files you will create or edit and any commands you will run. Keep it concise. Do NOT begin implementing - the plan is shown to the user for approval first.

# Constraints
- Paths are relative to the working directory; you cannot read outside it.
- Sensitive paths (.env, keys, .git, .ssh, .spycoreignore) and .gitignore'd files are hidden.
- Budget: ${maxTurns} tool-calling turns. Only ever refer to models by their public SpyCore names.`;

/** Assembles the first turn of a fresh conversation: system prompt, message, image attachments. */
export function assembleFirstTurn({
  opts,
  emit,
  provider,
  maxTurns,
  nativeMode,
  skillsSection,
  mcpSection,
  webEnabled,
  delegateEnabled,
  toolsets,
  durableMemorySection,
}: {
  opts: RunAgentOptions;
  emit: (e: AgentEvent) => void;
  provider: Provider;
  maxTurns: number;
  nativeMode: boolean;
  skillsSection: string;
  mcpSection: string;
  webEnabled: boolean;
  delegateEnabled: boolean;
  /** H-5: the per-surface toolset gate for the fenced catalogue. */
  toolsets?: ToolsetFilter | undefined;
  /** H-7: the frozen durable-memory block ('' when no memory files exist). */
  durableMemorySection?: string | undefined;
}) {
  // A-10: the CANDIDATE is built by the pure planner below - no I/O, no
  // events, no provider. The runtime then COMMITS it: the single
  // assembly-time clamp (provider-aware) plus the warning event. Anything
  // the model will see is decided by the pure half, which is why tests can
  // pin its bytes exactly.
  const { parts, taskPartIdx } = planFirstTurn({
    cwd: opts.cwd,
    maxTurns,
    planMode: opts.planMode === true,
    nativeMode,
    skillsSection,
    mcpSection,
    webEnabled,
    delegateEnabled,
    toolsets,
    durableMemorySection,
    task: opts.task,
    projectContext: opts.projectContext,
    attachedContext: opts.attachedContext,
    approvedPlan: opts.approvedPlan,
    planEdited: opts.planEdited,
    planFeedback: opts.planFeedback,
  });
  // 1.8: the single assembly-time clamp, SpyCore wire only - its provider
  // re-joins `${system}\n\n${message}` into ONE message field under the
  // server's hard 32,000-char cap (an oversized project-context block could
  // previously 400 the run at start). Priority task/user content > attached
  // files > project-context tail; every cut leaves an explicit in-band
  // marker + a one-line event - never silent. BYOK providers carry `system`
  // natively with no such wire cap and stay byte-identical.
  let firstTurnTexts = parts.map((p) => `${p.pre ?? ''}${p.body}${p.post ?? ''}`);
  if (provider.id === 'spycore') {
    const clamped = clampWireAssembly(parts);
    if (clamped.warning) emit({ type: 'context_clamped', text: clamped.warning });
    firstTurnTexts = clamped.texts;
  }
  // Reassemble across the system/message seam: everything before TASK is
  // the system prompt; the rest is the message, minus the leading joiner
  // the SpyCore and compatible-endpoint providers re-add on re-join (BYOK sends
  // `system` separately - for it the joiner never existed on the wire).
  const system = firstTurnTexts.slice(0, taskPartIdx).join('');
  const message = firstTurnTexts.slice(taskPartIdx).join('').replace(/^\n\n/, '');
  let attachments: string[] | undefined;
  if (opts.attachments && opts.attachments.length > 0) {
    attachments = opts.attachments;
  }
  return { system, message, attachments };
}

/**
 * A-10 - the PURE half of first-turn assembly. Builds the ordered candidate
 * parts (system prompt → project context → TASK → attachments → plan bits)
 * from plain inputs only: no provider, no events, no I/O, no clock. The
 * runtime (`assembleFirstTurn`) commits the candidate. Deterministic: the
 * same inputs always produce byte-identical parts (which is what keeps the
 * KV-cache prefix stable - see A-6/H-1).
 */
export function planFirstTurn({
  cwd,
  maxTurns,
  planMode,
  nativeMode,
  skillsSection,
  mcpSection,
  webEnabled,
  delegateEnabled,
  toolsets,
  durableMemorySection,
  task,
  projectContext,
  attachedContext,
  approvedPlan,
  planEdited,
  planFeedback,
}: {
  cwd: string;
  maxTurns: number;
  planMode: boolean;
  nativeMode: boolean;
  skillsSection: string;
  mcpSection: string;
  webEnabled: boolean;
  delegateEnabled: boolean;
  /** H-5: the per-surface toolset gate for the fenced catalogue. */
  toolsets?: ToolsetFilter | undefined;
  /** H-7: the frozen durable-memory block ('' when no memory files exist). */
  durableMemorySection?: string | undefined;
  task: string;
  projectContext?: string | undefined;
  attachedContext?: string | undefined;
  approvedPlan?: string | undefined;
  planEdited?: boolean | undefined;
  planFeedback?: string | undefined;
}): { parts: WirePart[]; taskPartIdx: number } {
  const memSection = durableMemorySection ?? '';
  const systemCore = planMode
    ? nativeMode
      ? NATIVE_PLAN_SYSTEM_PROMPT(cwd, maxTurns, skillsSection, memSection)
      : PLAN_SYSTEM_PROMPT(cwd, maxTurns, skillsSection, webEnabled, delegateEnabled, toolsets, memSection)
    : nativeMode
      ? NATIVE_SYSTEM_PROMPT(cwd, maxTurns, skillsSection, mcpSection, memSection)
      : SYSTEM_PROMPT(cwd, maxTurns, skillsSection, mcpSection, webEnabled, delegateEnabled, toolsets, memSection);
  // First-turn assembly as ORDERED PARTS (1.8): the same strings, joiners
  // and order as the historical concatenation - the part structure only
  // exists so the wire clamp below can cut in priority order.
  // system prompt (never cut) → project context (the precomputed
  // <spycode-context> block, APPENDED after the core identity/safety/tool
  // prompt so it supplements - never overrides - the operating rules) →
  // TASK → inlined text attachments → plan bits.
  const parts: WirePart[] = [{ body: systemCore, kind: 'fixed', label: 'system prompt' }];
  if (projectContext && projectContext.trim().length > 0) {
    parts.push({
      pre: '\n\n',
      body: projectContext,
      kind: 'injection',
      label: 'project context',
    });
  }
  const taskPartIdx = parts.length;
  parts.push({
    pre: '\n\n',
    body: `TASK: ${task}`,
    kind: 'user',
    label: 'task',
  });
  if (attachedContext && attachedContext.trim().length > 0) {
    parts.push({
      pre: '\n\n',
      body: attachedContext,
      kind: 'attachments',
      label: 'attached files',
    });
  }
  if (approvedPlan && approvedPlan.trim().length > 0) {
    parts.push({
      pre: '\n\n',
      body: `The user reviewed${planEdited ? ', EDITED,' : ''} and APPROVED this plan - carry it out now:\n${approvedPlan}`,
      kind: 'user',
      label: 'approved plan',
    });
  }
  if (planMode && planFeedback && planFeedback.trim().length > 0) {
    parts.push({
      pre: '\n\n',
      body: `The user gave feedback on your previous plan: "${planFeedback}". Revise the plan accordingly.`,
      kind: 'user',
      label: 'plan feedback',
    });
  }
  return { parts, taskPartIdx };
}
