import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceDirectory,DirectoryError} from '../server/workspace-directory.mjs';
import {fixtureConfig} from './helpers/mail-fixtures.mjs';

const alice={union_id:'on_fictional_alice01',name:'虚构甲',enterprise_email:'alice@110-lab.cn'};
const bob={union_id:'on_fictional_bob0002',name:'虚构乙',email:'personal@example.org'};
const response=data=>new Response(JSON.stringify({code:0,data}));
function fake(){
  const calls=[];let fail=false;
  return {calls,setFail(){fail=true;},async fetch(url,options){
    const u=new URL(url);calls.push({path:u.pathname,query:u.searchParams,options});
    assert.equal(u.origin,'https://open.feishu.cn');assert.equal(options.redirect,'error');
    if(fail)throw new Error('private upstream detail');
    if(u.pathname.endsWith('/internal'))return new Response(JSON.stringify({code:0,tenant_access_token:'test-only',expire:7200}));
    assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,'Bearer test-only');
    if(u.pathname.endsWith('/children'))return response({items:[{open_department_id:'od-fictional'}],has_more:false});
    assert.equal(u.searchParams.get('user_id_type'),'union_id');
    if(u.searchParams.get('department_id')==='0')return response({items:[alice],has_more:false});
    if(u.searchParams.get('page_token'))return response({items:[{...alice,status:{is_resigned:true}}],has_more:false});
    return response({items:[alice,bob],has_more:true,page_token:'page2'});
  }};
}
test('project directory uses tenant union identities, paginates, deduplicates and never fabricates email',async()=>{
  const provider=fake();let now=1000;const d=createWorkspaceDirectory({config:fixtureConfig,fetchImpl:provider.fetch,now:()=>now});
  const [members,concurrent]=await Promise.all([d.list(),d.list()]);assert.deepEqual(members,concurrent);
  assert.equal(members.length,2);assert.equal(members.find(m=>m.name==='虚构乙').email,'');
  assert.equal(members[0].subject.split(':')[0],fixtureConfig.tenantKey);
  assert.equal(provider.calls.filter(c=>c.path.endsWith('/internal')).length,1);
  const n=provider.calls.length;await d.list();assert.equal(provider.calls.length,n);
  now+=61000;provider.setFail();await assert.rejects(d.list(),DirectoryError);
  const failures=provider.calls.length;await assert.rejects(d.list(),DirectoryError);assert.equal(provider.calls.length,failures);
});
test('directory fails closed on repeated pagination token, malformed identifiers and oversized body',async()=>{
  for(const mode of ['loop','invalid','oversize','denied']){
    const d=createWorkspaceDirectory({config:fixtureConfig,fetchImpl:async url=>{
      if(url.endsWith('/internal'))return new Response(JSON.stringify({code:0,tenant_access_token:'test',expire:7200}));
      if(mode==='oversize')return new Response('x'.repeat(512*1024+1));
      if(mode==='denied')return new Response(JSON.stringify({code:99991672,msg:'private diagnostic'}));
      if(mode==='loop')return response({items:[],has_more:true,page_token:'repeat'});
      if(url.includes('/children'))return response({items:[],has_more:false});
      return response({items:[{...alice,union_id:'foreign:subject'}],has_more:false});
    }});
    await assert.rejects(d.list(),e=>e instanceof DirectoryError&&!e.message.includes('private'));
  }
});
