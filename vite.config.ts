import { defineConfig } from 'vite';

export default defineConfig({
  base: '/ifc-viewer-thatopen/',
  server: {
    port: 3000,
    open: true,
  },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 10000,
  },
});
