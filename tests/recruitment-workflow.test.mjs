import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {SMTPServer} from 'smtp-server';
import {openRecruitmentWorkflowStore} from '../server/recruitment-workflow-store.mjs';
import {createRecruitmentWorkflowHttp} from '../server/recruitment-workflow-http.mjs';
import {runWorkflowDeliveryOnce,createWorkflowSmtpProvider} from '../server/recruitment-workflow-worker.mjs';
import {templateSchema,defaultInterviewTemplate,renderInterviewTemplate,RECRUITMENT_FEISHU_APP_ID} from '../server/recruitment-templates.mjs';
import {createRecruitmentFeishuProvider} from '../server/recruitment-feishu-provider.mjs';
import {MailAuthError} from '../server/mail-auth.mjs';
const owner={subject:'fictional:owner',name:'虚构管理员',role:'super_admin',csrf:'fixture-csrf'},admin={...owner,subject:'fictional:admin',role:'admin'};
const fields={name:'虚构候选人',group:'开发组',email:'candidate@example.com',consent:'true',website:''};
const pdf=Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const key=()=>`Bearer ${randomBytes(32).toString('base64url')}`;
function fixture(t,options={}){const directory=mkdtempSync(join(tmpdir(),'110lab-workflow-'));const store=openRecruitmentWorkflowStore({directory,...options});t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return store;}
function accept(store,options={}){return store.acceptApplication({authorization:key(),ip:'127.0.0.1',fields,buffer:pdf,extension:'pdf',bytes:pdf.length,sha256:createHash('sha256').update(pdf).digest('hex'),intakeRevision:1,...options});}
function act(s,c,action,values={}){return s.act(owner,c.id,{requestId:randomUUID(),revision:c.revision,action,...values});}
function candidate(s){return s.create(owner,{requestId:randomUUID(),name:fields.name,group:fields.group,email:fields.email,summary:''});}
function ready(s){let c=candidate(s);c=act(s,c,'screen',{assessmentRequired:false,note:''});c=act(s,c,'schedule',{at:new Date(Date.now()+86400000).toISOString(),interviewer:'虚构面试官',email:'interviewer@example.com',contact:'interviewer@example.com',location:'测试会议室'});return act(s,c,'prepare_notice',{templateId:defaultInterviewTemplate().id,templateRevision:1,values:{}});}
function send(s,c){const p=s.preview(owner,c.id,'interview');return act(s,c,'send_notice',{previewHash:p.previewHash});}
function settingsInput(s){const {revision,mailboxes,sender,recipient,feishu}=s.settings(owner);return {requestId:randomUUID(),revision,mailboxes,sender,recipient,feishu};}

