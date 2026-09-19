import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The app talks to /api and Vite forwards it, so there is one origin in
    // development and no CORS preflight on every request.
    proxy: {
      '/api': {
        target: process.env.API_URL ?? 'http://127.0.0.1:4000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Charts are heavy and only two routes use them. Splitting them out
        // keeps the entry bundle small for the pages most people open first.
        manualChunks: {
          charts: ['recharts'],
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
