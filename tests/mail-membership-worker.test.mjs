import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openMailAccessStore} from '../server/mail-access-store.mjs';
import {openMailMembershipState,MEMBERSHIP_RECHECK_MS} from '../server/mail-membership-state.mjs';
import {startMailMembershipWorker} from '../server/mail-membership-worker.mjs';
import {createMailMembershipProvider} from '../server/mail-membership-provider.mjs';

const owner={subject:'fictional:owner',email:'owner.fixture@110-lab.cn',name:'虚构负责人'};
const member={subject:'fictional:member',email:'member.fixture@110-lab.cn',name:'虚构成员'};
function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'mail-membership-'));let time=Date.now();
  const now=()=>time,options={filename:join(directory,'access.sqlite'),bootstrapOwner:owner,now};
  const access=openMailAccessStore(options),state=openMailMembershipState({directory,now});
  const members=new Map(),calls=[];let id=0;
  const provider={
    async listMembers(){calls.push('list');return [...members].map(([memberId,subject])=>({memberId,subject}));},
    async addMember(subject){calls.push(['add',subject]);members.set(String(++id),subject);},
    async removeMember(memberId){calls.push(['remove',members.get(memberId)]);members.delete(memberId);}
  };
  const workers=[];
  const start=(overrides={})=>{const w=startMailMembershipWorker({access,state,provider,now,pollMs:3600000,...overrides});workers.push(w);return w;};
  t.after(async()=>{for(const w of workers)await w.stop();state.close();access.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,options,access,state,members,calls,provider,start,now,advance(ms){time+=ms;}};
}

test('grant, transfer and revoke converge to current administrators and recheck drift',async t=>{
  const f=fixture(t),w=f.start();await w.tick();
  assert.deepEqual([...f.members.values()],[owner.subject]);assert.equal(f.state.status(1).state,'ready');
  f.access.registerIdentity(member);f.access.grantAdministrator(owner.subject,member.email,1);
  assert.equal(f.state.status(2).state,'pending');await w.tick();
  assert.deepEqual(new Set(f.members.values()),new Set([owner.subject,member.subject]));
  f.access.transferSuperAdministrator(owner.subject,member.email,2);await w.tick();
  f.access.revokeAdministrator(member.subject,owner.email,3);await w.tick();
  assert.deepEqual([...f.members.values()],[member.subject]);assert.equal(f.state.status(4).state,'ready');
  const reopened=openMailAccessStore(f.options);assert.equal(reopened.me(owner.subject).role,'member');reopened.close();
  f.members.set('external','fictional:unmanaged');f.advance(MEMBERSHIP_RECHECK_MS+1);await w.tick();
  assert.deepEqual([...f.members.values()],[member.subject]);
  assert.equal(lstatSync(join(f.directory,'mail-membership.sqlite')).mode&0o777,0o600);
  await w.stop();assert.equal(f.state.status(4).state,'pending');
});

test('role change during a grant is corrected before claiming success',async t=>{
  const f=fixture(t);f.access.registerIdentity(member);f.access.grantAdministrator(owner.subject,member.email,1);
  const add=f.provider.addMember;f.provider.addMember=async subject=>{await add(subject);if(subject===member.subject)f.access.revokeAdministrator(owner.subject,member.email,2);};
  const w=f.start();await w.tick();
  assert.deepEqual([...f.members.values()],[owner.subject]);assert.equal(f.state.status(3).state,'ready');
  assert.ok(f.calls.some(c=>Array.isArray(c)&&c[0]==='remove'&&c[1]===member.subject));
});

test('provider outage leaves revocation pending and retries with durable backoff',async t=>{
  const f=fixture(t);f.access.registerIdentity(member);f.access.grantAdministrator(owner.subject,member.email,1);
  const w=f.start();await w.tick();f.access.revokeAdministrator(owner.subject,member.email,2);
  const remove=f.provider.removeMember;let attempts=0;
  f.provider.removeMember=async()=>{attempts++;throw Object.assign(new Error('fixture failure'),{providerCode:99991672});};
  await w.tick();assert.equal(f.state.status(3).state,'error');assert.ok([...f.members.values()].includes(member.subject));
  const retryAfter=f.state.read().retry_after;await w.tick();assert.equal(attempts,1);
  await w.stop();const replacement=f.start();await replacement.tick();assert.equal(attempts,1);
  f.advance(retryAfter-f.now());await replacement.tick();assert.equal(attempts,2);assert.equal(f.state.read().retry_after-f.now(),30000);
  f.provider.removeMember=remove;f.advance(30000);await replacement.tick();
  assert.deepEqual([...f.members.values()],[owner.subject]);assert.equal(f.state.status(3).state,'ready');assert.equal(f.state.read().failures,0);
});

test('lease takeover prevents the old worker from writing or reporting ready',async t=>{
  const f=fixture(t);let release,entered;const enteredPromise=new Promise(r=>entered=r);
  const oldProvider={...f.provider,listMembers:()=>{entered();return new Promise(r=>release=r);}};
  const old=f.start({provider:oldProvider});await enteredPromise;
  const other=openMailMembershipState({directory:f.directory,now:f.now});t.after(()=>other.close());
  const next=f.start({state:other});await next.tick();assert.equal(f.members.size,0);
  f.advance(60001);await next.tick();assert.deepEqual([...f.members.values()],[owner.subject]);
  const calls=f.calls.length;release([]);await old.tick();assert.equal(f.calls.length,calls);
  assert.equal(other.status(1).state,'ready');await old.stop();assert.equal(other.status(1).state,'ready');
});

test('upstream write without read-back confirmation never reports ready',async t=>{
  const f=fixture(t);f.provider.addMember=async()=>{};const w=f.start();await w.tick();
  assert.equal(f.state.status(1).state,'error');assert.equal(f.members.size,0);
});

test('real provider maps Feishu union IDs to stored subjects without removing current administrators',async t=>{
  const f=fixture(t),admin={subject:'fictional:on_admin',email:'mapping.fixture@110-lab.cn',name:'虚构映射管理员'};
  f.access.registerIdentity(admin);f.access.grantAdministrator(owner.subject,admin.email,1);f.access.transferSuperAdministrator(owner.subject,admin.email,2);f.access.revokeAdministrator(admin.subject,owner.email,3);
  const calls=[],provider=createMailMembershipProvider({config:{appId:'cli_fixture',appSecret:'fixture',tenantKey:'fictional'},fetchImpl:async(url,init)=>{
    const parsed=new URL(url);calls.push(init.method+' '+parsed.pathname);
    if(parsed.pathname.endsWith('/tenant_access_token/internal'))return Response.json({code:0,tenant_access_token:'fixture_token',expire:7200});
    assert.equal(init.method,'GET','a matching administrator must never be removed and re-added');
    return Response.json({code:0,data:{has_more:false,items:[{member_id:'member_fixture',user_id:'on_admin',type:'USER'}]}});
  }});
  const worker=f.start({provider});await worker.tick();assert.equal(f.state.status(4).state,'ready');assert.equal(calls.length,2);
});