test('template validation rejects unknown/reserved variables and subject injection',()=>{
 const template=defaultInterviewTemplate(),c={...fields,interview:{at:new Date().toISOString(),interviewer:'面试官',email:'interviewer@example.com',contact:'contact',location:'线上'}};
 assert.equal(renderInterviewTemplate(template,c).replyTo,'interviewer@example.com');
 assert.throws(()=>templateSchema.parse({...template,subject:'{{unknown}}'}));
 assert.throws(()=>templateSchema.parse({...template,variables:[{key:'constructor',label:'x',required:true,defaultValue:''}]}));
 assert.throws(()=>renderInterviewTemplate(template,{...c,name:'X\nBcc: thief@example.com'}));
 assert.throws(()=>renderInterviewTemplate(template,c,{name:'override'}));
 const custom=templateSchema.parse({...template,body:'{{room}}',variables:[{key:'room',label:'会议室',required:true,defaultValue:''}]});
 assert.throws(()=>renderInterviewTemplate(custom,c),/会议室/);assert.equal(renderInterviewTemplate(custom,c,{room:'110'}).body,'110');
});
test('intake is atomic, private, idempotent, bounded and permanently retained',t=>{
 let now=Date.now();const s=fixture(t,{now:()=>now}),authorization=key(),r=accept(s,{authorization});
 assert.equal(r.status,'RECEIVED');assert.equal(r.mailStatus,'HELD');assert.equal(accept(s,{authorization}).id,r.id);
 assert.equal(s.list(owner).items.length,1);assert.deepEqual(s.readResume(owner,r.id).buffer,pdf);
 assert.throws(()=>accept(s,{authorization,fields:{...fields,name:'其他人'}}),/回执/);
 assert.throws(()=>accept(s),/重复/);assert.throws(()=>s.receipt(r.id,key()),/回执/);
 assert.throws(()=>s.get({...owner,role:'member'},r.id),/管理员/);
 assert.throws(()=>accept(s,{fields:{...fields,email:'other@example.com'},intakeRevision:0}),/更新/);
 now+=20*365*86400000;s.cleanup();assert.equal(s.receipt(r.id,authorization).status,'RECEIVED');assert.deepEqual(s.readResume(owner,r.id).buffer,pdf);
});
test('capacity failure leaves no candidate, resume or receipt',t=>{
 const s=fixture(t,{maxStoredBytes:1});assert.throws(()=>accept(s),/空间/);assert.equal(s.list(owner).items.length,0);
});
test('superadmin mailbox settings change intake recipient and invalidate stale preview',t=>{
 const s=fixture(t);assert.throws(()=>s.saveSettings(admin,settingsInput(s)),/超级管理员/);
 let c=ready(s);const preview=s.preview(owner,c.id,'interview');const config=settingsInput(s);config.mailboxes.push({address:'recruitment@example.com',label:'招新',enabled:true});config.recipient='recruitment@example.com';s.saveSettings(owner,config);
 assert.equal(s.publicConfig().recipient,'recruitment@example.com');assert.throws(()=>act(s,c,'send_notice',{previewHash:preview.previewHash}),/改变/);
});
test('dry-run builds exact MIME and never calls provided live adapters',async t=>{
 const s=fixture(t);let c=send(s,ready(s)),calls=0,raw='';
 const out=await runWorkflowDeliveryOnce(s,{roleForSubject:()=>owner.role,intervalMs:0,smtp:{send(){calls++;throw new Error('external');}},feishu:{send(){calls++;}},simulate(_job,message){raw=message.raw.toString();}});
 assert.equal(out.status,'SIMULATED');assert.equal(calls,0);assert.match(raw,/Reply-To: interviewer@example.com/);assert.match(raw,/To: candidate@example.com/);assert.match(raw,/From: noreply@110-lab.cn/);
 c=s.get(owner,c.id);assert.equal(c.notification.status,'simulated');assert.equal(c.deliveries[0].status,'SIMULATED');
 c=act(s,c,'interview',{score:90,note:'虚构面试反馈'});assert.equal(c.stage,'decision');
 assert.equal(await runWorkflowDeliveryOnce(s,{roleForSubject:()=>owner.role,intervalMs:0}),null);
});
test('role revocation and template revision changes prevent queued delivery',async t=>{
 const s=fixture(t),c=send(s,ready(s));let result=await runWorkflowDeliveryOnce(s,{roleForSubject:()=> 'member',intervalMs:0});assert.equal(result.status,'FAILED');assert.equal(result.code,'PERMISSION_REVOKED');
 const next=send(s,ready(s));const template=defaultInterviewTemplate();s.saveTemplate(owner,{requestId:randomUUID(),template:{...template,body:template.body+'\n调整说明'}});
 result=await runWorkflowDeliveryOnce(s,{roleForSubject:()=>owner.role,intervalMs:0});assert.equal(result.code,'PREVIEW_CHANGED');
 assert.equal(s.get(owner,c.id).notification.status,'failed');assert.equal(s.get(owner,next.id).notification.status,'failed');
});
test('unknown result survives crash and requires explicit resolution before retry',t=>{
 let now=Date.now();const s=fixture(t,{now:()=>now});let c=send(s,ready(s));const job=s.claim({intervalMs:0});now+=301000;
 assert.equal(s.recoverInterrupted(),1);assert.equal(s.finish(job,{status:'SENT'}),false);c=s.get(owner,c.id);assert.equal(c.notification.status,'unknown');
 assert.throws(()=>act(s,c,'retry_delivery',{deliveryId:job.id}),/待核实/);
 c=act(s,c,'resolve_delivery',{deliveryId:job.id,outcome:'not_sent',note:'虚构服务商日志确认未提交'});
 c=act(s,c,'retry_delivery',{deliveryId:job.id});assert.equal(c.notification.status,'queued');
});
test('SMTP adapter completes mail through loopback only; frozen Reply-To and message id retained',async t=>{
 const messages=[];const smtpServer=new SMTPServer({secure:false,disabledCommands:['STARTTLS'],logger:false,onAuth(_auth,_session,callback){callback(null,{user:'fixture'});},onData(stream,_session,callback){const chunks=[];stream.on('data',c=>chunks.push(c));stream.on('end',()=>{messages.push(Buffer.concat(chunks).toString());callback(null,'queued-fixture');});}});
 await new Promise(r=>smtpServer.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>smtpServer.close(r)));
 const smtp=createWorkflowSmtpProvider([{address:'noreply@110-lab.cn',host:'127.0.0.1',port:smtpServer.server.address().port,secure:false,user:'fixture',pass:'fictional-password'}],{localTest:true});t.after(()=>smtp.close());
 const s=fixture(t,{deliveryMode:'live',mailProfiles:smtp.profiles});const c=send(s,ready(s));
 const result=await runWorkflowDeliveryOnce(s,{mode:'live',smtp,roleForSubject:()=>owner.role,intervalMs:0});assert.equal(result.status,'SENT');assert.equal(messages.length,1);assert.match(messages[0],/Reply-To: interviewer@example.com/);assert.match(messages[0],/110lab-recruitment-/);assert.equal(s.get(owner,c.id).notification.status,'sent');
});
test('Feishu adapter uses only recruitment app and idempotent outbound table APIs',async()=>{
 const requests=[];const provider=createRecruitmentFeishuProvider({appId:RECRUITMENT_FEISHU_APP_ID,appSecret:'fictional-secret-for-tests'},{fetchImpl:async(url,opts)=>{requests.push({url,opts,body:JSON.parse(opts.body)});return {ok:true,status:200,json:async()=>url.endsWith('/internal')?{code:0,tenant_access_token:'fictional-token',expire:7200}:url.endsWith('/search')?{code:0,data:{items:[]}}:{code:0,data:{record:{record_id:'recFake12345'}}}};}});
 const id=randomUUID();const result=await provider.send({payload:{candidateId:id,appId:RECRUITMENT_FEISHU_APP_ID,target:{appToken:'FakeAppToken123',tableId:'tblFake12345'},fields:{'110lab编号':id}}});assert.equal(result.recordId,'recFake12345');assert.equal(requests.length,3);assert.equal(requests[0].body.app_id,RECRUITMENT_FEISHU_APP_ID);assert.match(requests[2].url,new RegExp('client_token='+id));assert.ok(requests.every(r=>!r.url.includes('im/v1')&&!r.url.includes('event')));
});
test('HTTP website intake reaches admin list and template simulation, without exposing private files',async t=>{
 const s=fixture(t);let role='super_admin';const mail={enabled:true,workspaceDirectory:s.root,roleForSubject:()=>role,identity(req,{write}={}){if(req.headers.authorization!=='Bearer fixture-admin')throw new MailAuthError(401,'登录');if(write&&req.headers['x-csrf-token']!==owner.csrf)throw new MailAuthError(403,'CSRF');return {...owner,role};}};
 let fallback=0;const workflow=createRecruitmentWorkflowHttp({mail,enabled:true,store:s,localTest:true,legacyReceipt(id){fallback++;return {id,status:'EXPIRED'};}});
 const server=createServer(async(req,res)=>{if(!await workflow.handle(req,res,new URL(req.url,'http://local').pathname,'127.0.0.1')){res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));await workflow.close();});
 const base='http://127.0.0.1:'+server.address().port;
 async function call(path,{data,auth='Bearer fixture-admin',csrf=owner.csrf}={}){const r=await fetch(base+path,{method:data?'POST':'GET',headers:{Authorization:auth,Origin:base,'X-CSRF-Token':csrf,...(data&&!(data instanceof FormData)?{'Content-Type':'application/json'}:{})},body:data instanceof FormData?data:data?JSON.stringify(data):undefined});return {status:r.status,value:await r.json()};}
 const config=await call('/api/recruitment/config');assert.equal(config.value.recipient,'noreply@110-lab.cn');
 const form=new FormData();for(const[k,v]of Object.entries({...fields,intakeRevision:'1'}))form.set(k,v);form.append('resume',new Blob([pdf],{type:'application/pdf'}),'fixture.pdf');const auth=key();const receipt=await call('/api/recruitment/submissions',{data:form,auth});assert.equal(receipt.status,201,JSON.stringify(receipt.value));
 assert.equal((await call('/api/recruitment-admin/candidates',{auth:''})).status,401);assert.equal((await call('/api/recruitment-admin/candidates')).value.items.length,1);assert.equal(readdirSync(join(s.root,'tmp')).length,0);
 const old=await call('/api/recruitment/status',{data:{id:randomUUID()},auth:key()});assert.equal(old.value.status,'EXPIRED');assert.equal(fallback,1);
 const update=async(c,action,values)=>{const r=await call('/api/recruitment-admin/candidates/'+c.id+'/actions',{data:{revision:c.revision,requestId:randomUUID(),action,...values}});assert.equal(r.status,200,JSON.stringify(r.value));return r.value;};
 let c=s.get(owner,receipt.value.id);c=await update(c,'screen',{assessmentRequired:false,note:''});c=await update(c,'schedule',{at:new Date(Date.now()+86400000).toISOString(),interviewer:'虚构面试官',email:'interviewer@example.com',contact:'interviewer@example.com',location:'线上'});c=await update(c,'prepare_notice',{templateId:defaultInterviewTemplate().id,templateRevision:1,values:{}});
 const preview=await call('/api/recruitment-admin/candidates/'+c.id+'/preview-interview');c=await update(c,'send_notice',{previewHash:preview.value.previewHash});await new Promise(r=>setTimeout(r,100));assert.equal(s.get(owner,c.id).notification.status,'simulated');
 role='member';assert.equal((await call('/api/recruitment-admin/candidates')).status,403);
});
test('candidate, settings, template, receipt and private attachment survive reopening',()=>{
 const directory=mkdtempSync(join(tmpdir(),'110lab-workflow-reopen-'));let s=openRecruitmentWorkflowStore({directory});
 try{const authorization=key(),r=accept(s,{authorization});const config=settingsInput(s);s.saveSettings(owner,config);const t=defaultInterviewTemplate();s.saveTemplate(admin,{requestId:randomUUID(),template:{...t,name:'持久化模板'}});s.close();s=openRecruitmentWorkflowStore({directory});assert.equal(s.settings(owner).revision,2);assert.equal(s.templates(owner).items[0].name,'持久化模板');assert.equal(s.receipt(r.id,authorization).mailStatus,'HELD');assert.deepEqual(s.readResume(owner,r.id).buffer,pdf);assert.equal(s.get(owner,r.id).events[0].action,'官网简历投递');}
 finally{s.close();rmSync(directory,{recursive:true,force:true});}
});
test('switching mode never releases old held or simulated messages',async t=>{
 const s=fixture(t);accept(s);send(s,ready(s));assert.equal(await runWorkflowDeliveryOnce(s,{mode:'live',roleForSubject:()=>owner.role,smtp:{send(){throw new Error('Must not send');}},intervalMs:0}),null);
});
test('retrying a replaced interview draft cannot send the old content',async t=>{
 const s=fixture(t);let c=send(s,ready(s));await runWorkflowDeliveryOnce(s,{roleForSubject:()=> 'member',intervalMs:0});c=s.get(owner,c.id);const job=c.deliveries[0];c=act(s,c,'prepare_notice',{templateId:defaultInterviewTemplate().id,templateRevision:1,values:{}});assert.throws(()=>act(s,c,'retry_delivery',{deliveryId:job.id}),/最新预览/);
});
test('admin can choose an enabled sender but cannot inject an unconfigured mailbox',t=>{
 const s=fixture(t),input=settingsInput(s);input.mailboxes.push({address:'other@example.com',label:'其他邮箱',enabled:true});s.saveSettings(owner,input);
 let c=ready(s);const values={templateId:defaultInterviewTemplate().id,templateRevision:1,values:{}};
 c=act(s,c,'prepare_notice',{...values,sender:'other@example.com'});assert.equal(c.notification.from,'other@example.com');
 assert.throws(()=>act(s,c,'prepare_notice',{...values,sender:'forged@example.com'}),/已启用/);
});
