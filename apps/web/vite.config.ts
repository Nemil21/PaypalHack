import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, defaultClientConditions, type ProxyOptions } from 'vite';

// The API (apps/api) serves the built app on the same origin in every deployed environment (M31).
// In dev, Vite proxies the API prefixes to it so the browser still sees one origin: cookies,
// SSE and HF-006's Origin check behave exactly as in production.
const apiOrigin = `http://localhost:${process.env.API_PORT ?? process.env.PORT ?? 3000}`;

const toApi: ProxyOptions = {
  target: apiOrigin,
  // Origin check (HF-006): present the request as coming from the API's own origin.
  configure(proxy) {
    proxy.on('proxyReq', (proxyReq) => {
      if (proxyReq.getHeader('origin')) proxyReq.setHeader('origin', apiOrigin);
    });
  },
};

// `source` resolves workspace packages to their TypeScript sources, so the browser bundle is
// built from packages/shared/src directly. No Node polyfills are configured: if shared ever
// imports a Node built-in, this build breaks (see HF-001).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ['source', ...defaultClientConditions] },
  server: {
    port: 5173,
    proxy: { '/api': toApi, '/mcp': toApi, '/webhooks': toApi },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // AG Grid / Charts / Studio are large by nature; they load lazily, off the first paint.
    chunkSizeWarningLimit: 4000,
  },
});
