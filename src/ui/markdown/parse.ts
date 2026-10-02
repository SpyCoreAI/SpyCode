/**
 * Markdown lexing. We use marked's lexer to get a typed token tree and render
 * the tokens to Ink components ourselves (see Markdown.tsx) — we never use
 * marked's HTML/string renderers, so layout/theming/width-capping stay in Ink.
 */
import { marked } from 'marked';
import type { Token, TokensList } from 'marked';

export type { Token, TokensList } from 'marked';

/** Lex Markdown into a typed token tree. GFM on (tables + strikethrough). */
export function parseMarkdown(src: string): TokensList {
  return marked.lexer(src, { gfm: true });
}

/** Convenience: lex and return a plain `Token[]` (drops the `.links` extra). */
export function lexBlocks(src: string): Token[] {
  return parseMarkdown(src);
}
