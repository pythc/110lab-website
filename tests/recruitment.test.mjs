import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,readdirSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash,randomUUID} from 'node:crypto';
import {crc32,deflateRawSync} from 'node:zlib';
import {SMTPServer} from 'smtp-server';
import {request} from 'node:http';
import {createHttpServer} from '../server/http.mjs';
import {openRecruitmentStore,DAY,MAX_FILE_BYTES,RECIPIENT} from '../server/recruitment-store.mjs';
import {validateResume} from '../server/recruitment-files.mjs';
import {createSmtpSender,composeApplication,MAX_MIME_BYTES,classifyDeliveryError} from '../server/recruitment-mail.mjs';
import {runDeliveryOnce} from '../server/recruitment-worker.mjs';

const pdf=Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const key=()=>`Bearer ${randomBytes(32).toString('base64url')}`;
const applicant={name:'虚构测试候选人',group:'开发组',email:'candidate@example.com',consent:'true',website:''};
function zip(parts){
  const locals=[],central=[];let offset=0;
  for(const [name,value]of Object.entries(parts)){
    const bytes=Buffer.from(value),encoded=deflateRawSync(bytes),filename=Buffer.from(name),local=Buffer.alloc(30),index=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);local.writeUInt32LE(crc32(bytes),14);local.writeUInt32LE(encoded.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(filename.length,26);
    index.writeUInt32LE(0x02014b50);index.writeUInt16LE(20,4);index.writeUInt16LE(20,6);index.writeUInt16LE(8,10);index.writeUInt32LE(crc32(bytes),16);index.writeUInt32LE(encoded.length,20);index.writeUInt32LE(bytes.length,24);index.writeUInt16LE(filename.length,28);index.writeUInt32LE(offset,42);
    locals.push(local,filename,encoded);central.push(index,filename);offset+=local.length+filename.length+encoded.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(central.length/2,8);end.writeUInt16LE(central.length/2,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,directory,end]);
}
const docxParts={
  '[Content_Types].xml':'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml':'<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>虚构简历</w:t></w:r></w:p></w:body></w:document>',
};
function fixture(t,options={}){
  const root=mkdtempSync(join(tmpdir(),'110lab-resume-test-'));const store=openRecruitmentStore(root,options);
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return store;
}
function accept(store,{authorization=key(),buffer=pdf,fields=applicant,ip='127.0.0.1'}={}){
  const receipt=store.accept({authorization,ip,fields,extension:'pdf',bytes:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex'),moveFile:blob=>writeFileSync(join(store.root,'files',blob),buffer,{mode:0o600})});return {receipt,authorization};
}
async function httpFixture(t,store,options={}){
  const http=await createHttpServer({recruitment:{enabled:true,store,origins:['http://localhost'],...options}});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>http.close(resolve)));
  const base=`http://127.0.0.1:${http.address().port}`;
  const call=async(path,{body,authorization=key(),headers={},origin='http://localhost'}={})=>{
    const response=await fetch(base+'/api/recruitment/'+path,{method:body?'POST':'GET',headers:{Host:'110-lab.cn',Origin:origin,Authorization:authorization,...(body instanceof FormData?{}:body?{'Content-Type':'application/json'}:{}),...headers},body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
    return {status:response.status,body:await response.json()};
  };
  return {base,call};
}
function form({buffer=pdf,filename='虚构简历.pdf',mime='application/pdf',fields=applicant,two=false}={}){
  const body=new FormData();for(const[k,v]of Object.entries(fields))body.append(k,v);body.append('resume',new Blob([buffer],{type:mime}),filename);if(two)body.append('resume',new Blob([pdf],{type:'application/pdf'}),'second.pdf');return body;
}
async function smtpFixture(t,{mode='ok'}={}){
  const messages=[],control={mode};
  const smtp=new SMTPServer({secure:false,authOptional:true,disabledCommands:['AUTH','STARTTLS'],logger:false,onData(stream,session,callback){
    const chunks=[];stream.on('data',chunk=>chunks.push(chunk));stream.on('end',()=>{
      messages.push({raw:Buffer.concat(chunks),envelope:session.envelope});
      if(control.mode==='hang')return;
      if(control.mode!=='ok'){const error=new Error('Synthetic provider rejection');error.responseCode=Number(control.mode);callback(error);}else callback(null,'accepted locally');
    });
  }});
  await new Promise(resolve=>smtp.listen(0,'127.0.0.1',resolve));
  const sender=createSmtpSender({host:'127.0.0.1',port:smtp.server.address().port,secure:false,from:'110lab Test <noreply@example.com>'},{localTest:true});
  t.after(async()=>{sender.close();await new Promise(resolve=>smtp.close(resolve));});return {messages,control,sender};
}

test('valid PDF and DOCX; reject fake types, malformed ZIP, macros, XML entities and over-limit files',async()=>{
  assert.equal((await validateResume(pdf,'cv.PDF','application/pdf')).extension,'pdf');
  assert.equal((await validateResume(zip(docxParts),'cv.docx','application/octet-stream')).extension,'docx');
  for(const[buffer,name,mime]of [[Buffer.from('fake'),'cv.pdf','application/pdf'],[pdf,'cv.exe','application/pdf'],[pdf,'cv.docx','application/pdf'],[pdf,'cv.docx','application/octet-stream'],[zip({...docxParts,'word/vbaProject.bin':'macro'}),'cv.docx','application/octet-stream'],[zip({...docxParts,'[Content_Types].xml':'<!DOCTYPE foo><Types/>'}),'cv.docx','application/octet-stream'],[zip({...docxParts,'../x':'bad'}),'cv.docx','application/octet-stream'],[Buffer.alloc(MAX_FILE_BYTES+1),'cv.pdf','application/pdf']])await assert.rejects(validateResume(buffer,name,mime));
  const bomb=zip(docxParts);bomb.writeUInt32LE(40*1024*1024,bomb.indexOf(Buffer.from('PK\x01\x02'))+24);await assert.rejects(validateResume(bomb,'cv.docx','application/octet-stream'));
  await assert.rejects(validateResume(zip({...docxParts,'word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'+'<w:p>'.repeat(130)+'</w:p>'.repeat(130)+'</w:document>'}),'deep.docx','application/octet-stream'));
  const corrupt=zip(docxParts);corrupt[corrupt.indexOf(Buffer.from('PK\x01\x02'))+16]^=1;await assert.rejects(validateResume(corrupt,'corrupt.docx','application/octet-stream'));
  assert.equal((await validateResume(zip({...docxParts,'word/media/image.jpg':Buffer.alloc(9*1024*1024)}),'photo.docx','application/octet-stream')).extension,'docx');
});

test('actual SMTP stalls after DATA stay UNKNOWN and do not send again',async t=>{
  const store=fixture(t,{sendInterval:0}),{sender,messages}=await smtpFixture(t,{mode:'hang'}),{receipt}=accept(store);
  assert.equal((await runDeliveryOnce(store,sender,{deadlineMs:350})).status,'UNKNOWN');
  assert.equal(store.inspect(receipt.id).status,'UNKNOWN');assert.equal(messages.length,1);
  assert.equal(await runDeliveryOnce(store,sender),null);assert.equal(messages.length,1);
});

test('automatic retries stop at eight attempts; retry starts a fresh bounded round',async t=>{
  let time=Date.now();const store=fixture(t,{now:()=>time,sendInterval:0}),{receipt,authorization}=accept(store);
  const sender={from:'noreply@example.com',async send(){throw Object.assign(new Error('fictional transient rejection'),{responseCode:451,code:'EMESSAGE',command:'DATA'});},close(){}};
  for(let i=1;i<=8;i++){assert.equal((await runDeliveryOnce(store,sender,{delays:[1]})).status,i===8?'FAILED':'RETRYING');time++;}
  assert.equal(await runDeliveryOnce(store,sender),null);store.retry(receipt.id,authorization);
  assert.equal((await runDeliveryOnce(store,sender,{delays:[1]})).status,'RETRYING');assert.equal(store.inspect(receipt.id).attempts,9);
});

test('spoofed forwarding headers cannot bypass the persistent upload budget; malformed status bodies are bounded',async t=>{
  const store=fixture(t);store.heartbeat();const {call}=await httpFixture(t,store);
  for(let i=0;i<30;i++)assert.equal((await call('submissions',{body:form({fields:{...applicant,consent:'false'}}),headers:{'x-forwarded-for':`198.51.100.${i+1}`}})).status,400);
  assert.equal((await call('submissions',{body:form(),headers:{'x-forwarded-for':'203.0.113.1'}})).status,429);
  assert.equal((await call('status',{body:{id:'x'.repeat(1100)}})).status,413);
  assert.equal(readdirSync(join(store.root,'tmp')).length,0);
});

test('full multipart -> persistent receipt -> real loopback SMTP attachment -> SENT without public file URL',async t=>{
  const store=fixture(t,{sendInterval:0});store.heartbeat();
  const {call,base}=await httpFixture(t,store),{sender,messages}=await smtpFixture(t),authorization=key();
  const {name,...otherFields}=applicant;
  const result=await call('submissions',{body:form({fields:{...otherFields,applicantName:name}}),authorization});assert.equal(result.status,201);assert.equal(result.body.status,'RECEIVED');assert.doesNotMatch(JSON.stringify(result.body),/url|path|email|name|blob/i);
  assert.equal((await call('status',{body:{id:result.body.id},authorization})).body.status,'RECEIVED');
  assert.equal((await call('status',{body:{id:null},authorization})).body.id,result.body.id);
  assert.equal((await call('status',{body:{id:null}})).status,404);
  const duplicate=await call('submissions',{body:form(),authorization});assert.equal(duplicate.status,200);assert.equal(duplicate.body.id,result.body.id);
  assert.equal((await call('submissions',{body:form()})).status,409);
  const changed=await call('submissions',{body:form({fields:{...applicant,name:'其他虚构姓名'}}),authorization});assert.equal(changed.status,409);
  assert.equal((await call('status',{body:{id:result.body.id}})).status,404);
  assert.equal((await fetch(base+`/files/${result.body.id}.pdf`)).status,404);
  assert.equal((await fetch(base+'/admin')).status,404);
  assert.equal((await fetch(base+'/api/admin/content',{method:'PUT',body:'{}'})).status,404);
  assert.equal((await runDeliveryOnce(store,sender)).status,'SENT');assert.equal(messages.length,1);
  assert.equal(messages[0].envelope.rcptTo[0].address,RECIPIENT);
  const raw=messages[0].raw.toString();assert.match(raw,/Content-Type: application\/pdf/);assert.match(raw,/Reply-To: candidate@example.com/);assert.match(raw,/X-110lab-Receipt:/);assert.ok(raw.replaceAll(/\r\n/g,'').includes(pdf.toString('base64')));
  const subjects=raw.match(/^Subject: (.+(?:\r\n[ \t].+)*)/m)[1].replaceAll(/\r\n[ \t]/g,'');
  const decoded=subjects.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi,(_all,value)=>Buffer.from(value,'base64').toString());assert.equal(decoded,`[招新简历] ${applicant.name}-${applicant.group}`);
  assert.equal((await call('status',{body:{id:result.body.id},authorization})).body.status,'SENT');
  assert.equal(await runDeliveryOnce(store,sender),null);assert.equal(messages.length,1);assert.equal(readdirSync(join(store.root,'tmp')).length,0);
  assert.equal(lstatSync(store.root).mode&0o777,0o700);assert.equal(lstatSync(join(store.root,'files',result.body.id+'.pdf')).mode&0o777,0o600);
});

test('slow chunked multipart times out and removes its partial private file',async t=>{
  const store=fixture(t);store.heartbeat();const {base}=await httpFixture(t,store,{uploadTimeoutMs:60});
  const response=await new Promise((resolve,reject)=>{
    const upload=request(base+'/api/recruitment/submissions',{method:'POST',headers:{Origin:'http://localhost',Authorization:key(),'Content-Type':'multipart/form-data; boundary=fictional-boundary'}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()});upload.destroy();});
    });
    upload.once('error',error=>{if(error.code!=='ECONNRESET')reject(error);});
    upload.write('--fictional-boundary\r\nContent-Disposition: form-data; name="resume"; filename="test.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7\npartial');
  });
  assert.equal(response.status,408);assert.match(response.body,/UPLOAD_TIMEOUT/);assert.equal(readdirSync(join(store.root,'tmp')).length,0);
});

