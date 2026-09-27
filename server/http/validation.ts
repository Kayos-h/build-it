import { HttpError } from './errors.js';

export function requireString(value: unknown, field: string, maxLength = 2000): string {
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) throw new HttpError(400, `${field} is required.`);
  if (trimmed.length > maxLength) throw new HttpError(400, `${field} is too long.`);
  return trimmed;
}

export function optionalString(value: unknown, field: string, maxLength = 2000): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireString(value, field, maxLength);
}

export function requireEmail(value: unknown): string {
  const email = requireString(value, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  return email;
}

export function requirePassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  if (Buffer.byteLength(value, 'utf8') > 72) throw new HttpError(400, 'Password must be at most 72 UTF-8 bytes.');
  return value;
}

export function optionalIsoTimestamp(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const timestamp = requireString(value, 'expiresAt', 80);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) throw new HttpError(400, 'expiresAt must be a valid ISO timestamp.');
  return new Date(parsed).toISOString();
}

export function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new HttpError(400, `${field} must be a boolean.`);
  return value;
}

export function optionalModelIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new HttpError(400, 'modelIds must be an array.');
  const ids = value.map((item, index) => requireString(item, `modelIds[${index}]`, 80));
  return [...new Set(ids)];
}
