import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequirementTodos} from '../server/local-requirement-todos.mjs';
import {handleWorkspaceRequest} from '../src/embedded-workspace.js';
const credentials={personalToken:'rmcp_v1.'+Buffer.from(JSON.stringify({employeeId:'user_fixture',openId:'ou_fixture',name:'虚构连接人'})).toString('base64url')+'.fictional',openApiKey:'fictional'};
test('personal todo reader uses verified handler IDs and reviewer binding, sanitizes data and signals truncation',async()=>{
  const calls=[];
  const get=createRequirementTodos({readCredentials:()=>credentials,makeRelay:()=>async p=>{
    calls.push(p);let result={protocolVersion:'2025-03-26'};
    if(p.method==='notifications/initialized')return [];
    if(p.params?.name==='requirements_list')result={structuredContent:{requirements:Array.from({length:100},(_,i)=>({id:'record'+i,title:'事项 '+i,code:'F-'+i,personnelUserIds:{handlers:[]},handlers:[{id:i===0||i===2?'ou_fixture':'other',name:'同名成员'}],status:i===2?'已发布':'开发中',deadlineAt:i===0?'2026-10-12':null,introduction:'MUST NOT BE RETURNED'}))}};
    if(p.params?.name==='pull_requests_list')result={structuredContent:{reviewerCandidates:[{feishuEmployeeId:'user_fixture',login:'fixture'}],stale:false,pullRequests:[{number:42,state:'OPEN',title:'虚构评审',requestedReviewers:[{login:'Fixture'}]},{number:43,state:'OPEN',requestedReviewers:[{login:'other'}]}]}};
    return [{jsonrpc:'2.0',id:p.id,result}];
  }});
  const r=await get();assert.equal(r.state,'ready');assert.equal(r.partial,true);assert.equal(r.items.length,2);assert.equal(r.accountName,'虚构连接人');
  assert.equal(r.items[0].dueAt,'2026-10-12T00:00:00.000Z');assert.equal(r.items[1].status,'待我评审');
  assert.doesNotMatch(JSON.stringify(r),/MUST NOT|personalToken|openApiKey|fictional/);
  assert.deepEqual(calls.filter(x=>x.method==='tools/call').map(x=>x.params.name),['requirements_list','pull_requests_list']);
});
test('missing credentials and upstream failure never become a successful zero',async()=>{
  assert.equal((await createRequirementTodos({readCredentials:()=>{throw new Error('secret');}})()).state,'not_configured');
  const r=await createRequirementTodos({readCredentials:()=>credentials,makeRelay:()=>async()=>{throw new Error('secret');}})();assert.equal(r.state,'unavailable');assert.doesNotMatch(JSON.stringify(r),/secret/);
});
test('server-side personal todo pagination includes all pages and PR failure does not erase requirements',async()=>{
  let pages=0;const get=createRequirementTodos({readCredentials:()=>credentials,makeRelay:()=>async p=>{
    if(p.method==='notifications/initialized')return [];
    let result={};if(p.method==='tools/list')result={tools:[{name:'my_requirement_todos'}]};
    if(p.params?.name==='my_requirement_todos'){pages++;result={structuredContent:{accountName:'虚构已认证用户',total:101,nextCursor:pages===1?'page2':null,requirements:Array.from({length:pages===1?100:1},(_,i)=>({id:'r'+(pages===1?i:100),code:'T',title:'测试',status:'开发中',deadlineAt:'1790000000000'}))}};}
    if(p.params?.name==='pull_requests_list')return [{id:p.id,error:{code:-32603}}];
    return [{id:p.id,result}];
  }});const r=await get();assert.equal(r.state,'ready');assert.equal(r.items.length,101);assert.equal(r.partial,false);assert.equal(r.reviewState,'unavailable');assert.equal(r.accountName,'虚构已认证用户');assert.ok(r.items[0].dueAt);
});
test('changing snapshots are retried once, never presented as a successful empty list',async()=>{
  let attempts=0;const r=await createRequirementTodos({readCredentials:()=>credentials,makeRelay:()=>async p=>{
    if(p.method==='notifications/initialized')return [];
    let result=p.method==='tools/list'?{tools:[{name:'my_requirement_todos'}]}:{};
    if(p.params?.name==='my_requirement_todos'){attempts++;result={structuredContent:{restartRequired:true}};}
    return [{id:p.id,result}];
  }})();assert.equal(r.state,'unavailable');assert.equal(attempts,2);
});
test('workspace bridge rejects untrusted source and unsafe links and exposes only personal app tool',async()=>{
  const messages=[],opened=[],calls=[],source={postMessage:(...v)=>messages.push(v)},frame={contentWindow:source};
  const opts={frame,show:()=>{},openExternal:async u=>opened.push(u),callTool:async p=>{calls.push(p);return {_meta:{requirementTodos:{state:'ready',items:[]}}};}};
  const event={origin:'https://internal.110-lab.cn',source,data:{type:'110lab-workspace-requirements',requestId:'a'.repeat(36)}};
  assert.equal(await handleWorkspaceRequest({...event,source:{}},opts),false);assert.equal(await handleWorkspaceRequest({...event,origin:'https://evil.example'},opts),false);
  await handleWorkspaceRequest(event,opts);assert.equal(calls.length,1);assert.equal(calls[0].name,'get_my_110lab_requirement_todos');assert.equal(messages[0][1],event.origin);
  for(const url of ['javascript:alert(1)','https://u:p@example.com','http://example.com'])await handleWorkspaceRequest({...event,data:{type:'110lab-workspace-open-link',url}},opts);
  assert.equal(opened.length,0);
});
