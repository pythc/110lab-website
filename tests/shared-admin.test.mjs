import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,createHash} from 'node:crypto';
import {createHttpServer} from '../server/http.mjs';
import {parseBody} from '../src/admin-markdown.js';
import {fixtureConfig,fixtureIdentity} from './helpers/mail-fixtures.mjs';
import {createAdminHttp} from '../server/admin-http.mjs';

test('production dynamic management cannot silently fall back to independent passwords',async()=>{
  await assert.rejects(()=>createAdminHttp({enabled:true,mail:{enabled:false}}),/requires laboratory Feishu authentication/);
});

test('dynamic management reuses Feishu session, checks current admin role and rejects password fallback',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lab-shared-admin-'));
  const member={subject:'fictional_tenant:on_fixture_member_2026',name:'虚构成员',email:'fixture.member@110-lab.cn'};
  const server=await createHttpServer({admin:{enabled:true,localTest:true},mail:{enabled:true,localTest:true,directory,config:fixtureConfig,fetchIdentity:async(_,{code})=>code==='member'?member:fixtureIdentity,assessmentSsoEnabled:true}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  const request=(path,{method='GET',jar,csrf,data}={})=>fetch(base+path,{method,redirect:'manual',headers:{Host:'internal.110-lab.cn',...(jar?{Cookie:jar}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(data?{'Content-Type':'application/json',Origin:'https://internal.110-lab.cn'}:{})},body:data?JSON.stringify(data):undefined});
  const cookie=r=>r.headers.getSetCookie()[0].split(';')[0];
  async function login(code){
    const start=await request('/api/mail/auth/start',{method:'POST',data:{}}),flow=await start.json();
    const launch=await request('/mail/auth/launch?state='+flow.state),result=await request('/mail/auth/callback?state='+flow.state+'&code='+code,{jar:cookie(launch)});
    const jar=cookie(result),me=await request('/api/mail/session',{jar});return {jar,...await me.json()};
  }
  try{
    assert.equal((await request('/api/admin/session')).status,401);
    const owner=await login('owner'),person=await login('member');
    const verifier=randomBytes(32).toString('base64url'),state=randomBytes(32).toString('base64url');
    const authorization={state,challenge:createHash('sha256').update(verifier).digest('base64url'),embedded:false};
    assert.equal((await request('/api/mail/sso/authorize',{method:'POST',jar:owner.jar,data:authorization})).status,403);
    assert.equal((await request('/api/mail/sso/authorize',{method:'POST',jar:person.jar,csrf:person.csrf,data:authorization})).status,403);
    const issued=await request('/api/mail/sso/authorize',{method:'POST',jar:owner.jar,csrf:owner.csrf,data:authorization});assert.equal(issued.status,200);
    const target=new URL((await issued.json()).redirectUrl);assert.equal(target.origin,'https://exam.110-lab.cn');
    const payload={code:target.searchParams.get('code'),state,verifier,redirectUri:'https://exam.110-lab.cn/api/auth/feishu/callback'};
    assert.equal((await request('/api/mail/sso/exchange',{method:'POST',data:payload})).status,403);
    const backchannel=(path,data)=>fetch(base+'/api/mail/sso/'+path,{method:'POST',headers:{Host:'internal.110-lab.cn','Content-Type':'application/json'},body:JSON.stringify(data)});
    const exchanged=await backchannel('exchange',payload);assert.equal(exchanged.status,200);const grant=await exchanged.json();assert.equal(grant.subject,owner.subject);
    assert.equal((await backchannel('exchange',payload)).status,401);
    assert.equal((await backchannel('inspect',{token:grant.token})).status,200);
    const session=await request('/api/admin/session',{jar:owner.jar});assert.equal(session.status,200);assert.equal((await session.json()).subject,owner.subject);
    assert.equal((await request('/api/admin/session',{jar:person.jar})).status,403);
    assert.equal((await request('/api/admin/login',{method:'POST',data:{username:'admin',password:'anything'}})).status,410);
    assert.equal((await request('/api/admin/updates',{method:'POST',jar:owner.jar,data:{title:'虚构动态'}})).status,403);
    const content={title:'虚构动态',body:parseBody('虚构测试')};
    // A valid shared CSRF reaches validation; forged CSRF never reaches the store.
    assert.equal((await request('/api/admin/updates',{method:'POST',jar:owner.jar,csrf:owner.csrf,data:content})).status,201);
    const revision=(await (await request('/api/mail/administrators',{jar:owner.jar})).json()).revision;
    assert.equal((await request('/api/mail/administrators/grant',{method:'POST',jar:owner.jar,csrf:owner.csrf,data:{email:person.email,revision,confirmed:true}})).status,200);
    assert.equal((await request('/api/admin/session',{jar:person.jar})).status,200);
    const next=(await (await request('/api/mail/administrators',{jar:owner.jar})).json()).revision;
    assert.equal((await request('/api/mail/administrators/revoke',{method:'POST',jar:owner.jar,csrf:owner.csrf,data:{email:person.email,revision:next,confirmed:true}})).status,200);
    assert.equal((await request('/api/admin/updates',{jar:person.jar})).status,403);
    await request('/api/mail/logout',{method:'POST',jar:owner.jar,csrf:owner.csrf,data:{}});
    assert.equal((await request('/api/admin/session',{jar:owner.jar})).status,401);
    assert.equal((await backchannel('inspect',{token:grant.token})).status,401);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await server.workflowClosed;await rm(directory,{recursive:true,force:true});}
});
