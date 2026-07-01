/**
 * SpyCoreProvider — the DEFAULT provider. Wraps the existing SpyCore backend
 * call behind the `Provider` interface with ZERO behaviour change: it creates a
 * server-side conversation, then streams each turn from `/api/chat/stream` with
 * the Bearer spycore token (attached by `streamRequest`), the uppercase model
 * enum, and the exact same SSE event handling + error semantics as before.
 *
 * The backend supplies skills / memory / search / quota + identity protection;
 * none of that changes. The server is stateful, so each turn sends ONLY the new
 * message + the conversation id — the prior history lives server-side.
 */
import { api, streamRequest, type StreamEvent } from '../api.js';
import type {
  CreateConversationParams,
  Provider,
  ProviderEvent,
  ProviderToolCall,
  StreamChatParams,
} from './types.js';

interface ConversationCreateResp {
  id: string;
  /** Server capability advertisement (slice-1 servers and later). Absent on
   *  older servers → native tool-use stays off (fenced). */
  capabilities?: { nativeTools?: boolean };
}

export class SpyCoreProvider implements Provider {
  readonly id = 'spycore' as const;
  /** nativeTools capability per conversation id, captured at createConversation. */
  private readonly nativeToolsByConversation = new Map<string, boolean>();

  async createConversation(params: CreateConversationParams): Promise<string> {
    const resp = await api.post<ConversationCreateResp>('/conversations', {
      apiUrlOverride: params.apiUrlOverride,
      body: { model: params.model.toUpperCase() },
    });
    this.nativeToolsByConversation.set(resp.id, resp.capabilities?.nativeTools === true);
    return resp.id;
  }

  supportsNativeTools(conversationId: string): boolean {
    return this.nativeToolsByConversation.get(conversationId) === true;
  }

  async *streamChat(params: StreamChatParams): AsyncIterable<ProviderEvent> {
    // The system prompt is folded back into the message — `${system}\n\n${message}`
    // is exactly the concatenation the loop sent before the seam carried
    // `system` separately, so this wire stays byte-for-byte identical.
    const message =
      params.system && params.system.length > 0
        ? `${params.system}\n\n${params.message}`
        : params.message;
    const isToolContinuation = !!(params.toolResults && params.toolResults.length > 0);
    // Body is byte-identical to before when no tool fields are present. On a
    // tool-result continuation we OMIT `message` entirely (the server requires
    // exactly one of message|toolResults, and rejects an empty message string).
    const body: Record<string, unknown> = {
      conversationId: params.conversationId,
      model: params.model.toUpperCase(),
    };
    if (isToolContinuation) body.toolResults = params.toolResults;
    else body.message = message;
    if (params.tools && params.tools.length > 0) body.tools = params.tools;
    for await (const event of streamRequest(
      '/api/chat/stream',
      body,
      { apiUrlOverride: params.apiUrlOverride, signal: params.signal },
    )) {
      const data = (event as StreamEvent).data as
        | (Record<string, unknown> & { type?: string })
        | undefined;
      if (!data || typeof data !== 'object') continue;
      if (data.type === 'text' && typeof data.content === 'string') {
        yield { type: 'text', text: data.content };
        // Mirror the old streamTurn: poll the (time) budget after each chunk
        // and stop consuming when it trips, returning the partial text.
        if (params.shouldStop?.()) return;
      } else if (data.type === 'tool_call_started') {
        if (typeof data.index === 'number' && typeof data.name === 'string') {
          yield { type: 'tool_call_started', index: data.index, name: data.name };
        }
      } else if (data.type === 'tool_calls') {
        const raw = Array.isArray(data.calls) ? data.calls : [];
        const calls: ProviderToolCall[] = [];
        for (const c of raw) {
          if (c && typeof c === 'object') {
            const o = c as Record<string, unknown>;
            if (typeof o.id === 'string' && typeof o.name === 'string') {
              calls.push({ id: o.id, name: o.name, arguments: typeof o.arguments === 'string' ? o.arguments : '{}' });
            }
          }
        }
        if (calls.length > 0) yield { type: 'tool_calls', calls };
      } else if (data.type === 'usage') {
        yield {
          type: 'usage',
          input: Number(data.input ?? 0) || 0,
          output: Number(data.output ?? 0) || 0,
        };
      } else if (data.type === 'skills_activated') {
        // Server-side skill routing fired — surface the names (informational).
        const skills = Array.isArray(data.skills)
          ? data.skills.filter((s): s is string => typeof s === 'string' && s.length > 0)
          : [];
        if (skills.length > 0) yield { type: 'skills', skills };
      } else if (data.type === 'error') {
        yield { type: 'error', message: String(data.message ?? 'Agent reasoning failed') };
        return;
      } else if (data.type === 'done') {
        yield { type: 'done' };
        return;
      }
    }
  }
}
