import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {loadCredentials,ENDPOINT,createRelay,decodeResponse,startBridge} from '../plugin/110lab/mcp/requirements-bridge.mjs';
const fictional={version:1,endpoint:ENDPOINT,openApiKey:'fictional-api-key',personalToken:'rmcp_v1.fictional-token'};
const request={jsonrpc:'2.0',id:1,method:'tools/list'};
const reply=(id=1,result={tools:[]})=>({jsonrpc:'2.0',id,result});
const jsonResponse=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});

test('private credentials reject symlinks, permissive modes, redirects and header injection without echoing secrets',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'110lab-mcp-')); const file=path.join(dir,'credentials.json');
 try {
  const write=value=>{fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});fs.chmodSync(file,0o600);};
  write(fictional);assert.deepEqual(loadCredentials(file),{endpoint:ENDPOINT,openApiKey:fictional.openApiKey,personalToken:fictional.personalToken});
  fs.chmodSync(file,0o644);assert.throws(()=>loadCredentials(file));fs.chmodSync(file,0o600);
  const link=path.join(dir,'symlink');fs.symlinkSync(file,link);assert.throws(()=>loadCredentials(link));
  for(const data of [{...fictional,endpoint:ENDPOINT+'?token=secret'},{...fictional,personalToken:'rmcp_v1.\nsecret'},{...fictional,version:2}]){
   write(data);assert.throws(()=>loadCredentials(file),error=>!error.message.includes('secret')&&!error.message.includes(file));
  }
  fs.writeFileSync(file,'x'.repeat(65537));assert.throws(()=>loadCredentials(file));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('JSON and SSE accept multiline events while rejecting malformed and contradictory replies',()=>{
 assert.deepEqual(decodeResponse(JSON.stringify(reply()),'application/json; charset=utf-8'),[reply()]);
 const sse=': heartbeat\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":1,"result":{"tools":[]}}\r\n\r\n';
 assert.deepEqual(decodeResponse(sse,'text/event-stream'),[reply()]);
 for(const data of [{jsonrpc:'2.0',id:1},{...reply(),error:{code:1,message:'oops'}},{jsonrpc:'2.0',id:2,error:{message:'oops'}},{jsonrpc:'2.0',id:1,method:'ping'}])assert.throws(()=>decodeResponse(JSON.stringify(data),'application/json'));
});

test('relay keeps negotiated protocol and session, handles notifications, blocks redirects and reuses personal credentials',async()=>{
 const calls=[];let loads=0;
 const relay=createRelay({readCredentials:()=>{loads++;return fictional;},fetchImpl:async(url,options)=>{
  calls.push({url,...options});const p=JSON.parse(options.body);
  return p.method==='initialize'?new Response(JSON.stringify(reply(p.id,{protocolVersion:'2025-11-25'})),{headers:{'content-type':'application/json','mcp-session-id':'fictional-session'}}):Object.hasOwn(p,'id')?jsonResponse(reply(p.id)):new Response(null,{status:202});
 }});
 await relay({...request,method:'initialize'});await relay({jsonrpc:'2.0',method:'notifications/initialized'});await relay(request);
 assert.equal(loads,1);assert.equal(calls[0].url,ENDPOINT);assert.equal(calls[0].redirect,'error');
 assert.equal(calls[0].headers.Authorization,'Bearer '+fictional.openApiKey);assert.equal(calls[0].headers['X-Requirement-Mcp-Token'],fictional.personalToken);
 assert.equal(calls[1].headers['MCP-Protocol-Version'],'2025-11-25');assert.equal(calls[2].headers['Mcp-Session-Id'],'fictional-session');
});

test('relay rejects unrelated IDs and notification replies, bounds responses and never reflects HTTP error bodies',async()=>{
 for(const response of [jsonResponse(reply(2)),jsonResponse([reply(),reply(2)]),jsonResponse({jsonrpc:'2.0',id:1})]){
  const relay=createRelay({readCredentials:()=>fictional,fetchImpl:async()=>response});await assert.rejects(relay(request));
 }
 const relay=createRelay({readCredentials:()=>fictional,fetchImpl:async()=>jsonResponse(reply())});await assert.rejects(relay({jsonrpc:'2.0',method:'notifications/initialized'}));
 for(const status of [401,403,500]){
  let calls=0;const failing=createRelay({readCredentials:()=>fictional,fetchImpl:async()=>{calls++;return new Response(fictional.openApiKey+fictional.personalToken,{status});}});
  await assert.rejects(failing(request),error=>!error.message.includes(fictional.openApiKey)&&!error.message.includes(fictional.personalToken));assert.equal(calls,1);
 }
 await assert.rejects(createRelay({readCredentials:()=>fictional,responseLimit:10,fetchImpl:async()=>jsonResponse(reply())})(request));
});

test('deadline includes a stalled response body and never retries a mutation',async()=>{
 let calls=0;
 const relay=createRelay({readCredentials:()=>fictional,timeoutMs:20,fetchImpl:async(_,options)=>{
  calls++;
  return new Response(new ReadableStream({start(controller){options.signal.addEventListener('abort',()=>controller.error(new Error(fictional.personalToken)),{once:true});}}),{headers:{'content-type':'application/json'}});
 }});
 await assert.rejects(relay({...request,method:'tools/call',params:{name:'fictional_write'}}),error=>!error.message.includes(fictional.personalToken));assert.equal(calls,1);
});

test('stdio framing handles split UTF-8, malformed input, EOF and notifications without nonprotocol stdout',async()=>{
 const input=new PassThrough();const output=new PassThrough();let text='';output.on('data',chunk=>text+=chunk);const calls=[];
 const done=startBridge({input,output,relay:async p=>{calls.push(p);return Object.hasOwn(p,'id')?[reply(p.id)]:[];}});
 const content=Buffer.from(JSON.stringify({...request,params:{text:'中文'}})+'\n');const at=content.indexOf(Buffer.from('中文'))+1;
 input.write(content.subarray(0,at));input.write(content.subarray(at));input.write('invalid\n');input.write('{"jsonrpc":"2.0","id":1e309,"method":"ping"}\n');input.end(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'}));await done;
 assert.equal(calls.length,2);assert.equal(calls[0].params.text,'中文');const messages=text.trim().split('\n').map(JSON.parse);assert.equal(messages.length,3);assert.ok(messages.some(m=>m.error?.code===-32700));assert.ok(messages.some(m=>m.error?.code===-32600));assert.ok(messages.every(m=>m.jsonrpc==='2.0'));
});

test('stdio bounds huge input and pending requests while recovering after rejection',async()=>{
 const input=new PassThrough();const output=new PassThrough();let text='';output.on('data',chunk=>text+=chunk);let release;
 const gate=new Promise(resolve=>release=resolve);let calls=0;
 const done=startBridge({input,output,relay:async p=>{calls++;await gate;return [reply(p.id)];}});
 input.write('x'.repeat(1024*1024+1)+'\n');
 for(let id=0;id<33;id++)input.write(JSON.stringify({...request,id})+'\n');input.end();release();await done;
 assert.equal(calls,32);const messages=text.trim().split('\n').map(JSON.parse);assert.ok(messages.some(m=>m.error?.message==='Request too large'));assert.ok(messages.some(m=>m.id===32&&m.error?.message==='Too many pending requests'));assert.equal(messages.filter(m=>m.result).length,32);
});
