import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: process.env.DRAW_BASE_PATH || '/',
  server: {
    host: '127.0.0.1',
    strictPort: true,
    allowedHosts: (process.env.DRAW_ALLOWED_HOSTS || '').split(',').filter(Boolean),
  },
  build: {
    outDir: 'dist-preview',
    rollupOptions: {
      input: {
        workbench: fileURLToPath(new URL('./index.html', import.meta.url)),
        preview: fileURLToPath(new URL('./preview.html', import.meta.url)),
      },
    },
  },
});
