import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    // Les tuiles (~1,5 Go) ne sont pas recopiées à chaque build : elles sont
    // déployées séparément depuis public/ (voir tools/package.ps1 et README).
    copyPublicDir: false,
  },
});
