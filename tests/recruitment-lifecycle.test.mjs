import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {simpleParser} from 'mailparser';
import {openRecruitmentWorkflowStore} from '../server/recruitment-workflow-store.mjs';
import {createRecruitmentWorkflowHttp} from '../server/recruitment-workflow-http.mjs';
import {runWorkflowDeliveryOnce} from '../server/recruitment-workflow-worker.mjs';
import {MailAuthError} from '../server/mail-auth.mjs';
import {cleanMailHtml} from '../server/recruitment-rich-mail.mjs';
const owner={subject:'tenant:on_owner00000001',name:'虚构管理员',role:'super_admin',csrf:'csrf'},interviewer={subject:'tenant:on_interviewer001',name:'虚构面试官',role:'member',email:'interviewer@example.com',csrf:'csrf'},stranger={...interviewer,subject:'tenant:on_stranger00001'};
const pdf=Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=','base64');
function fixture(t,options={}){const directory=mkdtempSync(join(tmpdir(),'110lab-lifecycle-'));const s=openRecruitmentWorkflowStore({directory,deliveryMode:'live',mailProfiles:[{address:'noreply@110-lab.cn',configured:true}],...options});t.after(()=>{s.close();rmSync(directory,{recursive:true,force:true});});return s;}
const command=(s,c,action,extra={})=>s.act(owner,c.id,{requestId:randomUUID(),revision:c.revision,action,...extra});
const tick=(s,options={})=>runWorkflowDeliveryOnce(s,{mode:'live',roleForSubject:()=>owner.role,intervalMs:0,...options});
const intake=(s,email='candidate@example.com')=>s.acceptApplication({authorization:'Bearer '+randomBytes(32).toString('base64url'),ip:'127.0.0.1',fields:{name:'虚构候选人',email,group:'开发组',consent:'true'},buffer:pdf,extension:'pdf',bytes:pdf.length,sha256:createHash('sha256').update(pdf).digest('hex'),intakeRevision:1});
const assigned=(s,email='candidate@example.com')=>{const r=intake(s,email);let c=command(s,s.get(owner,r.id),'screen',{assessmentRequired:false,note:''});return s.assignInterviewer(owner,c.id,{requestId:randomUUID(),revision:c.revision,subject:interviewer.subject},interviewer);};
const proposal=(a,overrides={})=>({requestId:randomUUID(),revision:a.revision,at:new Date(Date.now()+86400000).toISOString(),email:interviewer.email,contact:'测试联系方式',location:'https://example.com/interview',...overrides});

