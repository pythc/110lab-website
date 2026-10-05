import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {handleMailExternalRequest} from '../src/embedded-workspace.js';
const state='x'.repeat(43),url='https://internal.110-lab.cn/mail/auth/launch?state='+state;

test('mail host bridge only opens exact destinations from its owned iframe',async()=>{
  const replies=[],opened=[],source={postMessage:(...args)=>replies.push(args)},frame={contentWindow:source};
  const options={frame,openExternal:async u=>{opened.push(u);return {isError:false};}};
  const event={origin:'https://internal.110-lab.cn',source,data:{type:'110lab-mail-open-login',state,url}};
  for(const invalid of [{...event,origin:'https://other.example'},{...event,source:{}},{...event,data:{...event.data,url:url+'&next=https://other.example'}},{...event,data:{...event.data,url:'https://www.feishu.cn/mail'}},{...event,data:{...event.data,state:'short'}}])assert.equal(await handleMailExternalRequest(invalid,options),false);
  assert.equal(opened.length,0);
  assert.equal(await handleMailExternalRequest(event,options),true);
  assert.deepEqual(opened,[url]);assert.equal(replies[0][0].opened,true);assert.equal(replies[0][1],event.origin);
  await handleMailExternalRequest(event,{frame,openExternal:async()=>({isError:true})});assert.equal(replies[1][0].opened,false);
  const mail={...event,data:{type:'110lab-mail-open-mailbox',url:'https://www.feishu.cn/mail'}};
  await handleMailExternalRequest(mail,options);assert.equal(opened[1],mail.data.url);
  await handleMailExternalRequest(mail,{frame,openExternal:async()=>{throw new Error('blocked');}});assert.equal(replies.at(-1)[0].opened,false);
});

