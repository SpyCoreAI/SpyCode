/**
 * Provider abstraction at the agent's model-call seam.
 *
 * The whole agent engine — tools, diff/approval, plan, self-verify, budget,
 * checkpoint/rewind — is provider-agnostic. Only the model call itself differs
 * between running against the SpyCore backend (the default) and the user's own
 * OpenAI-compatible endpoint (BYOK). A `Provider` encapsulates exactly that
 * seam: open a session, then stream one assistant turn at a time.
 *
 * The loop hands the provider one turn's input message plus the session handle;
 * what the provider does with prior history is its own concern — SpyCore keeps
 * it server-side (and only ever sends the new message), the OpenAI-compatible
 * provider accumulates it client-side. That keeps the loop identical for every
 * provider and keeps the SpyCore path byte-for-byte unchanged.
 */

/** A tool declared to the model for NATIVE tool-use (provider-wire shape). */
export interface ToolDecl {
  name: string;
  description?: string | undefined;
  /** JSON Schema object describing the tool's arguments. */
  parameters: Record<string, unknown>;
}

/** A tool result fed back on a NATIVE continuation turn. */
export interface ToolResultDecl {
  id: string;
  name?: string | undefined;
  content: string;
}

/** A fully-assembled tool call the model emitted (native mode); arguments is JSON text. */
export interface ProviderToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** A single assistant-turn event, mirroring exactly what the loop consumes. */
export type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'usage'; input: number; output: number }
  | { type: 'done' }
  | { type: 'error'; message: string }
  /**
   * OPTIONAL + informational: server-side skills the backend activated for
   * this turn. Only the SpyCore provider emits it (mapped from its
   * `skills_activated` SSE event); BYOK adapters never do. The loop surfaces
   * it to the UI and otherwise ignores it.
   */
  | { type: 'skills'; skills: string[] }
  /** NATIVE tool-use: the model named a tool (streamed) — an early UI affordance. */
  | { type: 'tool_call_started'; index: number; name: string }
  /** NATIVE tool-use: the fully-assembled tool calls for this turn. */
  | { type: 'tool_calls'; calls: ProviderToolCall[] };

/**
 * One chat message in the client-side history a stateless BYOK adapter keeps.
 * The agent system prompt travels separately (`StreamChatParams.system`):
 * adapters whose API has a native top-level system slot (Anthropic `system`,
 * Google `systemInstruction`) place it there; the SpyCore and OpenAI-compatible
 * adapters fold it back into the first user message — reproducing the exact
 * concatenated bytes those wires carried before the seam split it out.
 */
export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Inputs to open a session. */
export interface CreateConversationParams {
  /** Wire model id — a SpyCore slug ('charon') or a BYOK model id ('gpt-4o'). */
  model: string;
  /** SpyCore `--api-url` override (SpyCore-only; the BYOK provider ignores it). */
  apiUrlOverride?: string | undefined;
}

/** Inputs to stream one assistant turn — mirrors today's `streamTurn` arguments. */
export interface StreamChatParams {
  /** Session handle from `createConversation` (SpyCore conversation id / BYOK-local id). */
  conversationId: string;
  /** This turn's new input (the task on turn 1, tool results after). */
  message: string;
  /**
   * The agent system prompt — set ONLY on the first turn of a fresh
   * conversation. Stateless adapters must remember it per session and resend
   * it on every request (their APIs carry no server-side state).
   */
  system?: string | undefined;
  /** Wire model id — a SpyCore slug or a BYOK model id. */
  model: string;
  apiUrlOverride?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Polled while text streams; when it returns true, stop consuming (time-budget cut). */
  shouldStop?: (() => boolean) | undefined;
  /** NATIVE tool-use: the tools the model may call this turn (re-sent every turn). */
  tools?: ToolDecl[] | undefined;
  /** NATIVE tool-use: results answering the prior turn's tool_calls. When set,
   *  this is a continuation turn and `message` is empty (omitted on the wire). */
  toolResults?: ToolResultDecl[] | undefined;
}

/** The model-call seam. The prompt-loop (and self-verify, via it) call through this. */
export interface Provider {
  /** Stable id; SpyCore-specific branches (triage, plan-clamp) key off this. */
  readonly id: 'spycore' | 'openai' | 'anthropic' | 'google';
  /** Open a session and return its handle. */
  createConversation(params: CreateConversationParams): Promise<string>;
  /** Stream one assistant turn as an ordered `ProviderEvent` sequence. */
  streamChat(params: StreamChatParams): AsyncIterable<ProviderEvent>;
  /**
   * Whether the server backing `conversationId` advertised native tool-use
   * (captured at createConversation time). Optional — only the SpyCore provider
   * implements it; BYOK adapters omit it and the loop treats them as fenced.
   */
  supportsNativeTools?(conversationId: string): boolean;
}
