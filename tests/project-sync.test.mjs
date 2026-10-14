import {createServer} from 'node:http';
import {createWorkspaceHttp} from '../server/workspace-http.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {openWorkspaceStore} from '../server/workspace-store.mjs';
import {projectSyncWorker} from '../server/project-sync-worker.mjs';
import {createProjectSyncClient,ProjectSyncError} from '../server/project-sync-client.mjs';
const actor={subject:'alice',name:'Alice',email:'alice@lab.test',role:'member'};
const fields={name:'项目同步验收',summary:'同步测试',members:[],links:{repository:'',requirements:'',docs:'',demo:''}};
const mail={profile:()=>actor,projectMembers:async()=>({members:[actor]})};
function setup(t,{enabled=true}={}){
 const directory=mkdtempSync(join(tmpdir(),'project-sync-'));let now=1000000;
 const store=openWorkspaceStore({directory,syncProjects:enabled,now:()=>now});
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 return {store,directory,advance:n=>{now+=n;}};
}
const url=name=>'https://fcncvoyreb8p.feishuapp.com/app/app_17b6pxwde0x/requirements?project='+encodeURIComponent(name);
test('creation journal atomically enqueues exactly once and detects changed retries',t=>{
 const {store}=setup(t);const id=randomUUID();
 const save=()=>store.durable(actor,id,'web_project_create',fields,()=>store.create(actor,fields));
 const a=save(),b=save();assert.equal(a.id,b.id);assert.equal(store.list(actor).projects.length,1);assert.equal(store.requirementsSync.get(a.id).state,'queued');
 assert.throws(()=>store.durable(actor,id,'web_project_create',{...fields,name:'Changed'},()=>store.create(actor,fields)),e=>e.status===409);
 assert.throws(()=>store.create(actor,{...fields,summary:''}),e=>e.status===400);
 assert.equal(store.list(actor).projects.length,1);
});
test('disabled mode does not enqueue or retrofit old projects',t=>{
 const {store}=setup(t,{enabled:false});const p=store.create(actor,fields);assert.equal(p.requirementsSync,null);assert.equal(store.requirementsSync.claim(),null);
});
test('leases serialize independent SQLite instances, recover crashes and reject stale completion',t=>{
 const {store,directory,advance}=setup(t);const a=store.create(actor,fields),b=store.create(actor,{...fields,name:'Other'});
 const other=openWorkspaceStore({directory,syncProjects:true,now:()=>1000000});t.after(()=>other.close());
 const job=store.requirementsSync.claim();assert.equal(other.requirementsSync.claim(),null);
 advance(120001);const recovered=store.requirementsSync.claim();assert.equal(recovered.id,job.id);assert.notEqual(recovered.lease,job.lease);
 assert.equal(store.requirementsSync.finish(job,{projectId:job.id,url:url(job.name)}),false);
 assert.equal(store.requirementsSync.finish(recovered,{projectId:job.id,url:url(job.name)}),true);
 assert.ok(store.requirementsSync.claim());assert.equal(store.list(actor).projects.length,2);
});
test('completion preserves user links edited while remote operation is in flight',t=>{
 const {store}=setup(t);let p=store.create(actor,fields);const job=store.requirementsSync.claim();
 p=store.update(actor,p.id,{...fields,revision:p.revision,links:{...fields.links,requirements:'https://example.com/manual'}});
 store.requirementsSync.finish(job,{projectId:p.id,url:url(p.name)});
 assert.equal(store.get(actor,p.id).links.requirements,'https://example.com/manual');assert.equal(store.get(actor,p.id).requirementsSync.state,'synced');
});
test('worker retries temporary directory failure and never writes for inactive owners',async t=>{
 const {store,advance}=setup(t);const p=store.create(actor,fields);let ensure=0;let directory={unavailable:true,members:[actor]};
 const worker=projectSyncWorker({store,enabled:true,intervalMs:999999,mail:{...mail,projectMembers:async()=>directory},client:{ensure:async()=>{ensure++;return{projectId:p.id,url:url(p.name)}}}});t.after(()=>worker.close());
 await worker.run();assert.equal(ensure,0);assert.equal(store.requirementsSync.get(p.id).state,'retrying');
 advance(10001);directory={members:[]};await worker.run();assert.equal(ensure,0);assert.equal(store.requirementsSync.get(p.id).state,'blocked');
 directory={members:[actor]};store.requirementsSync.retry(p.id);await worker.run();assert.equal(ensure,1);assert.equal(store.get(actor,p.id).links.requirements,url(p.name));
});
test('shutdown drains an in-flight remote write before store closure',async t=>{
 const {store}=setup(t);const p=store.create(actor,fields);let finish,started;
 const began=new Promise(r=>{started=r});const remote=new Promise(r=>{finish=r});
 const worker=projectSyncWorker({store,mail,enabled:true,intervalMs:999999,client:{ensure:async()=>{started();return remote}}});
 const run=worker.run();await began;let closed=false;const closing=worker.close().then(()=>{closed=true});await Promise.resolve();assert.equal(closed,false);
 finish({projectId:p.id,url:url(p.name)});await Promise.all([run,closing]);assert.equal(closed,true);assert.equal(store.requirementsSync.get(p.id).state,'synced');
});
test('client recovers a remote commit after a timeout using lookup instead of creating again',async t=>{
 const {directory}=setup(t);const configPath=join(directory,'key.json');writeFileSync(configPath,JSON.stringify({openApiKey:'test-key'}),{mode:0o600});
 const job={id:randomUUID(),name:fields.name,summary:fields.summary};const dto={sourceProjectId:job.id,projectId:job.id,projectName:job.name,projectSummary:job.summary,projectUrl:url(job.name)};let created=false,syncCalls=0;
 const client=createProjectSyncClient({configPath,fetcher:async(path,init)=>{
  assert.equal(init.headers.Authorization,'Bearer test-key');assert.equal(init.redirect,'error');
  if(path.endsWith('/lookup'))return Response.json({code:0,data:{project:created?dto:null}});
  syncCalls++;created=true;throw new Error('response lost after commit');
 }});
 await assert.rejects(client.ensure(job),e=>e instanceof ProjectSyncError&&e.code==='CONNECTION_UNCONFIRMED');
 assert.deepEqual(await client.ensure(job),{projectId:job.id,url:url(job.name)});assert.equal(syncCalls,1);
});
test('client rejects unrelated project IDs and arbitrary redirect links',async t=>{
 const {directory}=setup(t);const configPath=join(directory,'key.json');writeFileSync(configPath,JSON.stringify({openApiKey:'test-key'}),{mode:0o600});
 const job={id:randomUUID(),name:fields.name,summary:fields.summary};let dto={sourceProjectId:job.id,projectId:job.id,projectName:job.name,projectSummary:job.summary,projectUrl:'https://evil.test/requirements?project='+job.name};
 const client=createProjectSyncClient({configPath,fetcher:async()=>Response.json({project:dto})});
 await assert.rejects(client.ensure(job),e=>e.code==='INVALID_PLATFORM_RESPONSE');dto={...dto,projectId:randomUUID(),projectUrl:url(job.name)};await assert.rejects(client.ensure(job),e=>e.code==='PROJECT_RESPONSE_MISMATCH');
});

