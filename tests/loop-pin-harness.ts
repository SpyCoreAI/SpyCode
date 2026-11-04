/**
 * Shared harness for the refactor pins that drive `runAgent` end to end.
 *
 * Nothing here is a test. It is the scripted provider, the workspace helpers
 * and the path scrubber the pin files share, so every pin drives the loop the
 * same way and records the same view of the wire.
 *
 * THE PROVIDER RECORDS WHAT THE LOOP SENDS, NOT WHAT IT MEANT TO SEND. Every
 * `streamChat` call is copied at the moment it arrives (message, system,
 * attachments, the declared tool names and the tool results), so a later
 * mutation of a shared array by the loop cannot rewrite the record.
 *
 * Conversations are numbered in creation order (`cnv_1`, `cnv_2`, …). A
 * delegated child shares its parent's provider, so the script is keyed by
 * conversation and by turn within that conversation.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDER_KINDS } from '../src/lib/providers/byok-config.js';
import type {
  CreateConversationParams,
  Provider,
  ProviderEvent,
  StreamChatParams,
  ToolResultDecl,
} from '../src/lib/providers/types.js';
import type { RequestApproval } from '../src/lib/agent/approval.js';
import type { McpBridge } from '../src/lib/agent/mcp.js';
import type { ToolDefinition } from '../src/lib/agent/tools.js';

/** A bring-your-own-key provider id, taken from the shipped list rather than spelled out. */
export const BYOK_ID = PROVIDER_KINDS.find((k) => k !== 'spycore') as Exclude<Provider['id'], 'spycore'>;

export const ACCEPT: RequestApproval = () => Promise.resolve({ approved: true });

/** One `streamChat` call as the provider received it. */
export interface RecordedTurn {
  conversationId: string;
  model: string;
  message: string;
  system: string | undefined;
  attachments: string[] | undefined;
  tools: string[] | undefined;
  toolResults: ToolResultDecl[] | undefined;
}

/** A scripted step: an event to yield, or a side effect to run at that point of the stream. */
export type ScriptStep = ProviderEvent | (() => void);

/** Where a turn sits: the conversation's creation index (1-based) and its turn (1-based). */
export interface TurnAddress {
  conversation: number;
  turn: number;
}

export type Script = (at: TurnAddress, params: StreamChatParams) => ScriptStep[];

export interface ScriptProviderOptions {
  id?: Provider['id'];
  /** Whether `supportsNativeTools` answers true for a conversation this provider opened. */
  native?: boolean;
  script: Script;
}

export class ScriptProvider implements Provider {
  readonly id: Provider['id'];
  readonly opened: CreateConversationParams[] = [];
  readonly turns: RecordedTurn[] = [];
  /** Every conversation id `supportsNativeTools` was asked about, in order. */
  readonly capabilityChecks: string[] = [];
  private readonly turnCount = new Map<string, number>();
  private readonly native: boolean;
  private readonly script: Script;

  constructor(opts: ScriptProviderOptions) {
    this.id = opts.id ?? BYOK_ID;
    this.native = opts.native === true;
    this.script = opts.script;
  }

  createConversation(params: CreateConversationParams): Promise<string> {
    this.opened.push({ ...params });
    return Promise.resolve(`cnv_${this.opened.length}`);
  }

  supportsNativeTools(conversationId: string): boolean {
    this.capabilityChecks.push(conversationId);
    if (!this.native) return false;
    const n = Number(/^cnv_(\d+)$/.exec(conversationId)?.[1] ?? '0');
    return n >= 1 && n <= this.opened.length;
  }

  async *streamChat(params: StreamChatParams): AsyncIterable<ProviderEvent> {
    this.turns.push({
      conversationId: params.conversationId,
      model: params.model,
      message: params.message,
      system: params.system,
      attachments: params.attachments ? [...params.attachments] : undefined,
      tools: params.tools ? params.tools.map((t) => t.name) : undefined,
      toolResults: params.toolResults ? params.toolResults.map((r) => ({ ...r })) : undefined,
    });
    const turn = (this.turnCount.get(params.conversationId) ?? 0) + 1;
    this.turnCount.set(params.conversationId, turn);
    const conversation = Number(/^cnv_(\d+)$/.exec(params.conversationId)?.[1] ?? '0');
    for (const step of this.script({ conversation, turn }, params)) {
      if (typeof step === 'function') step();
      else yield step;
    }
  }
}

