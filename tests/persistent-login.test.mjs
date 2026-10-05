import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {handleMailExternalRequest} from '../src/embedded-workspace.js';
const source=(await readFile(new URL('../src/persistent-login.js',import.meta.url),'utf8')).replace('export function','function');
const state='s'.repeat(43),ticket='t'.repeat(43);
function fixture({embedded=true,loggedIn=false,policy=1,enabled=true,ticketValue=ticket}={}){
  const requests=[],messages=[],listeners=new Set();
  const parent={postMessage(message){messages.push(message);queueMicrotask(()=>{
    for(const listener of listeners){listener({source:{},data:{type:'110lab-mail-host-result',state,ticket}});listener({source:parent,data:{type:'110lab-mail-host-result',state:'x'.repeat(43),ticket}});listener({source:parent,data:{type:'110lab-mail-host-result',state,ticket:ticketValue}});}
  });}};
  const window={parent,addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn)};
  const restore=runInNewContext(source+';restoreLabSession',{window,location:{pathname:embedded?'/honors/embedded':'/honors'},AbortSignal,setTimeout,clearTimeout,
    fetch:async(path,options)=>{requests.push({path,options});const route=path.split('/').at(-1);const status=route==='session'&&!loggedIn?401:200;return {ok:status===200,status,json:async()=>route==='config'?{loginAvailable:enabled,restorePolicy:policy}:route==='start'?{state}:{} };}
  });
  return {restore,requests,messages,listeners};
}
test('embedded pages silently restore once, accepting only their parent and flow',async()=>{
  const f=fixture();assert.equal(await f.restore(),true);assert.equal(await f.restore(),true);
  assert.equal(f.messages.length,1);assert.equal(f.messages[0].silent,true);assert.equal(f.messages[0].fresh,false);
  const redeem=f.requests.find(x=>x.path.endsWith('redeem'));assert.deepEqual(JSON.parse(redeem.options.body),{state,ticket});
  assert.equal(f.listeners.size,0);
});
test('normal pages, existing cookies, rollback server and absent grants never launch interactive login',async()=>{
  for(const options of [{embedded:false},{loggedIn:true},{policy:null},{enabled:false},{ticketValue:null}]){
    const f=fixture(options);await f.restore();
    assert.equal(f.requests.filter(x=>x.path.endsWith('redeem')).length,0);assert.equal(f.listeners.size,0);
    if(options.ticketValue!==null)assert.equal(f.messages.length,0);
  }
});
test('silent requests do not open OAuth even with an older bridge returning an authorization URL',async()=>{
  const calls=[],replies=[],source={postMessage:m=>replies.push(m)};let opened=0;
  await handleMailExternalRequest({origin:'https://internal.110-lab.cn',source,data:{type:'110lab-mail-host-login',state,fresh:false,silent:true}},{frame:{contentWindow:source},openExternal:async()=>{opened++;},callTool:async args=>{calls.push(args);return {_meta:{mailAuthorization:{state,url:'https://internal.110-lab.cn/authorize'}}};}});
  assert.equal(opened,0);assert.equal(calls[0].arguments.silent,true);assert.equal(calls[1].arguments.cancel,true);assert.equal(replies[0].ticket,undefined);
});
