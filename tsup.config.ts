import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'build',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  bundle: true,
  // Splitting keeps the Ink/React UI in a separate chunk that is only loaded
  // by the dynamic import() in the preview path — so non-UI commands never
  // eagerly load React/Ink/yoga at startup.
  splitting: true,
  sourcemap: false,
  clean: true,
  minify: true,
  shims: true,
  // React/Ink (and the @inkjs/ui kit) are kept external so esbuild never
  // bundles ink's yoga-layout wasm; they resolve from node_modules at runtime.
  external: [
    'keytar',
    'react',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    'ink',
    '@inkjs/ui',
  ],
  esbuildOptions(options) {
    // React automatic JSX runtime for the Ink (.tsx) UI layer.
    options.jsx = 'automatic';
  },
  banner: {
    js: '#!/usr/bin/env node',
  },
  // NO `define` for a version. There was a `__CLI_VERSION__` build define here
  // with ZERO consumers (F-2a #48) — a second, BUILD-FROZEN version mechanism
  // beside the four that read package.json at run time. Dead today, but a
  // build-frozen constant is the worst of the five shapes: it cannot be
  // corrected without a rebuild, and the next person to reach for a version
  // would have found it and used it. Removed rather than wired up; the runtime
  // readers are pinned to agree in tests/version-derivation.test.ts.
});
