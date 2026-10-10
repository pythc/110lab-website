import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {openRecruitmentWorkflowStore} from '../server/recruitment-workflow-store.mjs';
import {runWorkflowDeliveryOnce} from '../server/recruitment-workflow-worker.mjs';
import {createRecruitmentWorkflowHttp} from '../server/recruitment-workflow-http.mjs';
import {createRecruitmentFeishuProvider} from '../server/recruitment-feishu-provider.mjs';
import {RECRUITMENT_FEISHU_APP_ID} from '../server/recruitment-templates.mjs';
import {MailAuthError} from '../server/mail-auth.mjs';
const admin={subject:'tenant:on_admin000000001',name:'虚构管理员',role:'admin',csrf:'fixture'},owner={...admin,role:'super_admin'},hr={subject:'tenant:on_hr000000000001',name:'虚构 HR',role:'member',email:'hr@example.test',csrf:'fixture'},interviewer={...hr,subject:'tenant:on_interviewer001',name:'虚构面试官'},hr2={...hr,subject:'tenant:on_hr000000000002'};
function fixture(t){let clock=Date.now(),s;const directory=mkdtempSync(join(tmpdir(),'110lab-hr-test-'));const open=()=>openRecruitmentWorkflowStore({directory,deliveryMode:'live',now:()=>clock,mailProfiles:[{address:'noreply@110-lab.cn',configured:true}]});s=open();t.after(()=>{s.close();rmSync(directory,{recursive:true,force:true});});return {get s(){return s;},now:()=>clock,advance:n=>clock+=n,reopen(){s.close();s=open();},directory};}
const grant=(s,member=hr,enabled=true)=>s.setHr(admin,{requestId:randomUUID(),revision:s.listHr(admin).revision,subject:member.subject,enabled},member);
const create=(s,actor=admin)=>s.create(actor,{requestId:randomUUID(),name:'虚构候选人',group:'开发组',email:randomUUID()+'@example.test',summary:'虚构测试'});
const act=(s,c,action,values={})=>s.act(admin,c.id,{requestId:randomUUID(),revision:c.revision,action,...values});
const intake=(s,authorization='Bearer '+randomBytes(32).toString('base64url'))=>{const buffer=Buffer.from('%PDF fixture');return s.acceptApplication({authorization,ip:'127.0.0.1',fields:{name:'虚构候选人',group:'开发组',email:'candidate@example.test'},buffer,extension:'pdf',bytes:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex'),intakeRevision:1});};
const tick=(s,options={})=>runWorkflowDeliveryOnce(s,{mode:'live',roleForSubject:subject=>subject===admin.subject?'admin':'member',intervalMs:0,smtp:{async send(){return {};}},feishu:{async send(){return {messageId:'om_fixture'};}},...options});
const drain=async(s,options={})=>{const out=[];for(let n=0;n<30;n++){const v=await tick(s,options);if(!v)return out;out.push(v);}throw new Error('Queue did not drain');};
async function approved(f){let {s}=f,c=act(s,create(s),'screen',{assessmentRequired:false,note:''});c=s.assignInterviewer(admin,c.id,{requestId:randomUUID(),revision:c.revision,subject:interviewer.subject},interviewer);await drain(s);c=s.get(admin,c.id);s.proposeInterview(interviewer,c.assignment.id,{requestId:randomUUID(),revision:c.assignment.revision,at:new Date(f.now()+3600000).toISOString(),email:'interviewer@example.test',contact:'测试',location:'https://example.com/meeting'});c=s.get(admin,c.id);const template=s.templates(admin).items[0];c=act(s,c,'prepare_notice',{templateId:template.id,templateRevision:template.revision,values:{}});c=act(s,c,'send_notice',{previewHash:s.preview(admin,c.id,'interview').previewHash});await drain(s);return s.get(admin,c.id);}

test('HR grant is directory-bound, admin-only, versioned, durable and never elevates the laboratory role',t=>{
 const f=fixture(t),{s}=f,input={requestId:randomUUID(),revision:1,subject:hr.subject,enabled:true};
 assert.throws(()=>s.setHr(hr,input,hr),{status:403});assert.throws(()=>s.setHr(admin,input,null),{status:400});
 const result=s.setHr(admin,input,hr);assert.deepEqual(s.setHr(admin,input,hr),result);assert.throws(()=>s.setHr(admin,{...input,requestId:randomUUID()},hr),{status:409});
 assert.equal(s.recruitmentSession(hr).recruitmentRole,'hr');assert.equal(s.recruitmentSession(hr).role,'member');assert.equal(s.recruitmentSession(interviewer).recruitmentRole,'interviewer');
 const c=create(s,hr);assert.equal(s.get(hr,c.id).id,c.id);assert.throws(()=>s.setHr(hr,{...input,revision:2},hr2),{status:403});assert.throws(()=>s.saveSettings(hr,{}),{status:403});
 assert.throws(()=>s.create(interviewer,{requestId:randomUUID(),name:'a',group:'g',email:'a@example.test',summary:''}),{status:403});
 f.reopen();assert.equal(f.s.recruitmentSession(hr).recruitmentRole,'hr');grant(f.s,hr,false);assert.equal(f.s.recruitmentSession(hr).recruitmentRole,'interviewer');assert.throws(()=>f.s.get(hr,c.id),{status:404});assert.equal(f.s.get(admin,c.id).id,c.id);
});

test('new website submission durably notifies each configured HR once, preserving receipt behavior and handling no HR',async t=>{
 const f=fixture(t),key='Bearer '+randomBytes(32).toString('base64url'),r=intake(f.s,key);assert.equal(intake(f.s,key).id,r.id);assert.equal(f.s.scheduleNotifications(),0);assert.equal(f.s.notificationStatus().pendingHrEvents,1);f.reopen();
 grant(f.s);grant(f.s,hr2);assert.equal(f.s.scheduleNotifications(),2);assert.equal(f.s.scheduleNotifications(),0);
 const sent=[];await drain(f.s,{feishu:{async send(j){sent.push(j);return {messageId:'om_mock'};}}});
 assert.deepEqual(sent.map(j=>j.payload.subject).sort(),[hr.subject,hr2.subject].sort());assert.ok(sent.every(j=>j.kind==='hr_intake'&&j.payload.url.endsWith(r.id)));assert.equal(f.s.get(admin,r.id).receiptStatus,'SENT');
 f.reopen();assert.equal(await tick(f.s),null);grant(f.s,interviewer);assert.equal(f.s.scheduleNotifications(),0);
});

test('default 30-minute end triggers one HR reminder each and one feedback link; repeated ticks/restarts cannot duplicate',async t=>{
 const f=fixture(t);grant(f.s);grant(f.s,hr2);const c=await approved(f);assert.equal(c.interview.durationMinutes,30);
 f.advance(3600000+29*60000);assert.equal(f.s.scheduleNotifications(),0);f.advance(60000);assert.equal(f.s.scheduleNotifications(),3);assert.equal(f.s.scheduleNotifications(),0);f.reopen();assert.equal(f.s.scheduleNotifications(),0);
 const sent=[];await drain(f.s,{feishu:{async send(j){sent.push(j);return {messageId:'om_mock'};}}});assert.equal(sent.filter(j=>j.kind==='hr_feedback_reminder').length,2);assert.equal(sent.filter(j=>j.kind==='interviewer_feedback_reminder').length,1);assert.equal(sent.find(j=>j.kind==='interviewer_feedback_reminder').payload.subject,interviewer.subject);assert.equal(await tick(f.s),null);
});

test('revoking HR stops pending messages; feedback or rescheduling invalidates queued reminders before network',async t=>{
 const f=fixture(t);grant(f.s);const r=intake(f.s);await tick(f.s);grant(f.s,hr,false);let calls=0;const noSend={feishu:{async send(){calls++;return {messageId:'no'};}}};assert.equal((await tick(f.s,noSend)).code,'PERMISSION_REVOKED');assert.equal(calls,0);
 grant(f.s);let c=await approved(f);f.advance(5400000);f.s.scheduleNotifications();c=f.s.get(admin,c.id);f.s.submitFeedback(interviewer,c.assignment.id,{requestId:randomUUID(),revision:c.assignment.revision,score:85,note:'虚构面试评价',recommendation:'recommend'});const out=await drain(f.s,noSend);assert.equal(out.length,2);assert.ok(out.every(v=>v.code==='PREVIEW_CHANGED'));assert.equal(calls,0);
 c=await approved(f);f.advance(5400000);f.s.scheduleNotifications();c=f.s.get(admin,c.id);f.s.requestReschedule(admin,c.id,{requestId:randomUUID(),revision:c.revision,note:'虚构改期'});const jobs=[];await drain(f.s,{feishu:{async send(j){jobs.push(j.kind);return {messageId:'om_mock'};}}});assert.deepEqual(jobs,['interviewer']);
});

test('pre-upgrade past interviews do not backfill and early feedback does not schedule reminders',async t=>{
 const f=fixture(t);let c=await approved(f);const db=new DatabaseSync(join(f.directory,'recruitment.sqlite'));db.prepare('UPDATE recruitment_notification_meta SET activated_at=?').run(f.now()+7200000);db.close();f.advance(7200000);f.reopen();assert.equal(f.s.scheduleNotifications(),0);
 c=await approved(f);f.advance(3600001);f.s.submitFeedback(interviewer,c.assignment.id,{requestId:randomUUID(),revision:c.assignment.revision,score:90,note:'已完成的面评',recommendation:'recommend'});f.advance(1800000);assert.equal(f.s.scheduleNotifications(),0);
});

test('notifier uses the recruitment bot, only canonical links, and never exposes resume files',async()=>{
 const calls=[],provider=createRecruitmentFeishuProvider({appId:RECRUITMENT_FEISHU_APP_ID,appSecret:'fixture-secret-only'},{fetchImpl:async(url,options)=>{calls.push({url,data:JSON.parse(options.body)});return {ok:true,status:200,json:async()=>url.includes('tenant_access_token')?{code:0,tenant_access_token:'fixture-token',expire:7200}:{code:0,data:{message_id:'om_fixture'}}};}});
 for(const kind of ['hr_intake','hr_feedback_reminder','interviewer_feedback_reminder']){const id=randomUUID(),p={subject:hr.subject,candidateId:id,assignmentId:id,candidateName:'虚构姓名',group:'开发组',interviewerName:'虚构面试官',url:kind==='interviewer_feedback_reminder'?'https://internal.110-lab.cn/recruitment/interviewer?assignment='+id:'https://internal.110-lab.cn/recruitment?candidate='+id};await provider.send({id:randomUUID(),kind,payload:p});await assert.rejects(provider.send({id:randomUUID(),kind,payload:{...p,url:'https://evil.example'}}),{code:'FEISHU_TARGET_INVALID'});}
 assert.equal(calls.filter(c=>c.url.includes('tenant_access_token')).length,1);assert.equal(calls.filter(c=>c.url.includes('/im/')).length,3);assert.ok(calls.filter(c=>c.url.includes('/im/')).every(c=>c.data.msg_type==='text'&&c.data.receive_id===hr.subject.split(':')[1]));
});

test('HTTP role management and every recruitment mutation deny ordinary interviewers while assigned forms remain available',async t=>{
 const f=fixture(t),actors={admin,owner,hr,interviewer},mail={enabled:true,workspaceDirectory:f.directory,roleForSubject:s=>s===admin.subject?'admin':'member',projectMembers:async()=>({members:[hr,interviewer]}),identity(req,{write}={}){const a=actors[req.headers.authorization];if(!a)throw new MailAuthError(401,'登录');if(write&&req.headers['x-csrf-token']!==a.csrf)throw new MailAuthError(403,'CSRF');return a;}};
 const workflow=createRecruitmentWorkflowHttp({mail,enabled:true,store:f.s,deliveryMode:'live',localTest:true});const server=createServer(async(req,res)=>{if(!await workflow.handle(req,res,new URL(req.url,'http://local').pathname,'127.0.0.1')){res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));await workflow.close();});const base='http://127.0.0.1:'+server.address().port;
 const call=async(path,as='interviewer',data)=>{const r=await fetch(base+'/api/recruitment-admin/'+path,{method:data?'POST':'GET',headers:{Authorization:as,Origin:base,'X-CSRF-Token':'fixture','Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});return {status:r.status,value:await r.json()};};
 assert.equal((await call('session')).value.recruitmentRole,'interviewer');for(const path of ['hr','candidates','templates','images','settings','templates/preview','candidates/'+randomUUID()+'/actions'])assert.equal((await call(path,'interviewer',{})).status,403,path);
 assert.equal((await call('hr','admin',{requestId:randomUUID(),revision:1,subject:hr.subject,enabled:true})).status,200);assert.equal((await call('session','hr')).value.recruitmentRole,'hr');assert.equal((await call('hr','hr')).status,403);
 const c=create(f.s,hr);assert.equal((await call('candidates/'+c.id,'hr')).status,200);assert.equal((await call('settings','hr',{})).status,403);assert.equal((await call('my-interviews/'+randomUUID(),'interviewer',{})).status,400);
 const arranged=await approved(f);assert.equal((await call('my-interviews','interviewer')).value.items.length,1);assert.equal((await call('my-interviews/'+arranged.assignment.id,'hr')).status,404);
 grant(f.s,hr,false);assert.equal((await call('templates','hr',{})).status,403);assert.equal((await call('session','hr')).value.recruitmentRole,'interviewer');
});


test('cached interviewer commands cannot replay private records after reassignment',async t=>{
 const f=fixture(t);let c=act(f.s,create(f.s),'screen',{assessmentRequired:false,note:''});c=f.s.assignInterviewer(admin,c.id,{requestId:randomUUID(),revision:c.revision,subject:interviewer.subject},interviewer);await drain(f.s);c=f.s.get(admin,c.id);
 const old=c.assignment.id,input={requestId:randomUUID(),revision:c.assignment.revision,at:new Date(f.now()+3600000).toISOString(),durationMinutes:60,email:'i@example.test',contact:'测试',location:'https://example.com/meeting'};
 const result=f.s.proposeInterview(interviewer,old,input);assert.equal(result.assignment.proposal.durationMinutes,60);assert.deepEqual(f.s.proposeInterview(interviewer,old,input),result);
 c=f.s.get(admin,c.id);f.s.assignInterviewer(admin,c.id,{requestId:randomUUID(),revision:c.revision,subject:hr.subject},hr);assert.throws(()=>f.s.proposeInterview(interviewer,old,input),{status:404});
});
