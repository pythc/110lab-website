import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMailHttp} from '../server/mail-http.mjs';
import {createWorkspaceHttp} from '../server/workspace-http.mjs';
import {fixtureConfig,fixtureIdentity} from './helpers/mail-fixtures.mjs';
import {randomUUID} from 'node:crypto';

const member={subject:'fictional_tenant:on_workspace_member',email:'workspace.member@110-lab.cn',name:'虚构成员'};
const jar=r=>r.headers['set-cookie']?.[0]?.split(';')[0]||'';
test('shared live lab roles, cookie contexts, CSRF, project lifecycle and recruitment concurrency',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'110lab-workspace-http-'));
  const mail=await createMailHttp({enabled:true,directory,config:fixtureConfig,localTest:true,fetchIdentity:async(_,{code})=>code==='member'?member:fixtureIdentity});
  const id=randomUUID(),recruitment={labInbox:()=>({state:'ready',items:[{id,name:'虚构候选人',group:'开发组',receivedAt:new Date().toISOString(),deliveryStatus:'SENT'}]})};
  const workspace=createWorkspaceHttp({mail,recruitment,localTest:true});
  const server=createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname,host=req.headers.host.split(':')[0];if(!await mail.handle(req,res,path,host)&&!await workspace.handle(req,res,path,host)){res.writeHead(404);res.end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const call=(path,{actor,body,host='internal.110-lab.cn',origin='https://internal.110-lab.cn',cookie,csrf}={})=>new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port:server.address().port,path,method:body===undefined?'GET':'POST',headers:{Host:host,Origin:origin,Cookie:cookie??actor?.jar??'','X-CSRF-Token':csrf??actor?.csrf??'',...(body===undefined?{}:{'Content-Type':'application/json'})}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const text=Buffer.concat(chunks).toString();let value;try{value=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,text,value});});});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  async function login(code,embedded=false){
    const prefix='/api/mail/'+(embedded?'embedded/':''),start=await call(prefix+'auth/start',{body:{}}),state=start.value.state;
    const launch=await call('/mail/auth/launch?state='+state),callback=await call('/mail/auth/callback?state='+state+'&code='+code,{cookie:jar(launch)});
    const ticket=callback.text.match(/<code>([\w-]{43})<\/code>/)[1];
    const redeemed=await call(prefix+'auth/redeem',{body:{state,ticket},cookie:jar(start)}),cookie=jar(redeemed);
    const session=await call(prefix+'session',{cookie});return {...session.value,jar:cookie};
  }
  try{
    const admin=await login('owner'),person=await login('member');
    for(const path of ['session','members','projects','todos','recruitment/history'])assert.equal((await call('/api/workspace/'+path)).status,401);
    assert.equal((await call('/api/workspace/projects',{actor:admin,host:'110-lab.cn'})).status,404);
    const data={name:'虚构视觉项目',summary:'测试用项目',members:[{...member,name:'伪造名称'}],links:{repository:'https://github.com/example/repo',docs:'',demo:'',requirements:''}};
    assert.equal((await call('/api/workspace/projects',{actor:admin,body:data,origin:'https://evil.example'})).status,403);
    assert.equal((await call('/api/workspace/projects',{actor:admin,body:data,csrf:'invalid'})).status,403);
    const created=await call('/api/workspace/projects',{actor:admin,body:data});assert.equal(created.status,201);let project=created.value;
    assert.equal(project.members[0].name,member.name);
    const base='/api/workspace/projects/'+project.id;
    assert.equal((await call(base+'/update',{actor:person,body:{...data,revision:1}})).status,403);
    let response=await call(base+'/milestones',{actor:admin,body:{title:'虚构里程碑',assignee:person.subject,dueAt:'2026-10-10T15:59:59.000Z'}});assert.equal(response.status,200);project=response.value;
    const milestone=project.milestones[0];
    assert.equal((await call('/api/workspace/todos',{actor:person})).value.items.length,1);
    assert.equal((await call(base+'/milestones/'+milestone.id,{actor:person,body:{revision:milestone.revision,status:'done'}})).status,200);
    project=(await call(base,{actor:admin})).value;
    response=await call(base+'/apply',{actor:admin,body:{revision:project.revision,application:'已完成原型并希望共同推进'}});assert.equal(response.status,200);project=response.value;
    assert.equal((await call(base+'/review',{actor:person,body:{revision:project.revision,decision:'approve',note:''}})).status,403);
    assert.equal((await call('/api/mail/administrators/grant',{actor:admin,body:{email:member.email,revision:1,confirmed:true}})).status,200);
    assert.equal((await call('/api/workspace/session',{actor:person})).value.role,'admin');
    assert.ok((await call('/api/workspace/todos',{actor:person})).value.items.some(x=>x.kind==='project_review'));
    assert.equal((await call(base+'/review',{actor:person,body:{revision:project.revision,decision:'approve',note:''}})).status,200);
    const tasks=(await call('/api/workspace/todos',{actor:person})).value.items;
    assert.equal(tasks.find(x=>x.kind==='recruitment').deliveryStatus,'SENT');
    const handled='/api/workspace/recruitment/'+id+'/handled';
    const results=await Promise.all([call(handled,{actor:admin,body:{note:'虚构资料已核对'}}),call(handled,{actor:person,body:{note:'虚构资料已核对'}})]);
    assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
    assert.equal((await call('/api/workspace/todos',{actor:admin})).value.items.some(x=>x.kind==='recruitment'),false);
    assert.equal((await call('/api/workspace/recruitment/history',{actor:admin})).value.events.length,1);
    assert.equal((await call('/api/mail/administrators/revoke',{actor:admin,body:{email:member.email,revision:2,confirmed:true}})).status,200);
    assert.equal((await call('/api/workspace/recruitment/history',{actor:person})).status,403);
    const embedded=await login('member',true);
    assert.equal((await call('/api/workspace/session',{actor:embedded})).status,401);
    assert.equal((await call('/api/workspace/embedded/session',{actor:embedded})).status,200);
    assert.equal((await call('/api/workspace/embedded/projects',{actor:person})).status,401);
    assert.equal((await call('/api/workspace/embedded/projects',{actor:embedded})).status,200);
    assert.equal((await call('/api/mail/embedded/logout',{actor:embedded,body:{}})).status,200);
    assert.equal((await call('/api/workspace/embedded/projects',{actor:embedded})).status,401);
  }finally{await new Promise(r=>server.close(r));workspace.close();mail.close();await rm(directory,{recursive:true,force:true});}
});
