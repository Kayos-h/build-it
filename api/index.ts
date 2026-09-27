import type { Request, Response } from 'express';
import { createApp } from '../server/index.js';

let app: ReturnType<typeof createApp> | undefined;
export default async function handler(request: Request, response: Response) {
  try {
    app ??= createApp().catch(error => { app = undefined; throw error; });
    (await app)(request, response);
  } catch (error) {
    console.error('API startup failed', error instanceof Error ? error.message : 'unknown');
    response.status(503).json({ message: 'Service is temporarily unavailable. Please retry.' });
  }
}
