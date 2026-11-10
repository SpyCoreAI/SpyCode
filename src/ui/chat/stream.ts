/**
 * Bridge the existing SSE streaming layer to React callbacks for the Ink chat
 * session. The event vocabulary + error→hint mapping are lifted verbatim from
 * the original `chat` command - only the destination changes (callbacks that
 * drive Ink state instead of writes to stdout/stderr).
 */
import { streamRequest } from '../../lib/api.js';
import { ROUTED_EVENT_TYPE } from '../../lib/chat-events.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../../lib/errors.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
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
  /** Uploaded image FILE IDs - the web's existing `attachments` stream field. */
  attachments?: string[] | undefined;
}

/**
 * F-2c-30 - THE STATE BOUNDARY FOR THE WHOLE SSE FAMILY.
 *
 * SECURITY.md ships this sentence: *"**All** untrusted strings … pass through a
 * single sanitizer … before reaching the terminal."* It was not true. Counted
 * from this dispatcher rather than from the filed number: it lifts **12** values
 * off the server payload, **9 of them strings**; 7 reach a rendering surface;
 * and only 2 of those 7 were sanitized - `title` (at ChatApp's state boundary)
 * and `content` (at MessageView's render site). The other five -
 * `skills_activated.skills[]`, the routed `resolvedModel`, and `auto_switched`'s
 * `from` / `to` / `reason` - reached the TUI raw, two of them onto the
 * re-emitted-every-frame status line.
 *
 * THE PROMISE IS NOT WEAKENED TO MATCH THE CODE; THE CODE IS RAISED TO MATCH
 * THE PROMISE. That rule has decided four items in this arc.
 *
 * HERE, not at the render sites, and not per-consumer in `ChatApp`: this is
 * the ONE place a server-authored string becomes a handler argument, so every
 * consumer is covered including any added later - the same argument the `title`
 * fix made, applied to the whole family instead of to one field. It is the same
 * `sanitizeForDisplay`, not a second sanitizer beside it; the function is
 * idempotent, so the two sites that already clean their value stay correct.
 *
 * NOT SANITIZED HERE, deliberately and by measurement: `count`, `input` and
 * `output` are numbers and cannot carry an escape, and `finish_reason.reason`
 * is compared against a literal and never rendered. `content` IS sanitized here
 * even though MessageView cleans it again - a display-bound string with one
 * cleaning site is one edit away from having none.
 */
const clean = (v: unknown): string => sanitizeForDisplay(String(v ?? ''));

export async function streamAssistant(params: StreamParams, h: StreamHandlers): Promise<void> {
  for await (const event of streamRequest(
    '/api/chat/stream',
    {
      conversationId: params.conversationId,
      message: params.message,
      model: params.model.toUpperCase(),
      // Graduated reasoning effort (already clamped). 'auto' is wire-identical
      // to omitting it - the backend defaults to 'auto'.
      effort: params.effort,
      // Image FILE IDs (the web's field); omitted when empty so the wire stays
      // byte-identical for attachment-free sends.
      ...(params.attachments && params.attachments.length > 0
        ? { attachments: params.attachments }
        : {}),
    },
    { apiUrlOverride: params.apiUrl, signal: params.signal },
  )) {
    if (typeof event.data !== 'object' || event.data === null) continue;
    const payload = event.data as { type?: string } & Record<string, unknown>;

    switch (payload.type) {
      case 'text':
        h.onText(clean(payload.content));
        break;
      case 'thinking':
        h.onThinking();
        break;
      case 'skills_activated': {
        const skills = Array.isArray(payload.skills)
          ? (payload.skills as unknown[]).filter((s): s is string => typeof s === 'string').map(clean)
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
      case ROUTED_EVENT_TYPE: {
        const resolved = clean(payload.resolvedModel).toUpperCase();
        if (resolved) h.onRouted(resolved);
        break;
      }
      case 'auto_switched':
        h.onAutoSwitch(clean(payload.from), clean(payload.to), clean(payload.reason));
        break;
      case 'memory_created':
        h.onMemory();
        break;
      case 'usage':
        h.onUsage(Number(payload.input ?? 0), Number(payload.output ?? 0));
        break;
      case 'title':
        h.onTitle(clean(payload.content));
        break;
      case 'finish_reason':
        h.onFinishReason(String(payload.reason ?? ''));
        break;
      case 'error': {
        const message = clean(payload.message) || 'Unknown error';
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
