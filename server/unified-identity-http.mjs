import {isIP} from 'node:net';
import {readFile} from 'node:fs/promises';
import {openUnifiedIdentity,IDENTITY_ISSUER,SERVICES} from './unified-identity.mjs';
import {MailAuthError} from './mail-auth.mjs';
export async function createUnifiedIdentityHttp(options){
  const html=await readFile(new URL('../dist/identity.html',import.meta.url),'utf8');
  const store=options.enabled?openUnifiedIdentity(options):null;
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end(JSON.stringify(data));};
  async function read(req){if(!String(req.headers['content-type']||'').startsWith('application/json'))throw new MailAuthError(415,'请求格式无效');let size=0,parts=[];const timeout=setTimeout(()=>req.destroy(),8000);timeout.unref();try{for await(const p of req){size+=p.length;if(size>8192)throw new MailAuthError(413,'请求过长');parts.push(p);}return JSON.parse(Buffer.concat(parts));}catch(e){if(e instanceof MailAuthError)throw e;throw new MailAuthError(400,'请求无效');}finally{clearTimeout(timeout);}}
  return {finish:(...args)=>store?.finish(...args)||false,close(){store?.close();},async handle(req,res,path,host){
    if(path!=='/auth'&&path!=='/auth/'&&!path.startsWith('/api/identity/'))return false;
    try{
      if(host!=='internal.110-lab.cn'&&!(options.localTest&&host==='127.0.0.1'))throw new MailAuthError(404,'页面不存在');
      if(['GET','HEAD'].includes(req.method)&&['/auth','/auth/'].includes(path)){
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex,nofollow','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https://*.feishucdn.com data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'"});res.end(req.method==='HEAD'?undefined:html);return true;
      }
      if(path==='/api/identity/config'&&req.method==='GET'){json(res,200,{enabled:!!store,services:{...SERVICES,assessment:{...SERVICES.assessment,url:options.assessmentSsoEnabled?SERVICES.assessment.url:'https://exam.110-lab.cn/login'}}});return true;}
      if(!store)throw new MailAuthError(503,'登录暂时不可用');
      if(req.method==='GET'&&path==='/api/identity/session'){json(res,200,await store.session(req.headers.cookie));return true;}
      if(req.method!=='POST')throw new MailAuthError(405,'请求方式无效');
      const back=['exchange','inspect','revoke'].find(v=>path==='/api/identity/'+v);
      if(back){if(req.headers.origin||req.headers['sec-fetch-site'])throw new MailAuthError(403,'仅供服务连接使用');const input=await read(req);const keys=back==='exchange'?['audience','code','state','verifier','redirectUri']:['audience','token'];if(Object.keys(input).some(k=>!keys.includes(k)))throw new MailAuthError(400,'请求无效');json(res,200,await store[back](input)||{revoked:true});return true;}
      const origin=options.localTest?'http://'+req.headers.host:IDENTITY_ISSUER;
      if(req.headers.origin!==origin||req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin')throw new MailAuthError(403,'请在登录页面操作');
      const input=await read(req);
      if(path==='/api/identity/login'){if(Object.keys(input).some(k=>k!=='next'))throw new MailAuthError(400,'请求无效');const result=store.start(req.headers.cookie,input.next,options.trustedProxies?.includes(req.socket.remoteAddress)&&isIP(String(req.headers['x-forwarded-for']||'').split(',')[0].trim())?String(req.headers['x-forwarded-for']).split(',')[0].trim():req.socket.remoteAddress);res.setHeader('Set-Cookie',result.cookie);json(res,200,{launchUrl:result.launchUrl});return true;}
      if(path==='/api/identity/logout'){if(Object.keys(input).length)throw new MailAuthError(400,'请求无效');res.setHeader('Set-Cookie',store.logout(req.headers.cookie,req.headers['x-csrf-token']));json(res,200,{loggedOut:true});return true;}
      if(path==='/api/identity/authorize'){if(Object.keys(input).some(k=>!['audience','redirectUri','state','challenge'].includes(k)))throw new MailAuthError(400,'请求无效');json(res,200,await store.authorize(req.headers.cookie,req.headers['x-csrf-token'],input));return true;}
      throw new MailAuthError(404,'页面不存在');
    }catch(e){req.resume();if(!res.headersSent)json(res,e instanceof MailAuthError?e.status:503,{error:e instanceof MailAuthError?e.message:'暂时无法完成登录'});return true;}
  }};
}
