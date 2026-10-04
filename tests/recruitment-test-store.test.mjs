import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openRecruitmentTestStore} from '../server/recruitment-test-store.mjs';
const admin={subject:'test:admin',name:'虚构管理员',role:'admin'},member={subject:'test:member',name:'虚构成员',role:'member'};
const data=()=>({requestId:randomUUID(),name:'虚构候选人',group:'开发组',email:randomUUID()+'@example.com',summary:'仅测试'});
test('isolated empty workflow persists, enforces transitions and approved notification revision, retries once',()=>{
 const directory=mkdtempSync(join(tmpdir(),'110lab-pilot-'));let store=openRecruitmentTestStore({directory});
 try{
  assert.equal(store.list(admin).items.length,0);assert.throws(()=>store.list(member),e=>e.status===403);
  const input=data();let c=store.create(admin,input);assert.equal(store.create(admin,input).id,c.id);
  assert.throws(()=>store.create(admin,{...input,requestId:randomUUID()}),e=>e.status===409);
  assert.throws(()=>store.create(admin,{...input,name:'另一人'}),e=>e.status===409);
  assert.throws(()=>store.create(admin,{...data(),email:'real@gmail.com'}));
  const act=(action,args={})=>c=store.act(admin,c.id,{requestId:randomUUID(),revision:c.revision,action,...args});
  assert.throws(()=>act('accept',{note:'不能越过流程'}),e=>e.status===409);
  act('screen',{assessmentRequired:true,note:'虚构评审'});assert.equal(c.stage,'assessment');
  assert.throws(()=>act('assessment',{score:101,note:'无效成绩'}));
  act('assessment',{score:80,note:'虚构考核记录'});assert.equal(c.stage,'interview');
  assert.throws(()=>act('simulate_notice',{fail:false}),e=>e.status===409);
  const schedule={at:new Date(Date.now()+86400000).toISOString(),interviewer:'虚构面试官',location:'测试会议室'};
  act('schedule',schedule);act('approve_notice');
  act('schedule',{...schedule,location:'测试会议室二'});
  assert.equal(c.notification.status,'draft');assert.throws(()=>act('simulate_notice',{fail:false}),e=>e.status===409);
  act('approve_notice');act('simulate_notice',{fail:true});assert.equal(c.notification.status,'failed');
  const retry={requestId:randomUUID(),revision:c.revision,action:'simulate_notice',fail:false};
  c=store.act(admin,c.id,retry);assert.equal(c.notification.status,'simulated');assert.equal(c.notification.attempts,2);
  assert.equal(store.act(admin,c.id,retry).revision,c.revision);assert.equal(store.get(admin,c.id).notification.attempts,2);
  assert.throws(()=>store.act(admin,c.id,{requestId:randomUUID(),revision:c.revision-1,action:'interview',score:90,note:'过期操作'}),e=>e.status===409);
  act('interview',{score:90,note:'虚构面试反馈'});act('accept',{note:'测试录取结果'});act('archive');
  assert.equal(c.archived,true);assert.throws(()=>act('reject',{note:'已归档'}),e=>e.status===409);
  const second=store.create(admin,data());let rejected=store.act(admin,second.id,{requestId:randomUUID(),revision:1,action:'reject',note:'测试未通过'});assert.equal(rejected.stage,'rejected');
  store.close();store=openRecruitmentTestStore({directory});assert.equal(store.list(admin).items.length,2);assert.equal(store.get(admin,c.id).events.length,c.events.length);
  assert.equal(statSync(join(directory,'recruitment-test.sqlite')).mode&0o777,0o600);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
test('assessment can be skipped explicitly and parallel writers cannot both advance',()=>{
 const directory=mkdtempSync(join(tmpdir(),'110lab-pilot-'));const first=openRecruitmentTestStore({directory}),second=openRecruitmentTestStore({directory});
 try{
  let c=first.create(admin,data());const input={requestId:randomUUID(),revision:c.revision,action:'screen',assessmentRequired:false,note:''};
  c=first.act(admin,c.id,input);assert.equal(c.stage,'interview');assert.equal(c.assessment,null);
  assert.throws(()=>second.act(admin,c.id,{...input,requestId:randomUUID()}),e=>e.status===409);
  assert.throws(()=>second.act(member,c.id,{requestId:randomUUID(),revision:c.revision,action:'reject',note:'权限撤销'}),e=>e.status===403);
 }finally{first.close();second.close();rmSync(directory,{recursive:true,force:true});}
});
