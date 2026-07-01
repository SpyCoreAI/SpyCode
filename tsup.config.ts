import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as {
  version: string;
};

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
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version),
  },
});
