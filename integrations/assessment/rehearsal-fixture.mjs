// Run ONLY in the isolated rehearsal containers. Uses fictional data and an
// internal Docker network, never production credentials or candidate records.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire('/app/package.json');
const {Pool}=require('pg');
const pool=new Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path=assessment,public'});
const root='/rehearsal',mode=process.argv[2],sha=x=>createHash('sha256').update(x).digest('hex');
assert.equal(new URL(process.env.DATABASE_URL).pathname,'/lab_rehearsal');
assert.match(new URL(process.env.DATABASE_URL).hostname,/^sso-rehearsal-/);
const one=async(sql,args=[]) => (await pool.query(sql,args)).rows[0];
const json=async(path,value)=>writeFile(root+'/'+path,JSON.stringify(value),{mode:0o600});
const load=async path=>JSON.parse(await readFile(root+'/'+path,'utf8'));
const assetManifest=async()=>Object.fromEntries(await Promise.all((await readdir('/app/client/dist/assets')).map(async name=>[name,sha(await readFile('/app/client/dist/assets/'+name))])));
try{
 if(mode==='seed'){
  const u=await one("INSERT INTO users(role,name,email,password_hash) VALUES('CANDIDATE','虚构考生','fictional@example.test','unused-fixture-password') RETURNING id");
  const s=await one("INSERT INTO sessions(user_id,csrf_token,expires_at) VALUES($1,'fictional-csrf',now()+interval '2 hours') RETURNING id",[u.id]);
  const r=await one("INSERT INTO rounds(name) VALUES('隔离演练') RETURNING id");
  const b=await one("INSERT INTO batches(round_id,name,opens_at,start_closes_at,status) VALUES($1,'虚构批次',now()-interval '1 hour',now()+interval '24 hours','OPEN') RETURNING id",[r.id]);
  const q=await one("INSERT INTO questions(batch_id,direction,title,content,published) VALUES($1,'PRODUCT','虚构试题','仅用于部署演练',true) RETURNING id",[b.id]);
  const v=await one("INSERT INTO question_versions(question_id,version_no,title,content,attachment_ids) VALUES($1,1,'虚构试题','仅用于部署演练','{}') RETURNING id",[q.id]);
  const e=await one("INSERT INTO enrollments(user_id,round_id,batch_id,direction,consent_version,consent_accepted_at,direct_upload_consent_at,mcp_connected,started_at,deadline,duration_hours,question_version_id) VALUES($1,$2,$3,'PRODUCT','assessment-consent-v1',now(),now(),true,now(),now()+interval '24 hours',24,$4) RETURNING id",[u.id,r.id,b.id,v.id]);
  const p=await one("INSERT INTO repository_previews(enrollment_id,user_id,url,branch,sha,message,author,committed_at,expires_at) VALUES($1,$2,'https://github.com/fixture/rehearsal','main',$3,'fictional','fixture',now(),now()+interval '1 hour') RETURNING id",[e.id,u.id,'a'.repeat(40)]);
  const repo=await one("INSERT INTO repositories(enrollment_id,preview_id,url,branch,sha,message,author,committed_at) SELECT enrollment_id,id,url,branch,sha,message,author,committed_at FROM repository_previews WHERE id=$1 RETURNING id",[p.id]);
  await pool.query('UPDATE enrollments SET repository_id=$1 WHERE id=$2',[repo.id,e.id]);
  const t=await one("INSERT INTO mcp_tokens(enrollment_id,token_hash,expires_at) VALUES($1,'fictional-hash',now()+interval '24 hours') RETURNING id",[e.id]);
  const {loadConfig}=await import('/app/server/dist/config.js');
  const {createMaterialUpload}=await import('/app/server/dist/uploads.js');
  const ticket=await createMaterialUpload({pool,config:loadConfig(process.env).config},{userId:u.id,enrollmentId:e.id,mcpTokenId:t.id},{repoSha:'a'.repeat(40),clients:[{name:'fixture',models:[{name:'unknown',source:'unknown'}]}],projectSummary:'虚构成果',collaborationSummary:'部署演练'});
  await json('fixture.json',{cookie:'lab_session='+s.id,csrf:'fictional-csrf',enrollment:e.id,repo:repo.id,ticket});
  await json('old-assets.json',await assetManifest());
  await json('exam-before.json',await one('SELECT started_at,deadline,question_version_id,repository_id,finalized_at FROM enrollments WHERE id=$1',[e.id]));
  console.log(JSON.stringify({seeded:true,migrations:(await pool.query('SELECT id FROM schema_migrations ORDER BY id')).rows.map(x=>x.id)}));
 }else if(mode==='monitor'){
  const f=await load('fixture.json'),cfg=await load('hosts.json'),samples=[],failures=[];
  for(let i=0;i<3000;i++){
   try{await readFile(root+'/stop-monitor');break;}catch{}
   const start=performance.now();
   try{
    const r=await fetch('http://'+cfg.gateway+':8080/api/auth/me',{headers:{cookie:f.cookie},signal:AbortSignal.timeout(8000)});
    assert.equal(r.status,200);assert.equal((await r.json()).user.role,'CANDIDATE');samples.push(performance.now()-start);
   }catch(e){failures.push(String(e));}
   await new Promise(r=>setTimeout(r,50));
  }
  await json('monitor-result.json',{samples:samples.length,failures,maxLatencyMs:Math.round(Math.max(0,...samples))});
 }else if(mode==='exercise'){
  const f=await load('fixture.json'),hosts=await load('hosts.json');
  const base='http://'+hosts.gateway+':8080';
  const api=async(path,init={})=>fetch(base+path,{redirect:'manual',...init,headers:{cookie:f.cookie,origin:'https://exam.110-lab.cn','x-csrf-token':f.csrf,...init.headers},signal:AbortSignal.timeout(12000)});
  const route=async upstream=>{
   const config={admin:{listen:'0.0.0.0:2019'},apps:{http:{servers:{rehearsal:{listen:[':8080'],routes:[{handle:[{handler:'reverse_proxy',upstreams:[{dial:upstream+':5380'}]}]}]}}}}};
   const r=await fetch('http://'+hosts.gateway+':2019/load',{method:'POST',headers:{'content-type':'application/json',origin:'http://0.0.0.0:2019'},body:JSON.stringify(config)});assert.equal(r.status,200,await r.text());
  };
  const uploadPath=new URL(f.ticket.uploadUrl).pathname;
  const send=async(suffix='',method='GET',body)=>{
   const r=await api(uploadPath+suffix,{method,headers:{authorization:'Bearer '+f.ticket.uploadToken,'content-type':Buffer.isBuffer(body)?'application/octet-stream':'application/json'},...(body!==undefined?{body}: {})});
   const text=await r.text();assert.equal(r.status,200,text);return JSON.parse(text);
  };
  const content=Buffer.concat([Buffer.from('Fictional deployment fixture\n'),Buffer.alloc(2*1024*1024,0x7a)]);
  const listed=await send('/manifest','POST',JSON.stringify({files:[{name:'fictional-history.txt',bytes:content.length,sha256:sha(content),source:'agent-export',coverage:'export'}]}));
  const file=listed.files[0];const cut1=700000,cut2=1400000;
  await send('/files/'+file.id+'?offset=0','PUT',content.subarray(0,cut1));
  const stable=await load('exam-before.json');
  const assertExam=async()=>{
   const r=await api('/api/enrollments/'+f.enrollment);assert.equal(r.status,200,await r.clone().text());
   assert.deepEqual(JSON.parse(JSON.stringify(await one('SELECT started_at,deadline,question_version_id,repository_id,finalized_at FROM enrollments WHERE id=$1',[f.enrollment]))),stable);
  };
  const assertAssets=async manifest=>{
   for(const [name,hash] of Object.entries(manifest)){
    const r=await api('/assets/'+name);assert.equal(r.status,200,name);assert.equal(sha(Buffer.from(await r.arrayBuffer())),hash,name);
   }
  };
  const switchWithInflight=async upstream=>{
   const blocker=await pool.connect();let inflight;
   try{
    await blocker.query('BEGIN');await blocker.query('LOCK TABLE enrollments IN ACCESS EXCLUSIVE MODE');
    inflight=api('/api/enrollments/'+f.enrollment);
    let waiting=false;
    for(let i=0;i<100;i++){
     const row=await one("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FROM enrollments WHERE id = $1%'");
     if(row.n){waiting=true;break;}await new Promise(r=>setTimeout(r,20));
    }
    assert.ok(waiting,'request is in flight on the previous HTTP process');
    await route(upstream);await new Promise(r=>setTimeout(r,500));
    await blocker.query('COMMIT');
    assert.equal((await inflight).status,200,'in-flight request survives reload');
   }finally{await blocker.query('ROLLBACK');blocker.release();if(inflight)await inflight;}
  };
  const oldAssets=await load('old-assets.json'),allAssets=await assetManifest();
  for(const [name,hash] of Object.entries(oldAssets))assert.equal(allAssets[name],hash,'old immutable asset preserved');
  await assertExam();await switchWithInflight(hosts.candidate);
  assert.equal((await (await api('/api/auth/feishu/config')).json()).enabled,true);
  await assertExam();await assertAssets(oldAssets);
  assert.equal((await send()).files[0].receivedBytes,cut1);
  await send('/files/'+file.id+'?offset='+cut1,'PUT',content.subarray(cut1,cut2));
  // Simulated SSO session exists only in the isolated DB. Rollback must revoke
  // it while preserving the pre-existing candidate and the upload ticket.
  const admin=await one("INSERT INTO users(role,name,email,password_hash) VALUES('ADMIN','虚构管理员','fictional-sso@example.test','LAB_SSO_ONLY') RETURNING id");
  await pool.query("INSERT INTO lab_sso_identities(subject,user_id) VALUES('fixture:on_fixture_admin_123',$1)",[admin.id]);
  const sid=randomUUID();await pool.query("INSERT INTO sessions(id,user_id,csrf_token,expires_at) VALUES($1,$2,'fixture',now()+interval '1 hour')",[sid,admin.id]);
  await pool.query("INSERT INTO lab_sso_sessions VALUES($1,'fixture:on_fixture_admin_123','fixture-invalid-grant')",[sid]);
  await writeFile(root+'/sso-frozen','rollback');
  const tx=await pool.connect();
  try{await tx.query('BEGIN');await tx.query("SELECT pg_advisory_xact_lock(hashtext('lab-sso-issuance'))");await tx.query('DELETE FROM sessions USING lab_sso_sessions WHERE sessions.id=lab_sso_sessions.session_id');await tx.query('COMMIT');}finally{tx.release();}
  await switchWithInflight(hosts.rollback);
  assert.equal((await api('/api/auth/me',{headers:{cookie:'lab_session='+sid}})).status,401);
  await assertExam();await assertAssets(allAssets);
  assert.equal((await send()).files[0].receivedBytes,cut2);
  await send('/files/'+file.id+'?offset='+cut2,'PUT',content.subarray(cut2));
  const completed=await send('/complete','POST','{}');
  assert.deepEqual(await send('/complete','POST','{}'),completed,'receipt retries remain idempotent after rollback');
  const done=await api('/api/enrollments/'+f.enrollment+'/finalize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({repositoryId:f.repo,materialsId:completed.receipt.id,confirmed:true})});assert.equal(done.status,200,await done.clone().text());
  assert.equal((await one('SELECT count(*)::int AS n FROM email_outbox WHERE sent_at IS NOT NULL')).n,0);
  await json('exercise-result.json',{forwardInflightSurvived:true,rollbackInflightSurvived:true,sessionPreserved:true,deadlineAndQuestionPreserved:true,oldAssets:Object.keys(oldAssets).length,rollbackAssets:Object.keys(allAssets).length,resumedUploadBytes:content.length,finalizedAfterRollback:true,ssoSessionRevoked:true,realMessagesSent:0});
  console.log(JSON.stringify({exercisePassed:true}));
 }else throw new Error('Unknown rehearsal mode');
}finally{await pool.end();}