test('rejected fields and a following file in the same network chunk cannot leave an open upload stream',async t=>{
  const store=fixture(t);store.heartbeat();const {base}=await httpFixture(t,store);
  const boundary='fictional-single-chunk',chunks=[];
  const {name:ignoredName,...fields}=applicant;
  for(const [name,value]of Object.entries({unexpected:'test',...fields}))chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="resume"; filename="fake.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),pdf,Buffer.from(`\r\n--${boundary}--\r\n`));
  const body=Buffer.concat(chunks);
  for(let i=0;i<5;i++){
    const status=await new Promise((resolve,reject)=>{
      const upload=request(base+'/api/recruitment/submissions',{method:'POST',headers:{Origin:'http://localhost',Authorization:key(),'Content-Type':`multipart/form-data; boundary=${boundary}`,'Content-Length':body.length}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});
      upload.setTimeout(2000,()=>upload.destroy(new Error('Rejected upload did not return')));upload.once('error',reject);upload.end(body);
    });
    assert.equal(status,400);
  }
  assert.equal(readdirSync(join(store.root,'tmp')).length,0);
});

test('multipart rejects extra files, fields, honeypot, consent, MIME and size; origin and worker gates stay closed',async t=>{
  const store=fixture(t);const {call}=await httpFixture(t,store);
  assert.equal((await call('submissions',{body:form()})).body.code,'DELIVERY_UNAVAILABLE');store.heartbeat();
  assert.equal((await call('submissions',{body:form(),origin:'https://untrusted.example'})).status,403);
  assert.equal((await call('submissions',{body:form(),headers:{'sec-fetch-site':'cross-site'}})).status,403);
  for(const options of [{two:true},{fields:{...applicant,website:'spam'}},{fields:{...applicant,consent:'false'}},{fields:{...applicant,name:'Name\r\nBcc:evil'}},{fields:{...applicant,email:'invalid'}},{fields:{...applicant,group:'其他'}},{filename:'cv.exe'},{buffer:Buffer.alloc(MAX_FILE_BYTES+1)},{fields:{...applicant,extra:'untrusted'}}])assert.ok((await call('submissions',{body:form(options)})).status>=400);
  assert.equal(readdirSync(join(store.root,'tmp')).length,0);assert.equal(readdirSync(join(store.root,'files')).length,0);
});

