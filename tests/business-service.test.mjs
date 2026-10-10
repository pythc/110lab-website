import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createBusinessService} from '../server/business-service.mjs';
import {BUSINESS_SCOPES} from '../server/business-scopes.mjs';
import {createWorkspaceHttp} from '../server/workspace-http.mjs';
import {createHonorsHttp} from '../server/honors-http.mjs';
import {openRecruitmentWorkflowStore} from '../server/recruitment-workflow-store.mjs';
import {openUpdatesStore} from '../server/updates.mjs';
import {runWorkflowDeliveryOnce} from '../server/recruitment-workflow-worker.mjs';

const roles={owner:{subject:'fictional:owner',name:'虚构管理员',email:'owner@example.test',role:'super_admin'},member:{subject:'fictional:member',name:'虚构成员',email:'member@example.test',role:'member'},other:{subject:'fictional:other',name:'另一个成员',email:'other@example.test',role:'member'}};
const ids=()=>({requestId:randomUUID()});
async function harness(t,{mode='dry-run',send=async()=>({accepted:['candidate@example.test'],rejected:[],messageId:'fictional-message'})}={}){
  const directory=await mkdtemp(join(tmpdir(),'110lab-business-')),profiles=structuredClone(roles);
  const mail={enabled:true,workspaceDirectory:directory,profile:subject=>{const a=Object.values(profiles).find(a=>a.subject===subject);if(!a)throw Object.assign(new Error('Unauthenticated'),{status:401});return a;},projectMembers:async()=>({members:Object.values(profiles).map(({subject,name,email})=>({subject,name,email})),source:'fixture'})};
  const workspace=createWorkspaceHttp({mail,recruitment:{labInbox:()=>({items:[]})},localTest:true});
  const honors=createHonorsHttp({mail,projects:a=>workspace.projects(a),localTest:true});
  const r=openRecruitmentWorkflowStore({directory:join(directory,'recruitment'),deliveryMode:'dry-run'}),updates=openUpdatesStore(join(directory,'updates.sqlite'));
  let sends=0;
  const provider={revision:'fixture-provider-v1',mode,mailboxes:()=>[{address:'noreply@110-lab.cn',enabled:true,canRead:true,canSend:true}],list:async()=>({items:[],nextCursor:null}),get:async()=>({messageId:'original@example.test',from:[{address:'candidate@example.test'}],replyTo:[],references:[],attachments:[],body:'不可信邮件内容'}),send:async(...args)=>{sends++;return send(...args);},close(){}};
  const create=()=>createBusinessService({mail,workspace,honors,recruitment:{store:r},updates,updatesEnabled:true,directory:join(directory,'business'),mailProvider:provider});
  let service=create();
  const actor=key=>({...profiles[key],scopes:Object.keys(BUSINESS_SCOPES),clientId:'fictional-client'});
  t.after(async()=>{await service.close();honors.close();workspace.close();r.close();updates.close();await rm(directory,{recursive:true,force:true});});
  return {profiles,mail,workspace,honors,r,updates,provider,actor,get sends(){return sends;},get service(){return service;},call:(name,args={},key='owner')=>service.call('lab_'+name,args,actor(key)),async restart(){await service.close();service=create();}};
}
const project={name:'虚构项目',summary:'项目介绍',members:[],links:{repository:'',requirements:'',docs:'',demo:''}};
const article={title:'虚构动态',summary:'测试摘要',body:[{type:'paragraph',content:[{text:'测试正文'}]}],link:null};

