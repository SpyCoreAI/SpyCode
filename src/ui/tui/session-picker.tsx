/**
 * Interactive Session Picker dialog (/sessions):
 * Lists recorded agent sessions for the current workspace so the user can
 * inspect and resume/continue a previous session using ↑/↓ and Enter.
 */
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme/theme.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import { computePickerViewport, PickerList, type PickerRow } from './picker-grammar.js';
import { getResumeState, type CheckpointSession } from '../../lib/agent/checkpoint.js';
import { isResumable } from '../../lib/agent/resume.js';

export interface SessionPickerProps {
  sessions: readonly CheckpointSession[];
  selected: number;
  width: number;
}

const MAX_ROWS = 8;

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return 'just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

export function sessionPickerRows(sessions: readonly CheckpointSession[]): PickerRow[] {
  return sessions.map((s) => {
    const state = getResumeState(s);
    const status = isResumable(s)
      ? '↻ resumable'
      : state?.status === 'completed'
        ? '✓ completed'
        : '• recorded';
    const rawTask = (s.task ?? '').replace(/\s+/g, ' ').trim();
    const taskPreview = rawTask.length > 42 ? `${rawTask.slice(0, 42)}…` : rawTask || '(untitled)';
    const filesCount = `${s.changes.length} file${s.changes.length === 1 ? '' : 's'}`;
    const timeLabel = formatRelativeTime(s.startedAt);
    return {
      key: s.id,
      text: `${sanitizeForDisplay(taskPreview)}  ·  ${timeLabel}  ·  ${filesCount}  [${status}]`,
    };
  });
}

export function SessionPicker({ sessions, selected, width }: SessionPickerProps): ReactNode {
  const theme = useTheme();
  const { colors, borderStyle } = theme;
  const inner = Math.max(24, width - 4);

  const rows = sessionPickerRows(sessions);
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
          Sessions History
        </Text>
        <Text color={colors.muted}>
          {`${sessions.length} session${sessions.length === 1 ? '' : 's'} in this workspace`}
        </Text>
      </Box>
      <Box marginTop={1}>
        <PickerList
          viewport={viewport}
          theme={theme}
          width={inner}
          emptyText="No previous sessions recorded in this directory."
        />
      </Box>
      <Box marginTop={1}>
        <Text color={colors.muted}>↑/↓ select · Enter load/resume · Esc close</Text>
      </Box>
    </Box>
  );
}
