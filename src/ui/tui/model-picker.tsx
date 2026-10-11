/**
 * 2D model picker (Wave 3-D, F15): Provider × Model in one picker.
 * Vertical axis = model, horizontal axis = provider (the ←/→ rail from the
 * picker grammar). Presentational - the owner (TuiApp) holds the provider
 * index, the model index, and the keys, exactly like `CommandPalette` in
 * `palette.tsx`. Confirming a choice is a mid-session model switch: the owner
 * applies the (provider, model) pair to its run resolution.
 *
 * List rendering follows the shared picker grammar (`picker-grammar.tsx`):
 * full-width accent selected row, ↑/↓ scroll rail, fixed-height list, plus
 * the grammar's `horizontal` prop for the provider rail.
 */
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme/theme.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import {
  computePickerViewport,
  PickerList,
  type PickerHorizontalScroll,
  type PickerRow,
} from './picker-grammar.js';
import { CHAT_MODELS, MODEL_DISPLAY } from '../../lib/models.js';
import type { StoredProviderConfig } from '../../lib/providers/byok-config.js';

/** One horizontal-rail entry: the SpyCore backend or a stored BYOK provider. */
export interface ModelPickerProvider {
  /** 'spycore' or the stored BYOK provider's name. */
  id: string;
  label: string;
  kind: 'spycore' | 'byok';
  /** The provider's configured model (BYOK only); null when unset. */
  model?: string | null;
}

export interface ModelPickerProps {
  /** Horizontal axis, in rail order. */
  providers: readonly ModelPickerProvider[];
  /** Index into `providers` (the ←/→ axis). */
  providerIndex: number;
  /** Vertical axis: model rows for the CURRENT provider (see `modelsForProvider`). */
  models: readonly PickerRow[];
  /** Index into the FULL model list (the viewport scrolls to it). */
  modelIndex: number;
  width: number;
}

const MAX_ROWS = 6;

/**
 * The horizontal rail: the SpyCore backend first, then the user's stored
 * BYOK providers in config order. Provider names are user-controlled
 * (`spycore provider add --name`), so labels pass through the display
 * sanitizer. Pure: unit-testable without Ink.
 */
export function pickerProviders(
  stored: readonly StoredProviderConfig[],
): ModelPickerProvider[] {
  return [
    { id: 'spycore', label: 'SpyCore', kind: 'spycore' as const },
    ...stored.map((s) => ({
      id: s.name,
      label: sanitizeForDisplay(s.name),
      kind: 'byok' as const,
      model: s.model ?? null,
    })),
  ];
}

/**
 * Model rows for the SpyCore backend: the advertised chat models. The
 * currently-pinned model (if any) carries an `(active)` marker. Pure.
 */
export function spycoreModelRows(currentSlug: string | null): PickerRow[] {
  return CHAT_MODELS.map((slug) => ({
    key: slug,
    text: `${MODEL_DISPLAY[slug]}${slug === currentSlug ? '  (active)' : ''}`,
  }));
}

/**
 * Model rows for a BYOK provider: the user's OWN configured model.
 * BYOK has no SpyCore model list - the provider config names one model.
 * Pure.
 */
export function byokModelRows(
  configuredModel: string | null | undefined,
  currentModel: string | null,
): PickerRow[] {
  const model = (configuredModel ?? '').trim();
  if (model.length === 0) {
    return [{ key: 'unset', text: '(no model configured for this provider)' }];
  }
  return [
    {
      key: model,
      text: `${sanitizeForDisplay(model)}${model === currentModel ? '  (active)' : ''}`,
    },
  ];
}

/** Vertical-axis rows for whichever provider the rail currently points at. Pure. */
export function modelsForProvider(
  provider: ModelPickerProvider,
  currentModel: string | null,
): PickerRow[] {
  return provider.kind === 'spycore'
    ? spycoreModelRows(currentModel)
    : byokModelRows(provider.model, currentModel);
}

const FALLBACK_PROVIDER: ModelPickerProvider = {
  id: 'spycore',
  label: 'SpyCore',
  kind: 'spycore',
};

export function ModelPicker({
  providers,
  providerIndex,
  models,
  modelIndex,
  width,
}: ModelPickerProps): ReactNode {
  const theme = useTheme();
  const { colors, borderStyle } = theme;
  const inner = Math.max(24, width - 4);

  const clampedProvider = Math.min(Math.max(0, providerIndex), providers.length - 1);
  const provider = providers[clampedProvider] ?? FALLBACK_PROVIDER;
  const viewport = computePickerViewport(models, modelIndex, MAX_ROWS);
  const horizontal: PickerHorizontalScroll = {
    hasLeft: clampedProvider > 0,
    hasRight: clampedProvider < providers.length - 1,
  };

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle={borderStyle}
      borderColor={colors.borderSubtle}
      paddingX={1}
    >
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={colors.text}>
          Model
        </Text>
        <Text color={colors.muted}>
          Provider: <Text color={colors.accent}>{provider.label}</Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        <PickerList
          viewport={viewport}
          theme={theme}
          width={inner}
          horizontal={horizontal}
          emptyText="No models for this provider"
        />
      </Box>
      <Box marginTop={1}>
        <Text color={colors.muted}>↑/↓ model · ←/→ provider · Enter switch · Esc close</Text>
      </Box>
    </Box>
  );
}