async function ui(embedded,{failStart=false}={}){
  const elements=new Map(),sent=[],navigated=[],requests=[],listeners={};let authenticated=false;
  const el=id=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,value:'',textContent:'',open:false,replaceChildren(){},addEventListener(){}});return elements.get(id);};
  const parent={postMessage:m=>sent.push(m)};
  const window={parent,addEventListener:(name,fn)=>listeners[name]=fn,open(){throw new Error('must never open a blank popup');}};
  const location={pathname:embedded?'/mail/embedded':'/mail',assign:u=>navigated.push(u)};
  const fetch=async(path)=>{requests.push(path);if(path.endsWith('config'))return {ok:true,json:async()=>({loginAvailable:true})};if(path.endsWith('auth/redeem')){authenticated=true;return {ok:true,json:async()=>({loggedIn:true})};}if(path.endsWith('session'))return authenticated?{ok:true,json:async()=>({name:'虚构成员',role:'member',csrf:state})}:{ok:false,status:401,json:async()=>({error:'unauthenticated'})};return failStart?{ok:false,status:429,json:async()=>({error:'请稍后再试'})}:{ok:true,json:async()=>({state,launchUrl:url})};};
  const source=(await readFile(new URL('../src/mail.js',import.meta.url),'utf8')).replace(/^import .*persistent-login.*\n/m,'');
  await runInNewContext('(async()=>{'+source+'})()',{restoreLabSession:async()=>false,window,location,document:{getElementById:el,querySelectorAll:()=>[]},fetch,AbortSignal,setTimeout(){return 1;},clearTimeout(){},setInterval(){},Option:function(){}});
  await el('login').onclick();return {el,sent,navigated,requests,async receive(data,source=parent){listeners.message({source,data});await new Promise(r=>setImmediate(r));}};
}
test('embedded login automatically redeems only the host result for its current flow',async()=>{
  const h=await ui(true);assert.equal(h.navigated.length,0);assert.deepEqual(JSON.parse(JSON.stringify(h.sent)),[{type:'110lab-mail-host-login',state,fresh:false}]);
  assert.equal(h.el('handoff').hidden,true);assert.equal(h.el('manual-login').open,false);assert.equal(h.el('login').disabled,true);
  const result={type:'110lab-mail-host-result',state,ticket:'t'.repeat(43)};
  await h.receive(result,{});await h.receive({...result,state:'y'.repeat(43)});assert.equal(h.requests.some(p=>p.endsWith('redeem')),false);
  await h.receive(result);assert.equal(h.el('identity').textContent,'虚构成员 · 普通成员');assert.equal(h.el('login').hidden,true);assert.equal(h.el('logout').hidden,false);
  h.el('open-mailbox').onclick({preventDefault(){}});assert.equal(h.sent.at(-1).url,'https://www.feishu.cn/mail');
});
test('host login bridge uses an app-only OAuth tool and never exposes a ticket to other frames',async()=>{
  const replies=[],calls=[],source={postMessage:(...args)=>replies.push(args)},frame={contentWindow:source};
  const event={origin:'https://internal.110-lab.cn',source,data:{type:'110lab-mail-host-login',state,fresh:false}};
  const options={frame,callTool:async args=>{calls.push(args);return {_meta:{mailHandoff:{state,ticket:'t'.repeat(43)}}};}};
  assert.equal(await handleMailExternalRequest({...event,origin:'https://evil.example'},options),false);
  assert.equal(await handleMailExternalRequest({...event,source:{}},options),false);assert.equal(calls.length,0);
  await handleMailExternalRequest(event,options);assert.deepEqual(calls,[{name:'connect_110lab_mail',arguments:{state,fresh:false}}]);assert.equal(replies[0][0].ticket,'t'.repeat(43));assert.equal(replies[0][1],event.origin);
  await handleMailExternalRequest(event,{frame,callTool:async()=>({_meta:{'mcp/www_authenticate':['Bearer']},isError:true})});assert.equal(replies.at(-1)[0].updateRequired,true);assert.equal(replies.at(-1)[0].ticket,undefined);
});
test('regular browser login navigates in the current tab; failed start restores the button',async()=>{
  const regular=await ui(false);assert.deepEqual(regular.navigated,[url]);assert.equal(regular.sent.length,0);
  const failed=await ui(true,{failStart:true});assert.equal(failed.sent.length,0);assert.equal(failed.el('login').disabled,false);assert.equal(failed.el('handoff').hidden,true);assert.equal(failed.el('message').textContent,'请稍后再试');
});
test('local OAuth is opened through the host and its callback completes the original iframe login',async()=>{
  const replies=[],calls=[],opened=[],source={postMessage:(...args)=>replies.push(args)},frame={contentWindow:source};
  const event={origin:'https://internal.110-lab.cn',source,data:{type:'110lab-mail-host-login',state,fresh:false}};
  const authorization='https://internal.110-lab.cn/authorize?state=fixture';
  await handleMailExternalRequest(event,{frame,openExternal:async url=>{opened.push(url);return {};},callTool:async args=>{calls.push(args);return args.name==='connect_110lab_mail'?{_meta:{mailAuthorization:{state,url:authorization}}}:{_meta:{mailHandoff:{state,ticket:'t'.repeat(43)}}};}});
  assert.deepEqual(opened,[authorization]);assert.deepEqual(calls.map(c=>c.name),['connect_110lab_mail','complete_110lab_mail_login']);assert.equal(replies[0][0].type,'110lab-mail-host-opened');assert.equal(replies[1][0].ticket,'t'.repeat(43));
  const h=await ui(true);await h.receive({type:'110lab-mail-host-opened',state});assert.equal(h.el('message').textContent,'请在打开的飞书页面完成授权');assert.equal(h.el('login').disabled,true);
  await h.receive(replies[1][0]);assert.equal(h.el('identity').textContent,'虚构成员 · 普通成员');
});
test('failed external opening cancels the pending local OAuth and rejects untrusted authorization URLs',async()=>{
  const replies=[],calls=[],opened=[],source={postMessage:m=>replies.push(m)},frame={contentWindow:source};
  const event={origin:'https://internal.110-lab.cn',source,data:{type:'110lab-mail-host-login',state,fresh:false}};
  const callTool=async args=>{calls.push(args);return {_meta:{mailAuthorization:{state,url:'https://internal.110-lab.cn/authorize'}}};};
  await handleMailExternalRequest(event,{frame,callTool,openExternal:async()=>({isError:true})});assert.equal(calls.at(-1).arguments.cancel,true);assert.equal(replies.at(-1).ticket,undefined);
  for(const url of ['https://evil.example/authorize','https://internal.110-lab.cn@evil.example/authorize','https://internal.110-lab.cn/other','javascript:alert(1)'])await handleMailExternalRequest(event,{frame,callTool:async()=>({_meta:{mailAuthorization:{state,url}}}),openExternal:async url=>opened.push(url)});
  assert.deepEqual(opened,[]);
});
test('host login polls without keeping one MCP request open while the user authorizes',async()=>{
  let polls=0,opens=0;const replies=[],source={postMessage:m=>replies.push(m)},frame={contentWindow:source};
  await handleMailExternalRequest({origin:'https://internal.110-lab.cn',source,data:{type:'110lab-mail-host-login',state,fresh:false}},{frame,openExternal:async()=>{opens++;return {};},callTool:async args=>args.name==='connect_110lab_mail'?{_meta:{mailAuthorization:{state,url:'https://internal.110-lab.cn/authorize'}}}:++polls===1?{_meta:{mailAuthorizationPending:{state}}}:{_meta:{mailHandoff:{state,ticket:'t'.repeat(43)}}}});
  assert.equal(opens,1);assert.equal(polls,2);assert.equal(replies.at(-1).ticket,'t'.repeat(43));
});
