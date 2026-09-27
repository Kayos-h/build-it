import bcrypt from 'bcryptjs';
import { supabase, check } from './supabase.js';
import { config } from '../config.js';
import { productFromHardwareModel } from '../hardware/catalog.js';
import { DEFAULT_MODEL_TRANSFORM, normalizeModelBounds, normalizeModelTransform, type StoredModelBounds, type StoredModelTransform } from '../hardware/calibration.js';
import type { Product, ProductKind } from '../../src/config/products.js';
import type { BoardMountLayout } from '../../src/core/types.js';
export type RoleName = 'admin' | 'user';

interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  role_name: RoleName;
  expires_at: string | null;
  force_password_reset: number;
  created_at: string;
  updated_at: string;
}

export interface SafeUser {
  id: number;
  email: string;
  role: RoleName;
  expiresAt: string | null;
  forcePasswordReset: boolean;
  createdAt: string;
  updatedAt: string;
  active: boolean;
  assignedModelIds: string[];
}

export interface ModelRecord {
  id: string;
  kind: ProductKind;
  name: string;
  detail: string;
  modelPath: string;
  powerWatts: number;
  metadata: Record<string, unknown>;
  transform: StoredModelTransform;
  bounds: StoredModelBounds | null;
  product: Product;
  isBuiltin: boolean;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserWithHash extends SafeUser {
  passwordHash: string;
}


const now = () => new Date().toISOString();
const normalizeEmail = (email: string) => email.trim().toLowerCase();
async function safeUser(row: any): Promise<SafeUser> {
  return { id: row.id, email: row.email, role: row.role, expiresAt: row.expires_at,
    forcePasswordReset: Boolean(row.force_password_reset), createdAt: row.created_at, updatedAt: row.updated_at,
    active: !row.expires_at || Date.parse(row.expires_at) > Date.now(), assignedModelIds: await assignedModelIds(row.id) };
}
export async function initializeDatabase(): Promise<void> {
  // Schema and initial administrator are provisioned once, never mutated on cold starts.
  const { error } = await supabase.from('buildit_users').select('id').limit(1);
  check(error);
}
export async function assignedModelIds(userId: number): Promise<string[]> {
  const { data, error } = await supabase.from('buildit_permissions').select('model_id').eq('user_id', userId);
  check(error); return (data ?? []).map(row => row.model_id);
}
export async function findUserByEmail(email: string): Promise<UserWithHash | null> {
  const { data, error } = await supabase.from('buildit_users').select('*').eq('email', normalizeEmail(email)).maybeSingle();
  check(error); return data ? { ...await safeUser(data), passwordHash: data.password_hash } : null;
}
export async function findUserById(id: number): Promise<SafeUser | null> {
  const { data, error } = await supabase.from('buildit_users').select('*').eq('id', id).maybeSingle();
  check(error); return data ? safeUser(data) : null;
}
export async function createUser(input: { email: string; password: string; role?: RoleName; expiresAt?: string | null; forcePasswordReset?: boolean }): Promise<SafeUser> {
  const { data, error } = await supabase.from('buildit_users').insert({ email: normalizeEmail(input.email),
    password_hash: await bcrypt.hash(input.password, 12), role: input.role ?? 'user', expires_at: input.expiresAt ?? null,
    force_password_reset: input.forcePasswordReset ?? false }).select('*').single();
  check(error); return safeUser(data);
}
export async function updateUser(id: number, input: { email?: string; password?: string; role?: RoleName; expiresAt?: string | null; forcePasswordReset?: boolean }): Promise<SafeUser | null> {
  const existing = await findUserById(id); if (!existing) return null;
  const updates: Record<string, unknown> = { updated_at: now() };
  if(input.email !== undefined) updates.email = normalizeEmail(input.email);
  if(input.role !== undefined) updates.role = input.role;
  if(input.expiresAt !== undefined) updates.expires_at = input.expiresAt;
  if(input.forcePasswordReset !== undefined) updates.force_password_reset = input.forcePasswordReset;
  if(input.password) updates.password_hash = await bcrypt.hash(input.password, 12);
  const { error } = await supabase.from('buildit_users').update(updates).eq('id', id); check(error);
  return findUserById(id);
}
export async function deleteUser(id: number): Promise<boolean> {
  const { data, error } = await supabase.from('buildit_users').delete().eq('id', id).select('id'); check(error); return Boolean(data?.length);
}
export async function listUsers(): Promise<SafeUser[]> {
  const { data, error } = await supabase.from('buildit_users').select('*').order('created_at', {ascending:false}); check(error);
  return Promise.all((data ?? []).map(safeUser));
}
export async function updatePassword(userId: number, passwordHash: string): Promise<void> {
  const { error } = await supabase.from('buildit_users').update({password_hash: passwordHash, force_password_reset:false, updated_at: now()}).eq('id',userId); check(error);
}
export async function sessionVersion(userId: number): Promise<number> {
  const { data,error } = await supabase.from('buildit_users').select('session_version').eq('id',userId).maybeSingle(); check(error); return data?.session_version ?? -1;
}
function toModelRecord(row: any): ModelRecord {
  const input = {id:row.id, kind:row.kind as ProductKind, name:row.name, detail:row.detail, modelPath:row.model_path,
    powerWatts:row.power_watts, metadata:row.metadata ?? {}, transform:normalizeModelTransform(row.transform), bounds:row.bounds ? normalizeModelBounds(row.bounds) : null};
  return {...input, product:productFromHardwareModel(input), isBuiltin:row.is_builtin, createdBy:row.created_by, createdAt:row.created_at, updatedAt:row.updated_at};
}
export async function createHardwareModel(model: { id: string; kind: ProductKind; name: string; detail: string; modelPath: string; powerWatts: number; metadata: Record<string, unknown>; transform?: StoredModelTransform; bounds?: StoredModelBounds | null; createdBy: number | null }): Promise<ModelRecord> {
  const {data,error} = await supabase.from('buildit_models').insert({id:model.id,kind:model.kind,name:model.name,detail:model.detail,
    model_path:model.modelPath,power_watts:model.powerWatts,metadata:model.metadata,transform:model.transform ?? DEFAULT_MODEL_TRANSFORM,
    bounds:model.bounds ?? null,created_by:model.createdBy}).select('*').single(); check(error); return toModelRecord(data);
}
export async function listModels(): Promise<ModelRecord[]> {
  const {data,error} = await supabase.from('buildit_models').select('*').order('kind').order('name'); check(error); return (data ?? []).map(toModelRecord);
}
export async function findModelById(id: string): Promise<ModelRecord | null> {
  const {data,error} = await supabase.from('buildit_models').select('*').eq('id',id).maybeSingle(); check(error); return data ? toModelRecord(data) : null;
}
export async function deleteHardwareModel(id: string): Promise<ModelRecord | null> {
  const {data,error} = await supabase.from('buildit_models').delete().eq('id',id).select('*').maybeSingle(); check(error); return data ? toModelRecord(data) : null;
}
export async function updateModelTransform(id: string, transform: StoredModelTransform): Promise<ModelRecord | null> {
  const {data,error} = await supabase.from('buildit_models').update({transform:normalizeModelTransform(transform),updated_at:now()}).eq('id',id).select('*').maybeSingle(); check(error); return data ? toModelRecord(data) : null;
}
export async function updateModelBoardMountLayout(id: string, boardMountLayout: BoardMountLayout): Promise<ModelRecord | null> {
  const existing = await findModelById(id); if(!existing || existing.kind !== 'motherboard') return null;
  const {error} = await supabase.rpc('buildit_merge_model_metadata', {model_id:id, patch:{boardMountLayout}}); check(error); return findModelById(id);
}
export async function updateModelComponentPlacements(id: string, placements: Record<string, BoardMountLayout>): Promise<ModelRecord | null> {
  const existing = await findModelById(id); if(!existing || existing.kind !== 'motherboard') return null;
  const {error} = await supabase.rpc('buildit_merge_model_metadata', {model_id:id, patch:{componentPlacements:placements}}); check(error); return findModelById(id);
}
export function userCanAccessModel(user: SafeUser, modelId: string): boolean {
  return user.active && (user.role === 'admin' || user.assignedModelIds.includes(modelId));
}
export async function replaceUserPermissions(userId: number, modelIds: string[], grantedBy: number | null): Promise<string[]> {
  const {error} = await supabase.rpc('buildit_replace_permissions', {target_user:userId, models:[...new Set(modelIds)], actor:grantedBy}); check(error); return assignedModelIds(userId);
}