test('business identity is live, scopes narrow, projects preserve canonical members and durable retries',async t=>{
  const h=await harness(t),a=h.actor('member');
  assert.equal((await h.service.call('lab_candidates_list',{},a)).items.length,0);
  await assert.rejects(h.service.call('lab_projects_list',{}, {...a,scopes:['mail:session']}),{code:'SCOPE_REQUIRED'});
  await assert.rejects(h.call('project_save',{...ids(),fields:{...project,members:[{subject:'invented:member'}]}},'member'),{status:400});
  const args={...ids(),fields:{...project,members:[{subject:roles.other.subject}]}};
  let p=await h.call('project_save',args,'member');assert.equal((await h.call('project_save',args,'member')).id,p.id);
  assert.equal(p.members[0].name,roles.other.name);assert.equal((await h.call('project_get',{id:p.id},'other')).id,p.id);
  await assert.rejects(h.call('project_save',{...args,fields:{...project,name:'changed'}},'member'),{code:'REQUEST_CONFLICT'});
  await assert.rejects(h.call('project_save',{...ids(),id:p.id,expectedRevision:p.revision,fields:project},'other'),{status:403});
  p=await h.call('project_apply',{...ids(),id:p.id,expectedRevision:p.revision,application:'申请实验室共同开发'},'member');assert.equal(p.phase,'pending');
  p=await h.call('project_review',{...ids(),id:p.id,expectedRevision:p.revision,decision:'approve',note:''});assert.equal(p.phase,'active');
  await h.restart();assert.equal((await h.call('project_save',args,'member')).id,p.id);assert.equal((await h.call('projects_list',{},'member')).items.length,1);
  h.profiles.owner.role='member';await assert.rejects(h.call('updates_list'),{status:403});
});

test('honor submission, approval and private certificates preserve existing visibility',async t=>{
  const h=await harness(t);
  const fields={name:'虚构荣誉',organizer:'虚构主办方',level:'校级',levelNote:'',prize:'一等奖',awardedAt:'2026-10-01',projectId:null,members:[{subject:roles.member.subject}],description:'虚构资料'};
  let r=await h.call('honor_save',{...ids(),fields},'member');
  assert.equal((await h.call('honors_list',{},'other')).items.length,0);
  await assert.rejects(h.call('honor_get',{id:r.id},'other'),{status:404});
  r=await h.call('honor_submit',{...ids(),id:r.id,expectedRevision:r.revision},'member');
  await assert.rejects(h.call('honor_review',{...ids(),id:r.id,expectedRevision:r.revision,decision:'approve',note:''},'member'),{status:403});
  r=await h.call('honor_review',{...ids(),id:r.id,expectedRevision:r.revision,decision:'approve',note:''});
  assert.equal((await h.call('honors_list',{},'other')).items.length,1);
  r=await h.call('honor_save',{...ids(),id:r.id,expectedRevision:r.revision,fields},'member');assert.equal(r.status,'draft');
  assert.equal((await h.call('updates_list')).items.length,0);
});

test('publication requires exact human confirmation, stale snapshots fail, repeated execution is safe',async t=>{
  const h=await harness(t);let d=await h.call('update_draft_save',{...ids(),content:article});
  let p=await h.call('update_publication_preview',{...ids(),id:d.id,expectedRevision:d.revision,action:'publish'});
  await assert.rejects(h.call('update_publish',{...ids(),previewId:p.id}),{code:'CONFIRMATION_REQUIRED'});
  assert.throws(()=>h.service.confirm(h.actor('member'),p.id,p.fingerprint),{status:404});
  h.service.confirm(h.actor('owner'),p.id,p.fingerprint);
  d=await h.call('update_publish',{...ids(),previewId:p.id});assert.equal(h.updates.listPublished().length,1);
  assert.equal((await h.call('update_publish',{...ids(),previewId:p.id})).revision,d.revision);
  d=await h.call('update_draft_save',{...ids(),id:d.id,expectedRevision:d.revision,content:{...article,title:'新草稿'}});assert.equal(h.updates.listPublished()[0].title,article.title);
  p=await h.call('update_publication_preview',{...ids(),id:d.id,expectedRevision:d.revision,action:'publish'});
  d=await h.call('update_draft_save',{...ids(),id:d.id,expectedRevision:d.revision,content:{...article,title:'再次修改'}});
  assert.throws(()=>h.service.confirm(h.actor('owner'),p.id,p.fingerprint),{code:'REVISION_CONFLICT'});
  const withdraw=await h.call('update_publication_preview',{...ids(),id:d.id,expectedRevision:d.revision,action:'withdraw'});h.service.confirm(h.actor('owner'),withdraw.id,withdraw.fingerprint);await h.call('update_withdraw',{...ids(),previewId:withdraw.id});assert.equal(h.updates.listPublished().length,0);
});

