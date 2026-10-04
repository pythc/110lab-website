// Exercise shared laboratory identity from an isolated standalone release.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {request} from 'node:http';
const root=mkdtempSync(join(tmpdir(),'110lab-admin-release-'));let server;
try{
 const manifest=JSON.parse(readFileSync('release.json'));
 for(const path of Object.keys(manifest.files)){mkdirSync(dirname(join(root,path)),{recursive:true});copyFileSync(path,join(root,path));}
 const {createHttpServer}=await import(pathToFileURL(join(root,'server/runtime.mjs')));
 const owner={subject:'fixture_tenant:on_fixture_owner_2026',email:'owner.fixture@110-lab.cn',name:'虚构管理员'};
 process.env.PORTAL_UPDATES_DATABASE=join(root,'updates.sqlite');
 server=await createHttpServer({admin:{enabled:true,localTest:true},mail:{enabled:true,directory:join(root,'private'),localTest:true,config:{appId:'cli_fixture12345',appSecret:'fictional-app-secret-2026',tenantKey:'fixture_tenant',bootstrapUnionId:'on_fixture_owner_2026',bootstrapEmail:owner.email,bootstrapName:owner.name},fetchIdentity:async()=>owner}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const call=(path,data,headers={})=>new Promise((resolve,reject)=>{
  const req=request({hostname:'127.0.0.1',port:server.address().port,path,method:data===undefined?'GET':'POST',headers:{Host:'internal.110-lab.cn',...(data===undefined?{}:{Origin:'https://internal.110-lab.cn','Content-Type':'application/json'}),...headers}},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>{const text=Buffer.concat(chunks).toString();let body;try{body=JSON.parse(text);}catch{}resolve({status:res.statusCode,body,headers:res.headers,text});});});req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data));
 });
 const cookie=r=>r.headers['set-cookie'][0].split(';')[0];
 assert.equal((await call('/api/admin/session')).status,401);
 assert.equal((await call('/api/admin/login',{username:'old-admin',password:'fictional'})).status,410);
 const start=await call('/api/mail/auth/start',{}),launch=await call('/mail/auth/launch?state='+start.body.state);
 const login=await call('/mail/auth/callback?state='+start.body.state+'&code=fictional',undefined,{Cookie:cookie(launch)});
 const me=await call('/api/admin/session',undefined,{Cookie:cookie(login)});assert.equal(me.body.subject,owner.subject);
 const headers={Cookie:cookie(login),'X-CSRF-Token':me.body.csrf};
 const created=await call('/api/admin/updates',{title:'Fictional bundled test'},headers);assert.equal(created.status,201);
 assert.deepEqual((await call('/api/updates')).body.updates,[]);
 assert.equal((await call('/api/admin/updates/'+created.body.id+'/publish',{revision:created.body.revision,confirmPublic:true},headers)).status,200);
 assert.equal((await call('/api/updates')).body.updates[0].title,'Fictional bundled test');
 assert.equal((await call('/admin/embedded')).status,200);
 assert.equal((await call('/api/admin/embedded/session',undefined,headers)).status,401);
 assert.equal((await call('/api/admin/updates',undefined,{...headers,Host:'110-lab.cn'})).status,404);
 assert.equal((await call('/api/mail/logout',{},headers)).status,200);
 assert.equal((await call('/api/admin/session',undefined,headers)).status,401);
 console.log(JSON.stringify({isolatedAdminBundle:true,sharedFeishuIdentity:true,passwordFallbackClosed:true,draftsPrivate:true,publishVerified:true,logoutVerified:true,externalCalls:false}));
}finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await server.workflowClosed;}delete process.env.PORTAL_UPDATES_DATABASE;rmSync(root,{recursive:true,force:true});}