test('transient SMTP failures retry; explicit permanent failure permits bounded client retry and keeps trace',async t=>{
  let time=Date.now();const store=fixture(t,{now:()=>time,sendInterval:0}),{sender,control}=await smtpFixture(t,{mode:'451'}),{receipt,authorization}=accept(store);
  let result=await runDeliveryOnce(store,sender);assert.equal(result.status,'RETRYING');assert.equal(result.code,'SMTP_451');assert.equal(await runDeliveryOnce(store,sender),null);
  time+=60000;control.mode='550';result=await runDeliveryOnce(store,sender);assert.equal(result.status,'FAILED');assert.equal(result.code,'SMTP_550');
  store.retry(receipt.id,authorization);control.mode='ok';assert.equal((await runDeliveryOnce(store,sender)).status,'SENT');
  assert.deepEqual(store.inspect(receipt.id).events.map(x=>x.event),['RECEIVED','SENDING','RETRYING','SENDING','FAILED','MANUAL_RETRY','SENDING','SENT']);
  assert.throws(()=>store.retry(receipt.id,authorization));
  const other=accept(store,{fields:{...applicant,name:'另一个虚构候选人'}});control.mode='550';
  for(let i=0;i<3;i++){assert.equal((await runDeliveryOnce(store,sender)).status,'FAILED');if(i<2)store.retry(other.receipt.id,other.authorization);}
  assert.throws(()=>store.retry(other.receipt.id,other.authorization),e=>e.code==='RETRY_LIMITED');
});

