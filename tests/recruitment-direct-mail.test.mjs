import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {SMTPServer} from 'smtp-server';
import {simpleParser} from 'mailparser';
import {openRecruitmentWorkflowStore} from '../server/recruitment-workflow-store.mjs';
import {createRecruitmentWorkflowHttp} from '../server/recruitment-workflow-http.mjs';
import {runWorkflowDeliveryOnce,createWorkflowSmtpProvider,composeWorkflowMail} from '../server/recruitment-workflow-worker.mjs';
import {directMailSchema} from '../server/recruitment-direct-mail.mjs';
import {cleanMailHtml} from '../server/recruitment-rich-mail.mjs';
import {MailAuthError} from '../server/mail-auth.mjs';
const actor={subject:'fictional:owner',name:'虚构管理员',role:'super_admin',csrf:'fixture-csrf'};
const member={subject:'fictional:on_member00000001',name:'普通面试官',role:'member'};
const mail=(extra={})=>({from:'noreply@110-lab.cn',replyTo:'reply@example.com',to:['one@example.com','two@example.com'],cc:['cc@example.com'],bcc:['private@example.com'],separate:true,template:{id:randomUUID(),revision:0,name:'直接邮件',kind:'custom',subject:'通知 {{name}}',body:'你好 {{name}}',html:'<p>你好 {{name}}</p>',variables:[]},values:{},recipientValues:{'one@example.com':{name:'甲'},'two@example.com':{name:'乙'}},...extra});
function fixture(t,options={}){const directory=mkdtempSync(join(tmpdir(),'110lab-direct-mail-'));let clock=Date.now();const s=openRecruitmentWorkflowStore({directory,now:()=>clock,...options});t.after(()=>{s.close();rmSync(directory,{recursive:true,force:true});});return {s,directory,advance:n=>clock+=n};}
const preview=(s,m=mail(),a=actor)=>s.previewDirectMail(a,{requestId:randomUUID(),mail:m});
const send=(s,p,a=actor)=>s.sendDirectMail(a,{requestId:randomUUID(),id:p.id,previewHash:p.previewHash});
const run=(s,options={})=>runWorkflowDeliveryOnce(s,{roleForSubject:()=>actor.role,intervalMs:0,...options});

test('separate previews freeze each recipient and CID image, Bcc never leaks in MIME; retries do not duplicate batches',async t=>{
  const {s}=fixture(t);const img=s.saveImage(actor,{requestId:randomUUID(),data:readFileSync(new URL('../src/assets/110lab-icon.png',import.meta.url)).toString('base64')});
  const m=mail();m.template.html+='<p style="text-align:center"><a href="https://exam.110-lab.cn/offer"><img width="240" src="cid:lab-'+img.id+'"></a></p>';
  const p=preview(s,m);assert.equal(p.items.length,2);assert.equal(s.list(actor).items.length,0);assert.equal(s.claim({intervalMs:0}),null,'Preview must not enqueue delivery');
  const input={requestId:randomUUID(),id:p.id,previewHash:p.previewHash};const batch=s.sendDirectMail(actor,input);assert.equal(batch.deliveries.length,2);assert.deepEqual(s.sendDirectMail(actor,input),JSON.parse(JSON.stringify(batch)));assert.throws(()=>send(s,p),/已确认/);
  const output=[];for(let i=0;i<2;i++){const result=await run(s,{simulate:async(job,message)=>{output.push({parsed:await simpleParser(message.raw),raw:message.raw.toString(),message,job});}});assert.equal(result.status,'SIMULATED');}
  assert.equal(output[0].parsed.subject,'通知 甲');assert.equal(output[1].parsed.subject,'通知 乙');
  for(const [i,v]of output.entries()){assert.deepEqual(v.parsed.to.value.map(a=>a.address),[m.to[i]]);assert.equal(v.parsed.bcc,undefined);assert.ok(!v.raw.includes('private@example.com'));assert.deepEqual(v.message.envelope.to,[m.to[i],...m.cc,...m.bcc]);assert.equal(v.parsed.attachments.length,1);assert.match(v.parsed.html,/https:\/\/exam\.110-lab.cn\/offer/);assert.equal(v.parsed.attachments[0].cid,'lab-'+img.id);}
  assert.equal(s.list(actor).items.length,0);assert.equal(s.directMailList(actor).items.length,1);
});

test('combined delivery retains To/Cc and only envelopes Bcc; malformed and duplicate addresses rejected',async t=>{
  const {s}=fixture(t),m=mail({separate:false,recipientValues:{},values:{name:'同学'}}),p=preview(s,m);assert.equal(p.items.length,1);send(s,p);
  await run(s,{simulate:async(_job,message)=>{const parsed=await simpleParser(message.raw);assert.deepEqual(parsed.to.value.map(a=>a.address),m.to);assert.deepEqual(parsed.cc.value.map(a=>a.address),m.cc);assert.equal(parsed.bcc,undefined);assert.equal(message.envelope.to.length,4);}});
  for(const bad of [{to:['a@example.com\r\nBcc:x@example.com']},{to:['same@example.com'],cc:['SAME@example.com']},{to:Array.from({length:51},(_,i)=>i+'@example.com')},{recipientValues:{'other@example.com':{name:'别的'}}}])assert.equal(directMailSchema.safeParse({...mail(),...bad}).success,false);
  assert.throws(()=>preview(s,mail({recipientValues:{}})),/请填写变量/);
  assert.throws(()=>preview(s,mail({recipientValues:{'one@example.com':{name:'X\nBcc:bad@example.com'},'two@example.com':{name:'Y'}}})),/主题/);
});

