import { Command, Option } from 'commander';
import { api } from '../lib/api.js';
import { formatOption, json, print, resolveFormat, writeFormatted } from '../lib/output.js';
import { MODEL_DISPLAY, isModelSlug } from '../lib/models.js';

/**
 * `spycore usage` — a one-screen quota view over GET /api/usage.
 *
 * The response (server: routes/user/index.ts + services/usage.service.ts
 * getUsageSnapshot) carries plan + planDisplay, the two enforced buckets
 * (allModels = the four chat models pooled; hephaestus = images) for BOTH the
 * 5-hour rolling window and the rolling 7-day window, a weekly messages/images
 * totals split, and an informational per-model credit breakdown. Every field is
 * optional here so shape drift degrades to omitted sections, never a crash.
 *
 * Identity-safe: only SpyCore model display names are ever rendered — the
 * UPPERCASE enum keys from the API are mapped through MODEL_DISPLAY.
 */

interface BucketBlock {
  used: number;
  limit: number;
  resetAt?: string | null;
}

interface UsageResp {
  plan?: string;
  /** Marketing display name ('Pro', 'Max 5×', …) — preferred over `plan`. */
  planDisplay?: string;
  /** Human-facing weekly reset (next Monday 00:00 UTC). */
  resetsOn?: string | null;
  allModels?: { fiveHour?: BucketBlock; weekly?: BucketBlock };
  hephaestus?: { fiveHour?: BucketBlock; weekly?: BucketBlock };
  /** Informational per-model CREDIT usage (images for Hephaestus). */
  perModel?: Record<string, { fiveHour?: number; weekly?: number }>;
  weekly?: {
    totals?: {
      messagesUsed?: number;
      messagesLimit?: number;
      imagesUsed?: number;
      imagesLimit?: number;
    };
  };
}

const BAR_WIDTH = 24;

function bar(used: number, limit: number): string {
  if (!Number.isFinite(limit) || limit <= 0) return '─'.repeat(BAR_WIDTH);
  const pct = Math.max(0, Math.min(1, used / limit));
  const filled = Math.floor(pct * BAR_WIDTH);
  return '█'.repeat(filled).padEnd(BAR_WIDTH, '░');
}

function pct(used: number, limit: number): string {
  if (!Number.isFinite(limit) || limit <= 0) return '∞';
  const v = Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
  return `${v}%`;
}

