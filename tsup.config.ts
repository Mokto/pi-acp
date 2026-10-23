import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', 'compaction-extension': 'src/pi-rpc/compaction-extension.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  dts: false,
  splitting: false,
  minify: false,
  banner: {
    js: '#!/usr/bin/env node'
  }
})
