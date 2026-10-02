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
  const elements=new Map(),sent=[],navigated=[],requests=[];
  const el=id=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,value:'',textContent:'',open:false,replaceChildren(){},addEventListener(){}});return elements.get(id);};
  const parent={postMessage:m=>sent.push(m)};
  const window={parent,addEventListener(){},open(){throw new Error('must never open a blank popup');}};
  const location={pathname:embedded?'/mail/embedded':'/mail',assign:u=>navigated.push(u)};
  const fetch=async(path)=>{requests.push(path);if(path.endsWith('config'))return {ok:true,json:async()=>({loginAvailable:true})};if(path.endsWith('session'))return {ok:false,status:401,json:async()=>({error:'unauthenticated'})};return failStart?{ok:false,status:429,json:async()=>({error:'请稍后再试'})}:{ok:true,json:async()=>({state,launchUrl:url})};};
  const source=await readFile(new URL('../src/mail.js',import.meta.url),'utf8');
  await runInNewContext('(async()=>{'+source+'})()',{window,location,document:{getElementById:el,querySelectorAll:()=>[]},fetch,AbortSignal,setInterval(){},Option:function(){}});
  await el('login').onclick();return {el,sent,navigated,requests};
}
test('embedded login uses host open-link with a visible retry and collapsed manual code',async()=>{
  const h=await ui(true);assert.equal(h.navigated.length,0);assert.deepEqual(JSON.parse(JSON.stringify(h.sent)),[{type:'110lab-mail-open-login',state,url}]);
  assert.equal(h.el('handoff').hidden,false);assert.equal(h.el('manual-login').open,false);assert.equal(h.el('continue-login').href,url);assert.equal(h.el('login').disabled,false);
  h.el('open-mailbox').onclick({preventDefault(){}});assert.equal(h.sent.at(-1).url,'https://www.feishu.cn/mail');
});
test('regular browser login navigates in the current tab; failed start restores the button',async()=>{
  const regular=await ui(false);assert.deepEqual(regular.navigated,[url]);assert.equal(regular.sent.length,0);
  const failed=await ui(true,{failStart:true});assert.equal(failed.sent.length,0);assert.equal(failed.el('login').disabled,false);assert.equal(failed.el('handoff').hidden,true);assert.equal(failed.el('message').textContent,'请稍后再试');
});
