import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const {createHttpServer}=await import(process.env.BUSINESS_RELEASE_ROOT?pathToFileURL(join(process.env.BUSINESS_RELEASE_ROOT,'server/runtime.mjs')):new URL('../server/http.mjs',import.meta.url));
import {fixtureConfig,fixtureIdentity} from './helpers/mail-fixtures.mjs';
import {MAIL_ISSUER,MAIL_RESOURCE} from '../server/mail-oauth.mjs';
import {createLocalBusinessClient} from '../server/local-business-client.mjs';
import {BUSINESS_TOOLS} from '../server/business-tools.mjs';

const cookies=r=>(r.headers['set-cookie']||[]).map(s=>s.split(';')[0]).join('; ');
const nonce=r=>r.text.match(/name="request" value="([\w-]{43})"/)[1];
const next=r=>new URL(r.text.match(/<meta http-equiv="refresh" content="0;url=([^"]+)"/)[1].replaceAll('&amp;','&'));
async function setup(t){
  const directory=await mkdtemp(join(tmpdir(),'110lab-business-http-'));
  const server=await createHttpServer({mail:{enabled:true,directory,config:fixtureConfig,localTest:true,fetchIdentity:async()=>fixtureIdentity},admin:{enabled:true,localTest:true},business:{enabled:true,localTest:true},workspace:{localTest:true},honors:{localTest:true}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(r=>{server.close(r);server.closeAllConnections();});await server.workflowClosed;await rm(directory,{recursive:true,force:true});});
  const call=(path,{data,form,headers={},method=data||form?'POST':'GET'}={})=>new Promise((resolve,reject)=>{
    const body=form?new URLSearchParams(form).toString():data?JSON.stringify(data):undefined;
    const req=request({host:'127.0.0.1',port:server.address().port,path,method,headers:{Host:'internal.110-lab.cn',Accept:'application/json, text/event-stream',Origin:MAIL_ISSUER,...body?{'Content-Type':form?'application/x-www-form-urlencoded':'application/json'}:{},...headers}},res=>{const parts=[];res.on('data',c=>parts.push(c));res.on('end',()=>{const text=Buffer.concat(parts).toString();let body;try{body=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,text,body});});});req.on('error',reject);req.end(body);
  });
  const feishu=async url=>{
    const authorization=await call(url.pathname+url.search),binding=cookies(authorization);
    const start=await call('/mail/oauth/login',{form:{request:nonce(authorization)},headers:{Cookie:binding}});
    const auth=next(start),callback=await call('/mail/auth/callback?'+new URLSearchParams({state:auth.searchParams.get('state'),code:'fictional-code'}),{headers:{Cookie:binding+'; '+cookies(start)}});
    const approval=await call('/mail/oauth/approve',{form:{request:nonce(callback)},headers:{Cookie:binding}});
    return {redirect:next(approval),cookie:cookies(callback),consent:callback.text};
  };
  const grant=async scope=>{
    const registration=await call('/register',{data:{redirect_uris:['http://127.0.0.1/callback/business_test'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],scope}});
    assert.equal(registration.status,201);const client=registration.body.client_id,verifier='v'.repeat(43),redirect='http://127.0.0.1:49111/callback/business_test';
    const value=await feishu(new URL(MAIL_ISSUER+'/authorize?'+new URLSearchParams({client_id:client,redirect_uri:redirect,response_type:'code',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',resource:MAIL_RESOURCE,scope,state:'fictional_business_state'})));
    const token=await call('/token',{form:{client_id:client,code:value.redirect.searchParams.get('code'),redirect_uri:redirect,resource:MAIL_RESOURCE,grant_type:'authorization_code',code_verifier:verifier}});assert.equal(token.status,200);
    return {...value,token:token.body,client};
  };
  const tool=(token,name,args={})=>call('/mcp/workbench-v6-1',{data:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},headers:token?{Authorization:'Bearer '+token}:{}});
  return {call,grant,tool,feishu,server,directory};
}

test('MCP discovery, narrow OAuth scopes, browser confirmation CSRF and publish work end to end',async t=>{
  const h=await setup(t),list=await h.call('/mcp/workbench-v6-1',{data:{jsonrpc:'2.0',id:1,method:'tools/list'}});
  assert.equal(list.status,200);assert.equal(list.body.result.tools.filter(t=>t.name.startsWith('lab_')).length,BUSINESS_TOOLS.length);
  assert.equal((await h.tool(null,'lab_updates_list')).status,401);
  const legacy=await h.grant('mail:session');assert.equal(legacy.cookie,'');assert.equal((await h.tool(legacy.token.access_token,'lab_updates_list')).status,403);
  const grant=await h.grant('lab:identity updates:read updates:write updates:publish');assert.match(grant.consent,/动态草稿/);assert.ok(grant.cookie);
  assert.equal(grant.token.scope,'lab:identity updates:publish updates:read updates:write');const token=grant.token.access_token;
  const draft=await h.tool(token,'lab_update_draft_save',{requestId:randomUUID(),content:{title:'仅测试的动态',summary:'虚构数据',body:[],link:null}});assert.equal(draft.status,200,JSON.stringify(draft.body));assert.equal(draft.body.result.isError,undefined);const d=draft.body.result.structuredContent;
  const pre=await h.tool(token,'lab_update_publication_preview',{requestId:randomUUID(),id:d.id,expectedRevision:d.revision,action:'publish'});const p=pre.body.result.structuredContent;
  const send=()=>h.tool(token,'lab_update_publish',{requestId:randomUUID(),previewId:p.id});assert.equal((await send()).body.result.structuredContent.code,'CONFIRMATION_REQUIRED');
  const session=await h.call('/api/business/session',{headers:{Cookie:grant.cookie}});assert.equal(session.status,200);
  const uri='/api/business/confirmations/'+p.id;
  assert.equal((await h.call(uri,{data:{fingerprint:p.fingerprint},headers:{Cookie:grant.cookie}})).status,403);
  assert.equal((await h.call(uri,{data:{fingerprint:p.fingerprint},headers:{Cookie:grant.cookie,'X-CSRF-Token':session.body.csrf,Origin:'https://evil.example'}})).status,403);
  assert.equal((await h.call(uri,{data:{fingerprint:p.fingerprint},headers:{Cookie:grant.cookie,'X-CSRF-Token':session.body.csrf}})).status,200);
  assert.equal((await send()).body.result.structuredContent.published.title,'仅测试的动态');
  assert.equal((await h.call('/api/updates')).body.updates.length,1);
  const revoked=await h.call('/revoke',{form:{client_id:grant.client,token}});assert.equal(revoked.status,200);
  assert.equal((await h.tool(token,'lab_updates_list')).status,401);
});

test('local business bridge OAuth callback persists private credentials and retries intended tool only after grant',async t=>{
  const h=await setup(t);let credentials={};
  const storage={load:()=>credentials,save:value=>{credentials=structuredClone(value);}};
  const fetchImpl=async(input,options={})=>{
    const url=new URL(String(input));assert.equal(url.origin,MAIL_ISSUER);
    const headers=Object.fromEntries(new Headers(options.headers).entries());let data,form;
    if(options.body){if(headers['content-type']?.startsWith('application/x-www-form-urlencoded'))form=Object.fromEntries(new URLSearchParams(String(options.body)));else data=JSON.parse(options.body);}
    const r=await h.call(url.pathname+url.search,{method:options.method||'GET',headers,data,form});
    return new Response([204,202].includes(r.status)?null:r.text,{status:r.status,headers:Object.fromEntries(Object.entries(r.headers).filter(([k])=>k!=='set-cookie').map(([k,v])=>[k,Array.isArray(v)?v.join(','):v]))});
  };
  const client=createLocalBusinessClient({fetchImpl,storage});t.after(()=>client.close());
  const first=await client.call('lab_whoami',{});assert.equal(first.structuredContent.code,'AUTH_REQUIRED');
  const approved=await h.feishu(new URL(first.structuredContent.authorizationUrl));
  const callback=await fetch(approved.redirect);assert.equal(callback.status,200);await callback.text();
  const me=await client.call('lab_whoami',{});assert.equal(me.structuredContent?.subject,fixtureIdentity.subject,JSON.stringify(me));
  assert.ok(credentials.tokens.refresh_token);assert.doesNotMatch(JSON.stringify(me),new RegExp(credentials.tokens.access_token));
  const project=await client.call('lab_projects_list',{});assert.equal(project.structuredContent.code,'AUTH_REQUIRED');
  const second=await h.feishu(new URL(project.structuredContent.authorizationUrl));assert.equal((await fetch(second.redirect)).status,200);
  const rows=await client.call('lab_projects_list',{});assert.equal(rows.structuredContent.total,0);assert.match(credentials.tokens.scope,/lab:identity/);assert.match(credentials.tokens.scope,/projects:read/);
});

test('portal keeps the deployed assessment login entry and preserves legacy OAuth table layouts',async t=>{
  const h=await setup(t);
  const page=await h.call('/workbench');assert.equal(page.status,200);assert.doesNotMatch(page.text,/https:\/\/exam\.110-lab\.cn\/api\/auth\/feishu\/start/);assert.match(page.text,/https:\/\/exam\.110-lab\.cn\/login/);
  const resource=await h.call('/mcp/workbench-v6-1',{data:{jsonrpc:'2.0',id:1,method:'resources/read',params:{uri:'ui://110lab/workbench/v0.8.7'}}});
  assert.equal(resource.status,200);assert.doesNotMatch(resource.body.result.contents[0].text,/https:\/\/exam\.110-lab\.cn\/api\/auth\/feishu\/start/);
  const db=new DatabaseSync(join(h.directory,'mail-oauth.sqlite'));
  try{for(const [table,count]of [['oauth_requests',11],['oauth_codes',7],['oauth_tokens',8]])assert.equal(db.prepare('PRAGMA table_info('+table+')').all().length,count);}finally{db.close();}
});
