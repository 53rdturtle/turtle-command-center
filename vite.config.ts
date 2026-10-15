import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { DEV_PORT, PORT } from './server/config.ts';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    // The API only accepts this exact port as a proxied Origin, so don't drift to another one.
    port: DEV_PORT,
    strictPort: true,
    // The string form sets changeOrigin, so the API sees Host 127.0.0.1:PORT; the browser's Origin
    // (http://localhost:DEV_PORT) passes through and is checked by server/guard.ts. Vite itself rejects foreign Hosts.
    proxy: { '/api': `http://127.0.0.1:${PORT}` },
  },
});
