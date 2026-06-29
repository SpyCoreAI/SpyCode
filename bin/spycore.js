#!/usr/bin/env node
import('../build/index.js').catch((err) => {
  console.error('Failed to start spycore CLI:', err?.message ?? err);
  process.exit(1);
});
