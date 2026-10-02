import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {UnauthorizedError} from '@modelcontextprotocol/sdk/client/auth.js';
import {createHttpServer} from '../server/http.mjs';
import {fixtureConfig,fixtureIdentity} from './helpers/mail-fixtures.mjs';
import {MAIL_RESOURCE,MAIL_ISSUER,allowedMailRedirect} from '../server/mail-oauth.mjs';

const cookies=r=>(r.headers['set-cookie']||[]).map(v=>v.split(';')[0]).join('; ');
const requestId=r=>r.text.match(/name="request" value="([\w-]{43})"/)[1];
const verifier='v'.repeat(43),challenge=createHash('sha256').update(verifier).digest('base64url');
async function harness(){
  const directory=await mkdtemp(join(tmpdir(),'110lab-host-oauth-'));let time=Date.now(),server;
  const options={mail:{enabled:true,directory,config:fixtureConfig,localTest:true,now:()=>time,fetchIdentity:async()=>fixtureIdentity}};
  const start=async()=>{server=await createHttpServer(options);await new Promise(r=>server.listen(0,'127.0.0.1',r));};await start();
  const stop=()=>new Promise(r=>{server.close(r);server.closeAllConnections();});
  const call=(path,{data,form,headers={},method=data||form?'POST':'GET'}={})=>new Promise((resolve,reject)=>{
    const body=form?new URLSearchParams(form).toString():data?JSON.stringify(data):undefined;
    const req=request({host:'127.0.0.1',port:server.address().port,path,method,headers:{Host:'internal.110-lab.cn',Accept:'application/json, text/event-stream',Origin:MAIL_ISSUER,...(body?{'Content-Type':form?'application/x-www-form-urlencoded':'application/json'}:{}),...headers}},res=>{const parts=[];res.on('data',c=>parts.push(c));res.on('end',()=>{const text=Buffer.concat(parts).toString();let body;try{body=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,text,body});});});req.on('error',reject);req.end(body);
  });
  return {call,advance(ms){time+=ms;},async restart(){await stop();await start();},async close(){await stop();await rm(directory,{recursive:true,force:true});}};
}
async function grant(h){
  const registered=await h.call('/register',{data:{redirect_uris:['http://127.0.0.1/callback/fixture_client'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']}});
  assert.equal(registered.status,201);const client=registered.body.client_id,redirect='http://127.0.0.1:49111/callback/fixture_client';
  const query=new URLSearchParams({client_id:client,redirect_uri:redirect,response_type:'code',code_challenge:challenge,code_challenge_method:'S256',resource:MAIL_RESOURCE,scope:'mail:session',state:'fictional_host_state'});
  const authorization=await h.call('/authorize?'+query);assert.equal(authorization.status,200);const bind=cookies(authorization);
  assert.equal(authorization.headers['referrer-policy'],'strict-origin');
  assert.equal((await h.call('/mail/oauth/login',{form:{request:requestId(authorization)},headers:{Cookie:bind,Origin:'null'}})).status,400,'opaque origins must remain rejected');
  const start=await h.call('/mail/oauth/login',{form:{request:requestId(authorization)},headers:{Cookie:bind}});assert.equal(start.status,303);
  assert.equal((await h.call('/mail/oauth/login',{form:{request:requestId(authorization)},headers:{Cookie:bind}})).status,400);
  const feishu=new URL(start.headers.location);assert.equal(feishu.origin,'https://accounts.feishu.cn');assert.equal(feishu.searchParams.get('redirect_uri'),MAIL_ISSUER+'/mail/auth/callback');
  const callback=await h.call('/mail/auth/callback?'+new URLSearchParams({state:feishu.searchParams.get('state'),code:'fictional-code'}),{headers:{Cookie:bind+'; '+cookies(start)}});
  assert.equal(callback.status,200);assert.equal(callback.headers['referrer-policy'],'strict-origin');assert.match(callback.text,/确认连接/);assert.doesNotMatch(callback.text,/<code>|一次性登录码/);
  assert.equal(callback.headers['set-cookie'],undefined,'host consent must not also sign the browser into the mailbox');
  const approval=await h.call('/mail/oauth/approve',{form:{request:requestId(callback)},headers:{Cookie:bind}});assert.equal(approval.status,303);
  const returned=new URL(approval.headers.location);assert.equal(returned.origin,'http://127.0.0.1:49111');assert.equal(returned.searchParams.get('state'),'fictional_host_state');assert.equal(returned.searchParams.get('iss'),MAIL_ISSUER);
  assert.equal((await h.call('/mail/oauth/approve',{form:{request:requestId(callback)},headers:{Cookie:bind}})).status,400);
  return {client_id:client,code:returned.searchParams.get('code'),redirect_uri:redirect,resource:MAIL_RESOURCE,grant_type:'authorization_code',code_verifier:verifier};
}
test('host OAuth completes Feishu -> PKCE -> MCP -> cookie-bound iframe without manual code',async()=>{
  const h=await harness();try{
    const metadata=await h.call('/.well-known/oauth-authorization-server');assert.equal(metadata.body.authorization_response_iss_parameter_supported,true);assert.deepEqual(metadata.body.code_challenge_methods_supported,['S256']);
    assert.equal((await h.call('/.well-known/oauth-protected-resource/mcp/workbench-v6-1')).body.resource,MAIL_RESOURCE);
    const tokenForm=await grant(h);
    for(const patch of [{code_verifier:'x'.repeat(43)},{redirect_uri:'http://127.0.0.1:49112/callback/fixture_client'},{resource:'https://other.example/mcp'},{client_id:'unknown-client'}])assert.equal((await h.call('/token',{form:{...tokenForm,...patch}})).status,400);
    const token=await h.call('/token',{form:tokenForm});assert.equal(token.status,200);assert.equal((await h.call('/token',{form:tokenForm})).status,400);
    const bearer=token.body.access_token;
    const login=async()=>{const started=await h.call('/api/mail/embedded/auth/start',{data:{}});return {state:started.body.state,jar:cookies(started)};};
    const connect=(state,header=bearer,fresh=false)=>h.call('/mcp/workbench-v6-1',{data:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'connect_110lab_mail',arguments:{state,fresh}}},headers:{Authorization:'Bearer '+header}});
    const flow=await login();const denied=await connect(flow.state,'x'.repeat(43));assert.equal(denied.status,401);assert.match(denied.headers['www-authenticate'],/resource_metadata=/);assert.equal(denied.body.result.isError,true);assert.ok(denied.body.result._meta['mcp/www_authenticate']);
    const handoff=await connect(flow.state);assert.equal(handoff.status,200);const ticket=handoff.body.result._meta.mailHandoff.ticket;assert.doesNotMatch(JSON.stringify(handoff.body.result.content),new RegExp(ticket));
    assert.equal((await h.call('/api/mail/embedded/auth/redeem',{data:{state:flow.state,ticket}})).status,401);
    const redeemed=await h.call('/api/mail/embedded/auth/redeem',{data:{state:flow.state,ticket},headers:{Cookie:flow.jar}});assert.equal(redeemed.status,200);assert.match(redeemed.headers['set-cookie'][0],/HttpOnly; SameSite=None.*Secure; Partitioned/);
    assert.equal((await h.call('/api/mail/embedded/auth/redeem',{data:{state:flow.state,ticket},headers:{Cookie:flow.jar}})).status,401);
    const session=await h.call('/api/mail/embedded/session',{headers:{Cookie:cookies(redeemed)}});assert.equal(session.body.role,'super_admin');
    assert.equal((await h.call('/api/mail/session',{headers:{Cookie:cookies(redeemed)}})).status,401);
    await h.restart();assert.equal((await h.call('/api/mail/embedded/session',{headers:{Cookie:cookies(redeemed)}})).status,200);
    h.advance(300001);const aged=await login(),agedResult=await connect(aged.state);const agedCookie=await h.call('/api/mail/embedded/auth/redeem',{data:{state:aged.state,ticket:agedResult.body.result._meta.mailHandoff.ticket},headers:{Cookie:aged.jar}});
    const me=await h.call('/api/mail/embedded/session',{headers:{Cookie:cookies(agedCookie)}});
    const mutation=await h.call('/api/mail/embedded/administrators/grant',{data:{email:'nobody@110-lab.cn',revision:1,confirmed:true},headers:{Cookie:cookies(agedCookie),'X-CSRF-Token':me.body.csrf}});assert.equal(mutation.status,403);assert.match(mutation.body.error,/重新通过飞书/);
    const fresh=await login();assert.ok((await connect(fresh.state,bearer,true)).body.result._meta['mcp/www_authenticate']);
    assert.equal((await h.call('/token',{form:{client_id:tokenForm.client_id,grant_type:'refresh_token',refresh_token:token.body.refresh_token,resource:MAIL_RESOURCE}})).status,400);
  }finally{await h.close();}
});
test('OAuth rejects redirects and cross-browser consent and rotates/revokes refresh families',async()=>{
  for(const url of ['https://evil.example/callback','http://127.0.0.1.evil.example/callback','https://chatgpt.com.evil.example/connector_platform_oauth_redirect','http://127.0.0.1/callback?next=evil','http://evil@127.0.0.1/callback','javascript:alert(1)'])assert.equal(allowedMailRedirect(url),false);
  const h=await harness();try{
    assert.equal((await h.call('/register',{data:{redirect_uris:['https://evil.example/callback'],token_endpoint_auth_method:'none'}})).status,400);
    assert.equal((await h.call('/register',{data:{redirect_uris:['http://127.0.0.1/callback'],token_endpoint_auth_method:'none'},headers:{Host:'110-lab.cn'}})).status,404);
    assert.equal((await h.call('/mail/oauth/login',{form:{request:'a'.repeat(43)}})).status,400);
    assert.equal((await h.call('/mail/oauth/approve',{form:{request:'a'.repeat(43)},headers:{Origin:'https://evil.example'}})).status,400);
    const form=await grant(h),tokens=(await h.call('/token',{form})).body;
    const refresh={client_id:form.client_id,grant_type:'refresh_token',refresh_token:tokens.refresh_token,resource:MAIL_RESOURCE};
    const next=await h.call('/token',{form:refresh});assert.equal(next.status,200);assert.notEqual(next.body.refresh_token,tokens.refresh_token);
    assert.equal((await h.call('/token',{form:refresh})).status,400);
    assert.equal((await h.call('/token',{form:{...refresh,refresh_token:next.body.refresh_token}})).status,400);
  }finally{await h.close();}
});

test('an MCP HTTP client discovers OAuth after a protected call and retries with its token',async()=>{
  const h=await harness(),client=new Client({name:'fictional-oauth-client',version:'1'});
  let information,tokens,pkce,authorization;
  const paths=[],redirect='http://127.0.0.1:49112/callback/fictional_client';
  const provider={redirectUrl:redirect,clientMetadata:{redirect_uris:[redirect],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']},state:()=> 'fictional_client_state',clientInformation:()=>information,saveClientInformation:v=>{information=v;},tokens:()=>tokens,saveTokens:v=>{tokens=v;},saveCodeVerifier:v=>{pkce=v;},codeVerifier:()=>pkce,redirectToAuthorization:u=>{authorization=u;}};
  const localFetch=async(input,init={})=>{
    const url=new URL(input instanceof Request?input.url:String(input));assert.equal(url.origin,MAIL_ISSUER,'no live OAuth or external requests in this test');paths.push(url.pathname);
    const headers=Object.fromEntries(new Headers(init.headers)),body=init.body;
    const response=await h.call(url.pathname+url.search,{method:init.method||'GET',headers,...(body?headers['content-type']?.includes('application/json')?{data:JSON.parse(body)}:{form:Object.fromEntries(new URLSearchParams(body))}:{})});
    return new Response(response.status===204?null:response.text,{status:response.status,headers:Object.fromEntries(Object.entries(response.headers).map(([k,v])=>[k,Array.isArray(v)?v.join(', '):v]))});
  };
  const transport=new StreamableHTTPClientTransport(new URL(MAIL_RESOURCE),{authProvider:provider,fetch:localFetch});
  try{
    await client.connect(transport);await client.callTool({name:'open_110lab',arguments:{}});assert.equal(authorization,undefined);
    const started=await h.call('/api/mail/embedded/auth/start',{data:{}}),state=started.body.state;
    await assert.rejects(client.callTool({name:'connect_110lab_mail',arguments:{state}}),UnauthorizedError);
    assert.ok(information);assert.ok(authorization);assert.ok(paths.includes('/.well-known/oauth-protected-resource/mcp/workbench-v6-1'));assert.ok(paths.includes('/register'));assert.equal(authorization.searchParams.get('resource'),MAIL_RESOURCE);
    const page=await h.call(authorization.pathname+authorization.search),bind=cookies(page);
    const launch=await h.call('/mail/oauth/login',{form:{request:requestId(page)},headers:{Cookie:bind}});
    const feishu=new URL(launch.headers.location);
    const callback=await h.call('/mail/auth/callback?'+new URLSearchParams({state:feishu.searchParams.get('state'),code:'fictional-code'}),{headers:{Cookie:bind+'; '+cookies(launch)}});
    const approved=await h.call('/mail/oauth/approve',{form:{request:requestId(callback)},headers:{Cookie:bind}});
    const destination=new URL(approved.headers.location);assert.equal(destination.searchParams.get('state'),'fictional_client_state');assert.equal(destination.searchParams.get('iss'),MAIL_ISSUER);
    await transport.finishAuth(destination.searchParams.get('code'));
    const result=await client.callTool({name:'connect_110lab_mail',arguments:{state}});assert.equal(result.isError,undefined);
    assert.equal((await h.call('/api/mail/embedded/auth/redeem',{data:{state,ticket:result._meta.mailHandoff.ticket},headers:{Cookie:cookies(started)}})).status,200);
    // Invalid tokens must challenge without making anonymous tools unusable.
    tokens={...tokens,access_token:'x'.repeat(43)};
    assert.equal((await client.callTool({name:'open_110lab',arguments:{}})).isError,undefined);
  }finally{await client.close();await h.close();}
});