test('permissions, preview owner/expiry/settings, idempotency and rate limit are enforced before enqueue',t=>{
  const {s,advance}=fixture(t),p=preview(s);assert.throws(()=>preview(s,mail(),member),e=>e.status===403);assert.throws(()=>s.directMailList(member),e=>e.status===403);assert.throws(()=>send(s,p,member),e=>e.status===403);
  assert.throws(()=>send(s,p,{...actor,subject:'fictional:other'}),/本人/);assert.throws(()=>s.sendDirectMail(actor,{requestId:randomUUID(),id:p.id,previewHash:'0'.repeat(64)}),/过期或改变/);advance(16*60000);assert.throws(()=>send(s,p),/过期/);
  const current=preview(s),settings=s.settings(actor);s.saveSettings(actor,{requestId:randomUUID(),revision:settings.revision,mailboxes:settings.mailboxes,sender:settings.sender,recipient:settings.recipient,feishu:settings.feishu});assert.throws(()=>send(s,current),/配置/);
  const many=mail({to:Array.from({length:50},(_,i)=>i+'@example.com'),cc:[],bcc:[],recipientValues:{},values:{name:'测试'}});
  for(let i=0;i<4;i++)send(s,preview(s,many));assert.throws(()=>send(s,preview(s,many)),/200/);assert.equal(s.directMailList(actor).items.length,4);
});

test('HR can send; revoked HR or admin cannot send queued mail',async t=>{
  const {s}=fixture(t);s.setHr(actor,{requestId:randomUUID(),revision:s.listHr(actor).revision,subject:member.subject,enabled:true},member);
  send(s,preview(s,mail(),member),member);s.setHr(actor,{requestId:randomUUID(),revision:s.listHr(actor).revision,subject:member.subject,enabled:false});
  assert.equal((await run(s,{roleForSubject:()=> 'member'})).code,'PERMISSION_REVOKED');
  send(s,preview(s));assert.equal((await run(s,{roleForSubject:()=> 'member'})).code,'PERMISSION_REVOKED');
});

test('crash recovery enters UNKNOWN without candidate lookup; explicit resolution required before retry',async t=>{
  const {s,advance}=fixture(t);const batch=send(s,preview(s));const job=s.claim({intervalMs:0});advance(301000);assert.equal(s.recoverInterrupted(),1);assert.equal(s.finish(job,{status:'SENT'}),false);
  const command=(action,note='')=>s.manageDirectDelivery(actor,{requestId:randomUUID(),id:job.id,action,note});assert.throws(()=>command('retry'),/明确失败/);assert.throws(()=>command('not_sent'),/依据/);
  command('not_sent','虚构服务商记录确认未提交');command('retry');await run(s);await run(s);assert.ok(s.directMailList(actor).items.find(b=>b.id===batch.id).deliveries.every(d=>d.status==='SIMULATED'));assert.throws(()=>command('retry'),/明确失败/);
});

test('SMTP loopback delivers multiple recipients and test allowlist covers Cc/Bcc too',async t=>{
  const messages=[],envelopes=[];const smtpServer=new SMTPServer({secure:false,disabledCommands:['STARTTLS'],logger:false,onAuth(_a,_s,cb){cb(null,{user:'fixture'});},onData(stream,session,cb){const chunks=[];stream.on('data',c=>chunks.push(c));stream.on('end',()=>{messages.push(Buffer.concat(chunks));envelopes.push(session.envelope.rcptTo.map(a=>a.address));cb(null,'queued');});}});await new Promise(r=>smtpServer.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>smtpServer.close(r)));
  const smtp=createWorkflowSmtpProvider([{address:'noreply@110-lab.cn',host:'127.0.0.1',port:smtpServer.server.address().port,secure:false,user:'fixture',pass:'fixture'}],{localTest:true});t.after(()=>smtp.close());
  const {s}=fixture(t,{deliveryMode:'live',mailProfiles:smtp.profiles}),m=mail({separate:false,recipientValues:{},values:{name:'虚构测试'}});send(s,preview(s,m));assert.equal((await run(s,{mode:'live',smtp})).status,'SENT');assert.deepEqual(envelopes[0],[...m.to,...m.cc,...m.bcc]);assert.equal((await simpleParser(messages[0])).bcc,undefined);
  send(s,preview(s,m));assert.equal((await run(s,{mode:'live',smtp,allowedEmails:m.to})).code,'RECIPIENT_NOT_ALLOWED');assert.equal(messages.length,1);
});