test('full HTTP intake, member assignment, authenticated proposal, approval and rich outcome mail',async t=>{
 const s=fixture(t),messages=[],im=[];const smtp={async send(job,m){messages.push({job,mail:await simpleParser(m.raw)});return {accepted:[job.payload.to],rejected:[]};}},feishu={async send(job){im.push(job);return {messageId:'om_fixture'};}};
 const actors={owner,interviewer,stranger};const mail={enabled:true,workspaceDirectory:s.root,projectMembers:async()=>({members:[interviewer]}),roleForSubject:()=>owner.role,identity(req,{write}={}){const a=actors[req.headers.authorization];if(!a)throw new MailAuthError(401,'登录');if(write&&req.headers['x-csrf-token']!==a.csrf)throw new MailAuthError(403,'CSRF');return a;}};
 const workflow=createRecruitmentWorkflowHttp({mail,enabled:true,store:s,deliveryMode:'live',localTest:true,freezeFile:join(s.root,'frozen')});
 const server=createServer(async(req,res)=>{if(!await workflow.handle(req,res,new URL(req.url,'http://local').pathname,'127.0.0.1')){res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));await workflow.close();});const base='http://127.0.0.1:'+server.address().port;
 const call=async(path,{data,as='owner',csrf='csrf'}={})=>{const r=await fetch(base+path,{method:data?'POST':'GET',headers:{Authorization:as,Origin:base,'X-CSRF-Token':csrf,...(data&&!(data instanceof FormData)?{'Content-Type':'application/json'}:{})},body:data instanceof FormData?data:data?JSON.stringify(data):undefined});return {status:r.status,value:await r.json()};};
 const post=async(c,action,values={})=>{const r=await call('/api/recruitment-admin/candidates/'+c.id+'/actions',{data:{action,requestId:randomUUID(),revision:c.revision,...values}});assert.equal(r.status,200,JSON.stringify(r.value));return r.value;};
 const form=new FormData();for(const[k,v]of Object.entries({name:'虚构候选人',group:'开发组',email:'candidate@example.com',consent:'true',website:'',intakeRevision:'1'}))form.set(k,v);form.append('resume',new Blob([pdf],{type:'application/pdf'}),'fixture.pdf');
 const receipt=await call('/api/recruitment/submissions',{data:form,as:'Bearer '+randomBytes(32).toString('base64url')});assert.equal(receipt.status,201);assert.equal(receipt.value.mailStatus,'QUEUED');
 assert.equal((await tick(s,{smtp,feishu})).status,'SENT');assert.equal(messages[0].job.kind,'receipt');assert.equal(messages[0].mail.to.value[0].address,'candidate@example.com');assert.match(messages[0].mail.text,/简历已收到/);
 let c=(await call('/api/recruitment-admin/candidates')).value.items[0];c=await post(c,'screen',{assessmentRequired:false,note:''});
 assert.equal((await call('/api/recruitment-admin/members')).value.members[0].subject,interviewer.subject);
 c=await post(c,'assign_interviewer',{subject:interviewer.subject});assert.equal((await tick(s,{smtp,feishu})).status,'SENT');assert.equal(im.length,1);assert.equal(im[0].payload.subject,interviewer.subject);
 assert.equal((await call('/api/recruitment-interviewer/assignments/'+c.assignment.id,{as:'stranger'})).status,404);
 assert.equal((await call('/api/recruitment-admin/candidates',{as:'interviewer'})).status,403);
 const arr=(await call('/api/recruitment-interviewer/assignments/'+c.assignment.id,{as:'interviewer'})).value;
 assert.equal((await call('/api/recruitment-interviewer/assignments/'+arr.assignment.id,{as:'interviewer',csrf:'bad',data:proposal(arr.assignment)})).status,403);
 assert.equal((await call('/api/recruitment-interviewer/assignments/'+arr.assignment.id,{as:'interviewer',data:proposal(arr.assignment)})).status,200);assert.equal(messages.length,1);
 c=s.get(owner,c.id);assert.equal(c.assignment.status,'submitted');
 const image=await call('/api/recruitment-admin/images',{data:{requestId:randomUUID(),data:png.toString('base64')}});assert.equal(image.status,201);
 let template=s.templates(owner).items[0];template=s.saveTemplate(owner,{requestId:randomUUID(),template:{...template,html:'<h2>{{name}}</h2><p>会议 <a href="{{location}}">参加面试</a></p><img src="cid:lab-'+image.value.id+'">',variables:[]}});
 c=await post(c,'prepare_notice',{templateId:template.id,templateRevision:template.revision,values:{}});const preview=s.preview(owner,c.id,'interview');assert.match(preview.payload.html,/cid:lab-/);assert.equal(messages.length,1);
 c=await post(c,'send_notice',{previewHash:preview.previewHash});assert.equal(c.assignment.status,'approved');assert.equal((await tick(s,{smtp,feishu})).status,'SENT');assert.equal(messages[1].mail.attachments.length,1);assert.deepEqual(messages[1].mail.attachments[0].content,png);assert.equal(messages[1].mail.replyTo.value[0].address,interviewer.email);
 assert.equal((await call('/api/recruitment-interviewer/assignments/'+arr.assignment.id,{as:'interviewer',data:proposal({...arr.assignment,revision:c.assignment.revision})})).status,409);
 c=s.get(owner,c.id);c=await post(c,'interview',{score:90,note:'虚构面试评价'});const resultTemplate=s.templates(owner).items.find(t=>t.kind==='accepted');
 c=await post(c,'prepare_outcome',{outcome:'accepted',note:'测试录取 不代表真实决定',templateId:resultTemplate.id,templateRevision:resultTemplate.revision,values:{}});assert.equal(c.stage,'decision');
 c=await post(c,'send_outcome',{previewHash:s.previewOutcome(owner,c.id).previewHash});assert.equal(c.stage,'accepted');assert.equal((await tick(s,{smtp,feishu})).status,'SENT');assert.match(messages[2].mail.subject,/录取通知/);assert.equal(messages[2].mail.replyTo.value[0].address,interviewer.email);assert.equal(s.get(owner,c.id).resultNotification.status,'sent');
 const other=s.create(owner,{requestId:randomUUID(),name:'虚构未通过候选人',email:'other@example.com',group:'开发组',summary:''}),rejectTemplate=s.templates(owner).items.find(t=>t.kind==='rejected');
 let rejected=await post(other,'prepare_outcome',{outcome:'rejected',note:'测试未通过',templateId:rejectTemplate.id,templateRevision:rejectTemplate.revision,values:{}});rejected=await post(rejected,'send_outcome',{previewHash:s.previewOutcome(owner,rejected.id).previewHash});assert.equal(rejected.stage,'rejected');assert.equal((await tick(s,{smtp,feishu})).status,'SENT');assert.match(messages[3].mail.text,/本次申请未通过/);
 assert.equal(await tick(s,{smtp,feishu}),null);assert.equal(messages.length,4);
 writeFileSync(join(s.root,'frozen'),'test freeze');assert.equal((await call('/api/recruitment-admin/candidates',{data:{requestId:randomUUID(),name:'冻结期间',email:'freeze@example.com',group:'开发组',summary:''}})).status,503);assert.equal((await call('/api/recruitment-admin/candidates')).status,200);assert.equal((await call('/api/recruitment-interviewer/assignments/'+arr.assignment.id,{as:'interviewer',data:proposal(c.assignment)})).status,503);unlinkSync(join(s.root,'frozen'));
});

