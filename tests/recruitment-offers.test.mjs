import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {openRecruitmentWorkflowStore} from '../server/recruitment-workflow-store.mjs';
import {createRecruitmentWorkflowHttp} from '../server/recruitment-workflow-http.mjs';
import {createOfferIntegration} from '../server/offer-integration.mjs';
import {MailAuthError} from '../server/mail-auth.mjs';

const admin={subject:'tenant:on_admin000000001',name:'测试管理员',role:'admin',csrf:'fixture'},hr={subject:'tenant:on_hr000000000001',name:'测试 HR',role:'member',csrf:'fixture'},interviewer={subject:'tenant:on_interviewer001',name:'测试面试官',role:'member',csrf:'fixture'};
const account=()=>({id:randomUUID(),name:'虚构候选人',studentNo:'2026000001',email:'candidate@example.test'});
const change=(a,revision=0,enabled=true)=>({requestId:randomUUID(),assessmentUserId:a.id,revision,enabled,note:'隔离环境测试'});
function fixture(t){const directory=mkdtempSync(join(tmpdir(),'110lab-offers-'));let store;const open=()=>openRecruitmentWorkflowStore({directory});store=open();t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return {get s(){return store;},directory,reopen(){store.close();store=open();}};}
const grantHr=(s,enabled=true)=>s.setHr(admin,{requestId:randomUUID(),revision:s.listHr(admin).revision,subject:hr.subject,enabled},hr);

test('empty list denies, grants bind exact assessment id, persist, and never enqueue notifications',t=>{
 const f=fixture(t),a=account(),sameName=account(),input=change(a);
 assert.deepEqual(f.s.offerAccess(a.id),{allowed:false});f.s.create(admin,{requestId:randomUUID(),name:a.name,email:a.email,group:'测试组',summary:''});assert.deepEqual(f.s.offerAccess(a.id),{allowed:false});
 const first=f.s.setOffer(admin,input,a);assert.equal(first.revision,1);assert.equal(first.status,'PENDING');assert.deepEqual(f.s.setOffer(admin,input,a),first);
 assert.deepEqual(f.s.offerAccess(a.id),{allowed:true,grantId:first.id,revision:1,status:'PENDING'});assert.deepEqual(f.s.offerAccess(sameName.id),{allowed:false});
 assert.throws(()=>f.s.setOffer(admin,{...input,requestId:randomUUID()},a),{status:409});assert.throws(()=>f.s.setOffer(admin,change(sameName),a),{status:400});
 f.reopen();assert.equal(f.s.listOffers(admin).items[0].assessmentUserId,a.id);
 const db=new DatabaseSync(join(f.directory,'recruitment.sqlite'));try{assert.equal(db.prepare('SELECT COUNT(*) n FROM deliveries').get().n,0);assert.equal(db.prepare("SELECT COUNT(*) n FROM audit WHERE action='offer_access_granted'").get().n,1);}finally{db.close();}
});

test('only HR or laboratory admins manage roster; revocation of HR applies immediately including cached commands',t=>{
 const f=fixture(t),a=account(),input=change(a);
 for(const actor of [hr,interviewer]){assert.throws(()=>f.s.listOffers(actor),{status:403});assert.throws(()=>f.s.setOffer(actor,input,a),{status:403});}
 grantHr(f.s);const first=f.s.setOffer(hr,input,a);assert.equal(first.enabled,true);grantHr(f.s,false);
 assert.throws(()=>f.s.setOffer(hr,input,a),{status:403});assert.throws(()=>f.s.listOffers(hr),{status:403});
 const revoked=f.s.setOffer(admin,change(a,1,false));assert.equal(revoked.enabled,false);assert.deepEqual(f.s.offerAccess(a.id),{allowed:false});
 // Replaying the original successful command never restores access.
 assert.deepEqual(f.s.setOffer(admin,{...input,requestId:randomUUID(),revision:2},a).enabled,true);
});

