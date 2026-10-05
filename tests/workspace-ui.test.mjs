import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {handleWorkspaceRequest} from '../src/embedded-workspace.js';

const flowState='s'.repeat(43),ticket='t'.repeat(43);
const profile={subject:'fixture:alice',name:'虚构成员',role:'member',csrf:'fixture-csrf'};
async function ui({embedded=true,pathname,search='',fetchImpl}={}){
  const elements=new Map(),sent=[],requests=[],navigated=[];
  const node=()=>({hidden:false,disabled:false,dataset:{},children:[],textContent:'',attrs:{},value:'',checked:false,
    classList:{add(){},remove(){}},
    append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;this.textContent='';},
    setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k];},removeAttribute(k){delete this.attrs[k];},
    addEventListener(){},querySelector(){return null;},querySelectorAll(){return [];}});
  const el=id=>{if(!elements.has(id))elements.set(id,node());return elements.get(id);};
  const parent={postMessage:m=>sent.push(m)},window={parent,addEventListener(){},open(){throw new Error('Unexpected popup');}};
  const source=(await readFile(new URL('../src/workspace.js',import.meta.url),'utf8')).replace(/^import .*persistent-login.*\n/m,'').replace('export function initWorkspace','function initWorkspace').replace('export default initWorkspace;','');
  const resolvedPath=pathname||(embedded?'/workbench/embedded':'/workbench');
  const context={window,location:{pathname:resolvedPath,search,assign:u=>navigated.push(u)},
    document:{addEventListener(){},getElementById:el,querySelector:()=>null,querySelectorAll:()=>[],createElement:node,createTextNode:text=>({textContent:text})},
    URL,URLSearchParams,AbortSignal,crypto:{randomUUID:()=> '12345678-1234-1234-1234-123456789012'},setInterval:()=>1,setTimeout:()=>1,clearTimeout(){},
    fetch:async(path,options)=>{requests.push({path,options});if(fetchImpl)return fetchImpl(path,options);
      const value=path.endsWith('auth/start')?{state:flowState,launchUrl:'https://internal.110-lab.cn/mail/auth/launch?state='+flowState}:
        path.endsWith('session')?profile:path.endsWith('projects')?{projects:[]}:path.endsWith('members')?{members:[],source:'feishu',unavailable:false}:{items:[]};
      return {ok:true,json:async()=>value};}};
  runInNewContext(source+';globalThis.h={state,projectPicker,doLogin,doLogout,handleParentMessage,loadProjects,loadMembers,clearIdentity,renderRequirementsSource,renderShell,renderMemberPicker,refreshMemberPicker,openProjectDialog,collectProjectForm,navigateToProject,bindEvents,PROJECTS_PAGE,EMBEDDED,isUuid};',context);
  return {...context.h,el,parent,sent,requests,navigated,context};
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

const projectId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const otherProjectId='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

test('workbench no longer renders the project tab or new-project button; projects live on their own page',async()=>{
  const workbench=await ui({embedded:true});
  workbench.state.profile={...profile};workbench.renderShell();
  assert.equal(workbench.PROJECTS_PAGE,false);
  assert.equal(workbench.el('ws-tabs').hidden,false);
  assert.equal(workbench.el('ws-tab-projects').hidden,true);
  assert.equal(workbench.el('ws-panel-projects').hidden,true);
  assert.equal(workbench.el('ws-panel-todos').hidden,false);
  assert.equal(workbench.el('ws-project-new').hidden,true);

  const projects=await ui({embedded:false,pathname:'/projects'});
  projects.state.profile={...profile};projects.renderShell();
  assert.equal(projects.PROJECTS_PAGE,true);
  assert.equal(projects.el('ws-greeting').textContent,'项目立项');
  assert.equal(projects.el('ws-tabs').hidden,true);
  assert.equal(projects.el('ws-panel-projects').hidden,false);
  assert.equal(projects.el('ws-panel-todos').hidden,true);
  assert.equal(projects.el('ws-project-new').hidden,false);
  // Logged out greeting still uses the project-page copy.
  projects.state.profile=null;projects.renderShell();
  assert.equal(projects.el('ws-greeting').textContent,'项目立项');
});

