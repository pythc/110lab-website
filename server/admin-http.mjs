import {readFile} from 'node:fs/promises';
import {isIP} from 'node:net';
import {z} from 'zod';
import {AdminError,openAdminAuth} from './admin-auth.mjs';
import {UpdateError} from './updates.mjs';
import {MailAuthError} from './mail-auth.mjs';

const json=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
export const ADMIN_FRAME_ANCESTORS=Object.freeze([
  'https://internal-110-lab-cn.web-sandbox.oaiusercontent.com',
  // Observed 110lab 0.8.7 local-plugin sidebar and conversation sandbox origins.
  'codex-sandbox://mcp-app-378d4bef0808dd032fe89b17252aa980ad0e29f3d5ace47c.web-sandbox.oaiusercontent.com',
  'codex-sandbox://mcp-app-6231ba4b79ed6a654eda2cd7ee1cca5ff88c1453a659ea27.web-sandbox.oaiusercontent.com',
  'codex-sandbox://mcp-app-eb754d6717539b08789f5fc6b454ba6b2faf9c1a6a456d80.web-sandbox.oaiusercontent.com',
  'codex-sandbox://mcp-app-866fa2382627ef9fa973c3a972919d239ffee4f00b64dac0.web-sandbox.oaiusercontent.com'
]);
const revision=z.number().int().positive();
async function body(req,limit=32768){
  if(req.headers['content-type']!=='application/json')throw new AdminError(415,'请求格式无效');
  if(Number(req.headers['content-length']||0)>limit)throw new AdminError(413,'内容过长');
  const chunks=[];let size=0;
  await new Promise((resolve,reject)=>{
    let done=false;
    const finish=error=>{if(done)return;done=true;clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',abort);req.off('aborted',abort);if(error){req.resume();reject(error);}else resolve();};
    const data=c=>{size+=c.length;if(size>limit)finish(new AdminError(413,'内容过长'));else chunks.push(c);};
    const end=()=>finish(),abort=()=>finish(new AdminError(400,'请求中断'));
    const timer=setTimeout(()=>finish(new AdminError(408,'请求超时')),8000);timer.unref();
    req.on('data',data);req.once('end',end);req.once('error',abort);req.once('aborted',abort);
  });
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new AdminError(400,'请求格式无效');}
}
export async function createAdminHttp({updates,mail,legacyPasswordEnabled=false,enabled=process.env.PORTAL_ADMIN_ENABLED==='true',directory=process.env.PORTAL_ADMIN_DATA,configPath=process.env.PORTAL_ADMIN_CONFIG,config,origins=['https://internal.110-lab.cn'],trustedProxies=(process.env.PORTAL_RECRUITMENT_TRUSTED_PROXY_IPS||'').split(',').filter(Boolean),localTest=false}={}){
  if(!enabled)return {enabled:false,async handle(){return false;},close(){}};
  const shared=!!mail?.enabled;
  if(!shared&&!legacyPasswordEnabled)throw new Error('Dynamic management requires laboratory Feishu authentication');
  if(!updates||!shared&&(!directory||(!configPath&&!config)))throw new Error('Admin updates are not configured');
  if(origins.some(o=>{const u=new URL(o);return u.protocol!=='https:'&&!(localTest&&u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname));}))throw new Error('Admin origin must use HTTPS');
  if(trustedProxies.some(ip=>!isIP(ip)))throw new Error('Invalid trusted proxy');
  const auth=shared?null:openAdminAuth({directory,configPath,config,localTest}),html=await readFile(new URL('../dist/admin.html',import.meta.url),'utf8'),allowed=new Set(origins),proxies=new Set(trustedProxies);
  return {enabled:true,close(){auth?.close();},
    async handle(req,res,path,host){
      const pagePath=['/admin','/admin/','/admin/embedded'].includes(path);
      if(!pagePath&&!path.startsWith('/api/admin/'))return false;
      const embedded=path==='/admin/embedded'||path.startsWith('/api/admin/embedded/');
      if(path.startsWith('/api/admin/embedded/'))path='/api/admin/'+path.slice('/api/admin/embedded/'.length);
      try{
        const local=localTest&&['localhost','127.0.0.1'].includes(host);
        if(host!=='internal.110-lab.cn'&&!local)throw new AdminError(404,'Not found');
        if(pagePath&&['GET','HEAD'].includes(req.method)){
          const ancestors=embedded?"'self' "+ADMIN_FRAME_ANCESTORS.join(' '):"'none'";
          res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','Content-Security-Policy':`default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors ${ancestors}; form-action 'self'`});res.end(req.method==='HEAD'?undefined:embedded?html.replace('<body>','<body class="embedded">'):html);return true;
        }
        if(!['GET','POST'].includes(req.method))throw new AdminError(405,'请求方式无效');
        if(req.method==='POST'){
          if(!allowed.has(req.headers.origin)||(req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin'))throw new AdminError(403,'请通过工作台操作');
        }
        if(path==='/api/admin/login'&&req.method==='POST'){
          if(shared)throw new AdminError(410,'请使用实验室飞书身份登录');
          const value=z.object({username:z.string().min(1).max(40),password:z.string().min(1).max(256)}).strict().parse(await body(req,2048));
          if(Buffer.byteLength(value.password)>256)throw new AdminError(400,'请求格式无效');
          const remote=req.socket.remoteAddress||'unknown',forwarded=String(req.headers['x-forwarded-for']||'').split(',')[0].trim();
          const ip=proxies.has(remote)&&isIP(forwarded)?forwarded:remote;
          const result=await auth.login(value.username,value.password,ip,{embedded});res.setHeader('Set-Cookie',result.cookie);json(res,200,result.session);return true;
        }
        const session=shared?mail.identity(req,{embedded,write:req.method==='POST'}):auth.session(req.headers.cookie,{embedded});
        if(shared&&!['admin','super_admin'].includes(session.role))throw new AdminError(403,'需要实验室管理员权限');
        if(path==='/api/admin/session'&&req.method==='GET'){const {key,embedded:context,...publicSession}=session;json(res,200,publicSession);return true;}
        if(req.method==='POST'&&!shared)auth.csrf(session,req.headers['x-csrf-token']);
        if(path==='/api/admin/logout'&&req.method==='POST'){if(shared)throw new AdminError(410,'请退出实验室飞书身份');z.object({}).strict().parse(await body(req,128));res.setHeader('Set-Cookie',auth.logout(session));json(res,200,{loggedOut:true});return true;}
        if(path==='/api/admin/updates'){
          if(req.method==='GET'){json(res,200,{updates:updates.listDrafts()});return true;}
          const value=await body(req);json(res,201,updates.create(value));return true;
        }
        const match=/^\/api\/admin\/updates\/([a-f0-9-]{36})(?:\/(publish|withdraw))?$/.exec(path);
        if(!match)throw new AdminError(404,'Not found');
        const id=z.string().uuid().parse(match[1]),action=match[2];
        if(req.method==='GET'&&!action){json(res,200,updates.get(id));return true;}
        if(req.method!=='POST')throw new AdminError(405,'请求方式无效');
        let result;
        if(action==='publish'){const v=z.object({revision,confirmPublic:z.literal(true)}).strict().parse(await body(req,256));result=updates.publish(id,v.revision,{publicConfirmed:true});}
        else if(action==='withdraw'){const v=z.object({revision}).strict().parse(await body(req,256));result=updates.withdraw(id,v.revision);}
        else{const v=z.object({revision,content:z.unknown()}).strict().parse(await body(req));result=updates.edit(id,v.revision,v.content);}
        json(res,200,result);
      }catch(error){
        req.resume();if(res.headersSent||res.destroyed)return true;
        if(error instanceof AdminError||error instanceof MailAuthError)json(res,error.status,{error:error.message});
        else if(error instanceof UpdateError)json(res,error.code==='NOT_FOUND'?404:409,{error:error.code==='CONFLICT'?'内容已被修改 请重新加载后操作':'请先确认此内容适合公开',code:error.code});
        else if(error instanceof z.ZodError)json(res,400,{error:'请检查标题、正文和链接格式'});
        else{console.error('Admin request failed',error.code||error.name);json(res,503,{error:'暂时无法完成操作 请稍后重试'});}
      }
      return true;
    }
  };
}