test('ambiguous timeout or interrupted lease never auto-resends; operator retry uses revision and explicit confirmation',async t=>{
  let time=Date.now();const store=fixture(t,{now:()=>time,sendInterval:0}),{receipt,authorization}=accept(store);
  const sender={from:'noreply@example.com',send:()=>new Promise(()=>{}),close(){}};
  assert.equal((await runDeliveryOnce(store,sender,{deadlineMs:15})).status,'UNKNOWN');assert.equal(await runDeliveryOnce(store,sender),null);
  assert.throws(()=>store.retry(receipt.id,authorization));const view=store.inspect(receipt.id);
  assert.throws(()=>store.operatorRetry(receipt.id,view.revision));store.operatorRetry(receipt.id,view.revision,{confirmUnknown:true});assert.throws(()=>store.operatorRetry(receipt.id,view.revision,{confirmUnknown:true}));
  const claimed=store.claim();time+=5*60000;assert.equal(store.recoverInterrupted(),1);assert.equal(store.finish(claimed.id,claimed.lease_token,{status:'SENT'}),false);assert.equal(store.inspect(receipt.id).status,'UNKNOWN');
  assert.deepEqual(classifyDeliveryError({code:'ETIMEDOUT',command:'DATA'}),{status:'UNKNOWN',code:'ETIMEDOUT'});
  assert.equal(classifyDeliveryError({code:'ECONNECTION',command:'CONN'}).status,'RETRYING');
});

