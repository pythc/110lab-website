import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
async function fixture({cached=true,refreshValid=true}={}){
  let base,refreshes=0,authorizationRequests=0,calls=0;
  const json=(res,status,v,headers={})=>{res.writeHead(status,{'Content-Type':'application/json',...headers});res.end(JSON.stringify(v));};
  const server=createServer(async(req,res)=>{
    const path=new URL(req.url,base).pathname;
    if(path.startsWith('/.well-known/oauth-protected-resource'))return json(res,200,{resource:base+'/mcp',authorization_servers:[base],scopes_supported:['knowledge:read']});
    if(path==='/.well-known/oauth-authorization-server')return json(res,200,{issuer:base,authorization_endpoint:base+'/authorize',token_endpoint:base+'/token',registration_endpoint:base+'/register',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256']});
    const parts=[];for await(const p of req)parts.push(p);const text=Buffer.concat(parts).toString();
    if(path==='/token'){refreshes++;assert.equal(new URLSearchParams(text).get('grant_type'),'refresh_token');return json(res,refreshValid?200:400,refreshValid?{access_token:'fixture-renewed',refresh_token:'fixture-rotated',token_type:'Bearer',expires_in:1800}:{error:'invalid_grant'});}
    if(path==='/authorize'||path==='/register'){authorizationRequests++;return json(res,400,{error:'unexpected_authorization'});}
    if(path!=='/mcp')return json(res,404,{});
    if(req.headers.authorization!=='Bearer fixture-renewed')return json(res,401,{error:'invalid_token'},{'WWW-Authenticate':'Bearer resource_metadata="'+base+'/.well-known/oauth-protected-resource/mcp"'});
    if(req.method!=='POST'){res.writeHead(405);return res.end();}
    const input=JSON.parse(text);if(input.id===undefined){res.writeHead(202);return res.end();}
    const output=input.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture-knowledge',version:'1'}}:input.method==='tools/call'?(calls++,{content:[{type:'text',text:'connected'}]}):{tools:[]};
    json(res,200,{jsonrpc:'2.0',id:input.id,result:output});
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
  const directory=await mkdtemp(join(tmpdir(),'110-kb-renew-')),endpoint=base+'/mcp',cache=join(directory,'110lab','knowledge',createHash('sha256').update(endpoint).digest('hex').slice(0,16));await mkdir(cache,{recursive:true,mode:0o700});
  if(cached)await writeFile(join(cache,'oauth.json'),JSON.stringify({client:{client_id:'fixture-client',redirect_uris:['http://127.0.0.1:9999/callback']},tokens:{access_token:'fixture-expired',refresh_token:'fixture-refresh',token_type:'Bearer'}}),{mode:0o600});
  const client=new Client({name:'test-plugin',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[new URL('../plugin/110lab/mcp/knowledge-bridge.mjs',import.meta.url).pathname],env:{...process.env,XDG_DATA_HOME:directory,KNOWLEDGE_URL:endpoint},stderr:'pipe'});transport.stderr?.on('data',()=>{});await client.connect(transport);
  return {client,cache,stats:()=>({refreshes,authorizationRequests,calls}),async close(){await client.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});await rm(directory,{recursive:true,force:true});}};
}
const status=async f=>JSON.parse((await f.client.callTool({name:'kb_connection_status',arguments:{}})).content[0].text);
test('connection status renews expired access with the saved refresh grant and serializes parallel checks',async()=>{const f=await fixture();try{const answers=await Promise.all([status(f),status(f)]);assert.ok(answers.every(v=>v.connected),JSON.stringify({answers,stats:f.stats()}));assert.deepEqual(f.stats(),{refreshes:1,authorizationRequests:0,calls:2});assert.equal(JSON.parse(await readFile(join(f.cache,'oauth.json'),'utf8')).tokens.refresh_token,'fixture-rotated');}finally{await f.close();}});
test('status never starts a new consent flow without a saved grant or after refresh rejection',async()=>{for(const options of [{cached:false},{refreshValid:false}]){const f=await fixture(options);try{const v=await status(f);assert.equal(v.connected,false);assert.equal(v.authorizationPending,false);assert.equal(f.stats().authorizationRequests,0);assert.equal(f.stats().calls,0);}finally{await f.close();}}});
