/**
 * Bridge the existing SSE streaming layer to React callbacks for the Ink chat
 * session. The event vocabulary + error→hint mapping are lifted verbatim from
 * the original `chat` command — only the destination changes (callbacks that
 * drive Ink state instead of writes to stdout/stderr).
 */
import { streamRequest } from '../../lib/api.js';
import { ROUTED_EVENT_WIRE } from '../../lib/chat-events.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../../lib/errors.js';
import type { ModelSlug } from '../../lib/models.js';
import type { EffortLevel } from '../../lib/effort.js';

export type SearchState = 'started' | 'completed' | 'failed';

export interface StreamHandlers {
  onText(chunk: string): void;
  onThinking(): void;
  onSkills(skills: string[]): void;
  onSearch(state: SearchState, count?: number): void;
  onRouted(model: string): void;
  onAutoSwitch(from: string, to: string, reason: string): void;
  onMemory(): void;
  onUsage(input: number, output: number): void;
  onTitle(title: string): void;
  onFinishReason(reason: string): void;
}

export interface StreamParams {
  conversationId: string;
  message: string;
  model: ModelSlug;
  /** Reasoning effort, already clamped to the model's supported set. */
  effort: EffortLevel;
  apiUrl: string | undefined;
  signal: AbortSignal;
}

export async function streamAssistant(params: StreamParams, h: StreamHandlers): Promise<void> {
  for await (const event of streamRequest(
    '/api/chat/stream',
    {
      conversationId: params.conversationId,
      message: params.message,
      model: params.model.toUpperCase(),
      // Graduated reasoning effort (already clamped). 'auto' is wire-identical
      // to omitting it — the backend defaults to 'auto'.
      effort: params.effort,
    },
    { apiUrlOverride: params.apiUrl, signal: params.signal },
  )) {
    if (typeof event.data !== 'object' || event.data === null) continue;
    const payload = event.data as { type?: string } & Record<string, unknown>;

    switch (payload.type) {
      case 'text':
        h.onText(String(payload.content ?? ''));
        break;
      case 'thinking':
        h.onThinking();
        break;
      case 'skills_activated': {
        const skills = Array.isArray(payload.skills)
          ? (payload.skills as unknown[]).filter((s): s is string => typeof s === 'string')
          : [];
        if (skills.length > 0) h.onSkills(skills);
        break;
      }
      case 'search_started':
        h.onSearch('started');
        break;
      case 'search_completed':
        h.onSearch('completed', Number(payload.count ?? 0));
        break;
      case 'search_failed':
        h.onSearch('failed');
        break;
      case ROUTED_EVENT_WIRE: {
        const resolved = String(payload.resolvedModel ?? '').toUpperCase();
        if (resolved) h.onRouted(resolved);
        break;
      }
      case 'auto_switched':
        h.onAutoSwitch(
          String(payload.from ?? ''),
          String(payload.to ?? ''),
          String(payload.reason ?? ''),
        );
        break;
      case 'memory_created':
        h.onMemory();
        break;
      case 'usage':
        h.onUsage(Number(payload.input ?? 0), Number(payload.output ?? 0));
        break;
      case 'title':
        h.onTitle(String(payload.content ?? ''));
        break;
      case 'finish_reason':
        h.onFinishReason(String(payload.reason ?? ''));
        break;
      case 'error': {
        const message = String(payload.message ?? 'Unknown error');
        const lower = message.toLowerCase();
        if (lower.includes('plan') || lower.includes('upgrade')) {
          throw new SpycoreCliError(
            `Stream error: ${message}`,
            EXIT_USER_ERROR,
            'Upgrade at https://spycore.ai/pricing.',
          );
        }
        if (lower.includes('quota') || lower.includes('limit')) {
          throw new SpycoreCliError(
            `Stream error: ${message}`,
            EXIT_USER_ERROR,
            'See your usage at https://spycore.ai/usage.',
          );
        }
        throw new SpycoreCliError(`Stream error: ${message}`);
      }
      case 'done':
        return;
      default:
        break;
    }
  }
}
