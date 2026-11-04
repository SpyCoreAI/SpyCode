/**
 * Theme gallery (Wave 3-D, F10) - curated extra themes as pure DATA.
 *
 * Beyond the built-in auto/light/dark settings, this file defines 5-8
 * additional themes in SpyCode's brand family: variations on the
 * malachite/teal identity, each hand-tuned (no copied palettes). A theme is
 * a compact spec (`GalleryThemeDef`); `expandThemeColors()` deterministically
 * maps it onto the full semantic token set, and `resolveGalleryTheme()`
 * produces a `Theme` the TUI can render directly.
 *
 * React-free on purpose: like `tokens.ts`, this module is safe to import
 * from non-UI code (config validation, tests, the CLI surface).
 */

import {
  asciiSymbols,
  palette,
  semanticTokens,
  spacing,
  unicodeSymbols,
} from './tokens.js';
import type {
  ColorLevel,
  ColorValue,
  SemanticColorName,
  SemanticColorSpec,
  ThemeMode,
} from './tokens.js';
import type { TerminalCapabilities } from './capabilities.js';
import type { ResolvedColor, ResolvedColors, Theme } from './theme.js';

/**
 * One gallery theme, as data. Every hex below was picked by hand against the
 * malachite/teal brand - no theme copies another product's palette.
 */
export interface GalleryThemeDef {
  /** Config-safe slug, e.g. 'abyss'. */
  id: string;
  /** Display name shown in the picker. */
  name: string;
  /** One-line description shown beside the name in the picker. */
  blurb: string;
  /** Base mode the theme was designed on. */
  mode: ThemeMode;
  /**
   * Primary accent. Used as accent TEXT on dark themes (bright, high
   * contrast on near-black) and as accent text on light themes (deep,
   * readable on ivory) - the same role the brand teal/malachite play.
   */
  accent: string;
  /** Quiet accent: borders and subtle emphasis. */
  deep: string;
  /** ANSI-16 fallback name for the accent pair. */
  ansi: 'cyan' | 'green' | 'gray' | 'white';
  /** Body text color. */
  text: string;
  /** Quiet elevated fill (status bar, pill chips) - the `surface` role. */
  surface: string;
  /** Optional overrides; default to the brand grays / functional colors. */
  textDim?: string;
  muted?: string;
  success?: string;
  error?: string;
  warning?: string;
  /** Hex swatch rendered in the theme picker's live preview. */
  swatch: string;
}

export const GALLERY_THEMES: readonly GalleryThemeDef[] = [
  {
    id: 'abyss',
    name: 'Abyssal',
    blurb: 'Deep-sea teal on near-black water',
    mode: 'dark',
    accent: '#66d9c5',
    deep: '#1d5a52',
    ansi: 'cyan',
    text: '#e9f5f2',
    surface: '#081613',
    swatch: '#66d9c5',
  },
  {
    id: 'pine',
    name: 'Pine',
    blurb: 'Forest floor, moss-lit green',
    mode: 'dark',
    accent: '#93d8a7',
    deep: '#2e6b47',
    ansi: 'green',
    text: '#ecf5ec',
    surface: '#0b150d',
    swatch: '#93d8a7',
  },
  {
    id: 'harbor',
    name: 'Harbor',
    blurb: 'Steel-blue teal, dockside dusk',
    mode: 'dark',
    accent: '#7cc4dc',
    deep: '#2b5a6d',
    ansi: 'cyan',
    text: '#ecf2f5',
    surface: '#0a1318',
    swatch: '#7cc4dc',
  },
  {
    id: 'tidepool',
    name: 'Tidepool',
    blurb: 'Misty gray-teal, low tide',
    mode: 'dark',
    accent: '#8fc9c1',
    deep: '#335f59',
    ansi: 'cyan',
    text: '#e9edeb',
    textDim: '#93a09c',
    surface: '#0d1413',
    swatch: '#8fc9c1',
  },
  {
    id: 'glacier',
    name: 'Glacier',
    blurb: 'Pale ice, crisp malachite ink',
    mode: 'light',
    accent: '#1e6f66',
    deep: '#63b3a7',
    ansi: 'cyan',
    text: '#0f1a19',
    surface: '#dfe9e7',
    swatch: '#1e6f66',
  },
  {
    id: 'dune',
    name: 'Dune',
    blurb: 'Warm sand, sunlit malachite',
    mode: 'light',
    accent: '#2e6e57',
    deep: '#8fbf9f',
    ansi: 'green',
    text: '#17140d',
    surface: '#eae2cd',
    swatch: '#2e6e57',
  },
  {
    id: 'meadow',
    name: 'Meadow',
    blurb: 'Spring green on morning mist',
    mode: 'light',
    accent: '#2f7a44',
    deep: '#9ed1a8',
    ansi: 'green',
    text: '#121a10',
    surface: '#dfe9d8',
    swatch: '#2f7a44',
  },
];

