import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {isIP} from 'node:net';
import {z} from 'zod';
import {openMailAuth,readMailConfig,parseMailConfig,bootstrapMailOwner,MailAuthError} from './mail-auth.mjs';
import {openMailAccessStore,MailAccessError} from './mail-access-store.mjs';
import {ADMIN_FRAME_ANCESTORS} from './admin-http.mjs';
import {escapeHTML} from './render.mjs';
import {openMailOAuth,mailAuthChallenge} from './mail-oauth.mjs';
import {createWorkspaceDirectory} from './workspace-directory.mjs';
import {openMailMembershipState} from './mail-membership-state.mjs';
import {openLabSso} from './lab-sso.mjs';

const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const revision=z.number().int().positive(),email=z.string().email().max(254);
const accessMessages={'forbidden':'需要超级管理员权限','revision conflict':'名单已变更 请重新加载','member must log in first':'该成员尚未通过飞书登录','administrator already exists':'该成员已经是管理员','cannot revoke super administrator':'请先转让超级管理员','target must be an active administrator':'请选择已验证的普通管理员','administrator not found':'该管理员已不存在','duplicate email':'该邮箱已绑定其他身份','email cannot be changed':'企业身份信息已变更 请联系负责人'};
async function body(req){
  if(req.headers['content-type']!=='application/json')throw new MailAuthError(415,'请求格式无效');
  if(Number(req.headers['content-length']||0)>4096)throw new MailAuthError(413,'请求过长');
  const chunks=[];let size=0;
  await new Promise((resolve,reject)=>{let done=false;
    const finish=error=>{if(done)return;done=true;clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',abort);req.off('aborted',abort);if(error){req.resume();reject(error);}else resolve();};
    const data=c=>{size+=c.length;if(size>4096)finish(new MailAuthError(413,'请求过长'));else chunks.push(c);},end=()=>finish(),abort=()=>finish(new MailAuthError(400,'请求中断'));
    const timer=setTimeout(()=>finish(new MailAuthError(408,'请求超时')),8000);timer.unref();req.on('data',data);req.once('end',end);req.once('error',abort);req.once('aborted',abort);
  });
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new MailAuthError(400,'请求格式无效');}
}
function page(res,html,{head=false,embedded=false,status=200}={}){
  const ancestors=embedded?"'self' "+ADMIN_FRAME_ANCESTORS.join(' '):"'none'";
  res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer','Content-Security-Policy':`default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors ${ancestors}; form-action 'self'`});res.end(head?undefined:html);
}
export async function createMailHttp({enabled=process.env.PORTAL_MAIL_ENABLED==='true',assessmentSsoEnabled=process.env.PORTAL_ASSESSMENT_SSO_ENABLED==='true',notifyEnabled=process.env.PORTAL_MAIL_NOTIFY_ENABLED==='true',directory=process.env.PORTAL_MAIL_DATA,configPath=process.env.PORTAL_MAIL_CONFIG,config,localTest=false,now=Date.now,fetchIdentity,fetchDirectory,trustedProxies=(process.env.PORTAL_RECRUITMENT_TRUSTED_PROXY_IPS||'').split(',').filter(Boolean)}={}){
  const html=await readFile(new URL('../dist/mail.html',import.meta.url),'utf8');
  if(trustedProxies.some(p=>!isIP(p)))throw new Error('Invalid mail trusted proxy');
  const proxies=new Set(trustedProxies);let auth,access,oauth,membership;
  if(notifyEnabled&&!enabled)throw new Error('Notify mailbox requires mail login');
  if(enabled){if(!directory||(!config&&!configPath))throw new Error('Mail login requires private configuration');config=config?parseMailConfig(config):readMailConfig(configPath);auth=openMailAuth({directory,config,now,localTest,fetchIdentity});try{access=openMailAccessStore({filename:join(directory,'mail-access.sqlite'),bootstrapOwner:bootstrapMailOwner(config),now});}catch(e){auth.close();throw e;}}
  if(enabled){try{oauth=openMailOAuth({directory,config,auth,access,now,localTest,trustedProxies});}catch(e){auth.close();access.close();throw e;}}
  if(notifyEnabled){try{membership=openMailMembershipState({directory,now});}catch(e){oauth.close();auth.close();access.close();throw e;}}
  const projectDirectory=enabled?(fetchDirectory?{list:fetchDirectory}:localTest?null:createWorkspaceDirectory({config,now})):null;
  const sso=assessmentSsoEnabled&&enabled?openLabSso({directory,auth,access,now}):null;
  return {enabled,
    businessIdentity:(header,scopes)=>{if(!oauth)throw new MailAuthError(503,'飞书登录尚未配置');return oauth.businessIdentity(header,scopes);},
    profile:subject=>{if(!access)throw new MailAuthError(503,'飞书登录尚未配置');return access.me(subject);},
    workspaceDirectory:directory?join(directory,'workspace'):null,
    mailboxReady(subject,address){access.assertAdministrator(subject);return address==='noreply@110-lab.cn'||address==='noreply@notify.110-lab.cn'&&membership?.status(access.membershipSnapshot().revision).state==='ready';},
    roleForSubject(subject){return access?.me(subject)?.role||'member';},
    // Trusted in-process adapter. Every request re-reads the current lab role.
    identity(req,{embedded=false,write=false}={}) {
      if(!enabled)throw new MailAuthError(503,'飞书登录尚未配置');
      const session=auth.session(req.headers.cookie,{embedded});
      if(write)auth.csrf(session,req.headers['x-csrf-token']);
      return {...access.me(session.subject),csrf:session.csrf,expiresAt:session.expiresAt};
    },
    members(subject){return access.listLabMembers(subject);},
    async projectMembers(subject){
      const known=access.listLabMembers(subject);
      if(!projectDirectory)return {members:known,source:'registered',unavailable:false};
      try{
        const members=await projectDirectory.list(),verified=new Map(known.map(m=>[m.subject,m]));
        return {members:members.map(m=>({...m,email:verified.get(m.subject)?.email||m.email})),source:'feishu',unavailable:false};
      }catch{return {members:known,source:'registered',unavailable:true};}
    },
    hostAuthorized:(header,options)=>oauth?oauth.authorized(header,options):Promise.resolve(false),hostHandoff:(header,state,options)=>oauth?oauth.handoff(header,state,options):Promise.resolve(mailAuthChallenge()),close(){sso?.close();membership?.close();oauth?.close();auth?.close();access?.close();},async handle(req,res,path,host){
    if(oauth?.handle(req,res,path,host))return true;
    if(!['/mail','/mail/','/mail/embedded','/mail/auth/launch','/mail/auth/callback','/sso/assessment','/sso/assessment/embedded'].includes(path)&&!path.startsWith('/api/mail/'))return false;
    const embedded=path.endsWith('/embedded')||path.startsWith('/api/mail/embedded/');
    const route=embedded&&path.startsWith('/api/mail/embedded/')?'/api/mail/'+path.slice('/api/mail/embedded/'.length):path;
    try{
      if(host!=='internal.110-lab.cn'&&!(localTest&&['127.0.0.1','localhost'].includes(host)))throw new MailAuthError(404,'Not found');
      if(path.startsWith('/sso/assessment')&&req.method==='GET'){
        if(!sso)throw new MailAuthError(503,'考核飞书登录尚未启用');
        page(res,await readFile(new URL('../dist/assessment-sso.html',import.meta.url),'utf8'),{embedded});return true;
      }
      if(['/mail','/mail/','/mail/embedded'].includes(path)&&['GET','HEAD'].includes(req.method)){page(res,embedded?html.replace('<body>','<body class="embedded">'):html,{head:req.method==='HEAD',embedded});return true;}
      if(route==='/api/mail/config'&&req.method==='GET'){json(res,200,{loginAvailable:enabled,notifyManualSend:notifyEnabled,persistentLoginDays:30,restorePolicy:1});return true;}
      if(!enabled)throw new MailAuthError(503,'飞书登录尚未配置');
      if(!['GET','POST'].includes(req.method))throw new MailAuthError(405,'请求方式无效');
      if(['/api/mail/sso/exchange','/api/mail/sso/inspect'].includes(path)&&req.method==='POST'){
        // Back-channel only. A browser Origin is never accepted as a service credential.
        if(!sso||req.headers.origin||req.headers['sec-fetch-site'])throw new MailAuthError(403,'请求来源无效');
        const value=await body(req);
        if(path.endsWith('/exchange')){const v=z.object({code:z.string(),verifier:z.string(),state:z.string(),redirectUri:z.string()}).strict().parse(value);json(res,200,sso.exchange(v));}
        else{const v=z.object({token:z.string()}).strict().parse(value);json(res,200,sso.inspect(v.token));}
        return true;
      }
      const originOK=req.headers.origin==='https://internal.110-lab.cn'||localTest&&req.headers.origin==='http://'+req.headers.host;
      if(req.method==='POST'&&(!originOK||req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin'))throw new MailAuthError(403,'请在公共邮箱管理页面操作');
      if(route==='/api/mail/auth/start'&&req.method==='POST'){
        z.object({}).strict().parse(await body(req));let expectedSubject=null;
        try{expectedSubject=auth.session(req.headers.cookie,{embedded}).subject;}catch(e){if(!(e instanceof MailAuthError)||e.status!==401)throw e;}
        const remote=req.socket.remoteAddress||'unknown',forwarded=String(req.headers['x-forwarded-for']||'').split(',')[0].trim(),ip=proxies.has(remote)&&isIP(forwarded)?forwarded:remote;
        const result=auth.start(req.headers.cookie,{embedded,ip,expectedSubject});res.setHeader('Set-Cookie',result.cookie);json(res,200,{state:result.state,launchUrl:result.launchUrl});return true;
      }
      if(path==='/mail/auth/launch'&&req.method==='GET'){
        const params=new URL(req.url,'https://internal.110-lab.cn').searchParams;
        if(params.getAll('state').length!==1)throw new MailAuthError(400,'登录链接无效');
        const result=auth.launch(params.get('state'));res.writeHead(303,{'Location':result.url,'Set-Cookie':result.cookie,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();return true;
      }
      if(path==='/mail/auth/callback'&&req.method==='GET'){
        const params=new URL(req.url,'https://internal.110-lab.cn').searchParams;
        if(params.getAll('state').length!==1||params.getAll('code').length!==1||params.has('error'))throw new MailAuthError(401,'飞书登录未完成 请重新登录');
        const pending=await auth.callback(params.get('state'),params.get('code'),req.headers.cookie);
        if(oauth.finishCallback(params.get('state'),pending.profile,req,res,(browserSession=false)=>{access.registerIdentity(pending.profile);if(browserSession)res.setHeader('Set-Cookie',pending.complete().cookie);else pending.consumeForHost();}))return true;
        access.registerIdentity(pending.profile);const result=pending.complete();res.setHeader('Set-Cookie',result.cookie);
        const script=JSON.stringify({type:'110lab-mail-login',state:result.state,ticket:result.ticket});
        page(res,`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>飞书登录完成 · 110lab</title><style>body{margin:0;padding:40px 24px;font:16px/1.6 system-ui;background:#f6f8fb;color:#20242c}main{max-width:520px;margin:auto;padding:24px;background:white;border-radius:16px}code{display:block;overflow-wrap:anywhere;padding:12px;background:#f2f5fa}a{color:#235fd5}</style><main><h1>已登录</h1><p>${escapeHTML(pending.profile.name)} · ${escapeHTML(pending.profile.email)}</p><p>返回工作台或公共邮箱管理。如果原窗口未自动登录，可输入下面的一次性登录码</p><code>${result.ticket}</code><p><a href="/workbench">返回工作台</a> · <a href="/mail">打开公共邮箱管理</a></p></main><script>const message=${script};if(window.opener)window.opener.postMessage(message,'https://internal.110-lab.cn');</script></html>`);return true;
      }
      if(route==='/api/mail/auth/redeem'&&req.method==='POST'){
        const v=z.object({state:z.string().regex(/^[\w-]{43}$/),ticket:z.string().regex(/^[\w-]{43}$/)}).strict().parse(await body(req));
        const result=auth.redeem(v.state,v.ticket,req.headers.cookie,{embedded});res.setHeader('Set-Cookie',result.cookie);json(res,200,{loggedIn:true});return true;
      }
      const session=auth.session(req.headers.cookie,{embedded}),me=access.me(session.subject);
      if(route==='/api/mail/session'&&req.method==='GET'){json(res,200,{...me,csrf:session.csrf,expiresAt:session.expiresAt});return true;}
      if(route==='/api/mail/notify'&&req.method==='GET'){
        access.assertAdministrator(session.subject);
        if(!membership){json(res,200,{state:'disabled'});return true;}
        const state=membership.status(access.membershipSnapshot().revision);
        json(res,200,{...state,...(state.state==='ready'?{url:'https://www.feishu.cn/mail'}:{})});return true;
      }
      if(req.method==='POST')auth.csrf(session,req.headers['x-csrf-token']);
      if(route==='/api/mail/sso/authorize'&&req.method==='POST'){
        if(!sso)throw new MailAuthError(503,'考核飞书登录尚未启用');
        const value=z.object({state:z.string(),challenge:z.string(),embedded:z.boolean()}).strict().parse(await body(req));
        if(value.embedded!==embedded)throw new MailAuthError(400,'登录上下文不一致');
        json(res,200,sso.authorize(session,value));return true;
      }
      if(route==='/api/mail/logout'&&req.method==='POST'){z.object({}).strict().parse(await body(req));res.setHeader('Set-Cookie',auth.logout(session));json(res,200,{loggedOut:true});return true;}
      if(route==='/api/mail/administrators'&&req.method==='GET'){json(res,200,access.listAdministrators(session.subject));return true;}
      if(route==='/api/mail/members'&&req.method==='GET'){json(res,200,{members:access.listMembers(session.subject)});return true;}
      if(route==='/api/mail/audit'&&req.method==='GET'){json(res,200,{events:access.audit(session.subject).entries});return true;}
      if(['/api/mail/administrators/grant','/api/mail/administrators/revoke','/api/mail/administrators/transfer'].includes(route)&&req.method==='POST'){
        const v=z.object({email,revision,confirmed:z.literal(true)}).strict().parse(await body(req));auth.recent(session);
        if(route.endsWith('/grant'))access.grantAdministrator(session.subject,v.email,v.revision);
        else if(route.endsWith('/revoke'))access.revokeAdministrator(session.subject,v.email,v.revision);
        else access.transferSuperAdministrator(session.subject,v.email,v.revision);
        json(res,200,{changed:true,...(membership?{mailbox:membership.status(access.membershipSnapshot().revision)}:{})});return true;
      }
      throw new MailAuthError(404,'Not found');
    }catch(error){
      req.resume();if(res.headersSent||res.destroyed)return true;
      if(path==='/mail/auth/callback'&&host==='internal.110-lab.cn'){
        const text=error instanceof MailAuthError?error.message:'暂时无法完成飞书登录 请重新登录';
        page(res,`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>飞书登录未完成 · 110lab</title><main><h1>登录未完成</h1><p>${escapeHTML(text)}</p><p>授权通知仅表示飞书已记录授权 公共邮箱登录尚未完成</p><a href="/mail">返回公共邮箱管理</a></main></html>`,{status:error instanceof MailAuthError?error.status:503});return true;
      }
      if(error instanceof MailAuthError)json(res,error.status,{error:error.message});
      else if(error instanceof MailAccessError)json(res,error.status,{error:accessMessages[error.message]||'无法完成管理员操作 请检查信息后重试'});
      else if(error instanceof z.ZodError)json(res,400,{error:'请检查邮箱和操作信息'});
      else{console.error('Mail management failed',error.code||error.name);json(res,503,{error:'暂时无法完成操作 请稍后再试'});}
      return true;
    }
  }};
}
