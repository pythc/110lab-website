import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createMailHttp} from '../server/mail-http.mjs';
import {createRecruitmentTestHttp} from '../server/recruitment-test-http.mjs';
import {fixtureConfig,fixtureIdentity} from './helpers/mail-fixtures.mjs';
test('real login adapter protects test data by live role, CSRF, host and cookie partition',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'110lab-pilot-http-'));
 const person={subject:'fictional_tenant:on_pilot_member',email:'pilot.member@110-lab.cn',name:'虚构成员'};
 const mail=await createMailHttp({enabled:true,directory,config:fixtureConfig,localTest:true,fetchIdentity:async(_,{code})=>code==='member'?person:fixtureIdentity});
 const pilot=createRecruitmentTestHttp({mail});
 const server=createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname,host=req.headers.host.split(':')[0];if(!await mail.handle(req,res,path,host)&&!await pilot.handle(req,res,path,host)){res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=(path,{actor,body,host='internal.110-lab.cn',origin='https://internal.110-lab.cn',cookie,csrf}={})=>new Promise((resolve,reject)=>{
  const req=request({hostname:'127.0.0.1',port:server.address().port,path,method:body===undefined?'GET':'POST',headers:{Host:host,Origin:origin,Cookie:cookie??actor?.cookie??'','X-CSRF-Token':csrf??actor?.csrf??'',...(body===undefined?{}:{'Content-Type':'application/json'})}},res=>{const parts=[];res.on('data',c=>parts.push(c));res.on('end',()=>{const text=Buffer.concat(parts).toString();let value;try{value=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,text,value});});});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
 });
 const jar=r=>r.headers['set-cookie']?.[0]?.split(';')[0]||'';
 async function login(code,embedded=false){const prefix='/api/mail/'+(embedded?'embedded/':'');const start=await call(prefix+'auth/start',{body:{}});const launch=await call('/mail/auth/launch?state='+start.value.state);const cb=await call('/mail/auth/callback?state='+start.value.state+'&code='+code,{cookie:jar(launch)});const ticket=cb.text.match(/<code>([\w-]{43})<\/code>/)[1];const redeemed=await call(prefix+'auth/redeem',{body:{state:start.value.state,ticket},cookie:jar(start)});const cookie=jar(redeemed);return {...(await call(prefix+'session',{cookie})).value,cookie};}
 try{
  const admin=await login('owner'),member=await login('member'),base='/api/recruitment-test/';
  assert.equal((await call(base+'session')).status,401);
  const memberSession=await call(base+'session',{actor:member});
  assert.equal(memberSession.status,200);assert.equal(memberSession.value.role,'member');
  assert.equal(memberSession.value.subject,person.subject);assert.equal(memberSession.value.items,undefined);
  assert.equal((await call(base+'candidates',{actor:member})).status,403);
  assert.equal((await call(base+'candidates',{actor:admin,host:'110-lab.cn'})).status,404);
  assert.deepEqual((await call(base+'candidates',{actor:admin})).value,{mode:'test',items:[]});
  const data={requestId:randomUUID(),name:'虚构测试生',email:'test@example.com',group:'前端组',summary:'测试简历摘要'};
  assert.equal((await call(base+'candidates',{actor:admin,body:data,csrf:'invalid'})).status,403);
  assert.equal((await call(base+'candidates',{actor:admin,body:data,origin:'https://evil.example'})).status,403);
  assert.equal((await call(base+'candidates',{actor:admin,body:{...data,summary:'x'.repeat(17000)}})).status,413);
  const created=await call(base+'candidates',{actor:admin,body:data});assert.equal(created.status,201);
  assert.equal((await call(base+'candidates',{actor:admin,body:data})).value.id,created.value.id);
  const embedded=await login('owner',true);
  assert.equal((await call(base+'candidates',{actor:embedded})).status,401);
  assert.equal((await call(base+'embedded/candidates',{actor:admin})).status,401);
  assert.equal((await call(base+'embedded/candidates',{actor:embedded})).value.items.length,1);
  assert.equal((await call('/api/mail/administrators/grant',{actor:admin,body:{email:person.email,revision:1,confirmed:true}})).status,200);
  assert.equal((await call(base+'candidates',{actor:member})).status,200);
  assert.equal((await call('/api/mail/administrators/revoke',{actor:admin,body:{email:person.email,revision:2,confirmed:true}})).status,200);
  assert.equal((await call(base+'session',{actor:member})).value.role,'member');
  assert.equal((await call(base+'candidates/'+created.value.id,{actor:member})).status,403);
  assert.equal((await call(base+'candidates/'+created.value.id+'/actions',{actor:member,body:{requestId:randomUUID(),revision:1,action:'reject',note:'权限已撤销'}})).status,403);
  assert.equal((await call('/api/mail/embedded/logout',{actor:embedded,body:{}})).status,200);
  assert.equal((await call(base+'embedded/candidates',{actor:embedded})).status,401);
 }finally{await new Promise(r=>server.close(r));pilot.close();mail.close();await rm(directory,{recursive:true,force:true});}
});