test('recruitment templates render variables, simulate only after per-person confirmation and report actual status',async t=>{
  const h=await harness(t);let c=h.r.create(h.actor('owner'),{...ids(),name:'虚构候选人',email:'candidate@example.test',group:'前端组',summary:'测试'});
  c=await h.call('candidate_record',{...ids(),id:c.id,expectedRevision:c.revision,record:{action:'screen',assessmentRequired:false,note:'测试初筛'}});
  c=await h.call('candidate_record',{...ids(),id:c.id,expectedRevision:c.revision,record:{action:'schedule',at:new Date(Date.now()+86400000).toISOString(),interviewer:'虚构面试官',email:'interviewer@example.test',contact:'测试联系方式',location:'测试会议室'}});
  const {templates}=await h.call('recruitment_options');const p=await h.call('recruitment_notice_preview',{...ids(),id:c.id,expectedRevision:c.revision,templateId:templates[0].id,templateRevision:templates[0].revision,values:{}});
  assert.match(p.preview.payload.body,/虚构候选人/);assert.equal(p.preview.payload.replyTo,'interviewer@example.test');
  await assert.rejects(h.call('recruitment_notice_send',{...ids(),previewId:p.id}),{code:'CONFIRMATION_REQUIRED'});
  h.service.confirm(h.actor('owner'),p.id,p.fingerprint);const queued=await h.call('recruitment_notice_send',{...ids(),previewId:p.id});assert.equal(queued.mailStatus,'NOT_SENT');
  await runWorkflowDeliveryOnce(h.r,{mode:'dry-run',roleForSubject:()=>h.profiles.owner.role,intervalMs:0});
  assert.equal((await h.call('operation_get',{operationId:queued.operationId})).status,'SIMULATED');assert.equal(h.sends,0);
  await assert.rejects(h.call('recruitment_feishu_preview',{...ids(),id:c.id,expectedRevision:h.r.get(h.actor('owner'),c.id).revision}),{code:'NOT_FOUND'});
});

test('mail drafts, attachment transfer, confirmation and simulation never invoke a network sender',async t=>{
  const h=await harness(t),upload=await h.call('file_upload',{...ids(),purpose:'mail_attachment',filename:'测试.txt',contentBase64:Buffer.from('虚构附件').toString('base64')});
  const args={...ids(),fields:{mailbox:'noreply@110-lab.cn',to:['candidate@example.test'],subject:'虚构邮件',body:'测试正文',attachments:[upload.artifactId]}};
  const p=await h.call('mail_draft_save',args);assert.equal((await h.call('mail_draft_save',args)).id,p.id);
  await assert.rejects(h.call('mail_send',{...ids(),previewId:p.id}),{code:'CONFIRMATION_REQUIRED'});
  h.service.confirm(h.actor('owner'),p.id,p.fingerprint);const op=await h.call('mail_send',{...ids(),previewId:p.id});await h.service.runMail();
  assert.equal((await h.call('operation_get',{operationId:op.operationId})).state,'SIMULATED');assert.equal(h.sends,0);
  await h.call('mail_send',{...ids(),previewId:p.id});await h.service.runMail();assert.equal(h.sends,0);
});

