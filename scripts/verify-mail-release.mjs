// Validate the standalone release with fictional identities and no provider calls.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {request} from 'node:http';
import {createHash} from 'node:crypto';
const root=mkdtempSync(join(tmpdir(),'110lab-mail-release-'));
let server;
const owner={subject:'fixture_tenant:on_fixture_owner_2026',email:'owner.fixture@110-lab.cn',name:'虚构负责人'},member={subject:'fixture_tenant:on_fixture_member_2026',email:'member.fixture@110-lab.cn',name:'虚构成员'};
try{
  const manifest=JSON.parse(readFileSync('release.json'));
  for(const path of Object.keys(manifest.files)){mkdirSync(dirname(join(root,path)),{recursive:true});copyFileSync(path,join(root,path));}
  const {createHttpServer}=await import(pathToFileURL(join(root,'server/runtime.mjs')));
  server=await createHttpServer({mail:{enabled:true,directory:join(root,'private'),localTest:true,config:{appId:'cli_fixture12345',appSecret:'fictional-app-secret-2026',tenantKey:'fixture_tenant',bootstrapUnionId:'on_fixture_owner_2026',bootstrapEmail:owner.email,bootstrapName:owner.name},fetchIdentity:async(_,{code})=>code==='member'?member:owner}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const call=(path,data,headers={})=>new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:server.address().port,path,method:data===undefined?'GET':'POST',headers:{Host:'internal.110-lab.cn',...(data===undefined?{}:{Origin:'https://internal.110-lab.cn','Content-Type':typeof data==='string'?'application/x-www-form-urlencoded':'application/json'}),...headers}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const text=Buffer.concat(chunks).toString();let body;try{body=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,text,body});});});req.on('error',reject);req.end(data===undefined?undefined:typeof data==='string'?data:JSON.stringify(data));});
  assert.equal((await call('/healthz')).body.version,manifest.version);
  const cookie=r=>r.headers['set-cookie'][0].split(';')[0];
  async function login(code){const start=await call('/api/mail/auth/start',{});assert.equal(start.status,200);const launch=await call('/mail/auth/launch?state='+start.body.state);assert.equal(launch.status,303);const done=await call('/mail/auth/callback?state='+start.body.state+'&code='+code,undefined,{Cookie:cookie(launch)});assert.equal(done.status,200);const session=await call('/api/mail/session',undefined,{Cookie:cookie(done)});assert.equal(session.status,200);return {Cookie:cookie(done),'X-CSRF-Token':session.body.csrf};}
  const a=await login('owner'),b=await login('member');
  assert.equal((await call('/mail/embedded')).status,200);
  const list=await call('/api/mail/administrators',undefined,a);
  assert.equal((await call('/api/mail/administrators/grant',{email:member.email,revision:list.body.revision,confirmed:true},a)).status,200);
  const updated=await call('/api/mail/administrators',undefined,a);
  assert.equal((await call('/api/mail/administrators/transfer',{email:member.email,revision:updated.body.revision,confirmed:true},a)).status,200);
  assert.equal((await call('/api/mail/administrators',undefined,a)).status,403);
  assert.equal((await call('/api/mail/session',undefined,b)).body.role,'super_admin');
  assert.equal((await call('/mail',undefined,{Host:'110-lab.cn'})).status,404);
  assert.equal((await call('/api/mail/send',{},b)).status,404);
  const issuer='https://internal.110-lab.cn',resource=issuer+'/mcp/workbench-v6-1',verifier='v'.repeat(43),redirect='http://127.0.0.1:49111/callback/fixture_client';
  const form=v=>new URLSearchParams(v).toString(),requestId=r=>r.text.match(/name="request" value="([\w-]{43})"/)[1];
  const registered=await call('/register',{redirect_uris:['http://127.0.0.1/callback/fixture_client'],token_endpoint_auth_method:'none'});assert.equal(registered.status,201);
  const authorization=await call('/authorize?'+form({client_id:registered.body.client_id,redirect_uri:redirect,response_type:'code',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',resource,scope:'mail:session',state:'fictional_host_state'}));assert.equal(authorization.status,200);
  const bind=cookie(authorization),launched=await call('/mail/oauth/login',form({request:requestId(authorization)}),{Cookie:bind});assert.equal(launched.status,303);
  const feishu=new URL(launched.headers.location),verified=await call('/mail/auth/callback?'+form({state:feishu.searchParams.get('state'),code:'member'}),undefined,{Cookie:bind+'; '+cookie(launched)});assert.equal(verified.status,200);
  const approval=await call('/mail/oauth/approve',form({request:requestId(verified)}),{Cookie:bind});assert.equal(approval.status,303);const returned=new URL(approval.headers.location);assert.equal(returned.searchParams.get('iss'),issuer);
  const tokens=await call('/token',form({client_id:registered.body.client_id,grant_type:'authorization_code',code:returned.searchParams.get('code'),redirect_uri:redirect,resource,code_verifier:verifier}));assert.equal(tokens.status,200);
  const started=await call('/api/mail/embedded/auth/start',{}),handoff=await call('/mcp/workbench-v6-1',{jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'connect_110lab_mail',arguments:{state:started.body.state}}},{Authorization:'Bearer '+tokens.body.access_token,Accept:'application/json, text/event-stream'});assert.equal(handoff.status,200);
  const embedded=await call('/api/mail/embedded/auth/redeem',{state:started.body.state,ticket:handoff.body.result._meta.mailHandoff.ticket},{Cookie:cookie(started)});assert.equal(embedded.status,200);
  assert.equal((await call('/api/mail/embedded/session',undefined,{Cookie:cookie(embedded)})).body.role,'super_admin');
  console.log(JSON.stringify({isolatedHostOAuthToIframe:true,isolatedMailBundle:true,fictionalLogin:true,roleTransfer:true,oldSessionDenied:true,publicHostDenied:true,manualSendingClosed:true,externalCalls:false}));
}finally{if(server)await new Promise(r=>{server.close(r);server.closeAllConnections();});rmSync(root,{recursive:true,force:true});}
