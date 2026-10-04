import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const state='s'.repeat(43),ticket='t'.repeat(43);
test('recruitment embedded login accepts only matching parent handoff, sends CSRF, clears on revocation',async()=>{
 const messages=[],requests=[],profiles=[],listeners={};let signedIn=false,revoked=false;
 const parent={postMessage:m=>messages.push(m)};
 const window={addEventListener:(n,f)=>listeners[n]=f};
 const fetch=async(path,options)=>{
  requests.push({path,options});
  let data={},status=200;
  if(path.endsWith('auth/start'))data={state,launchUrl:'https://internal.110-lab.cn/mail/auth/launch?state='+state};
  else if(path.endsWith('auth/redeem'))signedIn=true;
  else if(path.endsWith('session')){if(!signedIn)status=401;else data={subject:'fictional:admin',name:'虚构管理员',role:'admin',csrf:'fake-csrf'};}
  else if(revoked)status=403;
  return {ok:status===200,status,json:async()=>data};
 };
 const source=(await readFile(new URL('../src/lab-session.js',import.meta.url),'utf8')).replace('export function','function');
 const create=runInNewContext(source+';createLabSession',{window,parent,location:{pathname:'/recruitment-test/embedded'},fetch,URL,AbortSignal,setTimeout:()=>1,clearTimeout(){},setInterval:()=>2,clearInterval(){}});
 const session=create({onChange:p=>profiles.push(p)});
 await session.load();assert.equal(session.profile,null);await session.login();assert.equal(messages[0].state,state);
 const result={type:'110lab-mail-host-result',state,ticket};
 listeners.message({source:{},data:result});listeners.message({source:parent,data:{...result,state:'x'.repeat(43)}});
 await new Promise(r=>setImmediate(r));assert.equal(signedIn,false);
 listeners.message({source:parent,data:result});await new Promise(r=>setImmediate(r));assert.equal(session.profile.role,'admin');
 await session.request('candidates',{method:'POST',data:{}});
 const write=requests.at(-1);assert.equal(write.path,'/api/recruitment-test/embedded/candidates');assert.equal(write.options.headers['X-CSRF-Token'],'fake-csrf');
 revoked=true;await assert.rejects(session.request('candidates'),e=>e.status===403);assert.equal(session.profile,null);assert.equal(profiles.at(-1),null);
});

test('upload carries CSRF without overriding multipart boundary and stale downloads are discarded after logout',async()=>{
 const requests=[];let completeDownload;
 const source=(await readFile(new URL('../src/lab-session.js',import.meta.url),'utf8')).replace('export function','function');
 const create=runInNewContext(source+';createLabSession',{
  window:{addEventListener(){}},parent:{},location:{pathname:'/recruitment-test'},URL,AbortSignal,
  setTimeout,clearTimeout,setInterval,clearInterval,
  fetch:async(path,options)=>{
   requests.push({path,options});
   if(path.endsWith('session'))return {ok:true,json:async()=>({subject:'fictional:admin',role:'admin',csrf:'upload-csrf'})};
   if(path.endsWith('resume')&&options.method==='GET')return {ok:true,blob:()=>new Promise(resolve=>{completeDownload=resolve;})};
   return {ok:true,json:async()=>({id:'fictional-candidate'})};
  }
 });
 const session=create();await session.load();
 const form=new FormData();form.set('revision','1');
 await session.upload('candidates/fictional/resume',form);
 assert.equal(requests.at(-1).options.body,form);
 assert.equal(requests.at(-1).options.headers['X-CSRF-Token'],'upload-csrf');
 assert.equal(requests.at(-1).options.headers['Content-Type'],undefined);
 const download=session.download('candidates/fictional/resume');
 await new Promise(resolve=>setImmediate(resolve));
 await session.logout();completeDownload(new Blob(['fictional content']));
 await assert.rejects(download,e=>e.status===401);
 assert.equal(session.profile,null);
});
