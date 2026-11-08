import { describe, expect, test } from 'vitest';
import React, { type ReactElement } from 'react';
import { render, Text } from 'ink';
import { Badge } from '../src/ui/components/Badge.js';
import { Banner } from '../src/ui/components/Banner.js';
import { Brand } from '../src/ui/components/Brand.js';
import { Content } from '../src/ui/components/Content.js';
import { Header } from '../src/ui/components/Header.js';
import { KeyValue } from '../src/ui/components/KeyValue.js';
import { Notice } from '../src/ui/components/Notice.js';
import { Panel } from '../src/ui/components/Panel.js';
import { Section } from '../src/ui/components/Section.js';
import { Separator } from '../src/ui/components/Separator.js';
import { Spinner } from '../src/ui/components/Spinner.js';
import { StatusBar } from '../src/ui/components/StatusBar.js';
import { ChatInput } from '../src/ui/chat/ChatInput.js';
import { MessageView, type ChatItem } from '../src/ui/chat/MessageView.js';
import { Markdown } from '../src/ui/markdown/Markdown.js';
import { CodeBlock } from '../src/ui/markdown/CodeBlock.js';
import { StreamingMarkdown } from '../src/ui/markdown/StreamingMarkdown.js';
import { parseMarkdown } from '../src/ui/markdown/parse.js';
import { ApprovalPrompt, DiffLineView, clamp, modelLabel, statLabel } from '../src/ui/agent/shared.js';
import { ModelPicker, spycoreModelRows } from '../src/ui/tui/model-picker.js';
import { ThemePicker } from '../src/ui/tui/theme-picker.js';
import { listThemeOptions } from '../src/ui/theme/gallery.js';
import { CommandPalette } from '../src/ui/tui/palette.js';
import { TUI_COMMANDS } from '../src/ui/tui/commands.js';
import { TuiComposer } from '../src/ui/tui/composer.js';
import { TuiSessionSidebar } from '../src/ui/tui/sidebar.js';
import { HelpPanel } from '../src/ui/tui/help.js';
import { PreviewApp } from '../src/ui/preview/PreviewApp.js';
import { MarkdownPreviewApp } from '../src/ui/preview/MarkdownPreviewApp.js';
import { ThemeProvider, resolveTheme } from '../src/ui/theme/theme.js';
import { detectCapabilities } from '../src/ui/theme/capabilities.js';
import { palette, spacing, unicodeSymbols, asciiSymbols } from '../src/ui/theme/tokens.js';
import { gradient, hexToRgb, lerpHex, rgbToHex } from '../src/ui/lib/gradient.js';

/**
 * H16 - render tests for the UI layer. Previously no test imported any
 * `.tsx` file, so every render regression in the Ink components was
 * invisible. The harness mirrors `tests/file-picker-render.test.ts`: a
 * fake stdout captures the frame, ANSI codes are stripped, assertions run
 * on the plain text.
 *
 * Out of reach of this harness (documented, not faked): `ChatApp`,
 * `AgentApp` and `TuiApp` mount full interactive sessions (network,
 * stdin, provider runs) and cannot render to a captured frame; the
 * preview runners `run.ts` / `runMarkdown.ts` are covered at the command
 * wiring level instead (see `tests/command-entrypoints.test.ts`).
 */
const theme = resolveTheme(detectCapabilities(), 'dark');

