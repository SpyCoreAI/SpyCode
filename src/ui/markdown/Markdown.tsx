import { Box, Text } from 'ink';
import { Fragment, type ReactNode } from 'react';
import type { Token, Tokens } from 'marked';
import { useTheme, type Theme } from '../theme/theme.js';
import { useContentWidth } from '../lib/useContentWidth.js';
import { Separator } from '../components/Separator.js';
import { CodeBlock } from './CodeBlock.js';

interface Ctx {
  theme: Theme;
  /** Available width at this nesting level. */
  width: number;
  /** List nesting depth (drives bullet glyph). */
  depth: number;
  /** Render prose muted (blockquotes). */
  muted: boolean;
}

const MAX_COL = 40;
const MIN_COL = 3;

interface BoxChars {
  h: string;
  v: string;
  tl: string;
  tm: string;
  tr: string;
  ml: string;
  mm: string;
  mr: string;
  bl: string;
  bm: string;
  br: string;
}
const UNICODE_BOX: BoxChars = {
  h: '─', v: '│', tl: '┌', tm: '┬', tr: '┐', ml: '├', mm: '┼', mr: '┤', bl: '└', bm: '┴', br: '┘',
};
const ASCII_BOX: BoxChars = {
  h: '-', v: '|', tl: '+', tm: '+', tr: '+', ml: '+', mm: '+', mr: '+', bl: '+', bm: '+', br: '+',
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function bulletForDepth(depth: number, theme: Theme): string {
  if (!theme.capabilities.unicode) return depth % 2 === 0 ? '-' : '*';
  const bullets = ['•', '◦', '‣'];
  return bullets[depth % bullets.length] ?? '•';
}

function checkboxGlyph(checked: boolean, theme: Theme): string {
  if (!theme.capabilities.unicode) return checked ? '[x]' : '[ ]';
  return checked ? '☑' : '☐';
}

/** Flatten inline tokens to plain text (used for table cells, where formatting
 *  would break fixed-width alignment). */
function tokensToPlain(tokens: Token[] | undefined): string {
  if (!tokens) return '';
  let out = '';
  for (const t of tokens) {
    const anyT = t as { tokens?: Token[]; text?: string; raw?: string };
    if (anyT.tokens && anyT.tokens.length > 0) out += tokensToPlain(anyT.tokens);
    else if (typeof anyT.text === 'string') out += anyT.text;
    else if (typeof anyT.raw === 'string') out += anyT.raw;
  }
  return out;
}

function padCell(s: string, width: number, align: 'left' | 'right' | 'center' | null): string {
  const len = [...s].length;
  if (len >= width) return s;
  const pad = width - len;
  if (align === 'right') return ' '.repeat(pad) + s;
  if (align === 'center') {
    const left = Math.floor(pad / 2);
    return ' '.repeat(left) + s + ' '.repeat(pad - left);
  }
  return s + ' '.repeat(pad);
}

function truncateCell(s: string, width: number, ascii: boolean): string {
  const cps = [...s];
  if (cps.length <= width) return s;
  if (width <= 1) return cps.slice(0, width).join('');
  return cps.slice(0, width - 1).join('') + (ascii ? '~' : '…');
}

// ---------------------------------------------------------------------------
// inline rendering → nested <Text> spans
// ---------------------------------------------------------------------------
function renderInline(tokens: Token[] | undefined, ctx: Ctx, keyBase: string): ReactNode[] {
  if (!tokens) return [];
  const { theme } = ctx;
  const out: ReactNode[] = [];
  tokens.forEach((tok, i) => {
    const key = `${keyBase}.${i}`;
    switch (tok.type) {
      case 'text': {
        const t = tok as Tokens.Text;
        out.push(
          t.tokens && t.tokens.length > 0 ? (
            <Text key={key}>{renderInline(t.tokens, ctx, key)}</Text>
          ) : (
            <Text key={key}>{t.text}</Text>
          ),
        );
        break;
      }
      case 'strong':
        out.push(
          <Text key={key} bold>
            {renderInline((tok as Tokens.Strong).tokens, ctx, key)}
          </Text>,
        );
        break;
      case 'em':
        out.push(
          <Text key={key} italic>
            {renderInline((tok as Tokens.Em).tokens, ctx, key)}
          </Text>,
        );
        break;
      case 'del':
        out.push(
          <Text key={key} strikethrough>
            {renderInline((tok as Tokens.Del).tokens, ctx, key)}
          </Text>,
        );
        break;
      case 'codespan': {
        const t = tok as Tokens.Codespan;
        if (theme.colors.surface) {
          out.push(
            <Text key={key} backgroundColor={theme.colors.surface} color={theme.colors.accent}>
              {t.text}
            </Text>,
          );
        } else {
          out.push(<Text key={key}>{`\`${t.text}\``}</Text>);
        }
        break;
      }
      case 'link': {
        const t = tok as Tokens.Link;
        out.push(
          <Text key={key} color={theme.colors.accent} underline>
            {t.tokens && t.tokens.length > 0 ? renderInline(t.tokens, ctx, key) : t.text}
          </Text>,
        );
        if (t.href && t.href !== t.text) {
          out.push(
            <Text key={`${key}.u`} color={theme.colors.muted}>{` (${t.href})`}</Text>,
          );
        }
        break;
      }
      case 'br':
        out.push(<Text key={key}>{'\n'}</Text>);
        break;
      case 'escape':
        out.push(<Text key={key}>{(tok as Tokens.Escape).text}</Text>);
        break;
      case 'image': {
        const t = tok as Tokens.Image;
        out.push(
          <Text key={key} color={theme.colors.muted}>{`[${t.text || 'image'}]`}</Text>,
        );
        break;
      }
      default: {
        const raw = (tok as { text?: string; raw?: string }).text ?? (tok as { raw?: string }).raw;
        if (raw) out.push(<Text key={key}>{raw}</Text>);
      }
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// block rendering
// ---------------------------------------------------------------------------
function renderBlocks(tokens: Token[], ctx: Ctx, keyBase: string): ReactNode[] {
  const blocks = tokens.filter((t) => t.type !== 'space' && t.type !== 'def');
  const out: ReactNode[] = [];
  blocks.forEach((tok, i) => {
    const node = renderBlock(tok, ctx, `${keyBase}.${i}`);
    if (node === null) return;
    out.push(
      <Box key={`${keyBase}.${i}`} flexDirection="column" marginTop={out.length > 0 ? 1 : 0}>
        {node}
      </Box>,
    );
  });
  return out;
}

function renderList(list: Tokens.List, ctx: Ctx, key: string): ReactNode {
  return (
    <Box key={key} flexDirection="column">
      {list.items.map((item, idx) => renderListItem(item, list, idx, ctx, `${key}.${idx}`))}
    </Box>
  );
}

function renderListItem(
  item: Tokens.ListItem,
  list: Tokens.List,
  idx: number,
  ctx: Ctx,
  key: string,
): ReactNode {
  const { theme, width, depth } = ctx;
  let marker: string;
  let markerColor = theme.colors.accent;
  if (item.task) {
    const checked = item.checked === true;
    marker = checkboxGlyph(checked, theme);
    markerColor = checked ? theme.colors.success : theme.colors.muted;
  } else if (list.ordered) {
    const startNum = typeof list.start === 'number' ? list.start : 1;
    marker = `${startNum + idx}.`;
  } else {
    marker = bulletForDepth(depth, theme);
  }
  const markerStr = `${marker} `;
  const markerW = [...markerStr].length;
  const contentW = Math.max(1, width - markerW);

  // Drop the synthetic `checkbox` token marked emits for task items — the
  // checkbox is already rendered as the item marker above.
  const itemTokens = item.tokens.filter((t) => t.type !== 'checkbox');
  const first = itemTokens[0];
  let leadNode: ReactNode = null;
  let restTokens: Token[] = itemTokens;
  if (first && (first.type === 'text' || first.type === 'paragraph')) {
    const leadInline = renderInline(
      (first as Tokens.Text | Tokens.Paragraph).tokens,
      { ...ctx, width: contentW },
      `${key}.lead`,
    );
    leadNode = (
      <Text color={ctx.muted ? theme.colors.muted : theme.colors.text}>{leadInline}</Text>
    );
    restTokens = itemTokens.slice(1);
  }

  return (
    <Box key={key} flexDirection="column">
      <Box>
        <Text color={markerColor}>{markerStr}</Text>
        <Box width={contentW} flexDirection="column">
          {leadNode}
        </Box>
      </Box>
      {restTokens.length > 0 ? (
        <Box paddingLeft={markerW} flexDirection="column">
          {renderBlocks(restTokens, { ...ctx, depth: depth + 1, width: contentW }, `${key}.rest`)}
        </Box>
      ) : null}
    </Box>
  );
}

function renderTable(table: Tokens.Table, ctx: Ctx, key: string): ReactNode {
  const { theme, width } = ctx;
  const ascii = !theme.capabilities.unicode;
  const box = ascii ? ASCII_BOX : UNICODE_BOX;
  const border = theme.colors.borderSubtle;
  const ncols = table.header.length;

  const headerText = table.header.map((c) => tokensToPlain(c.tokens));
  const rowsText = table.rows.map((r) => r.map((c) => tokensToPlain(c.tokens)));

  // Natural widths (capped per column).
  const natural: number[] = [];
  for (let i = 0; i < ncols; i++) {
    let n = [...(headerText[i] ?? '')].length;
    for (const row of rowsText) n = Math.max(n, [...(row[i] ?? '')].length);
    natural.push(Math.max(1, Math.min(n, MAX_COL)));
  }
  // Fit to the available width: cells get 1 space of padding each side, plus
  // one vertical rule between/around columns.
  const budget = Math.max(ncols * MIN_COL, width - (ncols + 1) - 2 * ncols);
  const totalNatural = natural.reduce((a, b) => a + b, 0);
  let widths = natural;
  if (totalNatural > budget) {
    widths = natural.map((n) => Math.max(MIN_COL, Math.floor((n / totalNatural) * budget)));
  }

  const rule = (left: string, mid: string, right: string): ReactNode => (
    <Text color={border}>
      {left + widths.map((w) => box.h.repeat(w + 2)).join(mid) + right}
    </Text>
  );

  const dataRow = (cells: string[], header: boolean, rowKey: string): ReactNode => (
    <Text key={rowKey}>
      <Text color={border}>{box.v}</Text>
      {widths.map((w, i) => {
        const align = table.align[i] ?? null;
        const cell = ` ${padCell(truncateCell(cells[i] ?? '', w, ascii), w, align)} `;
        return (
          <Fragment key={i}>
            <Text color={header ? theme.colors.accent : theme.colors.text} bold={header}>
              {cell}
            </Text>
            <Text color={border}>{box.v}</Text>
          </Fragment>
        );
      })}
    </Text>
  );

  return (
    <Box key={key} flexDirection="column">
      {rule(box.tl, box.tm, box.tr)}
      {dataRow(headerText, true, `${key}.h`)}
      {rule(box.ml, box.mm, box.mr)}
      {rowsText.map((r, ri) => dataRow(r, false, `${key}.r${ri}`))}
      {rule(box.bl, box.bm, box.br)}
    </Box>
  );
}

function renderBlock(tok: Token, ctx: Ctx, key: string): ReactNode {
  const { theme, width } = ctx;
  switch (tok.type) {
    case 'heading': {
      const h = tok as Tokens.Heading;
      const color = h.depth <= 3 ? theme.colors.accent : theme.colors.text;
      const marker = h.depth <= 2 ? `${theme.symbols.section} ` : '';
      return (
        <Text color={color} bold>
          {marker}
          {renderInline(h.tokens, ctx, key)}
        </Text>
      );
    }
    case 'paragraph': {
      const p = tok as Tokens.Paragraph;
      return (
        <Text color={ctx.muted ? theme.colors.muted : theme.colors.text}>
          {renderInline(p.tokens, ctx, key)}
        </Text>
      );
    }
    case 'text': {
      const t = tok as Tokens.Text;
      return (
        <Text color={ctx.muted ? theme.colors.muted : theme.colors.text}>
          {t.tokens && t.tokens.length > 0 ? renderInline(t.tokens, ctx, key) : t.text}
        </Text>
      );
    }
    case 'code': {
      const c = tok as Tokens.Code;
      return <CodeBlock code={c.text} lang={c.lang ?? undefined} width={width} />;
    }
    case 'blockquote': {
      const b = tok as Tokens.Blockquote;
      const barStyle = theme.borderStyle === 'round' ? 'bold' : 'classic';
      return (
        <Box
          borderStyle={barStyle}
          borderColor={theme.colors.accentSubtle}
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          paddingLeft={1}
          flexDirection="column"
        >
          {renderBlocks(b.tokens, { ...ctx, muted: true, width: Math.max(1, width - 2) }, key)}
        </Box>
      );
    }
    case 'list':
      return renderList(tok as Tokens.List, ctx, key);
    case 'table':
      return renderTable(tok as Tokens.Table, ctx, key);
    case 'hr':
      return <Separator token="borderSubtle" />;
    case 'space':
    case 'def':
      return null;
    case 'html': {
      const raw = (tok as Tokens.HTML).text?.replace(/\n+$/, '');
      return raw ? <Text color={theme.colors.muted}>{raw}</Text> : null;
    }
    default: {
      const raw = (tok as { raw?: string }).raw?.replace(/\n+$/, '');
      return raw ? <Text color={theme.colors.text}>{raw}</Text> : null;
    }
  }
}

export interface MarkdownProps {
  tokens: Token[];
  /** Content width (defaults to the capped content width). */
  width?: number;
}

/**
 * Render a marked token tree as themed Ink components. Respects the content
 * width (prose wraps, tables/code fit) and degrades with the theme
 * (truecolor→none, unicode→ascii).
 */
export function Markdown({ tokens, width }: MarkdownProps): ReactNode {
  const theme = useTheme();
  const contentWidth = useContentWidth();
  const w = width ?? contentWidth;
  const ctx: Ctx = { theme, width: w, depth: 0, muted: false };
  return (
    <Box flexDirection="column" width={w}>
      {renderBlocks(tokens, ctx, 'b')}
    </Box>
  );
}
