// Executes copied release bundles outside node_modules; SMTP is loopback only.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {spawnSync,spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {SMTPServer} from 'smtp-server';
import {openRecruitmentStore} from '../server/recruitment-store.mjs';
import {createSmtpSender} from '../server/recruitment-mail.mjs';

const root=mkdtempSync(join(tmpdir(),'110lab-release-check-'));
let smtp,http,store,sender,workerProcess;
const started=(child,marker)=>new Promise((resolve,reject)=>{
  let output='';const timer=setTimeout(()=>reject(new Error('Bundled process did not start')),3000);
  child.stdout.on('data',data=>{output+=data.toString();if(output.includes(marker)){clearTimeout(timer);resolve();}});
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('exit',()=>{if(!output.includes(marker)){clearTimeout(timer);reject(new Error('Bundled process exited before starting'));}});
});
try{
  for(const directory of ['server','dist','src'])mkdirSync(join(root,directory));
  for(const path of ['server/runtime.mjs','server/recruitment-worker-runtime.mjs','server/recruitment-ops-runtime.mjs','dist/index.html','dist/workbench.html','dist/mail.html','dist/recruitment-test.html','dist/recruitment.html','src/projects.json'])copyFileSync(path,join(root,path));
  const {createHttpServer}=await import(pathToFileURL(join(root,'server/runtime.mjs')));
  const {runDeliveryOnce}=await import(pathToFileURL(join(root,'server/recruitment-worker-runtime.mjs')));
  const messages=[];
  smtp=new SMTPServer({authOptional:true,disabledCommands:['AUTH','STARTTLS'],logger:false,onData(stream,session,callback){const chunks=[];stream.on('data',c=>chunks.push(c));stream.on('end',()=>{messages.push(Buffer.concat(chunks));callback(null,'local release test accepted');});}});
  await new Promise(resolve=>smtp.listen(0,'127.0.0.1',resolve));
  sender=createSmtpSender({host:'127.0.0.1',port:smtp.server.address().port,secure:false,from:'noreply@example.com'},{localTest:true});
  store=openRecruitmentStore(join(root,'private'),{sendInterval:0});store.heartbeat();
  http=await createHttpServer({recruitment:{enabled:true,store,origins:['http://localhost']}});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${http.address().port}`,authorization=`Bearer ${randomBytes(32).toString('base64url')}`;
  const body=new FormData();
  for(const[k,v]of Object.entries({applicantName:'虚构运行包测试',group:'开发组',email:'release-test@example.com',consent:'true',website:''}))body.append(k,v);
  body.append('resume',new Blob(['%PDF-1.7\nfictional test\n%%EOF\n'],{type:'application/pdf'}),'fictional.pdf');
  const response=await fetch(base+'/api/recruitment/submissions',{method:'POST',headers:{Origin:'http://localhost',Authorization:authorization},body});
  assert.equal(response.status,201);const receipt=await response.json();assert.equal(receipt.status,'RECEIVED');
  assert.equal((await runDeliveryOnce(store,sender)).status,'SENT');assert.equal(messages.length,1);assert.match(messages[0].toString(),/Content-Type: application\/pdf/);
  assert.equal((await fetch(base+'/admin')).status,404);
  const inspected=spawnSync(process.execPath,[join(root,'server/recruitment-ops-runtime.mjs'),'inspect',receipt.id],{env:{...process.env,PORTAL_RECRUITMENT_DATA:join(root,'private')},encoding:'utf8'});
  assert.equal(inspected.status,0);assert.equal(JSON.parse(inspected.stdout).status,'SENT');assert.doesNotMatch(inspected.stdout,/release-test@example|虚构运行包测试/);
  const disabled=spawnSync(process.execPath,[join(root,'server/recruitment-worker-runtime.mjs')],{env:{PATH:process.env.PATH},stdio:'ignore'});assert.notEqual(disabled.status,0);
  // Fictional config only; all queue rows are SENT, so no SMTP connection is made.
  const config=join(root,'smtp-test.json');writeFileSync(config,JSON.stringify({host:'127.0.0.1',port:465,secure:true,user:'fictional',pass:'fictional',from:'noreply@example.com'}),{mode:0o600});
  workerProcess=spawn(process.execPath,[join(root,'server/recruitment-worker-runtime.mjs')],{env:{PATH:process.env.PATH,PORTAL_RECRUITMENT_ENABLED:'true',PORTAL_RECRUITMENT_DATA:join(root,'private'),PORTAL_RECRUITMENT_SMTP_CONFIG:config},stdio:['ignore','pipe','ignore']});
  await started(workerProcess,'Recruitment mail worker started');
  const exit=new Promise(resolve=>workerProcess.once('exit',resolve));workerProcess.kill('SIGTERM');assert.equal(await exit,0);workerProcess=null;
  // Age only this fictional record to prove the independent cleaner removes it.
  const database=new DatabaseSync(join(root,'private','submissions.sqlite'));database.prepare('UPDATE submissions SET created_at=?,sent_at=? WHERE id=?').run(Date.now()-2*86400000,Date.now()-2*86400000,receipt.id);database.close();
  workerProcess=spawn(process.execPath,[join(root,'server/recruitment-ops-runtime.mjs'),'cleanup-loop'],{env:{PATH:process.env.PATH,PORTAL_RECRUITMENT_DATA:join(root,'private')},stdio:['ignore','pipe','ignore']});
  await started(workerProcess,'Recruitment retention task started');assert.equal(store.inspect(receipt.id).temporaryFilePresent,false);
  const cleanerExit=new Promise(resolve=>workerProcess.once('exit',resolve));workerProcess.kill('SIGTERM');assert.equal(await cleanerExit,0);workerProcess=null;
  console.log(JSON.stringify({isolatedBundles:true,privateOps:true,workerEntryVerified:true,independentCleanupVerified:true,unconfiguredWorkerRefused:true,loopbackOnly:true,attachmentConfirmed:true,receivedThenSent:true,adminClosed:true}));
}finally{
  workerProcess?.kill('SIGKILL');sender?.close();if(http)await new Promise(resolve=>http.close(resolve));if(smtp)await new Promise(resolve=>smtp.close(resolve));store?.close();rmSync(root,{recursive:true,force:true});
}
