import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/login': 'http://localhost:3000',
      '/logout': 'http://localhost:3000',
    },
  },
  build: {
    outDir: '../public',
    // The on-site relay Mac runs macOS Sierra (Safari 12) — transpile syntax
    // like ?. / ?? down so the app still loads there.
    target: ['es2017', 'safari12'],
    emptyOutDir: true,
  },
});