test('reassignment and updated proposals invalidate old links and old approvals',t=>{
 const s=fixture(t,{deliveryMode:'dry-run'});let c=assigned(s);const old=c.assignment.id;
 c=s.assignInterviewer(owner,c.id,{requestId:randomUUID(),revision:c.revision,subject:stranger.subject},stranger);assert.throws(()=>s.proposeInterview(interviewer,old,proposal({revision:1})),/找不到/);
 s.proposeInterview(stranger,c.assignment.id,proposal(c.assignment));c=s.get(owner,c.id);const template=s.templates(owner).items[0];c=command(s,c,'prepare_notice',{templateId:template.id,templateRevision:template.revision,values:{}});const previous=s.preview(owner,c.id,'interview');
 s.proposeInterview(stranger,c.assignment.id,proposal(c.assignment,{location:'https://example.com/new'}));assert.throws(()=>command(s,c,'send_notice',{previewHash:previous.previewHash}),/已更新/);
 c=s.get(owner,c.id);assert.equal(c.notification,null);c=s.returnInterview(owner,c.id,{requestId:randomUUID(),revision:c.revision,note:'请更换时间'});assert.equal(c.assignment.status,'changes_requested');
});

test('email HTML removes executable content, external tracking and escapes candidate variables',t=>{
 const s=fixture(t);assert.equal(cleanMailHtml('<script>alert(1)</script><img src="https://evil.test/x"><a href="javascript:alert(1)">x</a>'),'<a>x</a>');
 const c=s.create(owner,{requestId:randomUUID(),name:'<img src=x>',email:'fixture@example.com',group:'开发组',summary:''});const template=s.templates(owner).items.find(t=>t.kind==='rejected');const payload=s.mailPayload({...c,decisionNote:'测试'},{...template,html:'<b>{{name}}</b>'});assert.match(payload.html,/&lt;img/);assert.ok(!payload.html.includes('<img'));
 assert.throws(()=>s.saveImage(owner,{requestId:randomUUID(),data:Buffer.from('<svg onload="alert(1)"></svg>').toString('base64')}),/仅支持/);
 assert.throws(()=>s.saveTemplate(owner,{requestId:randomUUID(),template:{...s.templates(owner).items.find(t=>t.kind==='receipt'),body:'{{interviewTime}}'}}),/自动回执/);
});

test('test recipient allowlists fail closed before network and delivery retries keep frozen recipients',async t=>{
 const s=fixture(t);intake(s);let called=0;
 const r=await tick(s,{allowedEmails:['owner@example.com'],allowedSubjects:[owner.subject],smtp:{send(){called++;}}});assert.equal(r.status,'FAILED');assert.equal(r.code,'RECIPIENT_NOT_ALLOWED');assert.equal(called,0);
});


test('selective live testing never promotes other applicants, wrong interviewers or held receipts',async t=>{
 const options={deliveryMode:'dry-run',liveTestEmails:['owner@example.com'],liveTestSubjects:[owner.subject]};
 const s=fixture(t,options),r=intake(s,'owner@example.com'),other=intake(s,'other@example.com');
 assert.equal(s.get(owner,r.id).deliveries[0].mode,'live');assert.equal(s.get(owner,other.id).deliveries[0].status,'HELD');
 let calls=0;const providers={allowedEmails:['owner@example.com'],allowedSubjects:[owner.subject],smtp:{async send(job){assert.equal(job.payload.to,'owner@example.com');calls++;return {};}}};
 assert.equal((await tick(s,providers)).status,'SENT');assert.equal(await tick(s,providers),null);assert.equal(calls,1);
 let c=command(s,s.get(owner,r.id),'screen',{assessmentRequired:false,note:''});
 assert.throws(()=>s.assignInterviewer(owner,c.id,{requestId:randomUUID(),revision:c.revision,subject:interviewer.subject},interviewer),/本人飞书/);
 assert.equal(s.get(owner,c.id).assignment,undefined);
 c=s.assignInterviewer(owner,c.id,{requestId:randomUUID(),revision:c.revision,subject:owner.subject},owner);
 assert.equal((await tick(s,{...providers,feishu:{async send(job){assert.equal(job.payload.subject,owner.subject);return {messageId:'fixture'};}}})).status,'SENT');
 assert.equal(s.get(owner,other.id).deliveries[0].status,'HELD');
});

