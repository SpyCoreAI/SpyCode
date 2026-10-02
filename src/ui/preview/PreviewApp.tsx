import { Box, Text, useApp } from 'ink';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import {
  Badge,
  Banner,
  Content,
  KeyValue,
  MAX_CONTENT_WIDTH,
  Notice,
  Panel,
  Section,
  Separator,
  Spinner,
  StatusBar,
  useContentWidth,
} from '../components/index.js';
import { useTheme } from '../theme/theme.js';

export interface PreviewAppProps {
  /** Milliseconds before the showcase auto-exits. */
  autoExitMs: number;
}

const CONTENT_PADDING = 2;
const SECTION_INDENT = 2;

/**
 * A self-contained showcase of the SpyCode terminal design system: the
 * half-block wordmark banner, accent + bordered panels, refined headers, both
 * pill-badge tiers, notices, a spinner, a faded rule, and the full-width filled
 * status bar — all constrained to a max content width so wide terminals read as
 * deliberate, not stretched. Auto-exits so it never hangs.
 */
export function PreviewApp({ autoExitMs }: PreviewAppProps): ReactNode {
  const { exit } = useApp();
  const { colors, symbols, mode, capabilities } = useTheme();
  const contentWidth = useContentWidth();

  useEffect(() => {
    const timer = setTimeout(() => exit(), autoExitMs);
    return () => clearTimeout(timer);
  }, [autoExitMs, exit]);

  const meta = [
    `theme ${mode}`,
    `color ${capabilities.colorLevel}`,
    `${capabilities.columns}x${capabilities.rows}`,
    `unicode ${capabilities.unicode ? 'yes' : 'no'}`,
  ].join(`  ${symbols.middot}  `);

  // The faded rule needs an explicit width (it can't auto-stretch like the
  // border rules). It lives inside the content padding AND a section indent.
  const ruleWidth = Math.max(1, contentWidth - CONTENT_PADDING * 2 - SECTION_INDENT);

  return (
    <Box flexDirection="column" alignItems="flex-start">
      <Content maxWidth={MAX_CONTENT_WIDTH} paddingX={CONTENT_PADDING} paddingTop={1}>
        <Banner />
        <Box marginTop={1}>
          <Text color={colors.muted}>{meta}</Text>
        </Box>

        <Section title="Panels" subtitle="accent callout + bordered">
          <Panel variant="accent" title="Session" titleGlyph={symbols.diamond}>
            <KeyValue
              items={[
                { label: 'Model', value: 'Charon' },
                { label: 'Service', value: 'SpyCore' },
                { label: 'Workspace', value: '~/code/spycore' },
                {
                  label: 'Status',
                  value: <Text color={colors.success}>ready</Text>,
                },
              ]}
            />
          </Panel>
          <Box marginTop={1}>
            <Panel variant="bordered" title="Details">
              <Text color={colors.text}>Denser content lives here.</Text>
              <Text color={colors.muted}>Rounded, quiet by default.</Text>
            </Panel>
          </Box>
        </Section>

        <Section title="Badges" subtitle="solid + subtle tiers">
          <Box gap={1} flexWrap="wrap">
            <Badge variant="accent">Charon</Badge>
            <Badge variant="success">ready</Badge>
            <Badge variant="info">streaming</Badge>
            <Badge variant="warning">rate-limited</Badge>
            <Badge variant="error">failed</Badge>
          </Box>
          <Box gap={1} flexWrap="wrap" marginTop={1}>
            <Badge variant="accent" tier="subtle">Charon</Badge>
            <Badge variant="success" tier="subtle">ready</Badge>
            <Badge variant="info" tier="subtle">streaming</Badge>
            <Badge variant="muted" tier="subtle">idle</Badge>
          </Box>
        </Section>

        <Section title="Notices" subtitle="success / error / warning / info">
          <Notice variant="success">Connection established.</Notice>
          <Notice variant="info">Streaming response from the model.</Notice>
          <Notice variant="warning">Approaching your usage limit.</Notice>
          <Notice variant="error">Request failed — please retry.</Notice>
        </Section>

        <Section title="Spinner & rule" subtitle="subtle accent to dim fade">
          <Spinner label="Thinking..." />
          <Box marginTop={1}>
            <Separator fade token="borderStrong" toToken="borderSubtle" width={ruleWidth} />
          </Box>
        </Section>
      </Content>

      <Box marginTop={1}>
        <StatusBar width={contentWidth} usage="12.4k tokens" />
      </Box>
    </Box>
  );
}
