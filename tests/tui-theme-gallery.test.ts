/**
 * Theme gallery + 2D model picker (Wave 3-D, F10/F15): pure-logic pins.
 * Gallery resolution, theme selection fallback, picker row builders, and
 * the provider rail. The Ink components themselves are presentational and
 * are not rendered here.
 */
import { describe, expect, test } from 'vitest';
import {
  expandThemeColors,
  GALLERY_THEMES,
  isGalleryThemeId,
  listThemeOptions,
  resolveGalleryTheme,
  resolveThemeSelection,
} from '../src/ui/theme/gallery.js';
import type { TerminalCapabilities } from '../src/ui/theme/capabilities.js';
import { themePickerRows } from '../src/ui/tui/theme-picker.js';
import {
  byokModelRows,
  modelsForProvider,
  pickerProviders,
  spycoreModelRows,
} from '../src/ui/tui/model-picker.js';

const CAPS: TerminalCapabilities = {
  isTTY: true,
  colorLevel: 'truecolor',
  columns: 100,
  rows: 30,
  unicode: true,
};
const CAPS_16: TerminalCapabilities = { ...CAPS, colorLevel: 'ansi16' };
const CAPS_NONE: TerminalCapabilities = { ...CAPS, colorLevel: 'none' };

const HEX = /^#[0-9a-f]{6}$/i;

describe('GALLERY_THEMES', () => {
  test('curates 5-8 themes', () => {
    expect(GALLERY_THEMES.length).toBeGreaterThanOrEqual(5);
    expect(GALLERY_THEMES.length).toBeLessThanOrEqual(8);
  });

  test('ids are unique config-safe slugs', () => {
    const ids = GALLERY_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
      expect(['auto', 'light', 'dark']).not.toContain(id);
    }
  });

  test('every color field is a valid hex literal', () => {
    for (const t of GALLERY_THEMES) {
      for (const field of [t.accent, t.deep, t.text, t.surface, t.swatch] as const) {
        expect(field, `${t.id}`).toMatch(HEX);
      }
      for (const opt of [t.textDim, t.muted, t.success, t.error, t.warning] as const) {
        if (opt !== undefined) expect(opt, `${t.id}`).toMatch(HEX);
      }
    }
  });

  test('covers both dark and light modes', () => {
    const modes = new Set(GALLERY_THEMES.map((t) => t.mode));
    expect(modes.has('dark')).toBe(true);
    expect(modes.has('light')).toBe(true);
  });
});

describe('expandThemeColors / resolveGalleryTheme', () => {
  test('accent resolves to the theme accent at truecolor', () => {
    const def = GALLERY_THEMES[0]!;
    const theme = resolveGalleryTheme(def, CAPS);
    expect(theme.colors.accent).toBe(def.accent);
    expect(theme.colors.accentSubtle).toBe(def.deep);
    expect(theme.colors.text).toBe(def.text);
    expect(theme.colors.surface).toBe(def.surface);
    expect(theme.mode).toBe(def.mode);
  });

  test('accent-family roles follow the theme accent', () => {
    const def = GALLERY_THEMES[0]!;
    const theme = resolveGalleryTheme(def, CAPS);
    for (const role of ['diffHunk', 'mdHeading', 'mdLink', 'syntaxKeyword'] as const) {
      expect(theme.colors[role]).toBe(def.accent);
    }
  });

  test('ansi16 level falls back to the theme ansi name', () => {
    const def = GALLERY_THEMES[0]!;
    const theme = resolveGalleryTheme(def, CAPS_16);
    expect(theme.colors.accent).toBe(def.ansi);
    expect(theme.colors.text).toBe(def.mode === 'dark' ? 'white' : 'black');
  });

  test('no-color level resolves every role to undefined', () => {
    const def = GALLERY_THEMES[0]!;
    const theme = resolveGalleryTheme(def, CAPS_NONE);
    for (const value of Object.values(theme.colors)) {
      expect(value).toBeUndefined();
    }
  });

  test('every semantic role resolves (no holes in the expansion)', () => {
    const def = GALLERY_THEMES[0]!;
    const expanded = expandThemeColors(def);
    for (const name of Object.keys(expanded)) {
      expect(expanded[name as keyof typeof expanded]).toBeDefined();
    }
    // Spot-check the full resolve too: accent must never be undefined at truecolor.
    const theme = resolveGalleryTheme(def, CAPS);
    for (const [name, value] of Object.entries(theme.colors)) {
      expect(value, name).toBeDefined();
    }
  });
});

