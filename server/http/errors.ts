import type { NextFunction, Request, Response } from 'express';

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly details?: unknown) {
    super(message);
  }
}

export const asyncRoute = (
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void> | void,
) => (request: Request, response: Response, next: NextFunction): void => {
  Promise.resolve(handler(request, response, next)).catch(next);
};

export function errorHandler(error: unknown, _request: Request, response: Response, _next: NextFunction): void {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : 'Unexpected error';
  response.status(status).json({
    error: {
      message: status >= 500 ? 'Internal server error' : message,
      details: error instanceof HttpError ? error.details : undefined,
    },
  });
}
