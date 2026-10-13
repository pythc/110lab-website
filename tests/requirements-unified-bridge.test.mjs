import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,publicEncrypt,createCipheriv,constants} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const platform='https://fcncvoyreb8p.feishuapp.com/app/app_17b6pxwde0x',endpoint=platform+'/openapi/mcp';
test('official SDK connects without a connection code; first native grant is encrypted to the same process',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'110-req-identity-')),preload=join(directory,'mock-provider.mjs');
 await writeFile(preload,`import fs from 'node:fs/promises';
 const root=process.env.LAB_IDENTITY_QA_DIR;const endpoint=${JSON.stringify(endpoint)};
 globalThis.fetch=async(url,init)=>{const u=String(url),p=JSON.parse(init.body);
 if(u.endsWith('/api/identity/exchange'))return Response.json({issuer:'https://internal.110-lab.cn',audience:'requirements',tenantKey:'fixture',unionId:'on_fictional00001',subject:'fixture:on_fictional00001',name:'虚构成员',token:'t'.repeat(43),expiresAt:new Date(Date.now()+3600000).toISOString()});
 if(u.endsWith('/api/identity/inspect'))return Response.json({subject:'fixture:on_fictional00001',name:'虚构成员'});
 if(u.endsWith('/api/identity/requirements/connect'))return Response.json({code:'NATIVE_CONNECTION_REQUIRED'},{status:412});
 if(u.endsWith('/api/identity/requirements/ticket')){await fs.writeFile(root+'/ticket.json',JSON.stringify(p),{mode:0o600});return Response.json({url:${JSON.stringify(platform+'/connect/110lab?ticket=fictional-ticket')}});}
 if(u===endpoint){if(init.headers['X-Lab-Identity-Token']!=='t'.repeat(43))throw Error('missing unified identity');if(p.method==='notifications/initialized')return new Response('',{status:202});if(p.method==='initialize')return Response.json({jsonrpc:'2.0',id:p.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}});if(p.method==='tools/list')return Response.json({jsonrpc:'2.0',id:p.id,result:{tools:[]}});return Response.json({jsonrpc:'2.0',id:p.id,result:{content:[{type:'text',text:'fixture read'}]}});}
 throw Error('unexpected network destination');};`,{mode:0o600});
 const transport=new StdioClientTransport({command:process.execPath,args:['--import',preload,join(process.cwd(),'server/requirements-identity-bridge.mjs')],env:{...process.env,LAB_REQUIREMENTS_AUTH_DIR:join(directory,'credentials'),LAB_IDENTITY_QA_DIR:directory},stderr:'pipe'}),client=new Client({name:'isolated-identity-qa',version:'1'});
 try{
  await client.connect(transport);const tools=await client.listTools();assert.ok(tools.tools.some(t=>t.name==='lab_connect_requirements'));assert.ok(tools.tools.some(t=>t.name==='requirements_list'));
  const open=await client.callTool({name:'lab_connect_requirements',arguments:{}}),v=JSON.parse(open.content[0].text),auth=new URL(v.authorizationUrl),callback=new URL(auth.searchParams.get('redirect_uri'));
  assert.equal(auth.origin,'https://internal.110-lab.cn');assert.equal(auth.pathname,'/auth');assert.equal(auth.searchParams.get('audience'),'requirements');
  const wrong=new URL(callback);wrong.search=new URLSearchParams({state:'bad',code:'c'.repeat(43),iss:'https://internal.110-lab.cn'}).toString();assert.equal((await fetch(wrong,{redirect:'manual'})).status,400);
  callback.search=new URLSearchParams({state:auth.searchParams.get('state'),code:'c'.repeat(43),iss:'https://internal.110-lab.cn'}).toString();const next=await fetch(callback,{redirect:'manual'});assert.equal(next.status,303);assert.equal(next.headers.get('location'),platform+'/connect/110lab?ticket=fictional-ticket');
  const ticket=JSON.parse(await readFile(join(directory,'ticket.json'),'utf8')),contentKey=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',contentKey,iv);cipher.setAAD(Buffer.from('mcp-credential-v1\0'+ticket.requestNonce));const bytes=Buffer.concat([cipher.update(JSON.stringify({endpoint,personalToken:'rmcp_v1.fixture.signature',openApiKey:'fictional-api-key'})),cipher.final(),cipher.getAuthTag()]);
  const {createPublicKey}=await import('node:crypto'),publicKey=createPublicKey({key:Buffer.from(ticket.publicKey,'base64url'),format:'der',type:'spki'});
  const encrypted={version:1,algorithm:'RSA-OAEP-256+A256GCM',requestNonce:ticket.requestNonce,encryptedKey:publicEncrypt({key:publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},contentKey).toString('base64url'),iv:iv.toString('base64url'),ciphertext:bytes.toString('base64url')};
  const send=(origin,state=ticket.state)=>fetch(ticket.redirectUri,{method:'POST',redirect:'manual',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({state,encrypted:JSON.stringify(encrypted)})});
  assert.equal((await send('https://attacker.example')).status,400);assert.equal((await send(new URL(platform).origin,'wrong-state')).status,400);assert.equal((await send(new URL(platform).origin)).status,200);
  const saved=JSON.parse(await readFile(join(directory,'credentials/identity.json'),'utf8'));assert.equal(saved.version,2);assert.equal(saved.subject,'fixture:on_fictional00001');assert.equal(saved.identityToken,'t'.repeat(43));
  const status=await client.callTool({name:'lab_requirements_connection_status',arguments:{}});assert.equal(JSON.parse(status.content[0].text).connected,true);assert.doesNotMatch(JSON.stringify(status),/fictional-api-key|rmcp_v1|tttttttt/);
  const call=await client.callTool({name:'requirements_list',arguments:{}});assert.equal(call.content[0].text,'fixture read');
 }finally{await client.close();await rm(directory,{recursive:true,force:true});}
});