/** "in 2h 5m" / "in 3d" relative formatting for a reset timestamp. */
function relReset(iso: string | null | undefined): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '';
  const diffSec = Math.floor((ts - Date.now()) / 1000);
  if (diffSec <= 0) return 'now';
  if (diffSec < 60) return `in ${diffSec}s`;
  if (diffSec < 3600) return `in ${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) {
    const h = Math.floor(diffSec / 3600);
    const m = Math.floor((diffSec % 3600) / 60);
    return m > 0 ? `in ${h}h ${m}m` : `in ${h}h`;
  }
  return `in ${Math.floor(diffSec / 86400)}d`;
}

/** One `label` + `bar  used / limit (pct)  · resets <rel>` pair for a bucket. */
function renderBucket(label: string, b: BucketBlock | undefined): string[] {
  if (!b || typeof b.used !== 'number') return [];
  const used = b.used ?? 0;
  const limit = b.limit ?? 0;
  const reset = relReset(b.resetAt);
  const tail = reset ? `  · resets ${reset}` : '';
  return [label, `  ${bar(used, limit)}  ${used} / ${limit} (${pct(used, limit)})${tail}`];
}

/** API enum key ('HERMES') → SpyCore display name ('Hermes'). Unknown keys pass as-is. */
function displayName(key: string): string {
  const lower = key.toLowerCase();
  return isModelSlug(lower) ? MODEL_DISPLAY[lower] : key;
}

export function registerUsageCommand(program: Command): void {
  program
    .command('usage')
    .description('Show your message and image quota (5-hour window, weekly cap, per-model)')
    .addOption(new Option('--week', 'Only print the weekly cap'))
    .addOption(new Option('--rolling', 'Only print the 5-hour rolling window'))
    .addOption(formatOption())
    .action(async (opts: { week?: boolean; rolling?: boolean; format?: string }, cmd: Command) => {
      const root = cmd.parent;
      const parentOpts = root?.opts<{ apiUrl?: string; json?: boolean }>() ?? {};

      const data = await api.get<UsageResp>('/api/usage', {
        apiUrlOverride: parentOpts.apiUrl,
      });

      const fmt = resolveFormat(opts.format);
      if (fmt === 'json') {
        json(data);
        return;
      }
      if (fmt !== 'text') {
        writeFormatted(data, fmt);
        return;
      }

      const showRolling = !opts.week;
      const showWeekly = !opts.rolling;
      const lines: string[] = [];

      // Plan line: display name preferred; the raw enum rides along when the
      // two differ so support conversations have the exact tier.
      const planLabel = data.planDisplay || data.plan;
      if (planLabel) {
        const rawTail =
          data.plan && data.planDisplay && data.plan.toLowerCase() !== data.planDisplay.toLowerCase()
            ? `  (${data.plan})`
            : '';
        lines.push(`Plan: ${planLabel}${rawTail}`);
        lines.push('');
      }

      if (showRolling) {
        const block = renderBucket('5-hour window (all chat models)', data.allModels?.fiveHour);
        if (block.length > 0) lines.push(...block, '');
      }
      if (showWeekly) {
        const weekly = data.allModels?.weekly;
        // The bucket's resetAt is the rolling-window edge; resetsOn (next
        // Monday) is the human-facing date the dashboard shows — prefer it.
        const block = renderBucket(
          'Weekly cap (all chat models)',
          weekly ? { ...weekly, resetAt: data.resetsOn ?? weekly.resetAt } : undefined,
        );
        if (block.length > 0) {
          lines.push(...block);
          const t = data.weekly?.totals;
          if (t && (typeof t.messagesUsed === 'number' || typeof t.imagesUsed === 'number')) {
            const parts: string[] = [];
            if (typeof t.messagesUsed === 'number') {
              parts.push(`messages ${t.messagesUsed}/${t.messagesLimit ?? '∞'}`);
            }
            if (typeof t.imagesUsed === 'number') {
              parts.push(`images ${t.imagesUsed}/${t.imagesLimit ?? '∞'}`);
            }
            if (parts.length > 0) lines.push(`  This week: ${parts.join(' · ')}`);
          }
          lines.push('');
        }
      }

      // Image bucket (Hephaestus) — separately metered.
      if (showRolling) {
        const block = renderBucket('Images (5-hour)', data.hephaestus?.fiveHour);
        if (block.length > 0) lines.push(...block, '');
      }
      if (showWeekly) {
        const block = renderBucket('Images (weekly)', data.hephaestus?.weekly);
        if (block.length > 0) lines.push(...block, '');
      }

      // Per-model break-out — informational (credit-weighted; image count for
      // the image model), does not gate quota the way the bucket totals do.
      const perModel = data.perModel ?? {};
      const keys = Object.keys(perModel);
      if (keys.length > 0 && !opts.week && !opts.rolling) {
        lines.push('Per-model usage (credits)');
        const rows = keys.map((k) => ({
          name: displayName(k),
          five: String(perModel[k]?.fiveHour ?? 0),
          week: String(perModel[k]?.weekly ?? 0),
        }));
        const nameCol = Math.max('Model'.length, ...rows.map((r) => r.name.length));
        const fiveCol = Math.max('5h'.length, ...rows.map((r) => r.five.length));
        lines.push(`${'Model'.padEnd(nameCol)}  ${'5h'.padEnd(fiveCol)}  Weekly`);
        lines.push('-'.repeat(nameCol + fiveCol + 10));
        for (const r of rows) {
          lines.push(`${r.name.padEnd(nameCol)}  ${r.five.padEnd(fiveCol)}  ${r.week}`);
        }
      }

      // Trim a trailing blank so the view ends tight.
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      for (const line of lines) print(line);
    });
}