test('HTTP creation retries return the same project and enforce CSRF and retry ownership',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'project-http-'));let current=actor;
 const workspace=createWorkspaceHttp({directory,localTest:true,projectSyncEnabled:true,mail:{...mail,enabled:true,identity:()=>current},projectSyncClient:{ensure:async job=>({projectId:job.id,url:url(job.name)})}});
 const server=createServer(async(req,res)=>{if(!await workspace.handle(req,res,new URL(req.url,'http://localhost').pathname,'127.0.0.1')){res.statusCode=404;res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await new Promise(r=>server.close(r));await workspace.close();rmSync(directory,{recursive:true,force:true});});
 const post=(path,data,headers={})=>fetch(origin+'/api/workspace/'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
 assert.equal((await post('projects',null)).status,400);
 assert.equal((await post('projects',fields,{Origin:'https://evil.test'})).status,403);
 const data={...fields,requestId:randomUUID()};const first=await post('projects',data);assert.equal(first.status,201);const p=await first.json();
 const again=await post('projects',data);assert.equal(again.status,201);assert.equal((await again.json()).id,p.id);
 assert.equal((await post('projects',{...data,name:'Other'})).status,409);
 current={...actor,subject:'bob'};assert.equal((await post('projects/'+p.id+'/requirements-sync/retry',{})).status,403);
 current=actor;assert.equal((await post('projects/'+p.id+'/requirements-sync/retry',{role:'admin'})).status,400);
 assert.equal(workspace.store.list(actor).projects.length,1);
});
