import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,lstatSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openMailAccessStore} from '../server/mail-access-store.mjs';
const owner={subject:'fictional:owner',email:'owner.fixture@110-lab.cn',name:'虚构负责人'},member={subject:'fictional:member',email:'member.fixture@110-lab.cn',name:'虚构成员'};
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'mail-access-')),options={filename:join(dir,'access.sqlite'),bootstrapOwner:owner},store=openMailAccessStore(options);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {dir,options,store};}
const error=status=>e=>e.status===status;
test('only verified corporate members can become administrators and binding cannot be reassigned',t=>{
  const {store}=fixture(t);assert.equal(store.me(owner.subject).role,'super_admin');
  assert.throws(()=>store.grantAdministrator(owner.subject,member.email,1),error(409));
  assert.throws(()=>store.registerIdentity({...member,email:'outside@example.org'}),error(400));
  store.registerIdentity(member);assert.equal(store.listMembers(owner.subject).length,2);
  assert.throws(()=>store.listMembers(member.subject),error(403));
  const granted=store.grantAdministrator(owner.subject,member.email,1);assert.equal(granted.active,true);assert.equal(granted.subject,member.subject);
  assert.equal(store.assertAdministrator(member.subject).role,'admin');
  assert.throws(()=>store.registerIdentity({...member,subject:'fictional:impostor'}),error(409));
  assert.throws(()=>store.registerIdentity({...member,email:'changed@110-lab.cn'}),error(409));
  assert.throws(()=>store.grantAdministrator(member.subject,owner.email,2),error(403));
  assert.throws(()=>store.audit(member.subject),error(403));
  store.revokeAdministrator(owner.subject,member.email,2);assert.equal(store.me(member.subject).role,'member');assert.throws(()=>store.assertAdministrator(member.subject),error(403));
});
test('transfer is atomic, keeps one owner, survives restart and bootstrap never reclaims',t=>{
  const {store,options}=fixture(t);store.registerIdentity(member);store.grantAdministrator(owner.subject,member.email,1);
  assert.throws(()=>store.revokeAdministrator(owner.subject,owner.email,2),error(403));
  store.transferSuperAdministrator(owner.subject,member.email,2);assert.equal(store.me(owner.subject).role,'admin');assert.equal(store.me(member.subject).role,'super_admin');
  assert.throws(()=>store.transferSuperAdministrator(owner.subject,member.email,3),error(403));store.close();
  const reopened=openMailAccessStore(options);try{assert.equal(reopened.me(owner.subject).role,'admin');assert.equal(reopened.listAdministrators(member.subject).administrators.filter(a=>a.role==='super_admin').length,1);reopened.revokeAdministrator(member.subject,owner.email,3);assert.equal(reopened.me(owner.subject).role,'member');assert.deepEqual(reopened.audit(member.subject).entries.map(e=>e.action),['revoke','transfer','grant','bootstrap']);}finally{reopened.close();}
  assert.throws(()=>openMailAccessStore({...options,bootstrapOwner:member}),error(409));
});
test('two connections reject stale revisions and revoked actors immediately',t=>{
  const {store,options}=fixture(t),other=openMailAccessStore(options);try{store.registerIdentity(member);assert.equal(other.listAdministrators(owner.subject).revision,1);store.grantAdministrator(owner.subject,member.email,1);assert.throws(()=>other.revokeAdministrator(owner.subject,member.email,1),error(409));store.transferSuperAdministrator(owner.subject,member.email,2);assert.throws(()=>other.revokeAdministrator(owner.subject,member.email,3),error(403));store.revokeAdministrator(member.subject,owner.email,3);assert.throws(()=>other.assertAdministrator(owner.subject),error(403));}finally{other.close();}
});
test('private SQLite files reject symlinks',t=>{
  const {dir,store,options}=fixture(t);assert.equal(lstatSync(dir).mode&0o777,0o700);assert.equal(lstatSync(options.filename).mode&0o777,0o600);store.close();
  const target=join(dir,'target.sqlite');writeFileSync(target,'',{mode:0o600});const link=join(dir,'linked.sqlite');symlinkSync(target,link);assert.throws(()=>openMailAccessStore({...options,filename:link}));
});
