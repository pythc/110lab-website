import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createHttpServer} from '../server/http.mjs';
import {UI_URI} from '../server/portal.mjs';
import {request} from 'node:http';

test('public HTTP server supports stateless MCP and contains only the portal catalog',async()=>{
  const http=await createHttpServer();
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${http.address().port}`;
  const client=new Client({name:'http-verification',version:'1.0.0'});
  try{
    const page=await fetch(base);assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/object-src 'none'/);assert.match(await page.text(),/110lab/);
    const asset=await fetch(base+'/assets/glass-loop-v2.png');assert.equal(asset.status,200);assert.equal(asset.headers.get('content-type'),'image/png');assert.equal(Buffer.from(await asset.arrayBuffer()).subarray(1,4).toString(),'PNG');
    assert.equal((await fetch(base+'/unknown')).status,404);
    assert.equal((await fetch(base+'/src/projects.json')).status,404);
    assert.equal((await fetch(base+'/healthz')).status,200);
    for(const p of ['/admin','/api/content','/api/admin/session','/api/admin/content','/media/not-a-file']){assert.equal((await fetch(base+p)).status,404);}
    assert.equal((await fetch(base+'/api/admin/content',{method:'PUT',body:'{}'})).status,404);
    const publicHTML=await (await fetch(base)).text();assert.doesNotMatch(publicHTML,/internal\.110-lab\.cn|暂停动效|管理首页/);
    assert.match(publicHTML,/陇ICP备2026009447号/);
    const workbench=await (await fetch(base+'/workbench')).text();assert.match(workbench,/批改系统内网版/);assert.doesNotMatch(workbench,/管理首页|首页内容/);
    assert.equal((await fetch(base+'/mcp/workbench-v5')).status,405);
    assert.equal((await fetch(base+'/mcp/workbench-v5',{method:'OPTIONS'})).status,204);
    assert.equal((await fetch(base+'/mcp/workbench-v5',{method:'POST',body:'{}'})).status,415);
    assert.equal((await fetch(base+'/mcp/workbench-v5',{method:'POST',headers:{'content-type':'application/json'},body:'invalid'})).status,400);
    assert.equal((await fetch(base+'/mcp/workbench-v5',{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(40*1024)})).status,413);
    const wrongHostStatus=await new Promise((resolve,reject)=>{const r=request(base,{headers:{Host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);r.end();});
    assert.equal(wrongHostStatus,421);
    const invalidTarget=await new Promise((resolve,reject)=>{const r=request(base,{path:'http://[',headers:{Host:'localhost'}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);r.end();});
    assert.equal(invalidTarget,400);assert.equal((await fetch(base+'/healthz')).status,200);
    await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp/workbench-v5-1')));
    const list=await client.listTools();assert.deepEqual(list.tools.map(t=>t.name).sort(),['open_110lab','search_110lab_projects']);
    for(let i=0;i<3;i++){
      const result=await client.callTool({name:'search_110lab_projects',arguments:{query:'需求'}});
      assert.equal(result.structuredContent.projects.length,1);
    }
    const result=await client.callTool({name:'open_110lab',arguments:{}});assert.equal(result.isError,undefined);
    const resource=await client.readResource({uri:UI_URI});assert.match(resource.contents[0].text,/110lab/);
    const previousResource=await client.readResource({uri:'ui://110lab/workbench/v0.5.0'});
    assert.equal(previousResource.contents[0].text,resource.contents[0].text);
    const sendChunks=async(chunks)=>await new Promise((resolve,reject)=>{
      const r=request(base+'/mcp/workbench-v5',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'}},res=>{
        const parts=[];res.on('data',x=>parts.push(x));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(parts).toString('utf8')}));res.on('error',reject);
      });
      r.on('error',reject);r.flushHeaders();
      let index=0;const next=()=>{if(index===chunks.length){r.end();return;}r.write(chunks[index++]);setTimeout(next,5);};next();
    });
    const utf8=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:101,method:'tools/call',params:{name:'search_110lab_projects',arguments:{query:'需求'}}}));
    const split=utf8.indexOf(Buffer.from('需求'))+1;
    const chinese=await sendChunks([utf8.subarray(0,split),utf8.subarray(split)]);
    assert.equal(chinese.status,200);assert.equal(JSON.parse(chinese.body).result.structuredContent.projects.length,1);
    const oversized=await sendChunks([Buffer.alloc(20*1024,32),Buffer.alloc(20*1024,32)]);
    assert.equal(oversized.status,413);assert.equal(oversized.body,'Request too large');
  }finally{await client.close();await new Promise(resolve=>{http.close(resolve);http.closeAllConnections();});}
});
