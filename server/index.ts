import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { initializeDatabase } from './db/database.js';
import { errorHandler } from './http/errors.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { modelsRouter } from './routes/models.js';
import { draftsRouter } from './routes/drafts.js';

export async function createApp(): Promise<express.Express> {
  await initializeDatabase();
  const app = express();
  app.disable('x-powered-by');

  app.use((_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  app.use((request, response, next) => {
    const origin = request.get('origin');
    if (origin && [config.appOrigin, 'http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    }
    if (request.method === 'OPTIONS') {
      response.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '1mb' }));
  app.get('/api/health', (_request, response) => response.json({ ok: true }));
  app.use('/api', (_request, response, next) => { response.setHeader('Cache-Control', 'no-store'); next(); });
  app.use('/api', authRouter, adminRouter, draftsRouter, modelsRouter);
  app.use('/api', (_request, response) => response.status(404).json({ message: 'API route not found.' }));
  app.use('/draco', express.static(join(process.cwd(), 'public/draco')));

  const dist = join(process.cwd(), 'dist');
  if (process.env.NODE_ENV === 'production' && existsSync(dist)) {
    app.use(express.static(dist));
    app.get('*splat', (_request, response) => response.sendFile(join(dist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}

export async function startServer(): Promise<void> {
  const app = await createApp();
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`API server listening on http://127.0.0.1:${config.port}`);
  });
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entry) {
  startServer().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
