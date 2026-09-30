import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

/** Strict CSP for the packaged renderer (dev server needs inline scripts for HMR). */
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
function cspPlugin(): Plugin {
  return {
    name: 'eventkit-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<head>',
        `<head>
    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  main: {
    build: {
      // Bundle everything (all deps are devDependencies) so the packaged app
      // needs no node_modules and pnpm symlinks never reach electron-builder.
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        external: ['electron'],
      },
    },
    resolve: { alias: { '@common': resolve(__dirname, 'src/common') } },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        external: ['electron'],
        // Sandboxed preloads must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
    resolve: { alias: { '@common': resolve(__dirname, 'src/common') } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
    resolve: { alias: { '@common': resolve(__dirname, 'src/common') } },
    plugins: [react(), tailwindcss(), cspPlugin()],
  },
});
