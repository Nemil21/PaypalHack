import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { testCardAllowed, type Config } from '@holdfast/core';

/**
 * Same-origin web app (M31, HF-007). The API serves the built SPA from `apps/web/dist`, so the
 * session cookie (SameSite=Lax), SSE and HF-006's Origin check all see one origin. No separate
 * static site.
 *
 *   - Files in dist are served as-is; hashed `/assets/*` are cached forever, `index.html` never.
 *   - Any other GET that accepts HTML and isn't under an API prefix gets `index.html`, so client
 *     routes like `/brand/listings/123` or `/o/aurel-a7` survive a reload.
 *   - API prefixes and asset-looking paths get a JSON 404 in the api.md error envelope.
 */

/** Paths the SPA must never shadow. */
const API_PREFIXES = ['/api', '/mcp', '/webhooks'];

/** Default location: `apps/web/dist`, from both `apps/api/src` (tsx) and `apps/api/dist` (node). */
export const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url));

export interface ClientConfig {
  /**
   * AG Grid / AG Charts / AG Studio licence. It has to reach the browser to remove the watermark;
   * serving it at runtime keeps it out of the repo and the build output.
   */
  agGridLicenseKey: string | null;
  demoMode: boolean;
  /**
   * PayPal's public client id for the JS SDK v6 card fields (HF-019). Public by design (S7 served
   * it the same way); null with the `FakePayPal` stub, where the browser SDK has nothing to call.
   */
  paypalClientId: string | null;
  /** Load the sandbox SDK host (`www.sandbox.paypal.com`). */
  paypalSandbox: boolean;
  /** The labelled "Use sandbox test card" button: core `testCardAllowed` (HF-014b Part 1). */
  testCardEnabled: boolean;
}

function isApiPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

function looksLikeFile(url: string): boolean {
  const last = (url.split('?')[0] ?? '').split('/').pop() ?? '';
  return /\.[a-z0-9]+$/i.test(last);
}

/** Synchronous: `register` is queued and loaded on `ready()`, so `buildServer` stays sync. */
export function registerWebApp(
  app: FastifyInstance,
  config: Config,
  webDistDir: string | null = DEFAULT_WEB_DIST,
): void {
  app.get('/api/client-config', async (_req, reply): Promise<ClientConfig> => {
    reply.header('Cache-Control', 'no-store');
    return {
      agGridLicenseKey: config.AG_GRID_LICENSE_KEY ?? null,
      demoMode: config.DEMO_MODE,
      paypalClientId: config.PAYPAL_MODE === 'stub' ? null : config.PAYPAL_CLIENT_ID,
      paypalSandbox: config.paypalIsSandbox,
      testCardEnabled: testCardAllowed(config),
    };
  });

  const indexPath = webDistDir ? join(webDistDir, 'index.html') : null;
  const hasBuild = indexPath !== null && existsSync(indexPath);

  if (hasBuild) {
    const assetsDir = join(webDistDir!, 'assets');
    void app.register(fastifyStatic, {
      root: webDistDir!,
      // Register a route per built file; unknown paths fall through to the handler below.
      wildcard: false,
      index: false,
      // We set Cache-Control ourselves below.
      cacheControl: false,
      setHeaders(res, path) {
        res.setHeader(
          'Cache-Control',
          path.startsWith(assetsDir) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  } else if (config.NODE_ENV !== 'test') {
    app.log.warn(
      'apps/web/dist not found: the API is running without the web app. Run `npm run build -w @holdfast/web`, or use the Vite dev server.',
    );
  }

  app.setNotFoundHandler((req, reply) => {
    const wantsHtml = (req.headers.accept ?? '').includes('text/html');
    const isPage =
      (req.method === 'GET' || req.method === 'HEAD') &&
      !isApiPath(req.url) &&
      !looksLikeFile(req.url) &&
      wantsHtml;

    if (isPage && hasBuild) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    if (isPage) {
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send('The web app is not built. Run `npm run build -w @holdfast/web`.');
    }
    return reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.url.split('?')[0]}` },
    });
  });
}
