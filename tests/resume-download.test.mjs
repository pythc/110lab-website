import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {saveResumeFile,handleResumeDownloadRequest,MAX_RESUME_DOWNLOAD_BYTES} from '../src/resume-download.js';
const pdf='application/pdf',docx='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const fixture=()=>new Blob(['%PDF-1.4\nFictional resume only'],{type:pdf});
const turn=()=>new Promise(r=>setImmediate(r));
function frameHarness(downloadFile){
  const listeners=new Set(),timers=new Map(),requests=[],statuses=[];let sequence=0;
  const parent={postMessage(message){requests.push(message);if(downloadFile!==undefined)void handleResumeDownloadRequest({origin:'https://internal.110-lab.cn',source,data:message},{frame:{contentWindow:source},downloadFile});}};
  const window={parent,addEventListener:(type,fn)=>listeners.add(fn),removeEventListener:(type,fn)=>listeners.delete(fn)};
  const receive=(message,from=parent)=>{for(const fn of [...listeners])fn({source:from,data:message});};
  const source={postMessage:message=>{statuses.push(message.status);receive(message);}};
  const env={window,crypto:{randomUUID},setTimeout(fn,ms){const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)};
  return {env,requests,statuses,listeners,timers,receive};
}
test('embedded PDF and DOCX use the host download protocol with exact bytes and no file URL on the server',async()=>{
  const exports=[],h=frameHarness(async p=>{exports.push(p);return {};});
  for(const [blob,name] of [[fixture(),'虚构候选人-简历.pdf'],[new Blob(['PK\x03\x04fictional'],{type:docx}),'虚构候选人.docx']]){
    await saveResumeFile(blob,name,{embedded:true},h.env);
    const file=exports.at(-1).contents[0];assert.equal(file.type,'resource');assert.equal(decodeURIComponent(new URL(file.resource.uri).pathname),'/'+name);assert.equal(file.resource.mimeType,blob.type);assert.deepEqual(Buffer.from(file.resource.blob,'base64'),Buffer.from(await blob.arrayBuffer()));
    assert.deepEqual(Object.keys(file.resource).sort(),['blob','mimeType','uri']);
  }
  assert.deepEqual(h.statuses,['started','complete','started','complete']);assert.equal(h.listeners.size,0);assert.equal(h.timers.size,0);
});
test('only the active owned frame can request a bounded PDF/DOCX export',async()=>{
  let calls=0;const replies=[],source={postMessage:(m,origin)=>replies.push({m,origin})},frame={contentWindow:source};
  const data={type:'110lab-resume-download',requestId:randomUUID(),filename:'test.pdf',mimeType:pdf,bytes:await fixture().arrayBuffer()},event={origin:'https://internal.110-lab.cn',source,data},options={frame,downloadFile:async()=>{calls++;return {};}};
  for(const invalid of [{...event,origin:'https://evil.example'},{...event,source:{}},{...event,data:{...data,requestId:'bad'}}])assert.equal(await handleResumeDownloadRequest(invalid,options),false);
  for(const patch of [{bytes:'not binary'},{bytes:new ArrayBuffer(0)},{bytes:new ArrayBuffer(MAX_RESUME_DOWNLOAD_BYTES+1)},{filename:'script.html',mimeType:'text/html'},{mimeType:docx}]){
    assert.equal(await handleResumeDownloadRequest({...event,data:{...data,...patch}},options),true);assert.equal(replies.at(-1).m.status,'failed');
  }
  assert.equal(calls,0);assert.ok(replies.every(r=>r.origin===event.origin));
  await handleResumeDownloadRequest({...event,data:{...data,filename:'../目录/候选人.pdf',bytes:new ArrayBuffer(MAX_RESUME_DOWNLOAD_BYTES)}},{frame,downloadFile:async p=>{const uri=p.contents[0].resource.uri;assert.equal(new URL(uri).hostname,'');assert.ok(!decodeURIComponent(uri).slice(8).includes('/'));assert.equal(Buffer.from(p.contents[0].resource.blob,'base64').length,MAX_RESUME_DOWNLOAD_BYTES);calls++;return {};}});
  assert.equal(calls,1);
});
test('host cancellation, unsupported clients and provider errors never claim success',async()=>{
  for(const [provider,error] of [[null,/不支持文件下载/],[async()=>({isError:true}),/取消/],[async()=>undefined,/下载未完成/],[async()=>{throw new Error('internal credential details');},/下载未完成/]]){
    const h=frameHarness(provider);await assert.rejects(saveResumeFile(fixture(),'简历.pdf',{embedded:true},h.env),error);assert.equal(h.listeners.size,0);assert.equal(h.timers.size,0);assert.ok(!h.statuses.includes('complete'));
  }
});
test('stale wrappers time out visibly; unrelated replies cannot complete another download',async()=>{
  const h=frameHarness(),p=saveResumeFile(fixture(),'简历.pdf',{embedded:true},h.env);await turn();
  const request=h.requests[0],reply={type:'110lab-resume-download-result',requestId:request.requestId,status:'complete'};
  h.receive(reply,{});h.receive({...reply,requestId:randomUUID()});assert.equal(h.listeners.size,1);
  const rejection=assert.rejects(p,/关闭后重新打开/);[...h.timers.values()][0].fn();await rejection;assert.equal(h.listeners.size,0);assert.equal(h.timers.size,0);
});
test('identity changes discard pending download results and delayed blob reads',async()=>{
  const h=frameHarness();let current=true;
  const p=saveResumeFile(fixture(),'简历.pdf',{embedded:true,current:()=>current},h.env);await turn();current=false;
  const rejected=assert.rejects(p,/登录状态已改变/);h.receive({type:'110lab-resume-download-result',requestId:h.requests[0].requestId,status:'complete'});await rejected;
  let resolve;const blob={type:pdf,size:10,arrayBuffer:()=>new Promise(r=>{resolve=r;})};current=true;
  const late=saveResumeFile(blob,'简历.pdf',{embedded:true,current:()=>current},h.env);current=false;resolve(new ArrayBuffer(10));await assert.rejects(late,/登录状态已改变/);assert.equal(h.requests.length,1);
});
test('ordinary browsers retain native downloads and revoke the private blob URL',async()=>{
  const actions=[],link={click(){actions.push('click');},remove(){actions.push('remove');}},window={};window.parent=window;
  let cleanup;const env={window,document:{createElement:()=>link,body:{append:()=>actions.push('append')}},URL:{createObjectURL:()=> 'blob:private-fixture',revokeObjectURL:u=>actions.push(u)},setTimeout:fn=>{cleanup=fn;}};
  await saveResumeFile(fixture(),'简历.pdf',{},env);assert.equal(link.download,'简历.pdf');assert.equal(link.href,'blob:private-fixture');assert.deepEqual(actions,['append','click','remove']);cleanup();assert.equal(actions.at(-1),'blob:private-fixture');
});
