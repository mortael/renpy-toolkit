import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    exclude: ['pyodide'],
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
  },
});