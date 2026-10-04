import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,symlinkSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {credentialFile,localUpload} from '../server/local-business-client.mjs';
import {openBusinessState,paginate} from '../server/business-state.mjs';
import {commandJournal} from '../server/durable-command.mjs';
import {extractAttachmentText} from '../server/attachment-text.mjs';
const actor={subject:'fictional:user',clientId:'test-client'};
const temp=t=>{const d=mkdtempSync(join(tmpdir(),'110lab-boundary-'));t.after(()=>rmSync(d,{recursive:true,force:true}));return d;};

test('private local credentials serialize sessions and refuse symlinks or public files',t=>{
  const dir=temp(t),path=join(dir,'oauth.json'),store=credentialFile(path);
  store.save({tokens:{access_token:'fictional'}});assert.equal(store.load().tokens.access_token,'fictional');
  const release=store.acquire();assert.throws(()=>credentialFile(path).acquire(),/另一个会话/);release();credentialFile(path).acquire()();
  chmodSync(path,0o644);assert.throws(()=>store.load(),/Unsafe/);chmodSync(path,0o600);
  const link=join(dir,'link');symlinkSync(path,link);assert.throws(()=>credentialFile(link).load());
  const input={requestId:randomUUID(),purpose:'mail_attachment',path};assert.ok(localUpload(input).contentBase64);assert.throws(()=>localUpload({...input,path:link}));assert.throws(()=>localUpload({...input,path:dir}));assert.throws(()=>localUpload({...input,path:'relative.txt'}));
});
test('confirmation crash recovery cannot create expired effects; SMTP leases survive overlapping instances',t=>{
  const dir=temp(t);let now=1000000;const state=openBusinessState({directory:dir,now:()=>now}),db=new DatabaseSync(join(dir,'target.sqlite')),durable=commandJournal(db);t.after(()=>{state.close();db.close();});
  const preview=()=>state.createPreview(actor,{kind:'updates.publish',scope:'updates:publish',payload:{content:'fixture'},requestId:randomUUID()});
  const p=preview();state.approve(actor,p.id,p.fingerprint);let effects=0;
  assert.throws(()=>state.execute(actor,p.id,p.kind,(payload,id,options)=>{durable(actor,id,p.kind,payload,()=>({effect:++effects}),options);throw new Error('crash after target commit');}));
  now+=700000;
  assert.equal(state.execute(actor,p.id,p.kind,(payload,id,options)=>durable(actor,id,p.kind,payload,()=>({effect:++effects}),options)).effect,1);assert.equal(effects,1);
  const q=preview();state.approve(actor,q.id,q.fingerprint);assert.throws(()=>state.execute(actor,q.id,q.kind,()=>{throw new Error('crash before target commit');}));now+=700000;
  assert.throws(()=>state.execute(actor,q.id,q.kind,(payload,id,options)=>durable(actor,id,q.kind,payload,()=>({effect:++effects}),options)),{code:'PREVIEW_STALE'});assert.equal(effects,1);
  const queued=state.queueMail(actor,randomUUID(),{mode:'live'}),job=state.claimMail();assert.equal(job.id,queued.operationId);
  const concurrent=openBusinessState({directory:dir,now:()=>now});concurrent.recoverMail();assert.equal(concurrent.operation(actor,job.id).state,'SENDING');concurrent.close();now+=120001;state.recoverMail();assert.equal(state.operation(actor,job.id).state,'UNKNOWN');assert.equal(state.claimMail(),null);
});
test('list cursors bind filters and revisions rather than silently skipping changed rows',()=>{
  const rows=[{id:'1',revision:1},{id:'2',revision:1}];const page=paginate(rows,{query:'',limit:1},actor.subject);assert.equal(paginate(rows,{query:'',limit:1,cursor:page.nextCursor},actor.subject).items[0].id,'2');
  assert.throws(()=>paginate([{id:'1',revision:2},rows[1]],{query:'',limit:1,cursor:page.nextCursor},actor.subject),{code:'CURSOR_STALE'});
  assert.throws(()=>paginate(rows,{query:'different',limit:1,cursor:page.nextCursor},actor.subject),{code:'CURSOR_STALE'});
});
test('attachment extraction is bounded, returns PDF source pages and treats invalid files explicitly',async()=>{
  const stream='BT /F1 18 Tf 72 720 Td (Fictional resume) Tj ET';
  const parts=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let source='%PDF-1.4\n';const offsets=[0];for(const [i,p]of parts.entries()){offsets.push(Buffer.byteLength(source));source+=`${i+1} 0 obj\n${p}\nendobj\n`;}const start=Buffer.byteLength(source);source+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n'+start+'\n%%EOF';const pdf=Buffer.from(source);
  const extracted=await extractAttachmentText(pdf,'application/pdf');assert.equal(extracted.status,'EXTRACTED');assert.equal(extracted.segments[0].page,1);assert.match(extracted.segments[0].text,/Fictional resume/);
  assert.equal((await extractAttachmentText(Buffer.from('invalid pdf'),'application/pdf')).status,'UNREADABLE');
  assert.equal((await extractAttachmentText(Buffer.from('fixture'),'image/png')).status,'UNSUPPORTED');
  assert.equal((await extractAttachmentText(Buffer.alloc(100010,65),'text/plain')).truncated,true);
});