function renderFrame(el: ReactElement): string {
  let out = '';
  const fakeStdout = {
    write: (s: string): boolean => {
      out += s;
      return true;
    },
    columns: 80,
    rows: 24,
  } as unknown as NodeJS.WriteStream;
  const inst = render(React.createElement(ThemeProvider, { theme, children: el }), {
    stdout: fakeStdout,
    debug: true,
  });
  inst.unmount();
  return out.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('design-system components', () => {
  test('Badge renders both tiers', () => {
    const frame = renderFrame(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Badge, { variant: 'success', children: 'ready' }),
        React.createElement(Badge, { variant: 'error', tier: 'subtle', children: 'failed' }),
      ),
    );
    expect(frame).toContain('ready');
    expect(frame).toContain('failed');
  });

  test('Notice renders each variant with its message', () => {
    for (const variant of ['info', 'warning', 'error', 'success'] as const) {
      const frame = renderFrame(
        React.createElement(Notice, { variant, children: `notice ${variant}` }),
      );
      expect(frame).toContain(`notice ${variant}`);
    }
  });

  test('Panel renders its title and children', () => {
    const frame = renderFrame(
      React.createElement(Panel, {
        variant: 'bordered',
        title: 'Session',
        children: React.createElement(Text, null, 'body text'),
      }),
    );
    expect(frame).toContain('Session');
    expect(frame).toContain('body text');
  });

  test('Section renders title, subtitle and body', () => {
    const frame = renderFrame(
      React.createElement(Section, {
        title: 'Panels',
        subtitle: 'accent callout',
        children: React.createElement(Text, null, 'section body'),
      }),
    );
    expect(frame).toContain('Panels');
    expect(frame).toContain('accent callout');
    expect(frame).toContain('section body');
  });

  test('Separator renders a rule of the requested width', () => {
    const frame = renderFrame(React.createElement(Separator, { width: 10, char: '-' }));
    expect(frame).toContain('----------');
  });

  test('Header, Brand, Banner and Content render', () => {
    const frame = renderFrame(
      React.createElement(
        Content,
        null,
        React.createElement(Header, { title: 'SpyCode', subtitle: 'coding agent' }),
        React.createElement(Brand, { subtitle: 'tagline here' }),
        React.createElement(Banner, null),
      ),
    );
    expect(frame).toContain('SpyCode');
    expect(frame).toContain('coding agent');
    expect(frame).toContain('tagline here');
  });

  test('KeyValue aligns labels and values', () => {
    const frame = renderFrame(
      React.createElement(KeyValue, {
        items: [
          { label: 'Model', value: 'Charon' },
          { label: 'Service', value: 'SpyCore' },
        ],
      }),
    );
    expect(frame).toContain('Model');
    expect(frame).toContain('Charon');
    expect(frame).toContain('Service');
    expect(frame).toContain('SpyCore');
  });

  test('StatusBar renders model, service and mode', () => {
    const frame = renderFrame(
      React.createElement(StatusBar, {
        model: 'Styx',
        service: 'SpyCore',
        mode: 'agent',
        usage: '1,234 tokens',
      }),
    );
    expect(frame).toContain('Styx');
    expect(frame).toContain('SpyCore');
    expect(frame).toContain('agent');
    expect(frame).toContain('1,234 tokens');
  });

  test('Spinner renders its label', () => {
    const frame = renderFrame(React.createElement(Spinner, { label: 'working…' }));
    expect(frame).toContain('working…');
  });
});

