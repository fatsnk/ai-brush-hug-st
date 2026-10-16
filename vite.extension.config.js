import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { protectBuild } from './scripts/protect-build.mjs';

export default defineConfig({
  base: './',
  plugins: [protectBuild()],
  build: {
    outDir: 'extension-dist',
    sourcemap: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        extension: fileURLToPath(new URL('./src/st-extension.js', import.meta.url)),
        ui: fileURLToPath(new URL('./extension-ui.html', import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => chunk.name === 'extension' ? 'index.js' : 'assets/[name]-[hash].js',
        manualChunks: (id) => id.replaceAll('\\', '/').includes('/node_modules/') ? 'vendor' : undefined,
      },
    },
  },
});
