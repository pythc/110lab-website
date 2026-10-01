// Bundled admin workflow, outside node_modules, using only fictional local data.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,copyFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {request} from 'node:http';
const root=mkdtempSync(join(tmpdir(),'110lab-admin-release-'));
let server;
try{
 const manifest=JSON.parse(readFileSync('release.json'));
 for(const path of Object.keys(manifest.files)){mkdirSync(dirname(join(root,path)),{recursive:true});copyFileSync(path,join(root,path));}
 const privateDir=join(root,'private');mkdirSync(privateDir,{mode:0o700});
 const configPath=join(privateDir,'admin.json'),credentials=join(privateDir,'account.txt');
 const init=()=>spawnSync(process.execPath,[join(root,'server/admin-init-runtime.mjs'),configPath,credentials,'fixture_admin'],{encoding:'utf8'});
 const first=init();assert.equal(first.status,0);assert.equal(statSync(credentials).mode&0o777,0o600);
 const password=readFileSync(credentials,'utf8').match(/密码：(.*)/)[1];assert.ok(!first.stdout.includes(password));assert.notEqual(init().status,0);
 const {createHttpServer}=await import(pathToFileURL(join(root,'server/runtime.mjs')));
 process.env.PORTAL_UPDATES_DATABASE=join(privateDir,'updates','updates.sqlite');
 server=await createHttpServer({admin:{enabled:true,directory:join(privateDir,'sessions'),configPath}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const call=(path,data,headers={})=>new Promise((resolve,reject)=>{
  const req=request({hostname:'127.0.0.1',port:server.address().port,path,method:data===undefined?'GET':'POST',headers:{Host:'internal.110-lab.cn',...(data===undefined?{}:{Origin:'https://internal.110-lab.cn','Content-Type':'application/json'}),...headers}},res=>{
   const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>{const text=Buffer.concat(chunks).toString();let body;try{body=JSON.parse(text);}catch{}resolve({status:res.statusCode,body,headers:res.headers,text});});
  });req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data));
 });
 assert.equal((await call('/admin')).status,200);
 const login=await call('/api/admin/login',{username:'fixture_admin',password});assert.equal(login.status,200);
 const headers={Cookie:login.headers['set-cookie'][0].split(';')[0],'X-CSRF-Token':login.body.csrf};
 const created=await call('/api/admin/updates',{title:'Fictional bundled test'},headers);assert.equal(created.status,201);
 assert.deepEqual((await call('/api/updates')).body.updates,[]);
 assert.equal((await call('/api/admin/updates/'+created.body.id+'/publish',{revision:created.body.revision,confirmPublic:true},headers)).status,200);
 assert.equal((await call('/api/updates')).body.updates[0].title,'Fictional bundled test');
 const discovery=await call('/mcp/workbench-v6',{jsonrpc:'2.0',id:1,method:'tools/list'},{'Accept':'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'});
 assert.equal(discovery.status,200);assert.match(discovery.body.result.tools[0].icons[0].src,/^data:image\/png;base64,/);
 assert.equal((await call('/api/admin/logout',{},headers)).status,200);assert.equal((await call('/api/admin/session',undefined,headers)).status,401);
 console.log(JSON.stringify({isolatedAdminBundle:true,privateAccountInitializer:true,secondInitializationRefused:true,draftsPrivate:true,publishVerified:true,logoutVerified:true,toolIconVerified:true}));
}finally{if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});delete process.env.PORTAL_UPDATES_DATABASE;rmSync(root,{recursive:true,force:true});}
