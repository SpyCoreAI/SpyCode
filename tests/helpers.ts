import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { AgentEvent } from '../src/lib/agent/loop.js';
import type { ApprovalRequest } from '../src/lib/agent/approval.js';
import type { ChatAgentIo } from '../src/lib/chat-agent-run.js';
import type { CommitFlowIo } from '../src/lib/slash/commit-flow.js';
import type { CompactFlowIo } from '../src/lib/slash/compact-flow.js';

/**
 * Each suite gets its own conf cwd so test runs don't trample each
 * other's config files. Sets SPYCORE_TEST_CWD before importing config.ts
 * - config.ts honours this when constructing the singleton.
 */
export function freshConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spycli-test-'));
  process.env.SPYCORE_TEST_CWD = dir;
  return dir;
}

// ── mock HTTP responder (undici) ──────────────────────────────────────────
// One shared responder harness: conversation create + scripted chat turns.
// Three copies of this drifted across agent.test.ts, auto-compact.test.ts
// and command-rules.test.ts (same /conversations + /api/chat/stream
// routing, differing only in the conversation id and the turn source), so
// a harness fix in one file never reached the others.

/** The undici-mock response shape every suite builds by hand. */
export interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: {
    json: () => Promise<unknown>;
    [Symbol.asyncIterator]?: () => AsyncIterator<Buffer>;
  };
}

export function jsonResp(status: number, body: unknown): MockResp {
  return { statusCode: status, headers: {}, body: { json: async () => body } };
}

/**
 * True only when the URL's host is exactly r2.example.com. A substring
 * check (`url.includes('r2.example.com')`) would also match lookalike
 * hosts such as r2.example.com.evil.test or notr2.example.com, so mock
 * fetch handlers must route on this, never on a substring.
 */
export function isR2Url(url: string): boolean {
  try {
    return new URL(url).hostname === 'r2.example.com';
  } catch {
    return false;
  }
}

export function sseResp(events: Array<Record<string, unknown>>): MockResp {
  const buf = Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: {
      json: async () => ({}),
      [Symbol.asyncIterator]: () => Readable.from([buf])[Symbol.asyncIterator](),
    },
  };
}

/** Each scripted reply becomes one /api/chat/stream turn (text + done). */
export function modelTurns(replies: string[]): () => MockResp {
  let i = 0;
  return () => {
    const reply = replies[i] ?? 'Done.';
    i += 1;
    return sseResp([{ type: 'text', content: reply }, { type: 'done' }]);
  };
}

/**
 * Build the standard responder: conversation create + scripted chat turns.
 *
 * `turns` is one of:
 * - a thunk (usually `modelTurns([...])`) - called fresh every turn;
 * - an array of `MockResp` - served in order, clamped at the last one;
 * - an array of reply strings - each becomes one text+done turn, clamped
 *   at 'Done.' once exhausted.
 * `conversationId` is the id the fake conversation-create returns;
 * `onChat` fires on every chat-turn call (lets a test count turns).
 */
export function makeResponder(
  turns: MockResp[] | (() => MockResp) | string[],
  conversationId = 'cnv_test',
  onChat?: () => void,
): (url: string, init: { method: string }) => MockResp {
  let i = 0;
  const next = (): MockResp => {
    if (typeof turns === 'function') return turns();
    const list = turns as Array<MockResp | string>;
    if (list.length === 0) return sseResp([{ type: 'text', content: 'Done.' }, { type: 'done' }]);
    if (typeof list[0] === 'string') {
      const replies = list as string[];
      const reply = replies[i] ?? 'Done.';
      i += 1;
      return sseResp([{ type: 'text', content: reply }, { type: 'done' }]);
    }
    const respTurns = list as MockResp[];
    return respTurns[Math.min(i++, respTurns.length - 1)]!;
  };
  return (url: string, init: { method: string }) => {
    if (init.method === 'POST' && url.endsWith('/conversations')) {
      return jsonResp(200, { success: true, data: { id: conversationId } });
    }
    if (init.method === 'POST' && url.includes('/api/chat/stream')) {
      onChat?.();
      return next();
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  };
}

// ── ChatAgentIo harness ───────────────────────────────────────────────────
// One harness for the chat-agent surfaces: chat-modes.test.ts used the
// bare form (ask → 'c', readText → '') and plan-edit.test.ts the extended
// form (queued ask/readText answers + a questions log). They are the same
// harness - the extended form is a superset, so both suites share it.

/** One recorded notice: the kind + text every harness collects. */
export interface NoticeRecord {
  kind: string;
  text: string;
}

export interface ChatIoHarness {
  notices: NoticeRecord[];
  events: AgentEvent[];
  plans: string[];
  approvals: ApprovalRequest[];
  questions: string[];
  io: ChatAgentIo;
}

/**
 * A ChatAgentIo that records everything instead of rendering: notices,
 * loop events, presented plans, approval requests, asked questions.
 * `opts.asks` / `opts.texts` queue answers for ask() / readText();
 * `overrides` replaces any io method (e.g. an accepting requestApproval).
 */
export function fakeChatIo(
  opts: { asks?: string[]; texts?: string[] } = {},
  overrides: Partial<ChatAgentIo> = {},
): ChatIoHarness {
  const notices: NoticeRecord[] = [];
  const events: AgentEvent[] = [];
  const plans: string[] = [];
  const approvals: ApprovalRequest[] = [];
  const questions: string[] = [];
  const asks = [...(opts.asks ?? [])];
  const texts = [...(opts.texts ?? [])];
  return {
    notices,
    events,
    plans,
    approvals,
    questions,
    io: {
      notify: (kind, text) => void notices.push({ kind, text }),
      renderEvent: (e) => void events.push(e),
      presentPlan: (p) => void plans.push(p),
      ask: async (q) => {
        questions.push(q);
        return asks.shift() ?? 'c';
      },
      readText: async () => texts.shift() ?? '',
      requestApproval: async (req) => {
        approvals.push(req);
        return 'reject';
      },
      ...overrides,
    },
  };
}

// ── slash-flow io harnesses ───────────────────────────────────────────────
// commit-slash and compact-command drive different io contracts
// (CommitFlowIo vs CompactFlowIo), so they keep separate harnesses -
// shared here so the shape lives in one place, not one per suite.

export interface CommitIoHarness {
  notices: NoticeRecord[];
  presented: string[];
  io: CommitFlowIo;
}

/** Queued one-line answers + full-text replacements for runCommitFlow. */
export function fakeCommitIo(answers: string[], texts: string[] = []): CommitIoHarness {
  const notices: NoticeRecord[] = [];
  const presented: string[] = [];
  return {
    notices,
    presented,
    io: {
      notify: (kind, text) => void notices.push({ kind, text }),
      present: (text) => void presented.push(text),
      ask: async () => answers.shift() ?? 'c',
      readText: async () => texts.shift() ?? '',
    },
  };
}

export interface AskIoHarness {
  notices: NoticeRecord[];
  asked: string[];
  io: CompactFlowIo;
}

/** A single canned answer for the /compact confirm question. */
export function fakeAskIo(answer: string): AskIoHarness {
  const notices: NoticeRecord[] = [];
  const asked: string[] = [];
  return {
    notices,
    asked,
    io: {
      notify: (kind, text) => void notices.push({ kind, text }),
      ask: async (q) => {
        asked.push(q);
        return answer;
      },
    },
  };
}