test('/projects/embedded shares the embedded auth cookie context and parent bridge',async()=>{
  const h=await ui({pathname:'/projects/embedded'});
  assert.equal(h.EMBEDDED,true);assert.equal(h.PROJECTS_PAGE,true);
  await h.doLogin();
  assert.equal(h.requests[0].path,'/api/mail/embedded/auth/start');
  assert.equal(h.navigated.length,0);
  assert.equal(h.sent[0].type,'110lab-mail-host-login');
});

test('todo navigation goes through the standalone projects page and validates UUIDs',async()=>{
  // Standalone workbench: open project assigns the projects URL with the id.
  const standalone=await ui({embedded:false});
  standalone.navigateToProject('not-a-uuid');
  assert.equal(standalone.navigated.length,0);
  standalone.navigateToProject(projectId);
  assert.deepEqual(standalone.navigated,['/projects?project='+projectId]);

  // Embedded workbench: forwards the id through the parent host bridge only.
  const embedded=await ui({embedded:true});
  embedded.sent.length=0;
  embedded.navigateToProject('short-id');
  embedded.navigateToProject(projectId);
  assert.equal(embedded.navigated.length,0);
  assert.deepEqual(JSON.parse(JSON.stringify(embedded.sent.at(-1))),{type:'110lab-workspace-open-app',id:'projects',projectId});
});

test('parent select-project message is UUID gated and only honored on the projects page',async()=>{
  const workbench=await ui({embedded:true});
  workbench.state.profile={...profile};workbench.state.projects=[{id:projectId}];
  await workbench.handleParentMessage({source:workbench.parent,data:{type:'110lab-workspace-select-project',projectId}});
  assert.equal(workbench.state.selectedProjectId,null,'workbench ignores project selection; projects live elsewhere');

  const projects=await ui({pathname:'/projects/embedded'});
  projects.state.profile={...profile};projects.state.projects=[{id:projectId}];
  // Non-parent sources are rejected even on the projects page.
  await projects.handleParentMessage({source:{},data:{type:'110lab-workspace-select-project',projectId}});
  assert.equal(projects.state.selectedProjectId,null);
  // Non-UUID payloads are ignored.
  await projects.handleParentMessage({source:projects.parent,data:{type:'110lab-workspace-select-project',projectId:'nope'}});
  assert.equal(projects.state.selectedProjectId,null);
  // Valid UUID from the real parent selects the project.
  await projects.handleParentMessage({source:projects.parent,data:{type:'110lab-workspace-select-project',projectId}});
  assert.equal(projects.state.selectedProjectId,projectId);
  // If the project is not yet loaded, pendingProjectId defers until loadProjects runs.
  projects.state.projects=[];projects.state.selectedProjectId=null;
  await projects.handleParentMessage({source:projects.parent,data:{type:'110lab-workspace-select-project',projectId:otherProjectId}});
  assert.equal(projects.state.pendingProjectId,otherProjectId);
});

test('member picker preserves selected teammates when the directory is unavailable or searching',async()=>{
  const h=await ui({pathname:'/projects/embedded'});
  h.state.profile={...profile};
  h.projectPicker.ownerSubject='fixture:alice';
  h.projectPicker.selected=new Set(['fixture:bob','fixture:carol']);
  h.state.members=[{subject:'fixture:bob',name:'虚构 Bob',email:'bob@example'},
                   {subject:'fixture:carol',name:'虚构 Carol',email:'carol@example'},
                   {subject:'fixture:dave',name:'虚构 Dave',email:'dave@example'}];
  h.state.membersLoaded=true;h.state.membersSource='feishu';
  h.renderMemberPicker();
  const listRows=h.el('ws-field-members-list').children;
  const bySubject=new Set(listRows.map(r=>r?.children?.[0]?.value));
  assert.ok(bySubject.has('fixture:bob'));assert.ok(bySubject.has('fixture:dave'));
  assert.ok(!bySubject.has('fixture:alice'),'owner is never shown in the picker');

  // Searching narrows unselected rows but always keeps already selected members.
  h.projectPicker.search='dave';h.renderMemberPicker();
  const searchedSubjects=h.el('ws-field-members-list').children.map(r=>r?.children?.[0]?.value);
  assert.ok(searchedSubjects.includes('fixture:bob'),'selected member stays visible while searching');
  assert.ok(searchedSubjects.includes('fixture:carol'),'selected member stays visible while searching');
  assert.ok(searchedSubjects.includes('fixture:dave'));

  // Directory failure (unavailable=true) keeps the current selection intact
  // and emits an explicit error status instead of silently clearing anything.
  h.projectPicker.search='';
  h.state.membersUnavailable=true;h.state.membersError='企业目录暂时无法读取';
  h.renderMemberPicker();
  const stillSelected=Array.from(h.projectPicker.selected);
  assert.deepEqual(stillSelected.sort(),['fixture:bob','fixture:carol']);
  const statusText=h.el('ws-field-members-status').textContent;
  assert.ok(/目录/.test(statusText),'status surfaces directory failure to the user');
  assert.equal(h.el('ws-field-members-status').hidden,false);
});

