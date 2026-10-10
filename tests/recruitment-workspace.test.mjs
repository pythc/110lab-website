import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openRecruitmentWorkflowStore} from '../server/recruitment-workflow-store.mjs';
import {runWorkflowDeliveryOnce} from '../server/recruitment-workflow-worker.mjs';
import {candidateTask,notificationIssue} from '../src/recruitment-tasks.js';
const admin={subject:'tenant:admin',role:'super_admin',name:'管理员'},member={subject:'tenant:interviewer',role:'member',name:'面试官',email:'interviewer@example.com'},other={...member,subject:'tenant:other'};
function fixture(t){const directory=mkdtempSync(join(tmpdir(),'110lab-workspace-test-'));let clock=Date.now();const s=openRecruitmentWorkflowStore({directory,now:()=>clock,deliveryMode:'dry-run'});t.after(()=>{s.close();rmSync(directory,{recursive:true,force:true});});return {s,advance:n=>clock+=n,now:()=>clock};}
const act=(s,c,action,values={})=>s.act(admin,c.id,{requestId:randomUUID(),revision:c.revision,action,...values});
const command=(s,c,name,values={})=>s[name](admin,c.id,{requestId:randomUUID(),revision:c.revision,...values});
const create=s=>s.create(admin,{requestId:randomUUID(),name:'虚构候选人',group:'开发组',email:randomUUID()+'@example.com',summary:'虚构资料'});
const drain=async s=>{while(await runWorkflowDeliveryOnce(s,{mode:'dry-run',intervalMs:0,roleForSubject:()=>admin.role}));};
function assigned(s){let c=act(s,create(s),'screen',{assessmentRequired:false,note:''});return s.assignInterviewer(admin,c.id,{requestId:randomUUID(),revision:c.revision,subject:member.subject},member);}
function proposed(s,c,now){s.proposeInterview(member,c.assignment.id,{requestId:randomUUID(),revision:c.assignment.revision,at:new Date(now+3600000).toISOString(),email:member.email,contact:'测试联系人',location:'https://example.com/meeting'});return s.get(admin,c.id);}
function prepare(s,c){const t=s.templates(admin).items.find(t=>(t.kind||'interview')==='interview');return act(s,c,'prepare_notice',{templateId:t.id,templateRevision:t.revision,values:{}});}
function approved(s,c){c=prepare(s,c);return act(s,c,'send_notice',{previewHash:s.preview(admin,c.id,'interview').previewHash});}
function outcome(s,c){const t=s.templates(admin).items.find(t=>t.kind==='rejected');return command(s,c,'prepareOutcome',{outcome:'rejected',note:'仅虚构测试',templateId:t.id,templateRevision:t.revision,values:{}});}

test('feedback belongs to the assigned interviewer, is idempotent, independent of failed mail, and leaves the decision to admins',async t=>{
 const {s,now,advance}=fixture(t);let c=assigned(s);await drain(s);c=approved(s,proposed(s,s.get(admin,c.id),now()));
 // An actual failed outbox delivery, without network calls.
 const job=s.claim({intervalMs:0});s.finish(job,{status:'FAILED',code:'FIXTURE_FAILURE'});c=s.get(admin,c.id);
 const input={requestId:randomUUID(),revision:c.assignment.revision,score:88,note:'良好的项目实践与协作能力',recommendation:'recommend'};
 assert.throws(()=>s.submitFeedback(other,c.assignment.id,input),e=>e.status===404);
 assert.throws(()=>s.submitFeedback(admin,c.assignment.id,input),e=>e.status===404);
 assert.throws(()=>s.submitFeedback(member,c.assignment.id,input),/开始后/);
 assert.throws(()=>act(s,c,'interview',{score:88,note:'管理员代填'}),/面试官/);
 advance(3600001);
 const result=s.submitFeedback(member,c.assignment.id,input);assert.equal(result.stage,'decision');assert.equal(result.assignment.feedback.subject,member.subject);
 assert.deepEqual(s.submitFeedback(member,c.assignment.id,input),result);
 assert.throws(()=>s.submitFeedback(member,c.assignment.id,{...input,requestId:randomUUID()}),e=>e.status===409);
 assert.throws(()=>s.submitFeedback(member,c.assignment.id,{...input,note:'改变的请求'}),e=>e.status===409);
 c=s.get(admin,c.id);assert.equal(c.notification.status,'failed');assert.equal(candidateTask(c).key,'decision');assert.equal(notificationIssue(c),'通知发送失败');
 assert.equal(c.events.filter(e=>e.action==='面试官提交评价').length,1);assert.equal(c.resultNotification??null,null);
});

test('rescheduling preserves the previous arrangement and makes old approval unusable',async t=>{
 const {s,now}=fixture(t);let c=assigned(s);await drain(s);c=approved(s,proposed(s,s.get(admin,c.id),now()));await drain(s);c=s.get(admin,c.id);const oldTime=c.interview.at,oldHash=s.preview(admin,c.id,'interview').previewHash;
 c=command(s,c,'requestReschedule',{note:'候选人需调整时间'});assert.equal(c.assignment.status,'changes_requested');assert.equal(c.interview,null);assert.equal(c.notification,null);assert.equal(c.interviewHistory[0].interview.at,oldTime);
 assert.throws(()=>act(s,c,'send_notice',{previewHash:oldHash}),e=>e.status===409);
 c=proposed(s,c,now()+3600000);assert.notEqual(c.assignment.proposal.at,oldTime);assert.equal(c.interviewHistory.length,1);
 c=approved(s,c);await drain(s);assert.equal(s.get(admin,c.id).notification.status,'simulated');
});

