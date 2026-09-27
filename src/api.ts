export type RoleName = 'admin' | 'user';

export interface SessionUser {
  id: number;
  email: string;
  role: RoleName;
  expiresAt: string | null;
  forcePasswordReset: boolean;
  active: boolean;
  assignedModelIds: string[];
}

export interface Session {
  token: string;
  user: SessionUser;
}

export type Vec3 = [number, number, number];

export interface ModelTransformRecord {
  normalization?: 'slot-v1';
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

export interface ModelBoundsRecord {
  min: Vec3;
  max: Vec3;
  size: Vec3;
  center: Vec3;
}

export interface AccessibleModel {
  id: string;
  kind: string;
  name: string;
  detail: string;
  modelPath: string;
  powerWatts: number;
  metadata: Record<string, unknown>;
  transform: ModelTransformRecord;
  bounds: ModelBoundsRecord | null;
  product: unknown;
  isBuiltin: boolean;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminUser extends SessionUser {
  createdAt: string;
  updatedAt: string;
}

const STORAGE_KEY = 'buildit.session';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export function getSession(): Session | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as Session;
    if (!session.token || !session.user?.role) return null;
    return session;
  } catch {
    return null;
  }
}

export function setSession(session: Session): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export async function apiRequest<T>(path: string, options: {
  method?: string;
  body?: unknown;
  token?: string;
} = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const token = options.token ?? getSession()?.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`/api${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = response.status === 204 ? '' : await response.text();
  const payload = text ? safeJson(text) : null;
  if (!response.ok) {
    if (response.status === 401) clearSession();
    throw new ApiError(response.status, apiErrorMessage(response, payload, text));
  }
  return payload as T;
}

export async function apiFormRequest<T>(path: string, formData: FormData, method = 'POST'): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getSession()?.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`/api${path}`, { method, headers, body: formData });
  const text = response.status === 204 ? '' : await response.text();
  const payload = text ? safeJson(text) : null;
  if (!response.ok) {
    if (response.status === 401) clearSession();
    throw new ApiError(response.status, apiErrorMessage(response, payload, text));
  }
  return payload as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function apiErrorMessage(response: Response, payload: unknown, text: string): string {
  const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  const nestedError = body?.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : null;
  const message = nestedError?.message ?? body?.message;
  if (typeof message === 'string' && message.trim()) return message;
  const fallback = text.trim().replace(/\s+/g, ' ').slice(0, 180);
  return fallback || `${response.status} ${response.statusText || 'Request failed'}`;
}

export async function login(path: '/auth/login' | '/admin/login', email: string, password: string): Promise<Session> {
  const session = await apiRequest<Session>(path, { body: { email, password } });
  setSession(session);
  return session;
}

