import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { findUserByEmail, findUserById, updatePassword } from '../db/database.js';
import { asyncRoute, HttpError } from '../http/errors.js';
import { authenticate, createSession, type AuthenticatedRequest } from '../http/auth.js';
import { requireEmail, requirePassword } from '../http/validation.js';
export const authRouter = Router();
const dummyHash = bcrypt.hash(randomUUID(), 12);
const attempts = new Map<string, {
    count: number;
    until: number;
}>();
const throttle: RequestHandler = (request, response, next) => {
    const now = Date.now();
    for (const [key, entry] of attempts)
        if (entry.until <= now)
            attempts.delete(key);
    const key = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    const entry = attempts.get(key) ?? { count: 0, until: now + 15 * 60000 };
    if (entry.count >= 30) {
        response.setHeader('Retry-After', Math.ceil((entry.until - now) / 1000));
        throw new HttpError(429, 'Too many sign-in attempts. Try again later.');
    }
    entry.count++;
    attempts.set(key, entry);
    next();
};
function loginPassword(value: unknown): string {
    if (typeof value !== 'string' || !value.length || Buffer.byteLength(value, 'utf8') > 72) {
        throw new HttpError(401, 'Invalid email or password.');
    }
    return value;
}
async function signIn(email: string, password: string, adminOnly = false) {
    const user = (await findUserByEmail(email));
    const valid = await bcrypt.compare(password, user?.passwordHash ?? await dummyHash);
    if (!user || !valid || adminOnly && user.role !== 'admin')
        throw new HttpError(401, 'Invalid email or password.');
    if (!user.active)
        throw new HttpError(403, 'Account access has expired. Contact your administrator.');
    const safeUser = (await findUserById(user.id));
    if (!safeUser)
        throw new HttpError(401, 'Invalid email or password.');
    return (await createSession(safeUser));
}
authRouter.post('/auth/login', throttle, asyncRoute(async (request, response) => {
    response.json(await signIn(requireEmail(request.body?.email), loginPassword(request.body?.password)));
}));
authRouter.post('/admin/login', throttle, asyncRoute(async (request, response) => {
    response.json(await signIn(requireEmail(request.body?.email), loginPassword(request.body?.password), true));
}));
authRouter.get('/auth/me', authenticate, asyncRoute(async (request, response) => {
    response.json({ user: (request as AuthenticatedRequest).user });
}));
authRouter.post('/auth/password', authenticate, throttle, asyncRoute(async (request, response) => {
    const authenticated = request as AuthenticatedRequest;
    const currentPassword = loginPassword(request.body?.currentPassword);
    const newPassword = requirePassword(request.body?.newPassword);
    const user = (await findUserByEmail(authenticated.user.email));
    if (!user || !await bcrypt.compare(currentPassword, user.passwordHash))
        throw new HttpError(401, 'Current password is incorrect.');
    if (currentPassword === newPassword)
        throw new HttpError(400, 'Choose a different password.');
    (await updatePassword(user.id, await bcrypt.hash(newPassword, 12)));
    const updated = (await findUserById(user.id))!;
    response.json((await createSession(updated)));
}));
