/**
 * Theme resolution + React context.
 *
 * `resolveTheme()` turns detected capabilities + a light/dark setting into a
 * concrete set of Ink-ready color strings, symbols and border style.
 * `ThemeProvider`/`useTheme` distribute it through the component tree. The
 * provider is built with `createElement` (no JSX) so this stays a `.ts` file.
 */
import { createContext, createElement, useContext, type ReactNode } from 'react';
import {
  asciiSymbols,
  semanticTokens,
  spacing,
  unicodeSymbols,
  type BorderStyleName,
  type ColorLevel,
  type SemanticColorName,
  type SemanticColorSpec,
  type SpacingScale,
  type SymbolSet,
  type ThemeMode,
} from './tokens.js';
import { detectCapabilities, type TerminalCapabilities } from './capabilities.js';

/**
 * A resolved color is exactly what we hand to Ink's `color`/`borderColor`
 * props: a hex string, an ANSI color name, or `undefined` meaning "no color"
 * (NO_COLOR / dumb terminal — hierarchy then relies on weight/borders/layout).
 */
export type ResolvedColor = string | undefined;
export type ResolvedColors = Record<SemanticColorName, ResolvedColor>;

export interface Theme {
  mode: ThemeMode;
  capabilities: TerminalCapabilities;
  colors: ResolvedColors;
  symbols: SymbolSet;
  spacing: SpacingScale;
  /** Ink `borderStyle` for panels, chosen from Unicode capability. */
  borderStyle: BorderStyleName;
}

function resolveColor(
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

export function resolveTheme(
  capabilities: TerminalCapabilities,
  mode: ThemeMode = 'dark',
): Theme {
  const colors = {} as ResolvedColors;
  for (const name of Object.keys(semanticTokens) as SemanticColorName[]) {
    colors[name] = resolveColor(semanticTokens[name], mode, capabilities.colorLevel);
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

let cachedDefault: Theme | undefined;
/**
 * Theme used by components rendered outside a `ThemeProvider`. Computed once
 * from the live terminal (dark mode) so standalone component usage still looks
 * correct without forcing every caller to wire a provider.
 */
export function defaultTheme(): Theme {
  if (!cachedDefault) cachedDefault = resolveTheme(detectCapabilities(), 'dark');
  return cachedDefault;
}

const ThemeContext = createContext<Theme | null>(null);

export interface ThemeProviderProps {
  theme: Theme;
  children: ReactNode;
}
export function ThemeProvider({ theme, children }: ThemeProviderProps): ReactNode {
  return createElement(ThemeContext.Provider, { value: theme }, children);
}

export function useTheme(): Theme {
  return useContext(ThemeContext) ?? defaultTheme();
}
