import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createHttpServer} from '../server/http.mjs';
import {fixtureConfig,fixtureIdentity} from './helpers/mail-fixtures.mjs';

test('full portal preserves shared embedded login, candidate, attachment and idempotency across restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'110lab-recruitment-integration-'));
  const member={subject:'fictional_tenant:on_recruitment_member',email:'fictional.member@110-lab.cn',name:'虚构成员'};
  let server;
  const boot=async()=>{
    server=await createHttpServer({mail:{enabled:true,notifyEnabled:false,directory,config:fixtureConfig,localTest:true,fetchIdentity:async(_,{code})=>code==='member'?member:fixtureIdentity},recruitment:{enabled:false},admin:{enabled:false}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  };
  const stop=async()=>{if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});server=null;};
  const call=(path,{data,buffer,cookie='',csrf='',headers={}}={})=>new Promise((resolve,reject)=>{
    const body=buffer??(data===undefined?undefined:JSON.stringify(data));
    const req=request({hostname:'127.0.0.1',port:server.address().port,path,method:body===undefined?'GET':'POST',headers:{Host:'internal.110-lab.cn',Origin:'https://internal.110-lab.cn',Cookie:cookie,'X-CSRF-Token':csrf,...(data===undefined?{}:{'Content-Type':'application/json'}),...headers}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const bytes=Buffer.concat(chunks),text=bytes.toString();let value;try{value=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,bytes,text,value});});
    });req.on('error',reject);req.end(body);
  });
  const jar=r=>(r.headers['set-cookie']||[]).map(v=>v.split(';')[0]).join('; ');
  const base='/api/recruitment-test/embedded/';
  async function login(code){
    const start=await call('/api/mail/embedded/auth/start',{data:{}});
    const launch=await call('/mail/auth/launch?state='+start.value.state);
    const callback=await call('/mail/auth/callback?state='+start.value.state+'&code='+code,{cookie:jar(launch)});
    assert.equal(callback.status,200,'fictional Feishu callback completes');
    const ticket=callback.text.match(/<code>([\w-]{43})<\/code>/)[1];
    const redeemed=await call('/api/mail/embedded/auth/redeem',{data:{state:start.value.state,ticket},cookie:jar(start)});
    const cookie=jar(redeemed),profile=await call(base+'session',{cookie});
    assert.equal(profile.status,200);return {cookie,csrf:profile.value.csrf};
  }
  try{
    await boot();
    assert.equal((await call('/healthz')).value.recruitmentTestEnabled,true);
    const page=await call('/recruitment-test/embedded');assert.equal(page.status,200);
    assert.match(page.text,/rt-table/);assert.match(page.headers['content-security-policy'],/codex-sandbox:/);
    assert.equal((await call('/recruitment-test/embedded',{headers:{Host:'110-lab.cn'}})).status,404);
    const admin=await login('owner');
    // The same cookie is used by all owned application frames, not a preview bypass.
    assert.equal((await call('/api/workspace/embedded/session',admin)).value.role,'super_admin');
    assert.equal((await call('/api/mail/embedded/session',admin)).value.role,'super_admin');
    const input={requestId:randomUUID(),name:'虚构集成测试生',email:'integration@example.com',group:'开发组',summary:'隔离集成验证'};
    const created=await call(base+'candidates',{...admin,data:input});assert.equal(created.status,201);
    const id=created.value.id,pdf=Buffer.from('%PDF-1.7\nFictional integration resume\n%%EOF');
    const form=new FormData();form.set('requestId',randomUUID());form.set('revision','1');form.append('resume',new Blob([pdf],{type:'application/pdf'}),'虚构简历.pdf');
    const upload=new Request('http://localhost',{method:'POST',body:form});
    const saved=await call(base+'candidates/'+id+'/resume',{...admin,buffer:Buffer.from(await upload.arrayBuffer()),headers:{'Content-Type':upload.headers.get('content-type')}});
    assert.equal(saved.status,200);assert.equal(saved.value.resume.filename,'虚构简历.pdf');
    const action={requestId:randomUUID(),revision:2,action:'screen',assessmentRequired:false,note:'测试初筛'};
    const moved=await call(base+'candidates/'+id+'/actions',{...admin,data:action});assert.equal(moved.status,200);assert.equal(moved.value.stage,'interview');
    const events=moved.value.events.length;
    await stop();await boot();
    const restored=await call(base+'candidates/'+id,admin);assert.equal(restored.status,200);assert.equal(restored.value.stage,'interview');assert.equal(restored.value.events.length,events);
    assert.equal((await call(base+'session',admin)).value.role,'super_admin');
    const downloaded=await call(base+'candidates/'+id+'/resume',admin);assert.equal(downloaded.status,200);assert.deepEqual(downloaded.bytes,pdf);
    const repeated=await call(base+'candidates/'+id+'/actions',{...admin,data:action});assert.equal(repeated.status,200);assert.equal(repeated.value.events.length,events);
    assert.equal((await call('/api/recruitment-test/candidates',admin)).status,401);
    assert.equal((await call(base+'candidates/'+id+'/resume')).status,401);
    const ordinary=await login('member');
    assert.equal((await call(base+'session',ordinary)).value.role,'member');
    assert.equal((await call(base+'candidates',ordinary)).status,403);
    assert.equal((await call(base+'candidates/'+id+'/resume',ordinary)).status,403);
    assert.equal((await call('/api/mail/embedded/logout',{...admin,data:{}})).status,200);
    assert.equal((await call(base+'candidates',admin)).status,401);
  }finally{await stop();await rm(directory,{recursive:true,force:true});}
});
