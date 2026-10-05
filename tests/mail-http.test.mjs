import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMailHttp} from '../server/mail-http.mjs';
import {openMailMembershipState} from '../server/mail-membership-state.mjs';
import {fixtureConfig,fixtureIdentity} from './helpers/mail-fixtures.mjs';

const member={subject:'fictional_tenant:on_fixture_member_2026',email:'fictional.member@110-lab.cn',name:'虚构成员'};
const cookie=r=>r.headers.get('set-cookie')?.split(';')[0]||'';
async function harness(options){
  const mail=await createMailHttp(options),server=createServer((req,res)=>mail.handle(req,res,new URL(req.url,'http://localhost').pathname,req.headers.host.split(':')[0]));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  return {mail,async request(path,{method='GET',data,jar='',origin='https://internal.110-lab.cn',host='internal.110-lab.cn',csrf=''}={}){
    return new Promise((resolve,reject)=>{const req=httpRequest(base+path,{method,headers:{Host:host,Cookie:jar,Origin:origin,...(data===undefined?{}:{'Content-Type':'application/json'}),...(csrf?{'X-CSRF-Token':csrf}:{})}},res=>{const parts=[];res.on('data',p=>parts.push(p));res.on('end',()=>{const headers=new Headers();for(const [k,v] of Object.entries(res.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(','):v);const text=Buffer.concat(parts).toString();resolve({status:res.statusCode,headers,text:async()=>text,json:async()=>JSON.parse(text)});});});req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data));});
  },async close(){await new Promise(r=>server.close(r));mail.close();}};
}
async function login(h,code,{embedded=false}={}){
  const prefix='/api/mail/'+(embedded?'embedded/':''),start=await h.request(prefix+'auth/start',{method:'POST',data:{}}),s=await start.json(),binding=cookie(start);
  assert.equal(start.status,200);
  const launch=await h.request('/mail/auth/launch?state='+s.state);assert.equal(launch.status,303);assert.equal(new URL(launch.headers.get('location')).origin,'https://accounts.feishu.cn');
  const callback=await h.request('/mail/auth/callback?state='+s.state+'&code='+code,{jar:cookie(launch)});assert.equal(callback.status,200);
  const html=await callback.text(),ticket=html.match(/<code>([-\w]{43})<\/code>/)[1];
  const redeem=await h.request(prefix+'auth/redeem',{method:'POST',data:{state:s.state,ticket},jar:binding});assert.equal(redeem.status,200);
  const jar=cookie(redeem),session=await h.request(prefix+'session',{jar});assert.equal(session.status,200);
  return {jar,...await session.json()};
}
test('mail HTTP enforces verified members, CSRF, fresh authentication, atomic transfer and live revocation',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'110lab-mail-http-'));let time=Date.now();
  const options={enabled:true,directory,config:fixtureConfig,localTest:true,now:()=>time,fetchIdentity:async(_,{code})=>code==='member'?member:fixtureIdentity};
  let h=await harness(options);
  try{
    const owner=await login(h,'owner'),person=await login(h,'member');
    const request=(actor,kind,email,revision,extra={})=>h.request('/api/mail/administrators/'+kind,{method:'POST',jar:actor.jar,csrf:actor.csrf,data:{email,revision,confirmed:true},...extra});
    const revision=async actor=>(await (await h.request('/api/mail/administrators',{jar:actor.jar})).json()).revision;
    assert.equal(owner.role,'super_admin');assert.equal(person.role,'member');
    for(const path of ['administrators','members','audit'])assert.equal((await h.request('/api/mail/'+path,{jar:person.jar})).status,403);
    const rev=await revision(owner);
    assert.equal((await request(owner,'grant','unknown@110-lab.cn',rev)).status,409);
    assert.equal((await request(owner,'grant',member.email,rev,{csrf:'a'.repeat(43)})).status,403);
    assert.equal((await request(owner,'grant',member.email,rev,{origin:'https://untrusted.example'})).status,403);
    assert.equal((await request(owner,'grant',member.email,rev,{data:{email:member.email,revision:rev,confirmed:false}})).status,400);
    assert.equal((await request(owner,'grant',member.email,rev)).status,200);
    assert.equal((await (await h.request('/api/mail/session',{jar:person.jar})).json()).role,'admin');
    assert.equal((await request(person,'transfer',fixtureIdentity.email,await revision(owner))).status,403);
    assert.equal((await request(owner,'transfer',member.email,rev)).status,409);
    assert.equal((await request(owner,'revoke',fixtureIdentity.email,await revision(owner))).status,403);
    time+=300001;assert.equal((await request(owner,'transfer',member.email,await revision(owner))).status,403);
    const fresh=await login(h,'owner');assert.equal((await request(fresh,'transfer',member.email,await revision(fresh))).status,200);
    assert.equal((await (await h.request('/api/mail/session',{jar:owner.jar})).json()).role,'admin');
    assert.equal((await request(fresh,'grant','unknown@110-lab.cn',3)).status,403);
    const next=await login(h,'member');assert.equal(next.role,'super_admin');
    assert.equal((await request(next,'revoke',fixtureIdentity.email,await revision(next))).status,200);
    assert.equal((await (await h.request('/api/mail/session',{jar:owner.jar})).json()).role,'member');
    const events=await (await h.request('/api/mail/audit',{jar:next.jar})).json();assert.deepEqual(events.events.map(e=>e.action),['revoke','transfer','grant','bootstrap']);
    await h.close();h=await harness(options);
    assert.equal((await (await h.request('/api/mail/session',{jar:next.jar})).json()).role,'super_admin');
    assert.equal((await (await h.request('/api/mail/session',{jar:owner.jar})).json()).role,'member');
    assert.equal((await h.request('/mail',{host:'110-lab.cn'})).status,404);
    assert.equal((await h.request('/api/mail/config',{host:'110-lab.cn'})).status,404);
    const invalidCallback=await h.request('/mail/auth/callback?state=private-invalid-state&code=private-invalid-code');assert.equal(invalidCallback.status,401);assert.match(invalidCallback.headers.get('content-type'),/text\/html/);assert.match(await invalidCallback.text(),/返回公共邮箱管理/);assert.doesNotMatch(await invalidCallback.text(),/private-invalid/);
    const embeddedPage=await h.request('/mail/embedded');assert.equal(embeddedPage.status,200);assert.match(embeddedPage.headers.get('content-security-policy'),/codex-sandbox:/);assert.doesNotMatch(embeddedPage.headers.get('content-security-policy'),/\*/);
    const allowed=embeddedPage.headers.get('content-security-policy').match(/frame-ancestors ([^;]+)/)[1].split(' ');
    for(const host of ['mcp-app-378d4bef0808dd032fe89b17252aa980ad0e29f3d5ace47c','mcp-app-6231ba4b79ed6a654eda2cd7ee1cca5ff88c1453a659ea27'])assert.ok(allowed.includes(`codex-sandbox://${host}.web-sandbox.oaiusercontent.com`));
    assert.ok(!allowed.includes('codex-sandbox:'));assert.equal(allowed.length,6);
    const embedded=await login(h,'member',{embedded:true});assert.match(embedded.jar,/__Host-110lab_mail_embedded=/);
    assert.equal((await h.request('/api/mail/session',{jar:embedded.jar})).status,401);
    assert.equal((await h.request('/api/mail/embedded/session',{jar:embedded.jar})).status,200);
    assert.equal((await h.request('/api/mail/send',{method:'POST',data:{},jar:next.jar,csrf:next.csrf})).status,404);
  }finally{await h.close();await rm(directory,{recursive:true,force:true});}
});
test('unconfigured mail login fails closed while its page remains available',async()=>{
  const h=await harness({enabled:false});
  try{assert.deepEqual(await (await h.request('/api/mail/config')).json(),{loginAvailable:false,notifyManualSend:false,persistentLoginDays:30,restorePolicy:1});assert.equal((await h.request('/api/mail/auth/start',{method:'POST',data:{}})).status,503);assert.equal((await h.request('/mail')).status,200);assert.match((await h.request('/mail')).headers.get('content-security-policy'),/frame-ancestors 'none'/);}
  finally{await h.close();}
});
test('notify access requires a live administrator and fresh membership verification',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'110lab-notify-http-'));let time=Date.now();
  const now=()=>time,h=await harness({enabled:true,notifyEnabled:true,directory,config:fixtureConfig,localTest:true,now,fetchIdentity:async(_,{code})=>code==='member'?member:fixtureIdentity});
  const state=openMailMembershipState({directory,now});
  try{
    const owner=await login(h,'owner'),person=await login(h,'member');
    assert.equal((await h.request('/api/mail/notify')).status,401);
    assert.equal((await h.request('/api/mail/notify',{jar:person.jar})).status,403);
    let status=await (await h.request('/api/mail/notify',{jar:owner.jar})).json();assert.equal(status.state,'pending');assert.equal(status.url,undefined);
    state.claim();state.finish(1);
    status=await (await h.request('/api/mail/notify',{jar:owner.jar})).json();assert.equal(status.state,'ready');assert.equal(status.url,'https://www.feishu.cn/mail');
    const change=async(kind,revision)=>h.request('/api/mail/administrators/'+kind,{method:'POST',jar:owner.jar,csrf:owner.csrf,data:{email:member.email,revision,confirmed:true}});
    const granted=await change('grant',1);assert.equal(granted.status,200);assert.equal((await granted.json()).mailbox.state,'pending');
    status=await (await h.request('/api/mail/notify',{jar:person.jar})).json();assert.equal(status.state,'pending');assert.equal(status.url,undefined);
    state.finish(2);assert.equal((await (await h.request('/api/mail/notify',{jar:person.jar})).json()).state,'ready');
    assert.equal((await change('revoke',2)).status,200);
    assert.equal((await h.request('/api/mail/notify',{jar:person.jar})).status,403);
    state.finish(3);time+=60001;
    status=await (await h.request('/api/mail/notify',{jar:owner.jar})).json();assert.equal(status.state,'pending');assert.equal(status.url,undefined);
  }finally{state.close();await h.close();await rm(directory,{recursive:true,force:true});}
});
