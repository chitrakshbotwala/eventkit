import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target =
    process.env['VITE_PROXY_TARGET'] ?? env['VITE_PROXY_TARGET'] ?? 'http://localhost:8080';
  const port = Number(process.env['ADMIN_DEV_PORT'] ?? 5173);
  // changeOrigin stays false so the Origin header (localhost:<port>) reaches the server's CSRF check.
  const proxy = { target, changeOrigin: false, ws: false };
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port,
      strictPort: true,
      proxy: { '/api': proxy, '/admin': proxy, '/auth': proxy, '/mirror': proxy },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 700,
    },
  };
});
