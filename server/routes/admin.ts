import jwt from 'jsonwebtoken';
import { supabase, check } from '../db/supabase.js';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { createHardwareModel, createUser, deleteHardwareModel, deleteUser, findModelById, findUserByEmail, findUserById, listModels, listUsers, replaceUserPermissions, updateModelBoardMountLayout, updateModelComponentPlacements, updateModelTransform, updateUser, } from '../db/database.js';
import { config } from '../config.js';
import { normalizeModelTransform, type StoredModelTransform, type Vec3 } from '../hardware/calibration.js';
import { inspectModelData } from '../hardware/modelInspection.js';
import { authenticate, requirePasswordReady, requireRole, type AuthenticatedRequest } from '../http/auth.js';
import { asyncRoute, HttpError } from '../http/errors.js';
import { optionalBoolean, optionalIsoTimestamp, optionalModelIds, optionalString, requireEmail, requirePassword, } from '../http/validation.js';
import type { ProductKind } from '../../src/config/products.js';
import type { BoardMountId, BoardMountLayout } from '../../src/core/types.js';
export const adminRouter = Router();
const protectedAdminRouter = Router();
protectedAdminRouter.use(authenticate, requireRole('admin'), requirePasswordReady);
function hardwareKind(value: unknown): ProductKind {
    const allowed: ProductKind[] = ['case', 'motherboard', 'cpu', 'cooler', 'ram', 'gpu', 'psu', 'ssd', 'fan'];
    if (typeof value !== 'string' || !allowed.includes(value as ProductKind))
        throw new HttpError(400, 'Select a valid hardware category.');
    return value as ProductKind;
}
function optionalNumber(value: unknown, fallback: number): number {
    if (value === undefined || value === null || value === '')
        return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        throw new HttpError(400, 'powerWatts must be a number.');
    return parsed;
}
function metadataFromForm(value: unknown): Record<string, unknown> {
    if (value === undefined || value === null || value === '')
        return {};
    if (typeof value !== 'string')
        throw new HttpError(400, 'metadata must be JSON text.');
    try {
        const parsed = JSON.parse(value) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('metadata must be an object');
        return parsed as Record<string, unknown>;
    }
    catch {
        throw new HttpError(400, 'metadata must be a valid JSON object.');
    }
}
function transformFromForm(value: unknown): StoredModelTransform | null {
    if (value === undefined || value === null || value === '')
        return null;
    if (typeof value !== 'string')
        throw new HttpError(400, 'transform must be JSON text.');
    try {
        return modelTransform(JSON.parse(value) as unknown);
    }
    catch (error) {
        if (error instanceof HttpError)
            throw error;
        throw new HttpError(400, 'transform must be a valid JSON object.');
    }
}
function transformVec3(value: unknown, field: string, options: {
    positive?: boolean;
} = {}): Vec3 {
    if (!Array.isArray(value) || value.length !== 3)
        throw new HttpError(400, `${field} must be a 3-number array.`);
    const vector = value.map(item => Number(item));
    if (!vector.every(Number.isFinite))
        throw new HttpError(400, `${field} must contain finite numbers.`);
    if (options.positive && vector.some(item => item <= 0))
        throw new HttpError(400, `${field} values must be greater than zero.`);
    return vector as Vec3;
}
const BOARD_MOUNT_IDS: readonly BoardMountId[] = ['motherboard:cpu', 'motherboard:dimm1', 'motherboard:dimm2', 'motherboard:dimm3', 'motherboard:dimm4', 'motherboard:m2-1', 'motherboard:pcie1'];
function boardMountLayoutFromBody(value: unknown): BoardMountLayout {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new HttpError(400, 'boardMountLayout must be an object.');
    const layout: BoardMountLayout = {};
    for (const [key, item] of Object.entries(value)) {
        if (!BOARD_MOUNT_IDS.includes(key as BoardMountId))
            throw new HttpError(400, `Unknown motherboard mount: ${key}.`);
        if (!item || typeof item !== 'object' || Array.isArray(item))
            throw new HttpError(400, `Mount ${key} must be an object.`);
        const record = item as Record<string, unknown>;
        const position = transformVec3(record.position, `${key}.position`);
        const rotation = record.rotation === undefined ? undefined : transformVec3(record.rotation, `${key}.rotation`);
        if ([...position, ...(rotation ?? [])].some(number => Math.abs(number) > 1))
            throw new HttpError(400, `Mount ${key} coordinates must be within one metre / radian unit.`);
        layout[key as BoardMountId] = rotation ? { position, rotation } : { position };
    }
    if (!Object.keys(layout).length)
        throw new HttpError(400, 'At least one motherboard mount is required.');
    return layout;
}
function modelTransform(value: unknown): StoredModelTransform {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new HttpError(400, 'transform must be an object.');
    const source = value as Record<string, unknown>;
    return normalizeModelTransform({
        normalization: source.normalization,
        position: transformVec3(source.position, 'transform.position'),
        rotation: transformVec3(source.rotation, 'transform.rotation'),
        scale: transformVec3(source.scale, 'transform.scale', { positive: true }),
    });
}
function accountRole(value: unknown): 'admin' | 'user' {
    if (value !== 'admin' && value !== 'user')
        throw new HttpError(400, 'Role must be admin or user.');
    return value;
}
async function protectAdminAccess(userId: number, role: 'admin' | 'user', expiresAt: string | null | undefined, actorId: number): Promise<void> {
    if (userId === actorId && (role !== 'admin' || expiresAt))
        throw new HttpError(400, 'You cannot remove or expire your own administrator access.');
    const current = (await findUserById(userId));
    if (current?.role === 'admin' && (role !== 'admin' || expiresAt)) {
        if (!(await listUsers()).some(user => user.id !== userId && user.role === 'admin' && user.active && !user.expiresAt)) {
            throw new HttpError(400, 'Keep at least one active administrator with permanent access.');
        }
    }
}
async function ensureKnownModelIds(modelIds: string[]): Promise<void> {
    const known = new Set((await listModels()).map(model => model.id));
    const unknown = modelIds.filter(modelId => !known.has(modelId));
    if (unknown.length)
        throw new HttpError(400, 'Unknown model ID.', { modelIds: unknown });
}
protectedAdminRouter.get('/users', asyncRoute(async (_request, response) => {
    response.json({ users: (await listUsers()), models: (await listModels()) });
}));
protectedAdminRouter.post('/users', asyncRoute(async (request, response) => {
    const admin = (request as AuthenticatedRequest).user;
    const email = requireEmail(request.body?.email);
    const password = requirePassword(request.body?.password);
    const expiresAt = optionalIsoTimestamp(request.body?.expiresAt);
    const forcePasswordReset = optionalBoolean(request.body?.forcePasswordReset, 'forcePasswordReset') ?? false;
    const modelIds = optionalModelIds(request.body?.modelIds) ?? [];
    (await ensureKnownModelIds(modelIds));
    if ((await findUserByEmail(email)))
        throw new HttpError(409, 'An account with this email already exists.');
    const role = accountRole(request.body?.role ?? 'user');
    const user = await createUser({ email, password, role, expiresAt: expiresAt ?? null, forcePasswordReset });
    (await replaceUserPermissions(user.id, modelIds, admin.id));
    response.status(201).json({ user: (await findUserById(user.id)) });
}));
protectedAdminRouter.put('/users/:id', asyncRoute(async (request, response) => {
    const userId = Number(request.params.id);
    if (!Number.isInteger(userId))
        throw new HttpError(400, 'Invalid user ID.');
    const current = (await findUserById(userId));
    if (!current)
        throw new HttpError(404, 'User not found.');
    const role = request.body?.role === undefined ? current.role : accountRole(request.body.role);
    const email = request.body?.email === undefined ? undefined : requireEmail(request.body.email);
    const password = request.body?.password ? requirePassword(request.body.password) : undefined;
    const expiresAt = optionalIsoTimestamp(request.body?.expiresAt);
    const forcePasswordReset = optionalBoolean(request.body?.forcePasswordReset, 'forcePasswordReset');
    const modelIds = optionalModelIds(request.body?.modelIds);
    if (email && (await findUserByEmail(email)) && (await findUserByEmail(email))?.id !== userId)
        throw new HttpError(409, 'An account with this email already exists.');
    if (modelIds)
        (await ensureKnownModelIds(modelIds));
    (await protectAdminAccess(userId, role, expiresAt, (request as AuthenticatedRequest).user.id));
    const updated = await updateUser(userId, { email, password, role, expiresAt, forcePasswordReset });
    if (!updated)
        throw new HttpError(404, 'User not found.');
    if (modelIds)
        (await replaceUserPermissions(userId, modelIds, (request as AuthenticatedRequest).user.id));
    response.json({ user: (await findUserById(userId)) });
}));
protectedAdminRouter.delete('/users/:id', asyncRoute(async (request, response) => {
    const userId = Number(request.params.id);
    if (!Number.isInteger(userId))
        throw new HttpError(400, 'Invalid user ID.');
    const admin = (request as AuthenticatedRequest).user;
    if (admin.id === userId)
        throw new HttpError(400, 'You cannot delete your own admin account.');
    const user = (await findUserById(userId));
    if (!user)
        throw new HttpError(404, 'User not found.');
    (await protectAdminAccess(userId, 'user', null, admin.id));
    (await deleteUser(userId));
    response.status(204).end();
}));
protectedAdminRouter.get('/permissions', asyncRoute(async (_request, response) => {
    response.json({ users: (await listUsers()), models: (await listModels()) });
}));
protectedAdminRouter.put('/permissions', asyncRoute(async (request, response) => {
    const userId = Number(request.body?.userId);
    if (!Number.isInteger(userId))
        throw new HttpError(400, 'userId must be an integer.');
    const user = (await findUserById(userId));
    if (!user)
        throw new HttpError(404, 'User not found.');
    if (user.role === 'admin')
        throw new HttpError(400, 'Admin permissions are implicit and cannot be edited from this panel.');
    const modelIds = optionalModelIds(request.body?.modelIds) ?? [];
    (await ensureKnownModelIds(modelIds));
    const assignedModelIds = (await replaceUserPermissions(userId, modelIds, (request as AuthenticatedRequest).user.id));
    response.json({ user: (await findUserById(userId)), assignedModelIds });
}));
protectedAdminRouter.get('/models', asyncRoute(async (_request, response) => {
    response.json({ models: (await listModels()) });
}));
protectedAdminRouter.get('/models/:id', asyncRoute(async (request, response) => {
    const model = (await findModelById(String(request.params.id)));
    if (!model)
        throw new HttpError(404, 'Model not found.');
    response.json({ model });
}));
protectedAdminRouter.post('/models/upload-url', asyncRoute(async (request,response) => {
  const admin=(request as AuthenticatedRequest).user;
  const filename=optionalString(request.body?.filename,'filename',200) ?? '';
  const size=Number(request.body?.size);
  if(!/\.(glb|gltf|obj)$/i.test(filename)) throw new HttpError(400,'Choose a GLB, embedded GLTF, or OBJ model.');
  if(!Number.isInteger(size)||size<=0||size>50*1024*1024) throw new HttpError(400,'Models must be between 1 byte and 50 MB.');
  const id=randomUUID(), path='custom/'+admin.id+'/'+id+extname(filename).toLowerCase();
  const {data,error}=await supabase.storage.from(config.modelBucket).createSignedUploadUrl(path); check(error);
  const receipt=jwt.sign({sub:String(admin.id),path,id,size,filename,purpose:'model-upload'},config.jwtSecret,{expiresIn:'2h'});
  response.json({signedUrl:data!.signedUrl,receipt});
}));
protectedAdminRouter.post('/models', asyncRoute(async (request,response) => {
  const admin=(request as AuthenticatedRequest).user;
  let receipt: jwt.JwtPayload;
  try {
    const value=jwt.verify(String(request.body?.receipt ?? ''),config.jwtSecret,{algorithms:['HS256']});
    if(typeof value==='string'||value.purpose!=='model-upload'||value.sub!==String(admin.id)) throw new Error();
    receipt=value;
  } catch {throw new HttpError(400,'Upload authorization expired. Select the file and try again.');}
  const id='custom-'+receipt.id;
  const existing=await findModelById(id);
  if(existing) {response.json({model:existing,models:await listModels()});return;}
  const kind=hardwareKind(request.body?.kind);
  const name=optionalString(request.body?.name,'name',120) ?? receipt.filename.replace(/\.(glb|gltf|obj)$/i,'');
  const detail=optionalString(request.body?.detail,'detail',300) ?? 'Uploaded 3D hardware model';
  const powerWatts=optionalNumber(request.body?.powerWatts,0);
  const formTransform=transformFromForm(request.body?.transform);
  const metadata=metadataFromForm(request.body?.metadata);
  const {data,error}=await supabase.storage.from(config.modelBucket).download(receipt.path);
  if(error||!data) throw new HttpError(400,'Upload is incomplete. Try again.');
  if(data.size!==receipt.size||data.size>50*1024*1024) throw new HttpError(400,'Uploaded file size differs from the selected file.');
  let inspection;
  try {inspection=inspectModelData(Buffer.from(await data.arrayBuffer()),receipt.filename,kind);}
  catch(error){await supabase.storage.from(config.modelBucket).remove([receipt.path]);throw new HttpError(400,error instanceof Error?error.message:'Invalid model file.');}
  const model=await createHardwareModel({id,kind,name,detail,modelPath:receipt.path,powerWatts,
    metadata:{...metadata,powerWatts,...(inspection.warning?{inspectionWarning:inspection.warning}:{})},
    transform:{...(formTransform??inspection.transform),normalization:'slot-v1'},bounds:inspection.bounds,createdBy:admin.id});
  response.status(201).json({model,models:await listModels(),inspection});
}));
protectedAdminRouter.delete('/models/:id', asyncRoute(async (request,response) => {
  const model=await findModelById(String(request.params.id));
  if(!model) throw new HttpError(404,'Model not found.');
  const {error}=await supabase.storage.from(config.modelBucket).remove([model.modelPath]); check(error);
  await deleteHardwareModel(model.id);
  response.status(204).end();
}));
protectedAdminRouter.put('/models/:id/transform', asyncRoute(async (request, response) => {
    const transform = modelTransform(request.body?.transform);
    const model = (await updateModelTransform(String(request.params.id), transform));
    if (!model)
        throw new HttpError(404, 'Model not found.');
    response.json({ model });
}));
protectedAdminRouter.put('/models/:id/board-mount-layout', asyncRoute(async (request, response) => {
    const boardMountLayout = boardMountLayoutFromBody(request.body?.boardMountLayout);
    const model = (await updateModelBoardMountLayout(String(request.params.id), boardMountLayout));
    if (!model)
        throw new HttpError(404, 'Motherboard model not found.');
    response.json({ model });
}));
protectedAdminRouter.put('/models/:id/component-placements', asyncRoute(async (request, response) => {
    const board = (await findModelById(String(request.params.id)));
    if (!board || board.kind !== 'motherboard')
        throw new HttpError(404, 'Motherboard model not found.');
    const value = request.body?.componentPlacements;
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new HttpError(400, 'componentPlacements must be an object.');
    const validMounts: Record<string, readonly string[]> = {
        cpu: ['motherboard:cpu'],
        ram: ['motherboard:dimm1', 'motherboard:dimm2', 'motherboard:dimm3', 'motherboard:dimm4'],
        gpu: ['motherboard:pcie1'],
        ssd: ['motherboard:m2-1'],
    };
    const placements: Record<string, BoardMountLayout> = {};
    for (const [componentKind, rawLayout] of Object.entries(value)) {
        if (!validMounts[componentKind])
            throw new HttpError(400, `Unknown component category: ${componentKind}.`);
        const layout = boardMountLayoutFromBody(rawLayout);
        if (Object.keys(layout).some(mount => !validMounts[componentKind].includes(mount))) {
            throw new HttpError(400, `The selected ${componentKind} cannot use those motherboard mounts.`);
        }
        placements[componentKind] = layout;
    }
    const model = (await updateModelComponentPlacements(board.id, placements));
    if (!model)
        throw new HttpError(404, 'Motherboard model not found.');
    response.json({ model });
}));
adminRouter.use('/admin', protectedAdminRouter);
