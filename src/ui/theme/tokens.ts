/**
 * SpyCode terminal design-system tokens.
 *
 * Pure data only: the brand palette, a spacing scale, glyph sets and the
 * semantic color roles. There is no runtime capability detection here (see
 * `capabilities.ts`) and no React (see `theme.ts`) so this module is safe to
 * import from anywhere, including non-UI code.
 */

export type ColorLevel = 'truecolor' | 'ansi256' | 'ansi16' | 'none';
export type ThemeMode = 'dark' | 'light';

/**
 * Raw brand palette. These are the only literal colors in the system; every
 * semantic token is derived from them so the brand stays consistent.
 */
export const palette = {
  /**
   * Deep Malachite — brand primary. Too low-contrast as foreground text on a
   * near-black background, so on dark themes it is reserved for borders and
   * subtle accents; it becomes the accent TEXT color on light themes.
   */
  malachite: '#2C5F5D',
  /** Bright teal — accent TEXT on dark (high contrast on near-black). */
  teal: '#58a5a2',
  bgDark: '#0a0b0c',
  bgLight: '#f6f5f0',
  muted: '#646464',
  /** Functional colors, tuned to sit well beside the malachite/teal brand. */
  green: '#3fb950',
  red: '#f85149',
  amber: '#d29922',
} as const;

/** Spacing scale in terminal cells (Ink margins/paddings are integers). */
export const spacing = {
  none: 0,
  xs: 1,
  sm: 1,
  md: 2,
  lg: 3,
  xl: 4,
} as const;
export type SpacingScale = typeof spacing;

/**
 * Glyphs used across components. The `ascii` set is selected when the terminal
 * is unlikely to render Unicode (dumb terminals / legacy Windows consoles) so
 * the UI never shows replacement boxes.
 */
export interface SymbolSet {
  success: string;
  error: string;
  warning: string;
  info: string;
  bullet: string;
  arrow: string;
  pointer: string;
  diamond: string;
  line: string;
  /** Leading glyph for section headers. */
  section: string;
  /** Dim separator between status-bar segments. */
  middot: string;
  /** Git branch indicator. */
  branch: string;
  /** Fine dashed rule character. */
  hairline: string;
}

export const unicodeSymbols: SymbolSet = {
  success: '✓',
  error: '✗',
  warning: '⚠',
  info: 'ℹ',
  bullet: '•',
  arrow: '→',
  pointer: '❯',
  diamond: '◆',
  line: '─',
  section: '▸',
  middot: '·',
  branch: '⎇',
  hairline: '┄',
};

export const asciiSymbols: SymbolSet = {
  success: '+',
  error: 'x',
  warning: '!',
  info: 'i',
  bullet: '*',
  arrow: '>',
  pointer: '>',
  diamond: '*',
  line: '-',
  section: '>',
  middot: '|',
  branch: 'git',
  hairline: '-',
};

/**
 * Box border styles (Ink `borderStyle`). `round` for capable terminals,
 * `classic` (ASCII `+ - |`) when Unicode is unavailable.
 */
export type BorderStyleName = 'round' | 'classic';

/**
 * Semantic color roles. Components reference these — never `palette` directly —
 * so light/dark mode and degraded color levels all resolve in one place
 * (`theme.ts`).
 */
export type SemanticColorName =
  | 'accent'
  | 'accentSubtle'
  | 'text'
  | 'textDim'
  | 'muted'
  | 'success'
  | 'error'
  | 'warning'
  | 'info'
  | 'borderSubtle'
  | 'borderStrong'
  | 'surface';

/**
 * A per-mode color value: a truecolor hex (used at the 256/truecolor levels —
 * chalk downsamples hex automatically for 256) plus an ANSI-named fallback
 * (used at the 16-color level).
 */
export interface ColorValue {
  hex: string;
  ansi: string;
}
export interface SemanticColorSpec {
  dark: ColorValue;
  light: ColorValue;
}

export const semanticTokens: Record<SemanticColorName, SemanticColorSpec> = {
  // Primary accent: bright teal as TEXT on dark, deep malachite as TEXT on light.
  accent: {
    dark: { hex: palette.teal, ansi: 'cyan' },
    light: { hex: palette.malachite, ansi: 'cyan' },
  },
  // Subtle accent (borders / quiet emphasis): the inverse of `accent`.
  accentSubtle: {
    dark: { hex: palette.malachite, ansi: 'cyan' },
    light: { hex: palette.teal, ansi: 'cyan' },
  },
  // Body text: near-white on dark, near-black on light (palette reuse).
  text: {
    dark: { hex: palette.bgLight, ansi: 'white' },
    light: { hex: palette.bgDark, ansi: 'black' },
  },
  textDim: {
    dark: { hex: palette.muted, ansi: 'gray' },
    light: { hex: palette.muted, ansi: 'gray' },
  },
  muted: {
    dark: { hex: palette.muted, ansi: 'gray' },
    light: { hex: palette.muted, ansi: 'gray' },
  },
  success: {
    dark: { hex: palette.green, ansi: 'green' },
    light: { hex: palette.green, ansi: 'green' },
  },
  error: {
    dark: { hex: palette.red, ansi: 'red' },
    light: { hex: palette.red, ansi: 'red' },
  },
  warning: {
    dark: { hex: palette.amber, ansi: 'yellow' },
    light: { hex: palette.amber, ansi: 'yellow' },
  },
  info: {
    dark: { hex: palette.teal, ansi: 'cyan' },
    light: { hex: palette.teal, ansi: 'cyan' },
  },
  borderSubtle: {
    dark: { hex: palette.malachite, ansi: 'gray' },
    light: { hex: palette.muted, ansi: 'gray' },
  },
  borderStrong: {
    dark: { hex: palette.teal, ansi: 'cyan' },
    light: { hex: palette.malachite, ansi: 'cyan' },
  },
  // Quiet elevated background for the filled status bar and subtle pill chips.
  // A near-black teal on dark; a hair darker than the page on light. Only used
  // as a fill at truecolor/256 — at 16-color the status bar degrades to a rule.
  surface: {
    dark: { hex: '#12201e', ansi: 'black' },
    light: { hex: '#e7e6df', ansi: 'white' },
  },
};
