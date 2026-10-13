import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,createHash} from 'node:crypto';
import {createUnifiedIdentityHttp} from '../server/unified-identity-http.mjs';
test('requirements back channel requires an audience-specific grant and keeps its route-scoped key on the server',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'110-identity-proxy-'));let active=true,calls=0,base;
 const profile={subject:'fixture:on_abcdefghijk',name:'虚构成员',email:'fictional@example.com',role:'member'};
 const session={key:'fixture-key',subject:profile.subject,csrf:'c'.repeat(43),created:Date.now(),expiresAt:new Date(Date.now()+3600000).toISOString()};
 const auth={session:()=>auth.sessionByKey(),sessionByKey(){if(!active)throw new Error('expired');return session;},csrf(s,v){assert.equal(v,s.csrf);},logout(){active=false;return ''}};
 const http=await createUnifiedIdentityHttp({enabled:true,localTest:true,directory,auth,access:{me:()=>profile},directoryProvider:{list:async()=>[{subject:profile.subject}]},requirementsKey:'fictional-transport-only',requirementsFetch:async(url,init)=>{calls++;assert.equal(url,'https://fcncvoyreb8p.feishuapp.com/app/app_17b6pxwde0x/openapi/identity/connect');assert.equal(init.headers.Authorization,'Bearer fictional-transport-only');assert.equal(init.redirect,'error');return Response.json({code:'NATIVE_CONNECTION_REQUIRED'},{status:412});}});
 const server=createServer((req,res)=>void http.handle(req,res,new URL(req.url,'http://localhost').pathname,'127.0.0.1'));await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
 const call=async(path,body,origin)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin,'X-CSRF-Token':session.csrf}:{})},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 try{
  const verifier=randomBytes(32).toString('base64url'),state=randomBytes(32).toString('base64url'),redirectUri='http://127.0.0.1:5829/callback/110lab_requirements';
  const a=await call('/api/identity/authorize',{audience:'requirements',state,redirectUri,challenge:createHash('sha256').update(verifier).digest('base64url')},base);assert.equal(a.status,200);
  const e=await call('/api/identity/exchange',{audience:'requirements',state,redirectUri,verifier,code:new URL(a.body.redirectUrl).searchParams.get('code')});assert.equal(e.status,200);
  const path='/api/identity/requirements/connect',token=e.body.token;
  assert.equal((await call(path,{token:'x'.repeat(43)})).status,401);assert.equal(calls,0);
  assert.equal((await call(path,{token},base)).status,403);assert.equal(calls,0);
  assert.equal((await call(path,{token,url:'https://attacker.example'})).status,400);
  const first=await call(path,{token});assert.equal(first.status,412);assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(first.body),/fictional-transport-only/);
  assert.equal((await call(path,null)).status,400);
 }finally{await new Promise(r=>{server.close(r);server.closeAllConnections();});http.close();await rm(directory,{recursive:true,force:true});}
});