/**
 * Expand a compact theme spec onto the full semantic token set. Accent-family
 * roles (headings, links, keywords, hunk headers...) follow the theme's
 * accent so the whole UI reads as one palette; functional roles fall back to
 * the brand green/red/amber unless the theme overrides them.
 */
export function expandThemeColors(
  def: GalleryThemeDef,
): Partial<Record<SemanticColorName, SemanticColorSpec>> {
  const mode = def.mode;
  const accent: ColorValue = { hex: def.accent, ansi: def.ansi };
  const deep: ColorValue = { hex: def.deep, ansi: def.ansi };
  const text: ColorValue = { hex: def.text, ansi: mode === 'dark' ? 'white' : 'black' };
  const dim: ColorValue = { hex: def.textDim ?? palette.muted, ansi: 'gray' };
  const muted: ColorValue = { hex: def.muted ?? palette.muted, ansi: 'gray' };
  const success: ColorValue = def.success
    ? { hex: def.success, ansi: 'green' }
    : semanticTokens.success[mode];
  const error: ColorValue = def.error
    ? { hex: def.error, ansi: 'red' }
    : semanticTokens.error[mode];
  const warning: ColorValue = def.warning
    ? { hex: def.warning, ansi: 'yellow' }
    : semanticTokens.warning[mode];
  const surface: ColorValue = {
    hex: def.surface,
    ansi: mode === 'dark' ? 'black' : 'white',
  };
  const shadow: ColorValue = semanticTokens.shadow[mode];
  // Each override is a full two-mode spec with the same value in both slots:
  // resolution always runs at `def.mode`, so the unused slot never renders.
  const spec = (v: ColorValue): SemanticColorSpec => ({ dark: v, light: v });

  return {
    accent: spec(accent),
    accentSubtle: spec(deep),
    text: spec(text),
    textDim: spec(dim),
    muted: spec(muted),
    success: spec(success),
    error: spec(error),
    warning: spec(warning),
    info: spec(accent),
    borderSubtle: spec(deep),
    borderStrong: spec(accent),
    surface: spec(surface),
    diffAdded: spec(success),
    diffRemoved: spec(error),
    diffUnchanged: spec(muted),
    diffHunk: spec(accent),
    mdHeading: spec(accent),
    mdCode: spec(accent),
    mdLink: spec(accent),
    mdQuote: spec(muted),
    syntaxKeyword: spec(accent),
    syntaxString: spec(deep),
    syntaxNumber: spec(accent),
    syntaxComment: spec(muted),
    syntaxFunction: spec(text),
    syntaxType: spec(deep),
    syntaxOperator: spec(dim),
    syntaxVariable: spec(text),
    syntaxPunctuation: spec(muted),
    syntaxAttribute: spec(accent),
    shadow: spec(shadow),
  };
}