/** The same scripted replies for every conversation, by turn. Past the end: a plain final answer. */
export function byTurn(turns: ScriptStep[][]): Script {
  return ({ turn }) => turns[turn - 1] ?? say('Done.');
}

/** A text reply that ends the turn. */
export function say(text: string, input = 1, output = 1): ScriptStep[] {
  return [{ type: 'text', text }, { type: 'usage', input, output }, { type: 'done' }];
}

/** A native turn: optional narration, then the fully assembled tool calls. */
export function nativeCalls(
  calls: Array<{ id: string; name: string; arguments: string }>,
  narration = '',
): ScriptStep[] {
  const steps: ScriptStep[] = [];
  if (narration.length > 0) steps.push({ type: 'text', text: narration });
  calls.forEach((c, index) => steps.push({ type: 'tool_call_started', index, name: c.name }));
  steps.push({ type: 'tool_calls', calls });
  steps.push({ type: 'usage', input: 1, output: 1 }, { type: 'done' });
  return steps;
}

/** One fenced tool block. */
export const block = (tool: string, args: unknown): string =>
  '```spycore:tool\n' + JSON.stringify({ tool, args }) + '\n```';

/** A temp directory under the OS temp root, returned by its real path. */
export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function removeDir(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Replace every spelling of each directory with a placeholder, so a captured
 * value carries no machine path. The real path and the path as the OS temp
 * root spells it can differ (a symlinked temp root); both are replaced, the
 * longer first, so neither leaves a fragment of the other behind.
 */
export function scrubPaths<T>(value: T, dirs: Record<string, string>): T {
  const spellings: Array<[string, string]> = [];
  for (const [label, dir] of Object.entries(dirs)) {
    spellings.push([dir, label]);
    const viaTmp = dir.replace(/^\/private\//, '/');
    if (viaTmp !== dir) spellings.push([viaTmp, label]);
  }
  return scrubText(value, spellings);
}

/** Replace each `[from, to]` text everywhere inside `value`, longest `from` first. */
export function scrubText<T>(value: T, replacements: Array<[string, string]>): T {
  const ordered = [...replacements].sort((a, b) => b[0].length - a[0].length);
  let text = JSON.stringify(value);
  for (const [from, to] of ordered) text = text.split(JSON.stringify(from).slice(1, -1)).join(to);
  return JSON.parse(text) as T;
}

/**
 * The engine's own `JSON.parse` message for `text`. Its wording differs across
 * Node versions, so a golden stores a placeholder in its place and only the
 * text the loop wraps around it is compared byte for byte.
 */
export function engineJsonError(text: string): string {
  try {
    JSON.parse(text);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error(`expected invalid JSON: ${text}`);
}

/** A per-run extra tool (the shape the MCP bridge registers), with externally validated args. */
export function extraTool(
  name: string,
  execute: ToolDefinition['execute'],
  opts: { mutating?: boolean; description?: string } = {},
): ToolDefinition {
  return {
    name,
    description: opts.description ?? `pin tool ${name}`,
    parameters: { type: 'object', properties: {} },
    mutating: opts.mutating === true,
    externalArgs: true,
    execute,
  };
}

/** A bridge as `setupMcpBridge` returns it, counting its shutdowns. */
export interface FakeBridge extends McpBridge {
  shutdowns: number;
}

export function fakeBridge(tools: ToolDefinition[], serverCount = 1): FakeBridge {
  const bridge: FakeBridge = {
    tools: new Map(tools.map((t) => [t.name, t])),
    promptSection: '',
    warnings: [],
    serverCount,
    toolCount: tools.length,
    serverPids: [],
    shutdowns: 0,
    shutdown: () => {
      bridge.shutdowns += 1;
      return Promise.resolve();
    },
  };
  return bridge;
}

/** A promise with its resolver exposed. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
