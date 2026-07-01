/**
 * Shared model metadata for the chat surface. Single source of truth so the
 * `chat` command and the interactive Ink session agree on slugs, display names
 * and validation. SpyCore brand names only — never upstream provider names.
 *
 * STYX_MAX is a full chat model: a recognised slug AND part of CHAT_MODELS — the
 * advertised, selectable chat list — now that the server enables it on every paid
 * plan (ENABLE_STYX_MAX). The CLI never gates entitlement locally; it offers the
 * model and lets the server enforce plan access (a non-entitled plan is rejected
 * server-side, the same way it already is for the other paid models). The server
 * maps STYX_MAX → STYX when it persists a conversation, so the stored/returned
 * brand label is STYX — STYX_MAX is a send-time selection, not a wire value.
 * HEPHAESTUS, by contrast, is a valid slug kept OUT of CHAT_MODELS so
 * `chat -m hephaestus` can be redirected to `spycore image` — it is image-only.
 */
import { getConfigStore } from './config.js';
import { EXIT_USER_ERROR, SpycoreCliError } from './errors.js';

export const ALLOWED_MODELS = ['hermes', 'minos', 'styx', 'styx_max', 'charon', 'hephaestus'] as const;
export type ModelSlug = (typeof ALLOWED_MODELS)[number];

/** Text-chat models advertised + selectable in chat. */
export const CHAT_MODELS = ['hermes', 'minos', 'styx', 'styx_max', 'charon'] as const;
export type ChatModelSlug = (typeof CHAT_MODELS)[number];

export const MODEL_DISPLAY: Record<ModelSlug, string> = {
  hermes: 'Hermes',
  minos: 'Minos',
  styx: 'Styx',
  styx_max: 'Styx Max',
  charon: 'Charon',
  hephaestus: 'Hephaestus',
};

export function isModelSlug(value: string): value is ModelSlug {
  return (ALLOWED_MODELS as readonly string[]).includes(value);
}

/**
 * Resolve a model slug from explicit input, falling back to the configured
 * default and then `hermes`. Throws a friendly SpycoreCliError on an
 * unrecognised slug (lists the valid chat models).
 */
export function resolveModelSlug(input: string | undefined): ModelSlug {
  const raw =
    (input && input.trim().length > 0
      ? input.trim()
      : getConfigStore().get('defaultModel')) || 'hermes';
  const slug = raw.toLowerCase();
  if (!isModelSlug(slug)) {
    throw new SpycoreCliError(
      `Unknown model: ${raw}`,
      EXIT_USER_ERROR,
      `Allowed: ${CHAT_MODELS.join(', ')}`,
    );
  }
  return slug;
}
