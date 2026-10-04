import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {createAdminConfig,openAdminAuth} from '../server/admin-auth.mjs';
import {createHttpServer} from '../server/http.mjs';
import {openUpdatesStore} from '../server/updates.mjs';
import {ADMIN_FRAME_ANCESTORS} from '../server/admin-http.mjs';
import {parseBody,serializeBody} from '../src/admin-markdown.js';
const config=await createAdminConfig('fixture_admin','fictional-password-2026');
test('admin sessions persist, expire, revoke, and never store raw tokens',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'110lab-auth-'));let time=Date.now(),auth=openAdminAuth({directory:dir,config,now:()=>time});
 try{
  await assert.rejects(auth.login('fixture_admin','wrong','192.0.2.1'),e=>e.status===401);
  const result=await auth.login('fixture_admin','fictional-password-2026','192.0.2.1'),cookie=result.cookie.split(';')[0];
  assert.match(result.cookie,/__Host-110lab_admin=.*HttpOnly; SameSite=Strict; Max-Age=28800; Secure/);
  assert.equal(auth.session(cookie).username,'fixture_admin');
  assert.throws(()=>auth.csrf(auth.session(cookie),'文'.repeat(43)),e=>e.status===403);
  assert.throws(()=>auth.session(cookie+'; '+cookie),e=>e.status===401);
  auth.close();auth=openAdminAuth({directory:dir,config,now:()=>time});
  assert.equal(auth.session(cookie).csrf,result.session.csrf);
  const bytes=await readFile(join(dir,'sessions.sqlite'));assert.equal(bytes.includes(Buffer.from(cookie.split('=')[1])),false);
  assert.equal((await stat(join(dir,'sessions.sqlite'))).mode&0o777,0o600);
  time+=31*60000;assert.throws(()=>auth.session(cookie),e=>e.status===401);
  const next=await auth.login('fixture_admin','fictional-password-2026','192.0.2.2');
  auth.logout(auth.session(next.cookie.split(';')[0]));assert.throws(()=>auth.session(next.cookie),e=>e.status===401);
  const rotating=await auth.login('fixture_admin','fictional-password-2026','192.0.2.2');auth.close();
  auth=openAdminAuth({directory:dir,config:await createAdminConfig('fixture_admin','replacement-fictional-password'),now:()=>time});
  assert.throws(()=>auth.session(rotating.cookie),e=>e.status===401);
 }finally{auth.close();await rm(dir,{recursive:true,force:true});}
});
test('admin HTTP requires host, origin, login and CSRF; drafts and public snapshots stay separate',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'110lab-admin-')),updates=openUpdatesStore(join(dir,'updates','updates.sqlite'));
 const http=await createHttpServer({updatesStore:updates,admin:{enabled:true,legacyPasswordEnabled:true,directory:join(dir,'auth'),config}});
 await new Promise(r=>http.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+http.address().port;
 const call=(path,{host='internal.110-lab.cn',method='GET',data,headers={}}={})=>new Promise((resolve,reject)=>{
  const req=request(base+path,{method,headers:{Host:host,...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://internal.110-lab.cn'}),...headers}},res=>{
   const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>{const text=Buffer.concat(chunks).toString();let body;try{body=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,body,text});});
  });req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data));
 });
 try{
  assert.equal((await call('/admin',{host:'110-lab.cn'})).status,404);
  assert.equal((await call('/api/admin/login',{host:'110-lab.cn',method:'POST',data:{}})).status,404);
  const page=await call('/admin');assert.equal(page.status,200);assert.match(page.headers['content-security-policy'],/frame-ancestors 'none'/);
  assert.equal((await call('/api/admin/updates')).status,401);
  const credentials={username:'fixture_admin',password:'fictional-password-2026'};
  assert.equal((await call('/api/admin/login',{method:'POST',data:credentials,headers:{Origin:'https://attacker.invalid'}})).status,403);
  const login=await call('/api/admin/login',{method:'POST',data:credentials});assert.equal(login.status,200);
  const headers={Cookie:login.headers['set-cookie'][0].split(';')[0],'X-CSRF-Token':login.body.csrf};
  assert.equal((await call('/api/admin/updates',{method:'POST',data:{title:'fictional draft'},headers:{Cookie:headers.Cookie}})).status,403);
  const created=await call('/api/admin/updates',{method:'POST',data:{title:'fictional draft',body:parseBody('## 技术分享\n\n**虚构资料** [链接](https://example.org)')},headers});assert.equal(created.status,201);
  const id=created.body.id;let revision=created.body.revision;
  let feed=await call('/api/updates',{host:'110-lab.cn'});assert.deepEqual(feed.body.updates,[]);const oldEtag=feed.headers.etag;
  assert.equal((await call('/api/admin/updates/'+id+'/publish',{method:'POST',data:{revision},headers})).status,400);
  const published=await call('/api/admin/updates/'+id+'/publish',{method:'POST',data:{revision,confirmPublic:true},headers});assert.equal(published.status,200);revision=published.body.revision;
  feed=await call('/api/updates',{host:'110-lab.cn',headers:{'If-None-Match':oldEtag}});assert.equal(feed.status,200);assert.equal(feed.body.updates[0].title,'fictional draft');assert.ok(!('draft' in feed.body.updates[0]));
  const edited=await call('/api/admin/updates/'+id,{method:'POST',data:{revision,content:{title:'private edited title'}},headers});assert.equal(edited.status,200);revision=edited.body.revision;
  assert.equal((await call('/api/updates')).body.updates[0].title,'fictional draft');
  assert.equal((await call('/api/admin/updates/'+id+'/publish',{method:'POST',data:{revision:revision-1,confirmPublic:true},headers})).status,409);
  assert.equal((await call('/api/admin/updates/'+id+'/withdraw',{method:'POST',data:{revision},headers})).status,200);
  assert.deepEqual((await call('/api/updates')).body.updates,[]);
  assert.equal((await call('/api/updates',{headers:{'If-None-Match':oldEtag}})).status,304);
  assert.equal((await call('/api/updates',{method:'POST',data:{}})).status,405);
  assert.equal((await call('/api/auth/login',{method:'POST',data:{}})).status,404);
  assert.equal((await call('/api/admin/logout',{method:'POST',data:{},headers})).status,200);
  assert.equal((await call('/api/admin/session',{headers})).status,401);
  for(let i=0;i<7;i++)assert.equal((await call('/api/admin/login',{method:'POST',data:{...credentials,password:'wrong'},headers:{'X-Forwarded-For':'192.0.2.'+i}})).status,401);
  assert.equal((await call('/api/admin/login',{method:'POST',data:credentials,headers:{'X-Forwarded-For':'192.0.2.99'}})).status,429);
 }finally{await new Promise(r=>{http.close(r);http.closeAllConnections();});updates.close();await rm(dir,{recursive:true,force:true});}
});
test('Markdown preserves supported formatting and treats executable links as text',()=>{
 const blocks=parseBody('## 标题\n\n**粗体** [链接](https://example.org)\n\n- 第一项\n- 第二项');assert.deepEqual(parseBody(serializeBody(blocks)),blocks);
 const untrusted=parseBody('[危险](javascript:alert(1)) <script>alert(1)</script>');assert.equal(untrusted[0].content.some(s=>s.href),false);assert.match(untrusted[0].content[0].text,/<script>/);
});

