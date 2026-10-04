import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {handleWorkspaceRequest} from '../src/embedded-workspace.js';

const flowState='s'.repeat(43),ticket='t'.repeat(43);
const profile={subject:'fixture:alice',name:'虚构成员',role:'member',csrf:'fixture-csrf'};
async function ui({embedded=true,fetchImpl}={}){
  const elements=new Map(),sent=[],requests=[],navigated=[];
  const node=()=>({hidden:false,disabled:false,dataset:{},children:[],textContent:'',attrs:{},classList:{add(){},remove(){}},
    append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;this.textContent='';},
    setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k];},removeAttribute(k){delete this.attrs[k];},
    addEventListener(){},querySelector(){return null;},querySelectorAll(){return [];}});
  const el=id=>{if(!elements.has(id))elements.set(id,node());return elements.get(id);};
  const parent={postMessage:m=>sent.push(m)},window={parent,open(){throw new Error('Unexpected popup');}};
  const source=(await readFile(new URL('../src/workspace.js',import.meta.url),'utf8')).replace('export function initWorkspace','function initWorkspace').replace('export default initWorkspace;','');
  const context={window,location:{pathname:embedded?'/workbench/embedded':'/workbench',assign:u=>navigated.push(u)},
    document:{getElementById:el,querySelector:()=>null,querySelectorAll:()=>[],createElement:node,createTextNode:text=>({textContent:text})},
    URL,AbortSignal,crypto:{randomUUID:()=> '12345678-1234-1234-1234-123456789012'},setTimeout:()=>1,clearTimeout(){},
    fetch:async(path,options)=>{requests.push({path,options});if(fetchImpl)return fetchImpl(path,options);
      const value=path.endsWith('auth/start')?{state:flowState,launchUrl:'https://internal.110-lab.cn/mail/auth/launch?state='+flowState}:
        path.endsWith('session')?profile:path.endsWith('projects')?{projects:[]}:path.endsWith('members')?{members:[]}:{items:[]};
      return {ok:true,json:async()=>value};}};
  runInNewContext(source+';globalThis.h={state,doLogin,doLogout,handleParentMessage,loadProjects,clearIdentity,renderRequirementsSource};',context);
  return {...context.h,el,parent,sent,requests,navigated};
}

test('workbench login uses its embedded cookie context and only redeems the matching parent handoff',async()=>{
  const h=await ui();await h.doLogin();
  assert.equal(h.requests[0].path,'/api/mail/embedded/auth/start');assert.equal(h.navigated.length,0);
  assert.equal(h.sent[0].type,'110lab-mail-host-login');assert.equal(h.el('ws-login').disabled,true);
  const result={type:'110lab-mail-host-result',state:flowState,ticket};
  await h.handleParentMessage({source:{},data:result});
  await h.handleParentMessage({source:h.parent,data:{...result,state:'wrong'}});
  assert.equal(h.requests.length,1);
  await h.handleParentMessage({source:h.parent,data:result});
  assert.equal(h.requests[1].path,'/api/mail/embedded/auth/redeem');assert.equal(h.state.profile.subject,profile.subject);
  assert.equal(h.el('ws-login').hidden,true);assert.equal(h.sent.at(-1).type,'110lab-workspace-requirements');
  const regular=await ui({embedded:false});await regular.doLogin();
  assert.equal(regular.requests[0].path,'/api/mail/auth/start');assert.equal(regular.navigated.length,1);assert.equal(regular.sent.length,0);
});

test('logout invalidates in-flight reads and wipes private UI and requirement results',async()=>{
  let resolveRead;
  const h=await ui({fetchImpl:()=>new Promise(resolve=>{resolveRead=resolve;})});
  h.state.profile=profile;h.state.projects=[{id:'old'}];h.state.todos=[{id:'private'}];h.state.requirements={items:[{id:'private'}]};
  const pending=h.loadProjects();h.clearIdentity();
  resolveRead({ok:true,json:async()=>({projects:[{id:'late'}]})});await pending;
  assert.equal(h.state.profile,null);assert.equal(h.state.projects.length,0);assert.equal(h.state.todos.length,0);assert.equal(h.state.requirements,null);
  assert.equal(h.el('ws-tabs').hidden,true);assert.equal(h.el('ws-panel-projects').hidden,true);
  await h.handleParentMessage({source:h.parent,data:{type:'110lab-workspace-requirements-result',requestId:'old',result:{items:[{id:'private'}]}}});
  assert.equal(h.state.requirements,null);
});

test('standalone recruitment failures remain visible instead of looking like an empty inbox',async()=>{
  const h=await ui({embedded:false});h.state.todoSources={recruitment:{state:'unavailable'}};h.renderRequirementsSource();
  assert.equal(h.el('ws-req-source').hidden,false);assert.match(h.el('ws-req-source').children.map(n=>n.textContent).join(''),/招新待办暂时无法同步/);
});

test('workbench host bridge restricts private tool results to the current owned frame',async()=>{
  const replies=[],calls=[],opened=[],shown=[],source={postMessage:(...args)=>replies.push(args)},frame={contentWindow:source};
  const options={frame,callTool:async args=>{calls.push(args);return {_meta:{requirementTodos:{state:'ready',items:[]}}};},openExternal:url=>opened.push(url),show:id=>shown.push(id)};
  const event={origin:'https://internal.110-lab.cn',source,data:{type:'110lab-workspace-requirements',requestId:'12345678-1234-1234-1234-123456789012'}};
  assert.equal(await handleWorkspaceRequest({...event,origin:'https://evil.example'},options),false);
  assert.equal(await handleWorkspaceRequest({...event,source:{}},options),false);assert.equal(calls.length,0);
  await handleWorkspaceRequest(event,options);assert.equal(calls[0].name,'get_my_110lab_requirement_todos');assert.equal(replies[0][1],event.origin);
  await handleWorkspaceRequest({...event,data:{type:'110lab-workspace-open-app',id:'public-mail'}},options);assert.deepEqual(shown,['public-mail']);
  await handleWorkspaceRequest({...event,data:{type:'110lab-workspace-open-app',id:'evil'}},options);assert.equal(shown.length,1);
  for(const url of ['javascript:alert(1)','https://user:secret@evil.example'])await handleWorkspaceRequest({...event,data:{type:'110lab-workspace-open-link',url}},options);
  assert.equal(opened.length,0);
});
