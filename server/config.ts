import dotenv from 'dotenv';
import { resolve } from 'node:path';

dotenv.config();

const booleanFromEnv = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const csv = (value: string | undefined): string[] => {
  if (!value) return [];
  return value.split(',').map(item => item.trim()).filter(Boolean);
};

export const config = {
  supabaseUrl: process.env.SUPABASE_URL ?? '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  modelBucket: process.env.SUPABASE_MODEL_BUCKET ?? 'buildit-models',
  port: Number(process.env.PORT ?? process.env.API_PORT ?? 3000),
  appOrigin: process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173',
  databaseFile: resolve(process.cwd(), process.env.DATABASE_FILE ?? './data/app.sqlite'),
  catalogModelDir: resolve(process.cwd(), process.env.CATALOG_MODEL_DIR ?? './data/models/catalog'),
  uploadedModelDir: resolve(process.cwd(), process.env.UPLOADED_MODEL_DIR ?? './data/uploads/models'),
  uploadedModelBasePath: process.env.UPLOADED_MODEL_BASE_PATH ?? 'custom',
  jwtSecret: process.env.JWT_SECRET ?? 'development-only-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
  seedAdminEmail: process.env.SEED_ADMIN_EMAIL ?? 'admin@gmail.com',
  seedAdminPassword: process.env.SEED_ADMIN_PASSWORD ?? 'admin123',
  seedAdminForcePasswordReset: booleanFromEnv(process.env.SEED_ADMIN_FORCE_PASSWORD_RESET, true),
  defaultUserModelIds: csv(process.env.DEFAULT_USER_MODEL_IDS),
};

if (config.jwtSecret === 'development-only-change-me' && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production.');
}
