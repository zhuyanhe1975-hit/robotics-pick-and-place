import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const LOG_DIR = path.resolve(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'experiment-log.jsonl');
const PAGES_BASE = '/robotics-pick-and-place/';

function createExperimentLogMiddleware() {
  return async (req: { method?: string; url?: string; on: (event: string, cb: (chunk?: Buffer) => void) => void }, res: { statusCode: number; setHeader: (name: string, value: string) => void; end: (body?: string) => void }, next: () => void) => {
    if (!req.url?.startsWith('/api/experiment-logs')) {
      next();
      return;
    }

    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET') {
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? '50') || 50));

      try {
        const content = await fs.readFile(LOG_FILE, 'utf8').catch(() => '');
        const entries = content
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .slice(-limit);

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ entries }));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to read experiment logs' }));
      }
      return;
    }

    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk?.toString?.() ?? '';
    });
    req.on('end', async () => {
      try {
        await fs.mkdir(LOG_DIR, { recursive: true });
        const payload = body ? JSON.parse(body) : {};
        const entry = {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          ...payload,
        };
        await fs.appendFile(LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8');

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, entry }));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to persist experiment log' }));
      }
    });
  };
}

function experimentLogPlugin() {
  const middleware = createExperimentLogMiddleware();

  return {
    name: 'experiment-log-plugin',
    configureServer(server: { middlewares: { use: (handler: (req: never, res: never, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        void middleware(req, res, next);
      });
    },
    configurePreviewServer(server: { middlewares: { use: (handler: (req: never, res: never, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        void middleware(req, res, next);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  // Absent key stays an empty string so `vite build` succeeds with no .env.
  // A real key is only read from a local, gitignored env file and is never
  // required for the static GitHub Pages bundle.
  const nuwaApiKey = env.NUWA_API_KEY ?? '';

  return {
    // Dev stays at /. Production matches the GitHub Pages project path.
    // `npm run build -- --base ` still overrides this in Actions.
    base: mode === 'production' ? PAGES_BASE : '/',
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [react(), experimentLogPlugin()],
    define: {
      'process.env.NUWA_API_KEY': JSON.stringify(nuwaApiKey),
      'process.env.NUWA_BASE_URL': JSON.stringify(env.NUWA_BASE_URL ?? ''),
      'process.env.NUWA_MODEL': JSON.stringify(env.NUWA_MODEL ?? ''),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
  };
});
