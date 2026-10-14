import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: './',
  build: {
    outDir: 'extension-dist',
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        extension: fileURLToPath(new URL('./src/st-extension.js', import.meta.url)),
        ui: fileURLToPath(new URL('./extension-ui.html', import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => chunk.name === 'extension' ? 'index.js' : 'assets/[name]-[hash].js',
      },
    },
  },
});