test('SQLite serializes multiple workers and persists idempotency, IP budgets, quota and cleanup across restart',async t=>{
  let time=Date.now();const store=fixture(t,{now:()=>time,sendInterval:0}),other=openRecruitmentStore(store.root,{now:()=>time,sendInterval:0});t.after(()=>other.close());
  const {receipt,authorization}=accept(store);assert.equal(other.receipt(receipt.id,authorization).status,'RECEIVED');const claimed=store.claim();assert.equal(other.claim(),null);other.finish(claimed.id,claimed.lease_token,{status:'SENT'});
  time+=DAY-1;assert.equal(store.cleanup().deletedFiles,0);time+=1;assert.equal(other.cleanup().deletedFiles,1);assert.equal(store.inspect(receipt.id).temporaryFilePresent,false);assert.equal(store.inspect(receipt.id).status,'SENT');
  const pending=accept(store,{fields:{...applicant,name:'等待清理的虚构候选人'}});time+=7*DAY;assert.equal(store.cleanup().deletedFiles,1);assert.equal(store.inspect(pending.receipt.id).status,'EXPIRED');
  for(let i=0;i<30;i++)store.beginUpload('rate-test-ip');assert.throws(()=>other.beginUpload('rate-test-ip'),e=>e.status===429);
  time+=31*DAY;store.cleanup();assert.equal(store.inspect(receipt.id),null);assert.equal(store.inspect(pending.receipt.id),null);
  const orphan=join(store.root,'tmp',randomUUID()+'.upload');writeFileSync(orphan,'fictional',{mode:0o600});time+=2*3600000;store.cleanup();assert.equal(readdirSync(join(store.root,'tmp')).length,0);
});

test('10MiB attachment fits actual provider MIME limit; persistent quota and daily mail limits reject safely',async t=>{
  const store=fixture(t,{maxStoredBytes:MAX_FILE_BYTES,maxAcceptedDay:1});
  const buffer=Buffer.alloc(MAX_FILE_BYTES,32);pdf.copy(buffer);Buffer.from('\n%%EOF\n').copy(buffer,buffer.length-7);await validateResume(buffer,'maximum.pdf','application/pdf');
  const {receipt}=accept(store,{buffer});const row=store.claim();const message=await composeApplication(row,store.root,'110lab <noreply@notify.110-lab.cn>');assert.ok(message.raw.length<MAX_MIME_BYTES);assert.ok(message.raw.length>MAX_FILE_BYTES);
  assert.throws(()=>accept(store,{fields:{...applicant,name:'达到每日上限的虚构候选人'}}),e=>e.status===429);
  const tiny=fixture(t,{maxStoredBytes:pdf.length-1});assert.throws(()=>accept(tiny),e=>e.code==='STORAGE_BUSY');assert.equal(readdirSync(join(tiny.root,'files')).length,0);
  assert.equal(store.inspect(receipt.id).status,'SENDING');
});