test('rescheduling blocks in-flight or unknown sends without changing revision or history',async t=>{
 const {s,now}=fixture(t);let c=assigned(s);await drain(s);c=approved(s,proposed(s,s.get(admin,c.id),now()));const job=s.claim({intervalMs:0});
 assert.throws(()=>command(s,c,'requestReschedule',{note:'测试改期'}),e=>e.status===409);assert.equal(s.get(admin,c.id).revision,c.revision);
 s.finish(job,{status:'UNKNOWN',code:'FIXTURE_UNKNOWN'});c=s.get(admin,c.id);assert.throws(()=>command(s,c,'requestReschedule',{note:'测试改期'}),e=>e.status===409);assert.equal(s.get(admin,c.id).interviewHistory,undefined);
});

test('progress invalidates result drafts, including pre-upgrade drafts; history remains permanent',t=>{
 const {s}=fixture(t);let c=outcome(s,create(s));assert.equal(s.get(admin,c.id).resultDraftValid,true);const old=s.previewOutcome(admin,c.id).previewHash;
 c=act(s,c,'screen',{assessmentRequired:false,note:''});assert.equal(c.resultNotification,null);assert.equal(c.draftHistory.length,1);assert.throws(()=>command(s,c,'confirmOutcome',{previewHash:old}),e=>e.status===409);
 c=outcome(s,c);const db=new DatabaseSync(join(s.root,'recruitment.sqlite'));try{const row=JSON.parse(db.prepare('SELECT data FROM candidates WHERE id=?').get(c.id).data);delete row.resultNotification.contextHash;db.prepare('UPDATE candidates SET data=? WHERE id=?').run(JSON.stringify(row),c.id);}finally{db.close();}
 c=s.get(admin,c.id);assert.equal(c.resultDraftValid,false);assert.throws(()=>command(s,c,'confirmOutcome',{previewHash:s.previewOutcome(admin,c.id).previewHash}),/旧版本/);
});

test('private resume access follows the current assignment, including reassignment',t=>{
 const {s}=fixture(t);let c=assigned(s);const buffer=Buffer.from('%PDF-1.7\nfixture');c=s.attachResume(admin,c.id,{requestId:randomUUID(),revision:c.revision,filename:'fixture.pdf',extension:'pdf',buffer,bytes:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex')});
 assert.deepEqual(s.interviewerResume(member,c.id).buffer,buffer);assert.throws(()=>s.interviewerResume(other,c.id),e=>e.status===404);
 c=s.assignInterviewer(admin,c.id,{requestId:randomUUID(),revision:c.revision,subject:other.subject},other);
 assert.throws(()=>s.interviewerResume(member,c.id),e=>e.status===404);assert.deepEqual(s.interviewerResume(other,c.id).buffer,buffer);
});

test('live template and composition previews render safely without mutating or enqueueing',t=>{
 const {s,now}=fixture(t);let c=proposed(s,assigned(s),now()),template=s.templates(admin).items[0];template={...template,html:'<h2 style="text-align:center">{{name}}</h2><script>alert(1)</script>',variables:[{key:'room',label:'房间',required:true,defaultValue:'实验室'}]};
 const before=s.get(admin,c.id),templates=s.templates(admin);const preview=s.previewTemplate(admin,{template,sample:{name:'<img onerror=x>',group:'开发组'}});assert.match(preview.payload.html,/text-align:center/);assert.match(preview.payload.html,/&lt;img/);assert.ok(!preview.payload.html.includes('<script'));
 assert.throws(()=>s.previewTemplate(member,{template}),e=>e.status===403);
 const exact=s.previewComposition(admin,c.id,{revision:c.revision,kind:'interview',templateId:template.id,templateRevision:template.revision,values:{}});assert.equal(exact.payload.to,c.email);assert.equal(exact.payload.replyTo,member.email);
 assert.deepEqual(s.get(admin,c.id),before);assert.deepEqual(s.templates(admin),templates);
 assert.throws(()=>s.previewComposition(admin,c.id,{revision:c.revision-1,kind:'interview',templateId:template.id,templateRevision:template.revision}),e=>e.status===409);
});


test('an invitation whose time passed while being reviewed cannot be enqueued',t=>{
 const {s,now,advance}=fixture(t);let c=prepare(s,proposed(s,assigned(s),now()));const preview=s.preview(admin,c.id,'interview');advance(3600001);
 assert.throws(()=>act(s,c,'send_notice',{previewHash:preview.previewHash}),/面试时间已过/);
 assert.equal(s.get(admin,c.id).notification.status,'draft');assert.equal(s.get(admin,c.id).deliveries.filter(d=>d.kind==='interview').length,0);
});