test('mail ambiguous delivery is never retried; queued permission changes prevent sending',async t=>{
  const h=await harness(t,{mode:'live',send:async()=>{throw Object.assign(new Error('unconfirmed'),{code:'ETIMEDOUT',command:'DATA'});}});
  const prepare=()=>h.call('mail_draft_save',{...ids(),fields:{mailbox:'noreply@110-lab.cn',to:['candidate@example.test'],subject:'测试',body:'测试'}});
  let p=await prepare();h.service.confirm(h.actor('owner'),p.id,p.fingerprint);const op=await h.call('mail_send',{...ids(),previewId:p.id});await h.service.runMail();
  assert.equal((await h.call('operation_get',{operationId:op.operationId})).state,'UNKNOWN');assert.equal(h.sends,1);
  await h.service.runMail();await h.call('mail_send',{...ids(),previewId:p.id});await h.service.runMail();assert.equal(h.sends,1);
  p=await prepare();h.service.confirm(h.actor('owner'),p.id,p.fingerprint);await h.call('mail_send',{...ids(),previewId:p.id});h.profiles.owner.role='member';await h.service.runMail();assert.equal(h.sends,1);
});

test('retired table tools cannot run even with old configuration and grants',async t=>{
  const h=await harness(t),a=h.actor('owner'),settings=h.r.settings(a);
  h.r.saveSettings(a,{...ids(),revision:settings.revision,mailboxes:settings.mailboxes,sender:settings.sender,recipient:settings.recipient,feishu:{appToken:'FictionalAppToken2026',tableId:'tblFictional2026'}});
  const c=h.r.create(a,{...ids(),name:'虚构联动候选人',email:'candidate@example.test',group:'开发组',summary:'测试'});
  await assert.rejects(h.call('recruitment_feishu_preview',{...ids(),id:c.id,expectedRevision:c.revision}),{code:'NOT_FOUND'});
  await assert.rejects(h.call('recruitment_feishu_sync',{...ids(),previewId:randomUUID()}),{code:'NOT_FOUND'});
  assert.throws(()=>h.r.preview(a,c.id,'feishu'),/停用/);assert.equal(h.sends,0);
});

test('HR MCP capabilities are recruitment-only, live revocation works, and member reads stay assignment-scoped',async t=>{
 const h=await harness(t);h.profiles.member.subject='tenant:on_fixturehr00001';const member=h.actor('member');
 h.r.setHr(h.actor('owner'),{...ids(),revision:1,subject:member.subject,enabled:true},member);
 const who=await h.call('whoami',{},'member');assert.ok(who.capabilities.includes('lab_candidate_record'));assert.ok(!who.capabilities.includes('lab_mail_send'));assert.ok(!who.capabilities.includes('lab_update_publish'));
 const c=h.r.create(member,{...ids(),name:'虚构 HR 候选人',email:'candidate@example.test',group:'开发组',summary:''});assert.equal((await h.call('candidate_get',{id:c.id},'member')).id,c.id);
 for(const name of ['mailboxes_list','updates_list'])await assert.rejects(h.call(name,{},'member'),{status:403});
 const template=(await h.call('recruitment_options',{},'member')).templates[0];await h.call('recruitment_template_save',{...ids(),template:{...template,subject:'测试 {{name}}'}},'member');
 h.r.setHr(h.actor('owner'),{...ids(),revision:2,subject:member.subject,enabled:false},member);
 assert.equal((await h.call('candidates_list',{},'member')).items.length,0);await assert.rejects(h.call('candidate_get',{id:c.id},'member'),{status:404});
 await assert.rejects(h.service.call('lab_recruitment_template_save',{...ids(),template}, {...member,recruitmentRole:'hr'}),{status:403});
 let assigned=h.r.act(h.actor('owner'),c.id,{...ids(),revision:c.revision,action:'screen',assessmentRequired:false,note:''});assigned=h.r.assignInterviewer(h.actor('owner'),c.id,{...ids(),revision:assigned.revision,subject:member.subject},member);
 assert.equal((await h.call('candidate_get',{id:c.id},'member')).id,c.id);assert.equal((await h.call('candidates_list',{},'member')).items.length,1);await assert.rejects(h.call('candidate_decide',{...ids(),id:c.id,expectedRevision:assigned.revision,decision:'reject',note:'越权'},'member'),{status:403});
});