describe('chat components', () => {
  test('ChatInput renders the value with a cursor and the disabled hint', () => {
    const frame = renderFrame(
      React.createElement(ChatInput, {
        value: 'hello',
        cursor: 5,
        placeholder: 'Ask…',
        disabled: false,
      }),
    );
    expect(frame).toContain('hello');
    const disabled = renderFrame(
      React.createElement(ChatInput, {
        value: '',
        cursor: 0,
        placeholder: 'Ask…',
        disabled: true,
      }),
    );
    expect(disabled).toContain('streaming…');
  });

  test('MessageView renders user, assistant, error and notice items', () => {
    const user: ChatItem = { kind: 'user', id: 1, text: 'rename the User type' };
    expect(renderFrame(React.createElement(MessageView, { item: user, width: 80 }))).toContain(
      'rename the User type',
    );
    const assistant: ChatItem = {
      kind: 'assistant',
      id: 2,
      content: 'Done. Renamed across 3 files.',
      model: 'Styx',
      skills: [],
      elapsedMs: 4200,
    };
    const aFrame = renderFrame(React.createElement(MessageView, { item: assistant, width: 80 }));
    expect(aFrame).toContain('Done. Renamed across 3 files.');
    expect(aFrame).toContain('4.2s');
    const error: ChatItem = { kind: 'error', id: 3, message: 'provider timeout', hint: 'retry' };
    const eFrame = renderFrame(React.createElement(MessageView, { item: error, width: 80 }));
    expect(eFrame).toContain('provider timeout');
    expect(eFrame).toContain('retry');
    const notice: ChatItem = { kind: 'notice', id: 4, variant: 'warning', text: 'context is 90% full' };
    expect(renderFrame(React.createElement(MessageView, { item: notice, width: 80 }))).toContain(
      'context is 90% full',
    );
  });

  test('MessageView renders tool calls and tool results, including diffs', () => {
    const call: ChatItem = { kind: 'toolcall', id: 5, tool: 'read_file', label: 'src/a.ts' };
    const cFrame = renderFrame(React.createElement(MessageView, { item: call, width: 80 }));
    expect(cFrame).toContain('read_file');
    expect(cFrame).toContain('src/a.ts');
    const result: ChatItem = {
      kind: 'toolresult',
      id: 6,
      tool: 'write_file',
      variant: 'diff',
      ok: true,
      diff: [
        { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
        { kind: 'del', text: 'old line' },
        { kind: 'add', text: 'new line' },
      ],
    };
    const rFrame = renderFrame(React.createElement(MessageView, { item: result, width: 80 }));
    expect(rFrame).toContain('old line');
    expect(rFrame).toContain('new line');
    const failed: ChatItem = {
      kind: 'toolresult',
      id: 7,
      tool: 'run_command',
      variant: 'error',
      ok: false,
      text: 'exit code 1',
    };
    expect(renderFrame(React.createElement(MessageView, { item: failed, width: 80 }))).toContain(
      'exit code 1',
    );
  });

  test('MessageView indents delegated turns by depth', () => {
    const item: ChatItem = { kind: 'user', id: 8, text: 'child task' };
    const flat = renderFrame(React.createElement(MessageView, { item, width: 80 }));
    const deep = renderFrame(React.createElement(MessageView, { item, width: 80, depth: 2 }));
    expect(flat).toContain('child task');
    expect(deep).toContain('child task');
    // The branch glyph follows the detected terminal: `└` on Unicode
    // terminals, `+` on the ASCII fallback (Windows CI runs with no
    // Unicode host, so `detectUnicode` is false there and the renderer
    // correctly emits `+`). Pin the glyph for the capabilities in effect,
    // with the depth-2 indent (`  `) in front of it, on every platform.
    const branch = detectCapabilities().unicode ? '└' : '+';
    expect(deep).toContain(`  ${branch} `);
  });
});

describe('markdown layer', () => {
  test('Markdown renders headings, code and lists', () => {
    const tokens = parseMarkdown('# Title\n\nSome **bold** text.\n\n- one\n- two\n');
    const frame = renderFrame(React.createElement(Markdown, { tokens, width: 80 }));
    expect(frame).toContain('Title');
    expect(frame).toContain('bold');
    expect(frame).toContain('one');
    expect(frame).toContain('two');
  });

  test('CodeBlock renders code with its language', () => {
    const frame = renderFrame(
      React.createElement(CodeBlock, {
        code: 'const a = 1;',
        lang: 'ts',
        width: 80,
      }),
    );
    expect(frame).toContain('const a = 1;');
  });

  test('StreamingMarkdown renders settled content without a cursor', () => {
    const frame = renderFrame(
      React.createElement(StreamingMarkdown, {
        content: 'Hello **world**',
        streaming: false,
        width: 80,
      }),
    );
    expect(frame).toContain('Hello');
    expect(frame).toContain('world');
    expect(frame).not.toContain('▍');
  });
});

describe('agent shared views and helpers', () => {
  test('modelLabel, statLabel and clamp are pure and exact', () => {
    expect(modelLabel('styx')).toBe('Styx');
    expect(modelLabel('unknown-slug')).toBe('unknown-slug');
    expect(statLabel(3, 1)).toBe('+3 -1');
    expect(statLabel(3, 0)).toBe('+3');
    // clamp floors the width at 8: a 10-char line at width 8 truncates.
    expect(clamp('abcdefghij', 8)).toBe('abcdefg…');
    expect(clamp('ab', 10)).toBe('ab');
  });

  test('DiffLineView marks additions and deletions', () => {
    const add = renderFrame(
      React.createElement(DiffLineView, { line: { kind: 'add', text: 'new' }, width: 80 }),
    );
    expect(add).toContain('+new');
    const del = renderFrame(
      React.createElement(DiffLineView, { line: { kind: 'del', text: 'old' }, width: 80 }),
    );
    expect(del).toContain('-old');
  });

  test('ApprovalPrompt shows a/A/r keys, and [w] only with allowPermanent', () => {
    const frame = renderFrame(React.createElement(ApprovalPrompt, {}));
    expect(frame).toContain('[a]');
    expect(frame).toContain('[A]');
    expect(frame).toContain('[r]');
    expect(frame).not.toContain('[w]');
    const withW = renderFrame(
      React.createElement(ApprovalPrompt, { always: true, allowPermanent: true }),
    );
    expect(withW).toContain('[w]');
  });
});

describe('TUI pickers and panels', () => {
  test('ModelPicker renders the provider rail and model rows', () => {
    const frame = renderFrame(
      React.createElement(ModelPicker, {
        providers: [{ id: 'spycore', label: 'SpyCore', kind: 'spycore' }],
        providerIndex: 0,
        models: spycoreModelRows('styx'),
        modelIndex: 2,
        width: 80,
      }),
    );
    expect(frame).toContain('SpyCore');
    expect(frame).toContain('Styx');
    expect(frame).toContain('(active)');
  });

  test('ThemePicker renders options with the active marker', () => {
    const options = listThemeOptions();
    expect(options.length).toBeGreaterThanOrEqual(3);
    const frame = renderFrame(
      React.createElement(ThemePicker, {
        options,
        selected: 2,
        currentId: 'dark',
        width: 80,
      }),
    );
    expect(frame).toContain('Dark');
    expect(frame).toContain('(active)');
  });

  test('CommandPalette renders filtered commands', () => {
    const frame = renderFrame(
      React.createElement(CommandPalette, {
        commands: TUI_COMMANDS,
        selected: 0,
        filter: '',
        width: 80,
      }),
    );
    expect(frame).toContain('/help');
    expect(frame).toContain('/model');
  });

  test('TuiComposer renders the draft and the disabled hint', () => {
    const frame = renderFrame(
      React.createElement(TuiComposer, {
        value: 'do the thing',
        cursor: 12,
        placeholder: 'Ask…',
        mode: 'normal',
        disabled: false,
        disabledHint: '',
      }),
    );
    expect(frame).toContain('do the thing');
    const disabled = renderFrame(
      React.createElement(TuiComposer, {
        value: '',
        cursor: 0,
        placeholder: 'Ask…',
        mode: 'normal',
        disabled: true,
        disabledHint: 'running…',
      }),
    );
    expect(disabled).toContain('running…');
  });

  test('TuiSessionSidebar renders the title and file stats', () => {
    const frame = renderFrame(
      React.createElement(TuiSessionSidebar, {
        title: 'Rename the type',
        files: [{ path: '/tmp/w/src/a.ts', added: 3, removed: 1, seen: [] }],
        cwd: '/tmp/w',
        width: 30,
      }),
    );
    expect(frame).toContain('Rename the type');
    expect(frame).toContain('a.ts');
  });

  test('HelpPanel renders the key list', () => {
    const frame = renderFrame(React.createElement(HelpPanel, null));
    expect(frame.length).toBeGreaterThan(0);
    expect(frame).toContain('help');
  });
});

describe('preview apps', () => {
  test('PreviewApp showcases the design system', () => {
    const frame = renderFrame(React.createElement(PreviewApp, { autoExitMs: 50 }));
    expect(frame).toContain('Panels');
    expect(frame).toContain('Charon');
    expect(frame).toContain('ready');
  });

  test('MarkdownPreviewApp renders the static sample doc', () => {
    const frame = renderFrame(React.createElement(MarkdownPreviewApp, { autoExitMs: 50 }));
    expect(frame).toContain('SpyCode rendering');
    expect(frame).toContain('Wire the lexer');
    expect(frame).toContain('Hermes');
  });
});

describe('theme tokens and gradient helpers', () => {
  test('palette, spacing and symbol sets are populated', () => {
    expect(Object.keys(palette).length).toBeGreaterThan(0);
    expect(spacing.md).toBeGreaterThan(0);
    expect(unicodeSymbols.pointer.length).toBeGreaterThan(0);
    expect(asciiSymbols.pointer.length).toBeGreaterThan(0);
  });

  test('gradient helpers round-trip hex', () => {
    expect(hexToRgb('#ff0000')).toEqual([255, 0, 0]);
    expect(rgbToHex([0, 255, 0])).toBe('#00ff00');
    expect(lerpHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(gradient(['#000000', '#ffffff'], 3)).toEqual(['#000000', '#808080', '#ffffff']);
  });
});
