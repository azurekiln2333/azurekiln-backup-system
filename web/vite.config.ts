import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [vue()],
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': `http://127.0.0.1:${process.env.BACKUP_API_PORT ?? 16323}` } },
  build: { outDir: 'dist', emptyOutDir: true },
});