test('receipt selection rejects templates requiring unavailable interview variables',t=>{
 const s=fixture(t);const template=s.saveTemplate(owner,{requestId:randomUUID(),template:{id:randomUUID(),revision:0,name:'错误回执',kind:'receipt',subject:'测试',body:'{{interviewTime}}',variables:[]}});
 const settings=s.settings(owner);assert.throws(()=>s.saveSettings(owner,{requestId:randomUUID(),revision:settings.revision,mailboxes:settings.mailboxes,sender:settings.sender,recipient:settings.recipient,receiptTemplateId:template.id}),/自动回执/);
 assert.equal(s.settings(owner).revision,settings.revision);assert.equal(intake(s).mailStatus,'QUEUED');
});

test('failed receipts and outcomes can be re-previewed after configuration changes without duplicate sends',async t=>{
 const s=fixture(t),r=intake(s),failedSmtp={async send(){throw Object.assign(new Error('unavailable'),{code:'SENDER_NOT_CONFIGURED',command:'CONN'});}};
 assert.equal((await tick(s,{smtp:failedSmtp})).status,'FAILED');
 const settings=s.settings(owner);s.saveSettings(owner,{requestId:randomUUID(),revision:settings.revision,mailboxes:settings.mailboxes,sender:settings.sender,recipient:settings.recipient});
 let c=s.get(owner,r.id),preview=s.preview(owner,c.id,'receipt');c=command(s,c,'send_receipt',{previewHash:preview.previewHash});
 let sent=0;const smtp={async send(){sent++;return {};}};assert.equal((await tick(s,{smtp})).status,'SENT');
 c=s.get(owner,r.id);assert.throws(()=>command(s,c,'retry_delivery',{deliveryId:c.deliveries.find(d=>d.kind==='receipt'&&d.status==='FAILED').id}),/更新的回执/);assert.throws(()=>command(s,c,'send_receipt',{previewHash:s.preview(owner,c.id,'receipt').previewHash}),/重复发送/);
 const tplt=s.templates(owner).items.find(t=>t.kind==='rejected');
 c=s.prepareOutcome(owner,c.id,{requestId:randomUUID(),revision:c.revision,outcome:'rejected',note:'虚构结果',templateId:tplt.id,templateRevision:tplt.revision,values:{}});
 c=s.confirmOutcome(owner,c.id,{requestId:randomUUID(),revision:c.revision,previewHash:s.previewOutcome(owner,c.id).previewHash});assert.equal((await tick(s,{smtp:failedSmtp})).status,'FAILED');
 c=s.get(owner,c.id);c=s.prepareOutcome(owner,c.id,{requestId:randomUUID(),revision:c.revision,outcome:'rejected',note:'更新后的虚构结果',templateId:tplt.id,templateRevision:tplt.revision,values:{}});
 c=s.confirmOutcome(owner,c.id,{requestId:randomUUID(),revision:c.revision,previewHash:s.previewOutcome(owner,c.id).previewHash});assert.equal((await tick(s,{smtp})).status,'SENT');
 c=s.get(owner,c.id);assert.throws(()=>s.prepareOutcome(owner,c.id,{requestId:randomUUID(),revision:c.revision,outcome:'rejected',note:'重复',templateId:tplt.id,templateRevision:tplt.revision,values:{}}),/当前阶段/);assert.equal(sent,2);
});

test('assignments, proposals, templates and private image bytes survive process reopening',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'110lab-reopen-'));let s;
 t.after(()=>{s?.close();rmSync(directory,{recursive:true,force:true});});
 s=openRecruitmentWorkflowStore({directory,deliveryMode:'dry-run'});let c=assigned(s);
 s.proposeInterview(interviewer,c.assignment.id,proposal(c.assignment));
 const image=s.saveImage(owner,{requestId:randomUUID(),data:png.toString('base64')});
 const template=s.templates(owner).items[0];s.saveTemplate(owner,{requestId:randomUUID(),template:{...template,html:'<p>{{name}}</p><img src="cid:lab-'+image.id+'">'}});
 s.close();s=openRecruitmentWorkflowStore({directory,deliveryMode:'dry-run'});
 assert.equal(s.interviewerGet(interviewer,c.assignment.id).assignment.status,'submitted');
 assert.deepEqual(s.readImage(owner,image.id).buffer,png);assert.deepEqual(s.readResume(owner,c.id).buffer,pdf);
 assert.equal(s.templates(owner).items.find(t=>t.id===template.id).revision,2);
 const row=s.get(owner,c.id);assert.ok(row.events.some(e=>e.action==='面试官提交安排'));assert.ok(row.deliveries.some(d=>d.kind==='interviewer'));
 const done=await runWorkflowDeliveryOnce(s,{mode:'dry-run',roleForSubject:()=>owner.role,intervalMs:0});assert.equal(done.status,'FAILED');assert.equal(done.code,'PREVIEW_CHANGED');
});