test('responses are durable, idempotent, conflict checked, and cannot cross revoked or reissued grants',t=>{
 const f=fixture(t),a=account(),input=change(a),g=f.s.setOffer(admin,input,a),response={userId:a.id,grantId:g.id,revision:1,decision:'ACCEPTED'};
 assert.throws(()=>f.s.respondOffer({...response,userId:randomUUID()}),{status:409});assert.throws(()=>f.s.respondOffer({...response,grantId:randomUUID()}),{status:409});
 const saved=f.s.respondOffer(response);assert.equal(saved.status,'ACCEPTED');assert.deepEqual(f.s.respondOffer(response),saved);assert.throws(()=>f.s.respondOffer({...response,decision:'DECLINED'}),{status:409});
 f.reopen();assert.equal(f.s.listOffers(admin).items[0].status,'ACCEPTED');
 f.s.setOffer(admin,change(a,1,false));assert.throws(()=>f.s.respondOffer(response),{status:409});assert.deepEqual(f.s.setOffer(admin,input,a),g);assert.deepEqual(f.s.offerAccess(a.id),{allowed:false});
 const reissued=f.s.setOffer(admin,change(a,2),a);assert.equal(reissued.status,'PENDING');assert.equal(reissued.revision,3);assert.throws(()=>f.s.respondOffer(response),{status:409});
 assert.equal(f.s.respondOffer({...response,revision:3,decision:'DECLINED'}).status,'DECLINED');
 const db=new DatabaseSync(join(f.directory,'recruitment.sqlite'));try{assert.equal(db.prepare("SELECT COUNT(*) n FROM audit WHERE action='offer_response'").get().n,2);}finally{db.close();}
});

test('multiple store handles observe revocation without stale access caches',t=>{
 const f=fixture(t),other=openRecruitmentWorkflowStore({directory:f.directory});t.after(()=>other.close());const a=account(),g=f.s.setOffer(admin,change(a),a);
 assert.equal(other.offerAccess(a.id).allowed,true);other.setOffer(admin,change(a,1,false));assert.deepEqual(f.s.offerAccess(a.id),{allowed:false});
 assert.throws(()=>f.s.respondOffer({userId:a.id,grantId:g.id,revision:1,decision:'ACCEPTED'}),{status:409});
});

