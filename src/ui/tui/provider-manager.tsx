/**
 * Interactive Provider Manager dialog (F-BYOK-TUI):
 * Browse, switch, test, delete, and add providers step-by-step
 * with simple keyboard shortcuts directly within the TUI.
 */
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme/theme.js';
import { computePickerViewport, PickerList, type PickerRow } from './picker-grammar.js';
import type { StoredProviderConfig, ByokProviderType } from '../../lib/providers/byok-config.js';
import { keySource } from '../../commands/provider/index.js';

export type ProviderWizardStep =
  | 'type'      // choose openai | anthropic | google
  | 'name'      // type unique name
  | 'baseUrl'   // type custom or accept default
  | 'model'     // default model
  | 'apiKey'    // env var or key
  | 'addModel'; // add extra model to existing provider

export interface ProviderWizardState {
  step: ProviderWizardStep;
  type: ByokProviderType;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  cursor: number;
}

export interface ProviderManagerProps {
  providers: readonly StoredProviderConfig[];
  defaultProvider: string;
  selected: number;
  wizard: ProviderWizardState | null;
  width: number;
}

const MAX_ROWS = 6;

export function providerPickerRows(
  providers: readonly StoredProviderConfig[],
  defaultProvider: string,
): PickerRow[] {
  const items: PickerRow[] = [
    {
      key: 'spycore',
      text: `SpyCore${defaultProvider === 'spycore' ? '  ★ default' : ''}`,
    },
  ];

  for (const p of providers) {
    const isDef = p.name === defaultProvider;
    const allModels = [
      ...(p.model ? [p.model] : []),
      ...(p.models ?? []),
    ].filter((m, idx, arr) => arr.indexOf(m) === idx);
    const modelsDisplay = allModels.length > 0 ? allModels.join(', ') : 'no model';

    items.push({
      key: p.name,
      text: `${p.name} (${p.type}) · [${modelsDisplay}] · ${keySource(p)}${isDef ? '  ★ default' : ''}`,
    });
  }

  return items;
}

export function ProviderManager({
  providers,
  defaultProvider,
  selected,
  wizard,
  width,
}: ProviderManagerProps): ReactNode {
  const theme = useTheme();
  const { colors, borderStyle } = theme;
  const inner = Math.max(24, width - 4);

  if (wizard) {
    const stepTitle =
      wizard.step === 'type'
        ? 'Step 1/5: Select Provider Type (← / → then Enter)'
        : wizard.step === 'name'
          ? 'Step 2/5: Provider Name (e.g. deepseek, ollama)'
          : wizard.step === 'baseUrl'
            ? 'Step 3/5: Base URL (Enter for default)'
            : wizard.step === 'model'
              ? 'Step 4/5: Default Model ID (e.g. deepseek-chat)'
              : wizard.step === 'addModel'
                ? `Add New Model to "${wizard.name}" (Type model ID, Enter to save)`
                : 'Step 5/5: API Key or Env Var (Enter to skip for local)';

    return (
      <Box
        flexDirection="column"
        marginTop={1}
        borderStyle={borderStyle}
        borderColor={colors.accent}
        paddingX={1}
      >
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color={colors.accent}>
            {wizard.step === 'addModel' ? 'Add Model' : 'Add Provider Wizard'}
          </Text>
          <Text color={colors.muted}>Esc to Cancel</Text>
        </Box>

        <Box marginTop={1}>
          <Text bold color={colors.text}>{stepTitle}</Text>
        </Box>

        <Box marginTop={1} paddingLeft={1}>
          {wizard.step === 'type' ? (
            <Box flexDirection="row">
              {(['openai', 'anthropic', 'google'] as const).map((t) => (
                <Box key={t} marginRight={2}>
                  <Text
                    bold={wizard.type === t}
                    color={wizard.type === t ? colors.accent : colors.muted}
                  >
                    {wizard.type === t ? `[● ${t}]` : `○ ${t}`}
                  </Text>
                </Box>
              ))}
            </Box>
          ) : (
            <Box flexDirection="row">
              <Text color={colors.accent}>&gt; </Text>
              <Text color={colors.text}>
                {wizard.step === 'name'
                  ? wizard.name
                  : wizard.step === 'baseUrl'
                    ? wizard.baseUrl || `(default: ${wizard.type === 'openai' ? 'https://api.openai.com/v1' : wizard.type === 'anthropic' ? 'https://api.anthropic.com' : 'https://generativelanguage.googleapis.com'})`
                    : wizard.step === 'model' || wizard.step === 'addModel'
                      ? wizard.model
                      : wizard.apiKey ? '••••••••' : '(empty / none)'}
              </Text>
              <Text color={colors.accent}>_</Text>
            </Box>
          )}
        </Box>

        <Box marginTop={1}>
          <Text color={colors.muted}>
            {wizard.step === 'type'
              ? '←/→ change type · Enter next · Esc cancel'
              : 'Type text · Enter next / confirm · Esc cancel'}
          </Text>
        </Box>
      </Box>
    );
  }

  const rows = providerPickerRows(providers, defaultProvider);
  const viewport = computePickerViewport(rows, selected, MAX_ROWS);

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
          Providers
        </Text>
        <Text color={colors.muted}>
          Default: <Text color={colors.accent}>{defaultProvider}</Text>
        </Text>
      </Box>

      <Box marginTop={1}>
        <PickerList
          viewport={viewport}
          theme={theme}
          width={inner}
          emptyText="No providers configured"
        />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={colors.accent}>
          [Enter] Set Default  ·  [m] Add Model  ·  [a] Add Provider  ·  [t] Test  ·  [d] Delete  ·  [Esc] Close
        </Text>
      </Box>
    </Box>
  );
}