describe('theme selection', () => {
  test('gallery ids resolve to gallery themes', () => {
    for (const def of GALLERY_THEMES) {
      const theme = resolveThemeSelection(def.id, CAPS, null);
      expect(theme.mode).toBe(def.mode);
      expect(theme.colors.accent).toBe(def.accent);
      expect(isGalleryThemeId(def.id)).toBe(true);
    }
  });

  test('built-in settings keep brand semantics', () => {
    expect(resolveThemeSelection('dark', CAPS, null).mode).toBe('dark');
    expect(resolveThemeSelection('light', CAPS, null).mode).toBe('light');
    expect(resolveThemeSelection('auto', CAPS, 'light').mode).toBe('light');
    expect(resolveThemeSelection('auto', CAPS, null).mode).toBe('dark');
    expect(isGalleryThemeId('dark')).toBe(false);
  });

  test('unknown ids fall back to auto semantics, never throw', () => {
    expect(resolveThemeSelection('nope', CAPS, 'light').mode).toBe('light');
    expect(resolveThemeSelection('nope', CAPS, null).mode).toBe('dark');
  });

  test('listThemeOptions puts auto/light/dark first', () => {
    const options = listThemeOptions();
    expect(options.slice(0, 3).map((o) => o.id)).toEqual(['auto', 'light', 'dark']);
    expect(options.length).toBe(3 + GALLERY_THEMES.length);
    expect(options[3]!.builtin).toBe(false);
    expect(options[3]!.swatch).toMatch(HEX);
  });
});

describe('themePickerRows', () => {
  test('marks the active theme', () => {
    const options = listThemeOptions();
    const rows = themePickerRows(options, 'abyss');
    const active = rows.find((r) => r.key === 'abyss')!;
    expect(active.text).toContain('(active)');
    expect(rows.find((r) => r.key === 'dark')!.text).not.toContain('(active)');
  });
});

describe('model picker rows', () => {
  test('spycoreModelRows lists the chat models with an active marker', () => {
    const rows = spycoreModelRows('styx');
    expect(rows.map((r) => r.key)).toEqual(['hermes', 'minos', 'styx', 'styx_max', 'charon']);
    expect(rows[2]!.text).toContain('(active)');
    expect(rows[0]!.text).not.toContain('(active)');
  });

  test('byokModelRows shows the configured model, or a placeholder when unset', () => {
    expect(byokModelRows('gpt-4o', null)).toEqual([{ key: 'gpt-4o', text: 'gpt-4o' }]);
    expect(byokModelRows('gpt-4o', 'gpt-4o')[0]!.text).toContain('(active)');
    expect(byokModelRows(null, null)[0]!.text).toContain('no model configured');
    expect(byokModelRows('  ', null)[0]!.text).toContain('no model configured');
  });

  test('modelsForProvider switches on provider kind', () => {
    const spycore = modelsForProvider({ id: 'spycore', label: 'SpyCore', kind: 'spycore' }, null);
    expect(spycore.length).toBe(5);
    const byok = modelsForProvider(
      { id: 'mine', label: 'mine', kind: 'byok', model: 'llama-3' },
      null,
    );
    expect(byok).toEqual([{ key: 'llama-3', text: 'llama-3' }]);
  });

  test('pickerProviders puts SpyCore first, then stored BYOK providers', () => {
    const providers = pickerProviders([
      { name: 'work', type: 'openai', baseURL: 'https://x', model: 'gpt-4o' },
      { name: 'local', type: 'openai', baseURL: 'http://localhost:1234' },
    ]);
    expect(providers.map((p) => p.id)).toEqual(['spycore', 'work', 'local']);
    expect(providers[1]!.kind).toBe('byok');
    expect(providers[1]!.model).toBe('gpt-4o');
    expect(providers[2]!.model).toBeNull();
  });
});
