import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {createMailHttp} from '../server/mail-http.mjs';
import {fixtureConfig,fixtureIdentity} from './helpers/mail-fixtures.mjs';
test('real HTTP central login binds the originating browser, issues audience-specific identity, and revokes it on logout',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'110-identity-http-'));
  const mail=await createMailHttp({enabled:true,unifiedIdentityEnabled:true,localTest:true,directory,config:fixtureConfig,fetchIdentity:async()=>fixtureIdentity,fetchDirectory:async()=>[{subject:fixtureIdentity.subject}]});
  const server=createServer((req,res)=>void mail.handle(req,res,new URL(req.url,'http://localhost').pathname,req.headers.host.split(':')[0]));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  const call=(path,{data,jar='',origin=base,csrf='',method=data?'POST':'GET'}={})=>new Promise((resolve,reject)=>{const req=request(base+path,{method,headers:{Cookie:jar,...(origin?{Origin:origin}:{}),...(data?{'Content-Type':'application/json'}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})}},res=>{const parts=[];res.on('data',v=>parts.push(v));res.on('end',()=>{const text=Buffer.concat(parts).toString();let value;try{value=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,text,value});});});req.on('error',reject);req.end(data?JSON.stringify(data):undefined);});
  const cookie=r=>r.headers['set-cookie']?.[0].split(';')[0]||'';
  try{
    const page=await call('/auth');assert.equal(page.status,200);assert.match(page.text,/欢迎来到 110lab/);assert.match(page.headers['content-security-policy'],/frame-ancestors 'none'/);
    assert.equal((await call('/api/identity/session')).status,401);
    const start=await call('/api/identity/login',{data:{next:'/auth?service=knowledge'}});assert.equal(start.status,200);const state=new URL(start.value.launchUrl).searchParams.get('state');
    const launch=await call('/mail/auth/launch?state='+state);const callback=await call('/mail/auth/callback?state='+state+'&code=fixture',{jar:cookie(launch)});assert.equal(callback.status,303);assert.equal(callback.headers.location,'/auth?service=knowledge');
    const jar=cookie(callback),session=await call('/api/identity/session',{jar});assert.equal(session.value.subject,fixtureIdentity.subject);const verifier=randomBytes(32).toString('base64url'),v={audience:'knowledge',state:randomBytes(32).toString('base64url'),redirectUri:'http://127.0.0.1:5840/api/auth/identity/callback',challenge:createHash('sha256').update(verifier).digest('base64url')};
    assert.equal((await call('/api/identity/authorize',{data:v,jar})).status,403);assert.equal((await call('/api/identity/authorize',{data:v,jar,csrf:session.value.csrf,origin:'https://attacker.example'})).status,403);
    assert.equal((await call('/api/identity/continuation',{data:v,jar})).status,403);
    assert.equal((await call('/api/identity/continuation',{data:v,jar,csrf:session.value.csrf,origin:'https://attacker.example'})).status,403);
    assert.equal((await call('/api/identity/continuation',{data:v,jar,csrf:session.value.csrf})).value.automatic,true);
    const grant=await call('/api/identity/authorize',{data:v,jar,csrf:session.value.csrf});assert.equal(grant.status,200);const code=new URL(grant.value.redirectUrl).searchParams.get('code');
    assert.equal((await call('/api/identity/exchange',{data:{...v,code,verifier},origin:base})).status,403);
    const token=await call('/api/identity/exchange',{data:{audience:v.audience,state:v.state,redirectUri:v.redirectUri,code,verifier},origin:''});assert.equal(token.status,200);
    assert.equal((await call('/api/identity/inspect',{data:{audience:'requirements',token:token.value.token},origin:''})).status,401);
    assert.equal((await call('/api/identity/logout',{data:{},jar,csrf:session.value.csrf})).status,200);
    assert.equal((await call('/api/identity/inspect',{data:{audience:'knowledge',token:token.value.token},origin:''})).status,401);
    assert.equal((await call('/api/identity/session',{jar})).status,401);
  }finally{await new Promise(r=>{server.close(r);server.closeAllConnections();});mail.close();await rm(directory,{recursive:true,force:true});}
});