test('partial recipient acceptance is UNKNOWN, never automatically retried',async t=>{
  const smtpServer=new SMTPServer({secure:false,disabledCommands:['STARTTLS'],logger:false,onAuth(_a,_s,cb){cb(null,{user:'fixture'});},onRcptTo(address,_s,cb){cb(address.address==='two@example.com'?Object.assign(Error('rejected'),{responseCode:550}):null);},onData(stream,_s,cb){stream.on('data',()=>{});stream.on('end',()=>cb(null,'queued'));}});await new Promise(r=>smtpServer.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>smtpServer.close(r)));
  const smtp=createWorkflowSmtpProvider([{address:'noreply@110-lab.cn',host:'127.0.0.1',port:smtpServer.server.address().port,secure:false,user:'fixture',pass:'fixture'}],{localTest:true});t.after(()=>smtp.close());const {s}=fixture(t,{deliveryMode:'live',mailProfiles:smtp.profiles});send(s,preview(s,mail({separate:false,recipientValues:{},values:{name:'测试'}})));assert.equal((await run(s,{mode:'live',smtp})).status,'UNKNOWN');assert.equal(await run(s,{mode:'live',smtp}),null);
});

test('email styles survive sanitization while dangerous styles, HTML and links are removed',()=>{
  const html=cleanMailHtml('<p style="line-height:1.8;text-align:justify;color:rgb(20, 86, 240);position:fixed;background-image:url(https://track.example/x)"><font size="5" color="#ff0000">格式</font><a href="https://example.com" style="display:inline-block;padding:12px 24px;border-radius:28px;background-color:#5745d6;color:#ffffff">按钮</a><script>alert(1)</script><img src="https://track.example/x" onerror="x()"><a href="javascript:alert(1)">X</a></p><table style="width:100%;border-collapse:collapse"><tr><td style="padding:8px;border:1px solid #dce2eb">内容</td></tr></table>');
  for(const style of ['line-height:1.8','text-align:justify','font-size:24px','border-radius:28px','padding:12px 24px','border:1px solid #dce2eb'])assert.ok(html.includes(style),style);
  for(const forbidden of ['<script','onerror','javascript:','position:','background-image:','track.example'])assert.ok(!html.includes(forbidden),forbidden);
});

test('direct mail HTTP requires same-origin authenticated HR/admin, CSRF and write-freeze',async t=>{
  const {s,directory}=fixture(t);const freezeFile=join(directory,'frozen');let role='super_admin';const mailAuth={enabled:true,workspaceDirectory:s.root,roleForSubject:()=>role,identity(req,{write}={}){if(req.headers.authorization!=='Bearer fixture')throw new MailAuthError(401,'登录');if(write&&req.headers['x-csrf-token']!==actor.csrf)throw new MailAuthError(403,'CSRF');return {...actor,role};}};
  const http=createRecruitmentWorkflowHttp({mail:mailAuth,enabled:true,store:s,localTest:true,freezeFile}),server=createServer(async(req,res)=>{await http.handle(req,res,new URL(req.url,'http://local').pathname,'127.0.0.1');});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await http.close();await new Promise(r=>server.close(r));});const base='http://127.0.0.1:'+server.address().port;
  const call=(path,data,extra={})=>fetch(base+'/api/recruitment-admin/'+path,{method:data?'POST':'GET',headers:{Authorization:'Bearer fixture',Origin:base,'X-CSRF-Token':actor.csrf,'Content-Type':'application/json',...extra},body:data&&JSON.stringify(data)});
  const raw={requestId:randomUUID(),mail:mail()};assert.equal((await call('direct-mail/preview',raw,{'X-CSRF-Token':''})).status,403);assert.equal((await call('direct-mail/preview',raw,{Origin:'https://evil.example'})).status,403);assert.equal((await call('direct-mail',null,{Authorization:''})).status,401);
  writeFileSync(freezeFile,'maintenance');assert.equal((await call('direct-mail/preview',raw)).status,503);unlinkSync(freezeFile);
  const p=await (await call('direct-mail/preview',raw)).json();assert.equal(p.items.length,2);const response=await call('direct-mail/send',{requestId:randomUUID(),id:p.id,previewHash:p.previewHash});assert.equal(response.status,200);assert.equal((await response.json()).deliveries.length,2);assert.equal((await call('direct-mail/'+p.id)).status,200);role='member';assert.equal((await call('direct-mail')).status,403);assert.equal((await call('direct-mail/preview',raw)).status,403);await http.close();
});


test('preview and delivery survive process restart and retain their frozen content',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'110lab-direct-restart-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 let s=openRecruitmentWorkflowStore({directory});const p=preview(s);s.close();
 s=openRecruitmentWorkflowStore({directory});try{const batch=send(s,p);assert.equal(batch.items[0].payload.subject,'通知 甲');await run(s);await run(s);assert.ok(s.directMailGet(actor,p.id).deliveries.every(d=>d.status==='SIMULATED'));}finally{s.close();}
});