test('assessment adapter pins origin, forbids redirects, bounds responses and rejects mismatched accounts',async t=>{
 const a=account(),token=randomBytes(32).toString('base64url'),config={token,assessmentBaseUrl:'https://exam.110-lab.cn'},calls=[];
 let payload={users:[a]},status=200;const adapter=createOfferIntegration({config,fetchImpl:async(url,opts)=>{calls.push({url,opts});return new Response(JSON.stringify(payload),{status});}});
 assert.deepEqual(await adapter.search({query:'虚构'}),{items:[a],hasMore:false});assert.equal(calls[0].url,config.assessmentBaseUrl+'/api/internal/offer-users/search');assert.equal(calls[0].opts.redirect,'error');assert.ok(calls[0].opts.signal);assert.equal(calls[0].opts.headers.Authorization,'Bearer '+token);
 payload={user:a};assert.deepEqual(await adapter.get(a.id),a);assert.equal(calls[1].opts.method,'GET');
 await assert.rejects(adapter.get(randomUUID()),{status:503});status=404;await assert.rejects(adapter.get(a.id),{status:404});status=200;payload='x'.repeat(65537);await assert.rejects(adapter.get(a.id),{status:503});
 assert.throws(()=>createOfferIntegration({config:{...config,assessmentBaseUrl:'https://evil.example'}}));await assert.rejects(createOfferIntegration().get(a.id),{status:503});
 adapter.authenticate({headers:{authorization:'Bearer '+token}});for(const headers of [{},{authorization:'wrong'},{authorization:'Bearer '+token,origin:config.assessmentBaseUrl},{authorization:'Bearer '+token,'sec-fetch-site':'same-origin'}])assert.throws(()=>adapter.authenticate({headers}),{status:401});
 const directory=mkdtempSync(join(tmpdir(),'offer-config-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const file=join(directory,'config.json');writeFileSync(file,JSON.stringify(config),{mode:0o644});assert.throws(()=>createOfferIntegration({configPath:file}),/Unsafe/);
});

test('HTTP protects directory/roster with current role and CSRF, and service access/respond with dedicated token',async t=>{
 const f=fixture(t),a=account(),token=randomBytes(32).toString('base64url'),actors={admin,hr,interviewer};let actorOverride=null,afterFetch=()=>{};
 const integration=createOfferIntegration({config:{token,assessmentBaseUrl:'https://exam.110-lab.cn'},fetchImpl:async(url)=>{afterFetch();return new Response(JSON.stringify(url.endsWith('/search')?{users:[a]}:{user:a}));}});
 const mail={enabled:true,workspaceDirectory:f.directory,identity(req,{write}={}){const v=actorOverride||actors[req.headers.authorization];if(!v)throw new MailAuthError(401,'登录');if(write&&req.headers['x-csrf-token']!=='fixture')throw new MailAuthError(403,'CSRF');return v;}};
 const workflow=createRecruitmentWorkflowHttp({mail,enabled:true,store:f.s,deliveryMode:'live',localTest:true,offerIntegration:integration});
 const server=createServer(async(req,res)=>{if(!await workflow.handle(req,res,new URL(req.url,'http://localhost').pathname,'127.0.0.1')){res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));await workflow.close();});const base='http://127.0.0.1:'+server.address().port;
 const call=async(path,auth,data,headers={})=>{const r=await fetch(base+path,{method:data?'POST':'GET',headers:{Authorization:auth,'Content-Type':'application/json',...headers},body:data?JSON.stringify(data):undefined});return {status:r.status,value:await r.json()};};
 const userHeaders={Origin:base,'X-CSRF-Token':'fixture'},path='/api/recruitment-admin/';
 for(const suffix of ['offers','embedded/offers'])assert.equal((await call(path+suffix,'interviewer')).status,403);
 assert.equal((await call(path+'offers','admin',change(a),{Origin:base})).status,403);
 assert.equal((await call(path+'offer-accounts/search','interviewer',{query:'虚构'},userHeaders)).status,403);
 grantHr(f.s);assert.equal((await call(path+'offer-accounts/search','hr',{query:'虚构'},userHeaders)).value.items[0].id,a.id);
 afterFetch=()=>{actorOverride=interviewer;};assert.equal((await call(path+'offers','hr',change(a),userHeaders)).status,403);assert.deepEqual(f.s.offerAccess(a.id),{allowed:false});actorOverride=null;afterFetch=()=>{};
 const added=await call(path+'embedded/offers','hr',change(a),userHeaders);assert.equal(added.status,200);const g=added.value;
 const service='/api/recruitment-offer/';assert.equal((await call(service+'access','admin',{userId:a.id})).status,401);assert.equal((await call(service+'access','Bearer '+token,{userId:a.id},userHeaders)).status,401);
 assert.equal((await call(service+'access','Bearer '+token,{userId:a.id})).value.allowed,true);
 const reply={userId:a.id,grantId:g.id,revision:1,decision:'ACCEPTED'};assert.equal((await call(service+'respond','Bearer '+token,reply)).value.status,'ACCEPTED');assert.equal((await call(service+'respond','Bearer '+token,{...reply,decision:'DECLINED'})).status,409);
 // Withdrawal still works if assessment is unavailable: no directory lookup.
 afterFetch=()=>{throw new Error('offline');};assert.equal((await call(path+'offers','admin',change(a,1,false),userHeaders)).status,200);assert.equal((await call(service+'respond','Bearer '+token,reply)).status,409);assert.equal((await call(service+'access','Bearer '+token,{userId:a.id})).value.allowed,false);
});