test('embedded admin sessions persist independently and cannot be relabelled across contexts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'110lab-embedded-auth-'));let auth=openAdminAuth({directory:dir,config});
 try{
  const normal=await auth.login('fixture_admin','fictional-password-2026','192.0.2.3');
  const embedded=await auth.login('fixture_admin','fictional-password-2026','192.0.2.3',{embedded:true});
  assert.match(embedded.cookie,/^__Host-110lab_admin_embedded=.*HttpOnly; SameSite=None; Max-Age=28800; Secure; Partitioned$/);
  const a=normal.cookie.split(';')[0],b=embedded.cookie.split(';')[0],both=a+'; '+b;
  assert.throws(()=>auth.session(a.replace('__Host-110lab_admin=','__Host-110lab_admin_embedded='),{embedded:true}),e=>e.status===401);
  assert.throws(()=>auth.session(b.replace('__Host-110lab_admin_embedded=','__Host-110lab_admin=')),e=>e.status===401);
  auth.close();auth=openAdminAuth({directory:dir,config});
  assert.equal(auth.session(both).csrf,normal.session.csrf);
  const session=auth.session(both,{embedded:true});assert.equal(session.csrf,embedded.session.csrf);
  assert.throws(()=>auth.csrf(session,normal.session.csrf),e=>e.status===403);
  assert.match(auth.logout(session),/__Host-110lab_admin_embedded=;.*Max-Age=0; Secure; Partitioned/);
  assert.throws(()=>auth.session(both,{embedded:true}),e=>e.status===401);
  assert.equal(auth.session(both).csrf,normal.session.csrf);
 }finally{auth.close();await rm(dir,{recursive:true,force:true});}
});
test('embedded admin preserves host, origin, CSRF, publication and shared login limits',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'110lab-embedded-http-')),updates=openUpdatesStore(join(dir,'updates.sqlite'));
 const http=await createHttpServer({updatesStore:updates,admin:{enabled:true,legacyPasswordEnabled:true,directory:join(dir,'auth'),config}});
 await new Promise(r=>http.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+http.address().port;
 const call=(path,{host='internal.110-lab.cn',method='GET',data,headers={}}={})=>new Promise((resolve,reject)=>{
  const req=request(base+path,{method,headers:{Host:host,...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://internal.110-lab.cn'}),...headers}},res=>{
   let text='';res.on('data',x=>text+=x);res.on('end',()=>{let body;try{body=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,body});});
  });req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data));
 });
 const prefix='/api/admin/embedded/',credentials={username:'fixture_admin',password:'fictional-password-2026'};
 try{
  assert.equal((await call('/admin/embedded',{host:'110-lab.cn'})).status,404);
  assert.equal((await call(prefix+'session',{host:'110-lab.cn'})).status,404);
  const page=await call('/admin/embedded');assert.equal(page.status,200);
  assert.ok(page.headers['content-security-policy'].includes("frame-ancestors 'self' "+ADMIN_FRAME_ANCESTORS.join(' ')+';'));
  assert.ok(!page.headers['content-security-policy'].includes('*'));
  assert.match((await call('/admin')).headers['content-security-policy'],/frame-ancestors 'none'/);
  assert.equal((await call(prefix+'session')).status,401);
  assert.equal((await call(prefix+'login',{method:'POST',data:credentials,headers:{Origin:'https://attacker.invalid'}})).status,403);
  assert.equal((await call(prefix+'login',{method:'POST',data:credentials,headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  const login=await call(prefix+'login',{method:'POST',data:credentials});assert.equal(login.status,200);
  const headers={Cookie:login.headers['set-cookie'][0].split(';')[0],'X-CSRF-Token':login.body.csrf};
  assert.match(login.headers['set-cookie'][0],/SameSite=None.*Secure; Partitioned/);
  assert.equal((await call(prefix+'session',{headers})).status,200);
  assert.equal((await call('/api/admin/session',{headers})).status,401);
  assert.equal((await call(prefix+'updates',{method:'POST',data:{title:'fictional embedded draft'},headers:{Cookie:headers.Cookie}})).status,403);
  const created=await call(prefix+'updates',{method:'POST',data:{title:'fictional embedded draft'},headers});assert.equal(created.status,201);
  assert.deepEqual((await call('/api/updates')).body.updates,[]);
  const path=prefix+'updates/'+created.body.id;
  assert.equal((await call(path+'/publish',{method:'POST',data:{revision:created.body.revision},headers})).status,400);
  const published=await call(path+'/publish',{method:'POST',data:{revision:created.body.revision,confirmPublic:true},headers});assert.equal(published.status,200);
  assert.equal((await call('/api/updates')).body.updates[0].title,'fictional embedded draft');
  assert.equal((await call(path+'/withdraw',{method:'POST',data:{revision:published.body.revision},headers})).status,200);
  assert.deepEqual((await call('/api/updates')).body.updates,[]);
  assert.equal((await call(prefix+'logout',{method:'POST',data:{},headers})).status,200);
  assert.equal((await call(prefix+'session',{headers})).status,401);
  for(let i=0;i<7;i++)assert.equal((await call((i%2?prefix:'/api/admin/')+'login',{method:'POST',data:{...credentials,password:'wrong'}})).status,401);
  assert.equal((await call('/api/admin/login',{method:'POST',data:credentials})).status,429);
 }finally{await new Promise(r=>{http.close(r);http.closeAllConnections();});updates.close();await rm(dir,{recursive:true,force:true});}
});
