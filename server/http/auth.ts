import type { NextFunction, Request, Response } from 'express';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { findUserById, sessionVersion, type RoleName, type SafeUser } from '../db/database.js';
import { HttpError } from './errors.js';
export interface AuthenticatedRequest extends Request {
    user: SafeUser;
    requestId: string;
}
export interface SessionPayload {
    token: string;
    user: SafeUser;
}
export async function createSession(user: SafeUser): Promise<SessionPayload> {
    const options: SignOptions = { expiresIn: config.jwtExpiresIn as SignOptions['expiresIn'] };
    const token = jwt.sign({ sub: String(user.id), version: (await sessionVersion(user.id)) }, config.jwtSecret, options);
    return { token, user };
}
export async function authenticate(request: Request, _response: Response, next: NextFunction): Promise<void> {
    const header = request.get('authorization') ?? '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match)
        throw new HttpError(401, 'Missing bearer token.');
    try {
        const payload = jwt.verify(match[1], config.jwtSecret, { algorithms: ['HS256'] });
        const subject = typeof payload === 'object' && payload.sub ? Number(payload.sub) : NaN;
        if (!Number.isInteger(subject))
            throw new HttpError(401, 'Invalid token subject.');
        const user = (await findUserById(subject));
        if (!user)
            throw new HttpError(401, 'User no longer exists.');
        if (typeof payload !== 'object' || payload.version !== (await sessionVersion(user.id)))
            throw new HttpError(401, 'Please sign in again.');
        if (!user.active)
            throw new HttpError(403, 'Account access has expired.');
        const authenticated = request as AuthenticatedRequest;
        authenticated.user = user;
        authenticated.requestId = randomUUID();
        next();
    }
    catch (error) {
        if (error instanceof HttpError)
            throw error;
        throw new HttpError(401, 'Invalid or expired token.');
    }
}
export function requireRole(role: RoleName) {
    return (request: Request, _response: Response, next: NextFunction): void => {
        const user = (request as AuthenticatedRequest).user;
        if (!user || user.role !== role)
            throw new HttpError(403, `${role} access is required.`);
        next();
    };
}
export function requirePasswordReady(request: Request, _response: Response, next: NextFunction): void {
    const user = (request as AuthenticatedRequest).user;
    if (user?.forcePasswordReset)
        throw new HttpError(428, 'Password reset is required before continuing.');
    next();
}