/**
 * Mirror of `resolveColor` in `theme.ts`, kept local so this module stays
 * React-free (safe to import from non-UI code like `tokens.ts` is).
 */
function resolveColorValue(
  spec: SemanticColorSpec,
  mode: ThemeMode,
  level: ColorLevel,
): ResolvedColor {
  if (level === 'none') return undefined;
  const value = spec[mode];
  if (level === 'ansi16') return value.ansi;
  // ansi256 + truecolor → hex. chalk downsamples hex to the 256 palette.
  return value.hex;
}

/** Resolve one gallery theme against live terminal capabilities. */
export function resolveGalleryTheme(
  def: GalleryThemeDef,
  capabilities: TerminalCapabilities,
): Theme {
  const overrides = expandThemeColors(def);
  const colors = {} as ResolvedColors;
  for (const name of Object.keys(semanticTokens) as SemanticColorName[]) {
    const spec = overrides[name] ?? semanticTokens[name];
    colors[name] = resolveColorValue(spec, def.mode, capabilities.colorLevel);
  }
  return {
    mode: def.mode,
    capabilities,
    colors,
    symbols: capabilities.unicode ? unicodeSymbols : asciiSymbols,
    spacing,
    borderStyle: capabilities.unicode ? 'round' : 'classic',
  };
}

/** True when `id` names a gallery theme (as opposed to auto/light/dark). */
export function isGalleryThemeId(id: string): boolean {
  return GALLERY_THEMES.some((t) => t.id === id);
}

/** One row of the theme picker: a built-in setting or a gallery theme. */
export interface ThemeOption {
  /** 'auto' | 'light' | 'dark' or a gallery theme id. */
  id: string;
  name: string;
  blurb: string;
  /** Hex preview swatch; null for the built-in settings (terminal default). */
  swatch: string | null;
  builtin: boolean;
}

/**
 * Picker ordering: the three built-in settings first (SpyCore brand default
 * stays the default), then the gallery in curated order.
 */
export function listThemeOptions(): ThemeOption[] {
  return [
    { id: 'auto', name: 'Auto', blurb: 'Follow the terminal background', swatch: null, builtin: true },
    { id: 'light', name: 'Light', blurb: 'Ivory light theme', swatch: null, builtin: true },
    { id: 'dark', name: 'Dark', blurb: 'Malachite dark theme (default)', swatch: null, builtin: true },
    ...GALLERY_THEMES.map((t) => ({
      id: t.id,
      name: t.name,
      blurb: t.blurb,
      swatch: t.swatch,
      builtin: false,
    })),
  ];
}

/**
 * One-call integration point for the TUI: turn a theme setting
 * ('auto' | 'light' | 'dark' | gallery id) into a renderable `Theme`.
 * Unknown ids fall back to 'auto' semantics (probe, else dark) rather than
 * throwing, so a stale config value can never break startup.
 */
export function resolveThemeSelection(
  setting: string,
  capabilities: TerminalCapabilities,
  probed: ThemeMode | null,
): Theme {
  const gallery = GALLERY_THEMES.find((t) => t.id === setting);
  if (gallery) return resolveGalleryTheme(gallery, capabilities);
  // Built-in settings: same semantics as `resolveThemeMode` in
  // `src/ui/tui/theme-detect.ts`, inlined to keep this module's dependency
  // direction theme-internal.
  const mode: ThemeMode =
    setting === 'light' ? 'light' : setting === 'dark' ? 'dark' : (probed ?? 'dark');
  const colors = {} as ResolvedColors;
  for (const name of Object.keys(semanticTokens) as SemanticColorName[]) {
    colors[name] = resolveColorValue(semanticTokens[name], mode, capabilities.colorLevel);
  }
  return {
    mode,
    capabilities,
    colors,
    symbols: capabilities.unicode ? unicodeSymbols : asciiSymbols,
    spacing,
    borderStyle: capabilities.unicode ? 'round' : 'classic',
  };
}
