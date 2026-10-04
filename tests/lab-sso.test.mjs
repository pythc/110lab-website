import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,createHash} from 'node:crypto';
import {openMailAuth} from '../server/mail-auth.mjs';
import {openMailAccessStore} from '../server/mail-access-store.mjs';
import {openLabSso,ASSESSMENT_CALLBACK} from '../server/lab-sso.mjs';
import {fixtureConfig,fixtureIdentity} from './helpers/mail-fixtures.mjs';
const nonce=()=>randomBytes(32).toString('base64url');

test('assessment SSO is one-use, PKCE-bound, administrator-only and follows central session revocation',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lab-sso-'));let time=Date.now();
  const auth=openMailAuth({directory,config:fixtureConfig,now:()=>time,fetchIdentity:async()=>fixtureIdentity});
  const access=openMailAccessStore({filename:join(directory,'mail-access.sqlite'),bootstrapOwner:fixtureIdentity,now:()=>time});
  const sso=openLabSso({directory,auth,access,now:()=>time});
  try{
    const start=auth.start(''),launch=auth.launch(start.state),pending=await auth.callback(start.state,'fictional',launch.cookie.split(';')[0]);
    access.registerIdentity(pending.profile);const completed=pending.complete(),session=auth.session(completed.cookie.split(';')[0]);
    const verifier=nonce(),challenge=createHash('sha256').update(verifier).digest('base64url'),state=nonce();
    const issue=()=>new URL(sso.authorize(session,{challenge,state,embedded:false}).redirectUrl).searchParams.get('code');
    let code=issue(),request={code,verifier,state,redirectUri:ASSESSMENT_CALLBACK};
    assert.throws(()=>sso.exchange({...request,verifier:nonce()}),e=>e.status===401);
    assert.throws(()=>sso.exchange({...request,state:nonce()}),e=>e.status===401);
    assert.throws(()=>sso.exchange({...request,redirectUri:'https://untrusted.invalid/callback'}),e=>e.status===401);
    const grant=sso.exchange(request);assert.equal(grant.subject,fixtureIdentity.subject);assert.equal(grant.audience,'assessment');
    assert.equal(sso.inspect(grant.token).role,'super_admin');
    assert.throws(()=>sso.exchange(request),e=>e.status===401);
    code=issue();time+=60001;assert.throws(()=>sso.exchange({...request,code}),e=>e.status===401);
    auth.logout(session);assert.throws(()=>sso.inspect(grant.token),e=>e.status===401);
    assert.throws(()=>sso.authorize(session,{state,challenge,embedded:false}),e=>e.status===401);
    assert.equal((await readFile(join(directory,'lab-sso.sqlite'))).includes(Buffer.from(grant.token)),false);
  }finally{sso.close();access.close();auth.close();await rm(directory,{recursive:true,force:true});}
});

test('role is re-read at exchange and introspection; changing roles never changes the identity',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lab-sso-roles-'));let role='admin',live=true;
  const session={key:'fixture-session',subject:fixtureIdentity.subject,expiresAt:new Date(Date.now()+3600000).toISOString()};
  const auth={sessionByKey(){if(!live)throw Object.assign(new Error('expired'),{status:401});return session;}};
  const access={me(){return {...fixtureIdentity,role};}};
  const sso=openLabSso({directory,auth,access});
  try{
    const verifier=nonce(),challenge=createHash('sha256').update(verifier).digest('base64url'),state=nonce();
    const issue=()=>new URL(sso.authorize(session,{state,challenge,embedded:true}).redirectUrl).searchParams.get('code');
    const code=issue();role='member';assert.throws(()=>sso.exchange({code,verifier,state,redirectUri:ASSESSMENT_CALLBACK}),e=>e.status===403);
    assert.throws(()=>issue(),e=>e.status===403);role='admin';
    const grant=sso.exchange({code:issue(),verifier,state,redirectUri:ASSESSMENT_CALLBACK});role='member';assert.throws(()=>sso.inspect(grant.token),e=>e.status===403);
    role='admin';live=false;assert.throws(()=>sso.inspect(grant.token),e=>e.status===401);
  }finally{sso.close();await rm(directory,{recursive:true,force:true});}
});
