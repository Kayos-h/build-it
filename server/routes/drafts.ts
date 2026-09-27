import { supabase, check } from '../db/supabase.js';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { findModelById, userCanAccessModel, type SafeUser } from '../db/database.js';
import { authenticate, requirePasswordReady, type AuthenticatedRequest } from '../http/auth.js';
import { asyncRoute, HttpError } from '../http/errors.js';
import { requireString } from '../http/validation.js';
import { PRODUCT_KINDS, type HardwareConfiguration } from '../../src/config/products.js';
import { SOFTWARE_PROFILES } from '../../src/config/software.js';
import type { DraftCamera, DraftState, SavedDraft } from '../../src/config/drafts.js';

export const draftsRouter = Router();
draftsRouter.use('/drafts', authenticate, requirePasswordReady);
interface DraftRow { id: string; name: string; state: DraftState; revision: number; created_at: string; updated_at: string }
function fromRow(row: DraftRow): SavedDraft {
  return { id: row.id, name: row.name, state: row.state, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
}
async function ownedDraft(id: string, userId: number): Promise<SavedDraft> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'Draft not found.');
  const {data,error} = await supabase.from('buildit_drafts').select('*').eq('id',id).eq('user_id',userId).maybeSingle(); check(error);
  if(!data) throw new HttpError(404,'Draft not found.'); return fromRow(data);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Invalid draft data.');
  return value as Record<string, unknown>;
}
function camera(value: unknown): DraftCamera | null {
  if (value === undefined || value === null) return null;
  const input = object(value);
  const vector = (v: unknown): [number, number, number] => {
    if (!Array.isArray(v) || v.length !== 3 || !v.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100)) throw new HttpError(400, 'Invalid camera position.');
    return [v[0], v[1], v[2]];
  };
  const position = vector(input.position), target = vector(input.target);
  if (Math.hypot(...position.map((value, index) => value - target[index])) < .001) throw new HttpError(400, 'Camera must be outside its target.');
  return { position, target };
}
async function stateFrom(value: unknown, user: SafeUser, previous?: SavedDraft): Promise<DraftState> {
  const input = object(value), selections = object(input.configuration);
  const configuration = {} as HardwareConfiguration;
  const products: DraftState['products'] = {};
  for (const kind of PRODUCT_KINDS) {
    const id = selections[kind];
    if (typeof id !== 'string' || id.length > 100) throw new HttpError(400, `Invalid ${kind} selection.`);
    configuration[kind] = id;
    if (!id) continue;
    const model = await findModelById(id);
    if (!model || model.kind !== kind || !userCanAccessModel(user, id)) throw new HttpError(400, `The selected ${kind} is unavailable. Choose an accessible model before saving.`);
    // Retain the exact calibration and hardware specs of an unchanged draft SKU.
    products[kind] = previous?.state.products[kind]?.id === id ? previous.state.products[kind] : model.product;
  }
  if (!Array.isArray(input.software) || !input.software.every(id => typeof id === 'string' && SOFTWARE_PROFILES.some(app => app.id === id))) throw new HttpError(400, 'Select supported applications.');
  if (typeof input.rgb !== 'string' || !/^#[\da-f]{6}$/i.test(input.rgb)) throw new HttpError(400, 'Invalid lighting color.');
  return { version: 1, configuration, products, software: [...new Set(input.software)] as string[], rgb: input.rgb, camera: camera(input.camera) };
}
async function responseFor(draft: SavedDraft, user: SafeUser) {
  const unavailableModelIds: string[] = [];
  for(const id of Object.values(draft.state.configuration)) if(id && (!userCanAccessModel(user,id) || !await findModelById(id))) unavailableModelIds.push(id);
  return {draft, unavailableModelIds};
}
draftsRouter.get('/drafts', asyncRoute(async (request,response) => {
  const {data,error} = await supabase.from('buildit_drafts').select('*').eq('user_id',(request as AuthenticatedRequest).user.id).order('updated_at',{ascending:false}); check(error);
  response.json({drafts:(data ?? []).map(fromRow)});
}));
draftsRouter.get('/drafts/:id', asyncRoute(async (request,response) => {
  const user=(request as AuthenticatedRequest).user;
  response.json(await responseFor(await ownedDraft(String(request.params.id),user.id),user));
}));
draftsRouter.post('/drafts', asyncRoute(async (request,response) => {
  const user=(request as AuthenticatedRequest).user;
  const name=requireString(request.body?.name,'Draft name',120);
  const original=request.body?.copyOf ? await ownedDraft(requireString(request.body.copyOf,'copyOf',100),user.id) : undefined;
  const state=await stateFrom(request.body?.state,user,original);
  const {data,error}=await supabase.from('buildit_drafts').insert({id:randomUUID(),user_id:user.id,name,state}).select('*').single(); check(error);
  response.status(201).json(await responseFor(fromRow(data),user));
}));
draftsRouter.put('/drafts/:id', asyncRoute(async (request,response) => {
  const user=(request as AuthenticatedRequest).user;
  const previous=await ownedDraft(String(request.params.id),user.id);
  if(request.body?.revision!==previous.revision) throw new HttpError(409,'Draft changed. Reload it or save a copy.');
  const name=requireString(request.body?.name,'Draft name',120),state=await stateFrom(request.body?.state,user,previous);
  const {data,error}=await supabase.from('buildit_drafts').update({name,state,revision:previous.revision+1,updated_at:new Date().toISOString()}).eq('id',previous.id).eq('user_id',user.id).eq('revision',previous.revision).select('*').maybeSingle(); check(error);
  if(!data) throw new HttpError(409,'Draft changed. Reload it or save a copy.');
  response.json(await responseFor(fromRow(data),user));
}));
draftsRouter.delete('/drafts/:id', asyncRoute(async (request,response) => {
  const user=(request as AuthenticatedRequest).user;
  const previous=await ownedDraft(String(request.params.id),user.id);
  if(request.body?.revision!==previous.revision) throw new HttpError(409,'Draft changed. Reload before deleting.');
  const {data,error}=await supabase.from('buildit_drafts').delete().eq('id',previous.id).eq('user_id',user.id).eq('revision',previous.revision).select('id'); check(error);
  if(!data?.length) throw new HttpError(409,'Draft changed. Reload before deleting.');
  response.status(204).end();
}));
