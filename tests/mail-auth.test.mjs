import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openMailAuth,fetchMailIdentity,MAIL_SCOPE,MAIL_CALLBACK,LAB_LOGIN_LIFETIME} from '../server/mail-auth.mjs';

import {fixtureConfig,fixtureIdentity} from './helpers/mail-fixtures.mjs';
const first=c=>c.split(';')[0];
async function completed(auth,{embedded=false,ip='192.0.2.4',expectedSubject=null}={}){
  const start=auth.start('',{embedded,ip,expectedSubject}),launch=auth.launch(start.state);
  const pending=await auth.callback(start.state,'fictional_code_2026',first(launch.cookie));
  return {start,launch,result:pending.complete()};
}
test('mail login uses PKCE, one-use callback, separate context cookies and bound handoff',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'110lab-mail-auth-'));let captured;const auth=openMailAuth({directory:dir,config:fixtureConfig,fetchIdentity:async(_,{code,verifier})=>{captured={code,verifier};return fixtureIdentity;}});
  try{
    const f=await completed(auth,{embedded:true});const u=new URL(f.launch.url);assert.equal(u.origin,'https://accounts.feishu.cn');assert.equal(u.searchParams.get('redirect_uri'),MAIL_CALLBACK);assert.equal(u.searchParams.get('scope'),MAIL_SCOPE);assert.equal(u.searchParams.get('code_challenge_method'),'S256');assert.equal(captured.verifier.length,43);assert.equal(u.searchParams.get('code_challenge'),createHash('sha256').update(captured.verifier).digest('base64url'));
    assert.match(f.launch.cookie,/SameSite=Lax;.*Secure$/);assert.match(f.start.cookie,/SameSite=None;.*Secure; Partitioned$/);
    // A phishing attacker who knows their flow and binding cookie still cannot
    // import the victim's login without the callback window's separate ticket.
    assert.throws(()=>auth.redeem(f.start.state,'a'.repeat(43),first(f.start.cookie),{embedded:true}),e=>e.status===401);
    assert.throws(()=>auth.redeem(f.start.state,f.result.ticket,'',{embedded:true}),e=>e.status===401);
    assert.throws(()=>auth.redeem(f.start.state,f.result.ticket,first(f.start.cookie)),e=>e.status===401);
    const login=auth.redeem(f.start.state,f.result.ticket,first(f.start.cookie),{embedded:true});assert.match(login.cookie,/SameSite=None;.*Secure; Partitioned$/);
    assert.equal(auth.session(first(login.cookie),{embedded:true}).subject,fixtureIdentity.subject);
    assert.throws(()=>auth.session(first(login.cookie).replace(auth.names.embedded+'=',auth.names.normal+'=')),e=>e.status===401);
    assert.throws(()=>auth.redeem(f.start.state,f.result.ticket,first(f.start.cookie),{embedded:true}),e=>e.status===401);
    await assert.rejects(()=>auth.callback(f.start.state,'fictional_code_2026',first(f.launch.cookie)),e=>e.status===401);
    const session=auth.session(first(login.cookie),{embedded:true});assert.throws(()=>auth.csrf(session,'b'.repeat(43)),e=>e.status===403);auth.csrf(session,session.csrf);
    auth.logout(session);assert.throws(()=>auth.session(first(login.cookie),{embedded:true}),e=>e.status===401);
  }finally{auth.close();await rm(dir,{recursive:true,force:true});}
});
test('reauthentication cannot switch identity; freshness, expiry and persisted sessions hold',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'110lab-mail-reauth-'));let time=Date.now();let auth=openMailAuth({directory:dir,config:fixtureConfig,now:()=>time,fetchIdentity:async()=>fixtureIdentity});
  try{
    const f=await completed(auth),cookie=first(f.result.cookie),session=auth.session(cookie);assert.match(f.result.cookie,/Max-Age=2592000/);auth.recent(session);
    time+=5*60000+1;assert.throws(()=>auth.recent(session),e=>e.status===403);auth.close();auth=openMailAuth({directory:dir,config:fixtureConfig,now:()=>time,fetchIdentity:async()=>fixtureIdentity});assert.equal(auth.session(cookie).subject,fixtureIdentity.subject);
    const mismatch=auth.start('',{expectedSubject:'fictional_tenant:on_other_user_2026'}),launched=auth.launch(mismatch.state);await assert.rejects(()=>auth.callback(mismatch.state,'fictional_code',first(launched.cookie)),e=>e.status===403);
    const expired=auth.start('');time+=5*60000+1;assert.throws(()=>auth.launch(expired.state),e=>e.status===401);
    time+=31*60000;assert.equal(auth.session(cookie).subject,fixtureIdentity.subject);
    time=session.created+LAB_LOGIN_LIFETIME-1;assert.equal(auth.session(cookie).subject,fixtureIdentity.subject);
    auth.close();auth=openMailAuth({directory:dir,config:fixtureConfig,now:()=>time,fetchIdentity:async()=>fixtureIdentity});assert.equal(auth.session(cookie).expiresAt,new Date(session.created+LAB_LOGIN_LIFETIME).toISOString());
    time++;assert.throws(()=>auth.session(cookie),e=>e.status===401);
  }finally{auth.close();await rm(dir,{recursive:true,force:true});}
});
test('identity provider rejects different tenants, contact email fallback and invalid token responses',async()=>{
  const original=globalThis.fetch;let calls=[];let profile={tenant_key:fixtureConfig.tenantKey,union_id:fixtureConfig.bootstrapUnionId,enterprise_email:fixtureConfig.bootstrapEmail,name:fixtureConfig.bootstrapName};
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(url.includes('/token')?{access_token:'fictional-test-access-token'}:{code:0,data:profile}),{status:200});};
  try{
    assert.deepEqual(await fetchMailIdentity(fixtureConfig,{code:'fixture_code',verifier:'x'.repeat(43)}),fixtureIdentity);assert.equal(calls[0].url,'https://open.feishu.cn/open-apis/authen/v2/oauth/token');assert.equal(calls[0].options.headers['Content-Type'],'application/json; charset=utf-8');const body=JSON.parse(calls[0].options.body);assert.equal(body.scope,MAIL_SCOPE);assert.equal(body.code_verifier,'x'.repeat(43));assert.equal(body.redirect_uri,MAIL_CALLBACK);assert.equal('offline_access' in body,false);
    profile={...profile,tenant_key:'other_tenant'};await assert.rejects(()=>fetchMailIdentity(fixtureConfig,{code:'fixture_code',verifier:'x'.repeat(43)}),e=>e.status===403);
    profile={...profile,tenant_key:fixtureConfig.tenantKey,enterprise_email:undefined,email:fixtureConfig.bootstrapEmail};await assert.rejects(()=>fetchMailIdentity(fixtureConfig,{code:'fixture_code',verifier:'x'.repeat(43)}),e=>e.status===403);
    globalThis.fetch=async()=>new Response(JSON.stringify({code:20027,error:'fictional-error'}));await assert.rejects(()=>fetchMailIdentity(fixtureConfig,{code:'fixture_code',verifier:'x'.repeat(43)}),e=>e.status===401);
  }finally{globalThis.fetch=original;}
});
test('OAuth start is bounded globally and per IP',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'110lab-mail-budget-')),auth=openMailAuth({directory:dir,config:fixtureConfig});
  try{for(let n=0;n<10;n++)auth.start('',{ip:'192.0.2.5'});assert.throws(()=>auth.start('',{ip:'192.0.2.5'}),e=>e.status===429);assert.equal(auth.start('',{ip:'192.0.2.6'}).state.length,43);}finally{auth.close();await rm(dir,{recursive:true,force:true});}
});
test('provider failures preserve a safe server code without exposing credentials or provider text',async()=>{
  const originalFetch=globalThis.fetch,originalWarn=console.warn,records=[];
  globalThis.fetch=async()=>new Response(JSON.stringify({code:20049,error:'invalid_grant',error_description:'private authorization code and profile',access_token:'private-token'}),{status:400});
  console.warn=(...args)=>records.push(args);
  try{
    await assert.rejects(()=>fetchMailIdentity(fixtureConfig,{code:'private-code',verifier:'x'.repeat(43)}),e=>e.status===502&&e.message==='飞书登录失败 请重新登录');
    assert.deepEqual(records,[['Mail OAuth failed',JSON.stringify({stage:'token',code:20049,httpStatus:400})]]);
    assert.doesNotMatch(JSON.stringify(records),/private|fictional-app-secret|access_token|error_description/);
    globalThis.fetch=async()=>new Response('null');
    await assert.rejects(()=>fetchMailIdentity(fixtureConfig,{code:'private-code',verifier:'x'.repeat(43)}),e=>e.status===401);
  }finally{globalThis.fetch=originalFetch;console.warn=originalWarn;}
});
