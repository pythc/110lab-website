import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {request} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMailLoginClient,ISSUER,RESOURCE,portalFetch} from '../server/local-portal-client.mjs';
import {createLocalPortalBridge} from '../server/local-portal-bridge.mjs';
import {createHttpServer} from '../server/http.mjs';
import {fixtureConfig,fixtureIdentity} from './helpers/mail-fixtures.mjs';

const navigationURL=r=>{assert.equal(r.status,200);assert.equal(r.headers.location,undefined);assert.equal(r.headers['referrer-policy'],'no-referrer');assert.match(r.headers['content-security-policy'],/form-action 'none'/);return new URL(r.text.match(/<meta http-equiv="refresh" content="0;url=([^"]+)"/)[1].replaceAll('&amp;','&'));};
const jar=r=>(r.headers['set-cookie']||[]).map(v=>v.split(';')[0]).join('; ');
const requestId=r=>r.text.match(/name="request" value="([\w-]{43})"/)[1];
async function harness(){
  const directory=await mkdtemp(join(tmpdir(),'110lab-local-oauth-'));let time=Date.now();
  const server=await createHttpServer({mail:{enabled:true,directory,config:fixtureConfig,localTest:true,now:()=>time,fetchIdentity:async()=>fixtureIdentity}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const call=(path,{data,form,method=data||form?'POST':'GET',headers={}}={})=>new Promise((resolve,reject)=>{
    const body=form?new URLSearchParams(form).toString():data?JSON.stringify(data):undefined;
    const req=request({host:'127.0.0.1',port:server.address().port,path,method,headers:{Host:'internal.110-lab.cn',Origin:ISSUER,Accept:'application/json, text/event-stream',...(body?{'Content-Type':form?'application/x-www-form-urlencoded':'application/json'}:{}),...headers}},res=>{const chunks=[];res.on('data',v=>chunks.push(v));res.on('end',()=>{const text=Buffer.concat(chunks).toString();let value;try{value=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,text,value});});});req.on('error',reject);req.end(body);
  });
  const fetchImpl=async(input,init={})=>{
    const url=new URL(String(input));assert.equal(url.origin,ISSUER,'fixture cannot send requests to the real internet');
    const headers=Object.fromEntries(new Headers(init.headers)),body=init.body;
    const r=await call(url.pathname+url.search,{headers,method:init.method||'GET',...(body?headers['content-type']?.includes('application/json')?{data:JSON.parse(body)}:{form:Object.fromEntries(new URLSearchParams(body))}:{})});
    return new Response(r.status===204?null:r.text,{status:r.status,headers:Object.fromEntries(Object.entries(r.headers).map(([k,v])=>[k,Array.isArray(v)?v.join(', '):v]))});
  };
  const start=async()=>{const r=await call('/api/mail/embedded/auth/start',{data:{}});return {state:r.value.state,cookie:jar(r)};};
  const approve=async authorization=>{
    const u=new URL(authorization),page=await call(u.pathname+u.search),binding=jar(page);
    assert.equal(u.searchParams.get('resource'),RESOURCE);assert.equal(u.searchParams.get('code_challenge_method'),'S256');
    const launch=await call('/mail/oauth/login',{form:{request:requestId(page)},headers:{Cookie:binding}});
    const feishu=navigationURL(launch);assert.equal(feishu.origin,'https://accounts.feishu.cn');
    const identity=await call('/mail/auth/callback?'+new URLSearchParams({code:'fictional-code',state:feishu.searchParams.get('state')}),{headers:{Cookie:binding+'; '+jar(launch)}});
    assert.match(identity.text,/确认连接/);assert.equal(identity.headers['set-cookie'],undefined);
    const approval=await call('/mail/oauth/approve',{form:{request:requestId(identity)},headers:{Cookie:binding}});assert.equal(approval.status,200);
    return navigationURL(approval);
  };
  return {call,fetchImpl,start,approve,advance(ms){time+=ms;},async close(){await new Promise(r=>{server.close(r);server.closeAllConnections();});await rm(directory,{recursive:true,force:true});}};
}

test('local client opens standard OAuth and uses a validated loopback callback to log into its iframe',async()=>{
  const h=await harness(),mail=createMailLoginClient({fetchImpl:h.fetchImpl});
  try{
    const flow=await h.start(),start=await mail.start({state:flow.state});
    const url=start._meta.mailAuthorization.url;assert.doesNotMatch(JSON.stringify(start.content),/authorize|127\.0\.0\.1/);
    assert.equal((await mail.finish({state:flow.state}))._meta.mailAuthorizationPending.state,flow.state);assert.equal((await mail.finish({state:'z'.repeat(43)})).isError,true);
    assert.equal((await mail.start({state:'z'.repeat(43)})).isError,true);
    const callback=await h.approve(url),wrongState=new URL(callback);wrongState.searchParams.set('state','wrong');
    assert.equal((await fetch(wrongState)).status,400);
    const wrongIssuer=new URL(callback);wrongIssuer.searchParams.set('iss','https://evil.example');assert.equal((await fetch(wrongIssuer)).status,400);
    const duplicateState=new URL(callback);duplicateState.searchParams.append('state',callback.searchParams.get('state'));assert.equal((await fetch(duplicateState)).status,400);
    const wrongHost=await new Promise((resolve,reject)=>{const req=request(callback,{headers:{Host:'localhost:'+callback.port}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});assert.equal(wrongHost,404);
    assert.equal((await fetch(callback)).status,200);
    const result=await mail.finish({state:flow.state});assert.equal(result.isError,undefined);const ticket=result._meta.mailHandoff.ticket;
    assert.doesNotMatch(JSON.stringify(result.content),new RegExp(ticket));
    assert.equal((await h.call('/api/mail/embedded/auth/redeem',{data:{state:flow.state,ticket}})).status,401);
    const redeemed=await h.call('/api/mail/embedded/auth/redeem',{data:{state:flow.state,ticket},headers:{Cookie:flow.cookie}});assert.equal(redeemed.status,200);
    assert.equal((await h.call('/api/mail/embedded/session',{headers:{Cookie:jar(redeemed)}})).value.role,'super_admin');
    const second=await h.start(),again=await mail.start({state:second.state});assert.ok(again._meta.mailHandoff.ticket);assert.equal(again._meta.mailAuthorization,undefined);
    h.advance(300001);const fresh=await h.start(),reauth=await mail.start({state:fresh.state,fresh:true});assert.ok(reauth._meta.mailAuthorization);
    // RFC 8252 permits a new loopback port with the same registered client.
    assert.equal(new URL(reauth._meta.mailAuthorization.url).searchParams.get('client_id'),new URL(url).searchParams.get('client_id'));
    const freshCallback=await h.approve(reauth._meta.mailAuthorization.url);assert.equal((await fetch(freshCallback)).status,200);assert.ok((await mail.finish({state:fresh.state}))._meta.mailHandoff.ticket);
  }finally{await mail.close();await h.close();}
});

test('cancelled and expired local authorizations do not hang or prevent retry',async()=>{
  const h=await harness(),mail=createMailLoginClient({fetchImpl:h.fetchImpl,timeoutMs:1500});
  try{
    const first=await h.start();assert.ok((await mail.start({state:first.state}))._meta.mailAuthorization);
    assert.ok((await mail.finish({state:first.state}))._meta.mailAuthorizationPending);await mail.finish({state:first.state,cancel:true});assert.equal((await mail.finish({state:first.state})).isError,true);
    const second=await h.start();assert.ok((await mail.start({state:second.state}))._meta.mailAuthorization);await new Promise(r=>setTimeout(r,1501));assert.equal((await mail.finish({state:second.state})).isError,true);
    const third=await h.start();assert.ok((await mail.start({state:third.state}))._meta.mailAuthorization);await mail.finish({state:third.state,cancel:true});
    await assert.rejects(portalFetch('https://evil.example/token'),/Unexpected OAuth destination/);
    await assert.rejects(portalFetch(ISSUER+'/other'),/Unexpected OAuth destination/);
  }finally{await mail.close();await h.close();}
});

test('local MCP proxy retains workbench metadata and exposes the login bridge only to apps',async()=>{
  const h=await harness(),bridge=createLocalPortalBridge({fetchImpl:h.fetchImpl}),client=new Client({name:'fixture-plugin-host',version:'1'});
  const [host,server]=InMemoryTransport.createLinkedPair();await bridge.server.connect(server);await client.connect(host);
  try{
    const tools=await client.listTools();assert.equal(tools.tools.length,4);
    for(const name of ['connect_110lab_mail','complete_110lab_mail_login']){const tool=tools.tools.find(t=>t.name===name);assert.deepEqual(tool._meta.ui.visibility,['app']);assert.deepEqual(tool._meta.securitySchemes,[{type:'noauth'}]);}
    const opener=tools.tools.find(t=>t.name==='open_110lab');assert.equal(opener._meta['openai/ui'].entrypoints[0].type,'global');assert.ok(opener.icons[0].src.startsWith('data:image/png'));
    const resource=await client.readResource({uri:opener._meta.ui.resourceUri});assert.equal(resource.contents[0]._meta.ui.domain,ISSUER);assert.match(resource.contents[0].text,/110lab/);
    assert.equal((await client.callTool({name:'open_110lab',arguments:{}})).structuredContent.appCount,7);
    const flow=await h.start(),started=await client.callTool({name:'connect_110lab_mail',arguments:{state:flow.state}});
    assert.ok((await client.callTool({name:'complete_110lab_mail_login',arguments:{state:flow.state}}))._meta.mailAuthorizationPending);
    const callback=await h.approve(started._meta.mailAuthorization.url);assert.equal((await fetch(callback)).status,200);
    assert.equal((await client.callTool({name:'complete_110lab_mail_login',arguments:{state:flow.state}}))._meta.mailHandoff.state,flow.state);
  }finally{await client.close();await bridge.close();await h.close();}
});

test('packaged local bridge initializes without node_modules or private configuration',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'110lab-bridge-bundle-')),file=join(directory,'bridge.mjs');
  await copyFile(new URL('../plugin/110lab/mcp/portal-bridge.mjs',import.meta.url),file);
  const client=new Client({name:'bundle-fixture',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[file],cwd:directory,stderr:'pipe'});
  let stderr='';transport.stderr?.on('data',chunk=>{stderr+=chunk;});
  try{await client.connect(transport);assert.equal(client.getServerVersion().name,'110lab');assert.ok(client.getServerCapabilities().tools);}
  catch(e){throw new Error(stderr.slice(-4000)||e.message);}
  finally{await client.close();await rm(directory,{recursive:true,force:true});}
});

test('a second login cannot replace the client while its authenticated handoff is in flight',async()=>{
  const h=await harness();let block=false,release,arrived;
  const gate=new Promise(r=>{release=r;}),received=new Promise(r=>{arrived=r;});
  const mail=createMailLoginClient({fetchImpl:async(input,init)=>{if(block&&new URL(String(input)).pathname==='/mcp/workbench-v6-1'&&new Headers(init?.headers).has('authorization')&&init?.body?.includes('connect_110lab_mail')){arrived();await gate;}return h.fetchImpl(input,init);}});
  try{
    const flow=await h.start(),started=await mail.start({state:flow.state}),callback=await h.approve(started._meta.mailAuthorization.url);assert.equal((await fetch(callback)).status,200);
    block=true;const completing=mail.finish({state:flow.state});await received;
    assert.equal((await mail.start({state:'z'.repeat(43)})).isError,true);release();assert.equal((await completing)._meta.mailHandoff.state,flow.state);
  }finally{release();await mail.close();await h.close();}
});
