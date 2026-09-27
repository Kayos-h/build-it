import { supabase, check } from '../db/supabase.js';
import { Router } from 'express';
import { config } from '../config.js';
import { authenticate, requirePasswordReady, type AuthenticatedRequest } from '../http/auth.js';
import { asyncRoute, HttpError } from '../http/errors.js';
import { findModelById, listModels, type ModelRecord, userCanAccessModel } from '../db/database.js';
export const modelsRouter = Router();
const catalogModelRoot = config.catalogModelDir;
modelsRouter.use('/models', authenticate, requirePasswordReady);
modelsRouter.get('/models/accessible', asyncRoute(async (request, response) => {
    const authenticated = request as AuthenticatedRequest;
    const models = (await listModels()).filter(model => userCanAccessModel(authenticated.user, model.id));
    response.json({ models });
}));
modelsRouter.get('/models/:modelId/status', asyncRoute(async (request, response) => {
    const authenticated = request as AuthenticatedRequest;
    const model = (await findModelById(String(request.params.modelId)));
    if (!model)
        throw new HttpError(404, 'Model not found.');
    if (!userCanAccessModel(authenticated.user, model.id))
        throw new HttpError(403, 'You do not have access to this model.');
    response.json({ model });
}));
modelsRouter.get('/models/:modelId/file', asyncRoute(async (request, response) => {
    const authenticated = request as AuthenticatedRequest;
    const model = (await findModelById(String(request.params.modelId)));
    if (!model)
        throw new HttpError(404, 'Model not found.');
    if (!userCanAccessModel(authenticated.user, model.id))
        throw new HttpError(403, 'You do not have access to this model.');
    const {data,error}=await supabase.storage.from(config.modelBucket).createSignedUrl(model.modelPath,60); check(error);
    if(!data) throw new HttpError(404,'Model file not found.');
    response.json({url:data.signedUrl});
}));