test('loadMembers failure preserves the previous members list and marks save disabled only during the first load',async()=>{
  const h=await ui({pathname:'/projects/embedded',fetchImpl:async(path)=>{
    if(path.endsWith('members'))return{ok:false,status:503,json:async()=>({error:'目录服务重启中'})};
    return{ok:true,json:async()=>({})};
  }});
  // Seed previously known members so we can confirm they are not wiped.
  h.state.profile={...profile};
  h.state.members=[{subject:'fixture:bob',name:'Bob',email:'bob@example'}];
  h.state.membersLoaded=true;
  h.projectPicker.selected=new Set(['fixture:bob']);

  await h.loadMembers({refresh:true});
  assert.deepEqual(h.state.members.map(m=>m.subject),['fixture:bob'],'members list is preserved on failure');
  assert.ok(h.state.membersUnavailable);
  assert.ok(h.projectPicker.selected.has('fixture:bob'),'existing selection is not cleared');
  assert.equal(h.state.membersLoading,false);
  // membersLoaded is still true from the earlier successful load, so submit is not forced disabled by first-load gating.
  // Simulate the first-load scenario explicitly:
  h.state.membersLoaded=false;h.state.membersLoading=true;
  h.refreshMemberPicker();
  assert.equal(h.el('ws-form-project-submit').disabled,true,'save is disabled during the very first directory load');
});

test('collectProjectForm sends only {subject} rows and never leaks the owner subject or arbitrary strings',async()=>{
  const h=await ui({pathname:'/projects'});
  h.state.profile={...profile};
  h.el('ws-field-name').value='测试项目';
  h.el('ws-field-summary').value='简介';
  h.projectPicker.ownerSubject='fixture:alice';
  h.projectPicker.selected=new Set(['fixture:bob','fixture:alice','',null,'fixture:carol']);
  const parsed=h.collectProjectForm();
  assert.equal(parsed.error,undefined);
  assert.deepEqual(Array.from(parsed.members,m=>Object.keys(m)).flat().sort(),['subject','subject']);
  const subjects=Array.from(parsed.members,m=>m.subject).sort();
  assert.deepEqual(subjects,['fixture:bob','fixture:carol']);
});

test('on /projects, bindEvents picks up ?project=<uuid> as the pending selection and loadProjects honors it',async()=>{
  const h=await ui({pathname:'/projects',search:'?project='+projectId,
    fetchImpl:async(path)=>{
      const value=path.endsWith('projects')?{projects:[{id:otherProjectId,name:'B'},{id:projectId,name:'A'}]}:
        path.endsWith('members')?{members:[],source:'feishu',unavailable:false}:
        path.endsWith('session')?profile:{items:[]};
      return{ok:true,json:async()=>value};
    }});
  h.bindEvents();
  assert.equal(h.state.pendingProjectId,projectId);
  h.state.profile={...profile};
  await h.loadProjects();
  assert.equal(h.state.selectedProjectId,projectId);
  assert.equal(h.state.pendingProjectId,null);

  // A bad ?project= value is ignored by UUID validation.
  const bad=await ui({pathname:'/projects',search:'?project=not-a-uuid'});
  bad.bindEvents();
  assert.equal(bad.state.pendingProjectId,null);
});
