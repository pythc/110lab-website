import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {BUSINESS_TOOL_MAP} from './business-tools.mjs';
import {createBusinessService} from './business-service.mjs';
import {createBusinessMailProvider,readBusinessMailConfig} from './business-mail-provider.mjs';
import {ADMIN_FRAME_ANCESTORS} from './admin-http.mjs';
import {MAIL_RESOURCE_METADATA} from './mail-oauth.mjs';
import {parseBusinessReference} from './business-reference.mjs';

export function businessScope(name,args={}){
  if(name==='lab_file_upload')return args.purpose==='honor_certificate'?'honors:write':'mail:draft';
  if(name==='lab_attachment_read'){try{const host=parseBusinessReference(args.reference).hostname;return ({honor:'honors:read',resume:'recruitment:read',mail:'mail:read'})[host]||'lab:identity';}catch{return 'lab:identity';}}
  return BUSINESS_TOOL_MAP.get(name)?.scope||'lab:identity';
}
export function businessChallenge(scope='lab:identity'){return `Bearer resource_metadata="${MAIL_RESOURCE_METADATA}", scope="${scope}", error="insufficient_scope"`;}
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store'});res.end(JSON.stringify(value));};
export async function createBusinessHttp({mail,workspace,honors,recruitment,updates,updatesEnabled,enabled=process.env.PORTAL_BUSINESS_MCP_ENABLED==='true',directory=mail.workspaceDirectory&&join(mail.workspaceDirectory,'mcp-business'),mailConfigPath=process.env.PORTAL_BUSINESS_MAIL_CONFIG,mailProvider,localTest=false,now=Date.now}={}){
  if(!enabled)return {enabled:false,handle:async()=>false,close:async()=>{}};
  if(!mail.enabled||!directory)throw new Error('Business MCP requires laboratory identity and persistent storage');
  const service=createBusinessService({mail,workspace,honors,recruitment,updates,updatesEnabled,directory,now,mailProvider:mailProvider||createBusinessMailProvider({config:mailConfigPath?readBusinessMailConfig(mailConfigPath):undefined})});
  const html=await readFile(new URL('../dist/mcp-confirm.html',import.meta.url),'utf8');
  return {enabled:true,service,close:()=>service.close(),
    async identity(header,scope){return mail.businessIdentity(header,[scope]);},
    async call(name,args,header){const actor=await mail.businessIdentity(header,[businessScope(name,args)]);return service.call(name,args,actor);},
    async handle(req,res,path,host){
      if(!['/mcp-confirm','/mcp-confirm/embedded'].includes(path)&&!path.startsWith('/api/business/'))return false;
      try{
        if(host!=='internal.110-lab.cn'&&!(localTest&&['localhost','127.0.0.1'].includes(host)))throw Object.assign(new Error('Not found'),{status:404});
        const embedded=path.endsWith('/embedded')||path.startsWith('/api/business/embedded/');
        if(path.startsWith('/mcp-confirm')&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors ${embedded?"'self' "+ADMIN_FRAME_ANCESTORS.join(' '):"'none'"}`});res.end(html);return true;}
        const route=path.slice(('/api/business/'+(embedded?'embedded/':'')).length),write=req.method==='POST';
        if(!['GET','POST'].includes(req.method))throw Object.assign(new Error('Method not allowed'),{status:405});
        if(write&&(req.headers.origin!=='https://internal.110-lab.cn'&&!(localTest&&req.headers.origin==='http://'+req.headers.host)||req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin'))throw Object.assign(new Error('请在确认页面操作'),{status:403});
        let actor=mail.identity(req,{embedded,write});
        if(route==='session'&&!write){json(res,200,actor);return true;}
        const m=/^confirmations\/([a-f0-9-]{36})$/.exec(route);if(!m)throw Object.assign(new Error('Not found'),{status:404});z.uuid().parse(m[1]);
        if(!write)json(res,200,service.getConfirmation(actor,m[1]));
        else{
          if(req.headers['content-type']!=='application/json')throw Object.assign(new Error('Invalid content type'),{status:415});
          const chunks=[];let size=0;req.setTimeout(8000,()=>req.destroy());for await(const c of req){if((size+=c.length)>1024)throw Object.assign(new Error('Request too large'),{status:413});chunks.push(c);}req.setTimeout(0);
          const value=z.object({fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(JSON.parse(Buffer.concat(chunks)));
          actor=mail.identity(req,{embedded,write:true});json(res,200,service.confirm(actor,m[1],value.fingerprint));
        }
      }catch(e){req.resume();if(!res.headersSent)json(res,e instanceof z.ZodError||e instanceof SyntaxError?400:e.status||503,{error:e.status?e.message:e instanceof z.ZodError?'参数无效':'暂时无法完成操作',code:e.code||'BUSINESS_ERROR'});}
      return true;
    },
  };
}
