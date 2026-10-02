import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {realpathSync} from 'node:fs';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {createPortalServer} from './portal.mjs';
import {serveAsset} from './assets.mjs';
import {createHash} from 'node:crypto';
import {openUpdatesStore} from './updates.mjs';
import {createRecruitmentHttp} from './recruitment-http.mjs';
import {createAdminHttp} from './admin-http.mjs';
class HttpError extends Error {constructor(status,message){super(message);this.status=status;}}
const securityHeaders={'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','Permissions-Policy':'camera=(), microphone=(), geolocation=()'};
const csp="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'";
function readBody(req,limit){
  return new Promise((resolve,reject)=>{
    if(Number(req.headers['content-length']||0)>limit){req.resume();reject(new HttpError(413,'Request too large'));return;}
    const chunks=[];let size=0,failed=false;
    req.on('data',chunk=>{if(failed)return;size+=chunk.length;if(size>limit){failed=true;chunks.length=0;reject(new HttpError(413,'Request too large'));return;}chunks.push(chunk);});
    req.once('end',()=>{if(!failed)resolve(Buffer.concat(chunks));});req.once('error',reject);req.once('aborted',()=>reject(new Error('Request aborted')));
  });
}
async function jsonBody(req,limit=1024*1024){
  if(String(req.headers['content-type']||'').split(';',1)[0].trim().toLowerCase()!=='application/json'){req.resume();throw new HttpError(415,'Use application/json');}
  try{return JSON.parse((await readBody(req,limit)).toString('utf8'));}catch(e){if(e instanceof HttpError)throw e;throw new HttpError(400,'Invalid JSON');}
}
const json=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
export async function createHttpServer(options={}){
  const [homepage,workbench]=await Promise.all(['index','workbench'].map(p=>readFile(new URL('../dist/'+p+'.html',import.meta.url),'utf8')));
  const allowedHosts=new Set(['110-lab.cn','internal.110-lab.cn','110lab-homepage','localhost','127.0.0.1','[::1]']);
  const updates=options.updatesStore||openUpdatesStore(process.env.PORTAL_UPDATES_DATABASE||':memory:');
  const recruitment=createRecruitmentHttp(options.recruitment);
  if(process.env.PORTAL_ADMIN_ENABLED==='true'&&!process.env.PORTAL_UPDATES_DATABASE&&!options.updatesStore)throw new Error('Admin updates require a persistent database');
  const admin=await createAdminHttp({...options.admin,updates});
  const server=createServer(async(req,res)=>{
    for(const [name,value] of Object.entries(securityHeaders))res.setHeader(name,value);
    const host=(req.headers.host||'').toLowerCase().replace(/:\d+$/,'');
    if(!allowedHosts.has(host)){res.writeHead(421);res.end('Unrecognized host');return;}
    let path;
    try{path=new URL(req.url,'http://localhost').pathname;}catch{res.writeHead(400);res.end('Invalid request target');return;}
    const internalHost=host!=='110-lab.cn';
    try{
      if(await admin.handle(req,res,path,host))return;
      if(await recruitment.handle(req,res,path,host))return;
      if(path==='/api/updates'){
        if(req.method!=='GET'&&req.method!=='HEAD'){req.resume();res.writeHead(405,{Allow:'GET, HEAD'});res.end();return;}
        const body=JSON.stringify({updates:updates.listPublished()}),etag='"'+createHash('sha256').update(body).digest('hex')+'"';
        const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'public, max-age=60, must-revalidate',ETag:etag};
        if(String(req.headers['if-none-match']||'').split(',').map(x=>x.trim()).includes(etag)){res.writeHead(304,headers);res.end();return;}
        res.writeHead(200,headers);res.end(req.method==='HEAD'?undefined:body);return;
      }
      if(path.startsWith('/admin')||path.startsWith('/api/')||path.startsWith('/media/'))throw new HttpError(404,'Not found');
      if(path==='/mcp'||path==='/mcp/workbench-v5'||path==='/mcp/workbench-v5-1'||path==='/mcp/workbench-v6'||path==='/mcp/workbench-v6-1'){
        if(!internalHost)throw new HttpError(404,'Not found');
        res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers','Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id');res.setHeader('Cache-Control','no-store');
        if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
        if(req.method!=='POST'){res.writeHead(405,{Allow:'POST, OPTIONS'});res.end('Method not allowed');return;}
        let parsed;
        try{parsed=await jsonBody(req,32*1024);}catch(error){if(error.status===400){json(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});return;}throw error;}
        const mcp=await createPortalServer(),transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
        try{await mcp.connect(transport);await transport.handleRequest(req,res,parsed);}finally{await transport.close();await mcp.close();}return;
      }
      if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405,{Allow:'GET, HEAD'});res.end('Method not allowed');req.resume();return;}
      const head=req.method==='HEAD';
      if(path==='/healthz'){json(res,200,{status:'ok',service:'110lab-homepage',version:'0.8.4',contentManagement:false,dynamicManagement:admin.enabled,recruitmentEnabled:recruitment.enabled});return;}
      if(path.startsWith('/assets/')){
        if(!await serveAsset(req,res,path.slice(8)))throw new HttpError(404,'Not found');
        return;
      }
      let html;
      if((path==='/workbench'||path==='/workbench/')&&internalHost)html=workbench;
      else if(path==='/'||path==='/index.html')html=host==='internal.110-lab.cn'?workbench:homepage;
      if(html&&options.liveReload){const name=path.startsWith('/workbench')||host==='internal.110-lab.cn'?'workbench':'index';html=await readFile(new URL('../dist/'+name+'.html',import.meta.url),'utf8');}
      if(html){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':csp});res.end(head?undefined:html);return;}
      if(path==='/robots.txt'){res.writeHead(200,{'Content-Type':'text/plain'});res.end(head?undefined:host==='110-lab.cn'?'User-agent: *\nAllow: /\n':'User-agent: *\nDisallow: /\n');return;}
      throw new HttpError(404,'Not found');
    }catch(error){
      req.resume();if(res.headersSent||res.destroyed)return;
      const status=error instanceof HttpError?error.status:500;
      if(status===500)console.error('110lab request failed',error?.code||error?.name||'Error');
      if(path.startsWith('/api/'))json(res,status,{error:status===500?'服务暂时不可用，请稍后重试。':error.message});
      else{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8'});res.end(status===500?'Internal error':error.message);}
    }
  });
  if(!options.updatesStore)server.once('close',()=>updates.close());
  server.once('close',()=>recruitment.close());
  server.once('close',()=>admin.close());
  server.requestTimeout=180000;server.headersTimeout=15000;
  return server;
}
function isMain(){try{return !!process.argv[1]&&fileURLToPath(import.meta.url)===realpathSync(process.argv[1]);}catch{return false;}}
if(isMain()){
  const port=Number(process.env.PORTAL_HTTP_PORT||8080);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid PORTAL_HTTP_PORT');
  const server=await createHttpServer();
  server.listen(port,'0.0.0.0',()=>console.log(`110lab homepage, workbench and MCP listening on ${port}`));
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),10000).unref();});
}
