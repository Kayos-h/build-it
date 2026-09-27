import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/index.js';
import { createUser, deleteUser, deleteHardwareModel } from '../server/db/database.js';
import { supabase } from '../server/db/supabase.js';
import { config } from '../server/config.js';

const fixture = randomUUID();
const password = randomUUID() + 'Aa1!';
const admin = await createUser({ email: `test-${fixture}@example.com`, password, role: 'admin' });
const app = await createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const address = server.address() as {port: number};
const base = process.env.TEST_BASE_URL ?? `http://127.0.0.1:${address.port}`;
let token = '', userId: number | undefined, modelId: string | undefined, modelPath: string | undefined;
async function request(path: string, method = 'GET', body?: unknown, auth = token, expected = 200) {
 const response = await fetch(base + '/api' + path, {method, headers: {'Content-Type':'application/json', ...(auth ? {Authorization:`Bearer ${auth}`} : {})}, body:body === undefined ? undefined : JSON.stringify(body)});
 const text = await response.text();
 assert.equal(response.status, expected, `${method} ${path}: ${text.slice(0,350)}`);
 return text ? JSON.parse(text) : null;
}
try {
 await request('/models/accessible','GET',undefined,'',401);
 token = (await request('/admin/login','POST',{email:admin.email,password},'')).token;
 await request('/admin/users');
 const user = (await request('/admin/users','POST',{email:`user-${fixture}@example.com`,password,forcePasswordReset:true},token,201)).user;
 userId=user.id;
 let userToken=(await request('/auth/login','POST',{email:user.email,password},'')).token;
 await request('/models/accessible','GET',undefined,userToken,428);
 const changed = await request('/auth/password','POST',{currentPassword:password,newPassword:password+'x'},userToken);
 await request('/auth/me','GET',undefined,userToken,401);
 userToken=changed.token;
 await request('/admin/users','GET',undefined,userToken,403);
 const configuration={case:'',motherboard:'',cpu:'',cooler:'',ram:'',gpu:'',psu:'',ssd:'',fan:''};
 const state={version:1,configuration,software:[],rgb:'#a7f36b',camera:null};
 const saved=await request('/drafts','POST',{name:'Cloud persistence check',state},userToken,201);
 assert.equal((await request('/drafts','GET',undefined,userToken)).drafts.length,1);
 await request('/drafts/'+saved.draft.id,'GET',undefined,token,404);
 await request('/drafts/'+saved.draft.id,'PUT',{name:'Updated',state,revision:1},userToken);
 await request('/drafts/'+saved.draft.id,'DELETE',{revision:1},userToken,409);
 await request('/drafts/'+saved.draft.id,'DELETE',{revision:2},userToken,204);
 await request('/admin/models/upload-url','POST',{filename:'bad.exe',size:2},token,400);
 await request('/admin/models/upload-url','POST',{filename:'large.glb',size:51*1024*1024},token,400);
 await request('/admin/models/upload-url','POST',{filename:'fixture.obj',size:20},userToken,403);
 // Exceeds Vercel's 4.5 MB body limit to exercise the direct-storage path.
 const file=new Blob(['# test fixture\n'.repeat(360000),'v 0 0 0\nv 0.1 0 0\nv 0 0.1 0\nf 1 2 3\n']);
 const upload=await request('/admin/models/upload-url','POST',{filename:'fixture.obj',size:file.size});
 const result=await fetch(upload.signedUrl,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:file});
 assert.equal(result.ok,true,'Direct upload failed: '+await result.text());
 const created=await request('/admin/models','POST',{receipt:upload.receipt,kind:'cpu',name:'Temporary integration fixture',metadata:'{"cores":6,"threads":12}',powerWatts:65},token,201);
 modelId=created.model.id; modelPath=created.model.modelPath;
 await request('/models/'+modelId+'/file','GET',undefined,userToken,403);
 await request('/admin/permissions','PUT',{userId,modelIds:[modelId]});
 assert.equal((await request('/models/accessible','GET',undefined,userToken)).models.length,1);
 const signed=await request('/models/'+modelId+'/file','GET',undefined,userToken);
 assert.equal((await fetch(signed.url)).status,200);
 await request('/admin/models/'+modelId+'/transform','PUT',{transform:{position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]}});
 await request('/admin/permissions','PUT',{userId,modelIds:[]});
 await request('/models/'+modelId+'/file','GET',undefined,userToken,403);
 await request('/admin/models/'+modelId,'DELETE',undefined,token,204);
 modelId=undefined; modelPath=undefined;
 await request('/admin/users/'+userId,'PUT',{expiresAt:'2020-01-01T00:00:00.000Z'});
 await request('/auth/me','GET',undefined,userToken,403);
 console.log('PASS: auth/reset/session invalidation, roles, draft persistence/ownership/conflicts, >4.5 MB uploads, signed downloads, grants/revocation, calibration, expiry, deletion.');
} finally {
 if(modelPath) await supabase.storage.from(config.modelBucket).remove([modelPath]);
 if(modelId) await deleteHardwareModel(modelId);
 if(userId) await deleteUser(userId);
 await deleteUser(admin.id);
 await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
