import express from 'express';
import {DatabaseSync} from 'node:sqlite';
import {lstatSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {authorizationHandler} from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import {tokenHandler} from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import {clientRegistrationHandler} from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import {revocationHandler} from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import {redirectUriMatches} from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import {InvalidClientMetadataError,InvalidGrantError,InvalidRequestError,InvalidScopeError,InvalidTokenError} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {escapeHTML} from './render.mjs';

export const MAIL_ISSUER='https://internal.110-lab.cn';
export const MAIL_RESOURCE=MAIL_ISSUER+'/mcp/workbench-v6-1';
export const MAIL_HOST_SCOPE='mail:session';
export const MAIL_RESOURCE_METADATA=MAIL_ISSUER+'/.well-known/oauth-protected-resource/mcp/workbench-v6-1';
const hash=s=>createHash('sha256').update(s).digest('hex'),nonce=()=>randomBytes(32).toString('base64url');
const secret=s=>typeof s==='string'&&/^[\w-]{43}$/.test(s);
const lifetime=8*3600000;

// DCR is restricted to the actual supported hosts. Loopback port variation is
// handled by the SDK; scheme, hostname and callback path still match exactly.
export function allowedMailRedirect(value){
  try{const u=new URL(value);if(u.username||u.password||u.search||u.hash)return false;
    if(u.origin==='https://chatgpt.com')return u.pathname==='/connector_platform_oauth_redirect'||/^\/connector\/oauth\/[A-Za-z0-9_-]{8,100}$/.test(u.pathname);
    return u.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(u.hostname)&&/^\/callback(?:\/[A-Za-z0-9_-]{8,100})?$/.test(u.pathname);
  }catch{return false;}
}
export function mailAuthChallenge(){return {isError:true,content:[{type:'text',text:'请连接 110lab 的飞书身份后继续登录'}],_meta:{'mcp/www_authenticate':[`Bearer resource_metadata="${MAIL_RESOURCE_METADATA}", scope="${MAIL_HOST_SCOPE}", error="invalid_token", error_description="Connect your Feishu identity to sign in to 110lab"`]}};}

export function openMailOAuth({directory,config,auth,access,now=Date.now,localTest=false,trustedProxies=[]}){
  const path=join(directory,'mail-oauth.sqlite');
  try{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077))throw new Error('Unsafe mail OAuth database');}catch(e){if(e.code!=='ENOENT')throw e;}
  const db=new DatabaseSync(path);chmodSync(path,0o600);
  db.exec(`PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS oauth_clients(id TEXT PRIMARY KEY,data TEXT NOT NULL,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_requests(id TEXT PRIMARY KEY,binding TEXT NOT NULL,client TEXT NOT NULL,redirect TEXT NOT NULL,state TEXT,challenge TEXT NOT NULL,flow TEXT,subject TEXT,authenticated INTEGER,status TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_codes(key TEXT PRIMARY KEY,client TEXT NOT NULL,redirect TEXT NOT NULL,challenge TEXT NOT NULL,subject TEXT NOT NULL,authenticated INTEGER NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_tokens(key TEXT PRIMARY KEY,kind TEXT NOT NULL,client TEXT NOT NULL,family TEXT NOT NULL,subject TEXT NOT NULL,authenticated INTEGER NOT NULL,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS oauth_configuration(id TEXT PRIMARY KEY);`);
  const configId=hash(JSON.stringify(config));
  if(!db.prepare('SELECT id FROM oauth_configuration WHERE id=?').get(configId)){db.exec('DELETE FROM oauth_requests; DELETE FROM oauth_codes; DELETE FROM oauth_tokens; DELETE FROM oauth_configuration;');db.prepare('INSERT INTO oauth_configuration VALUES(?)').run(configId);}
  const clean=()=>{db.prepare('DELETE FROM oauth_requests WHERE expires<=?').run(now());db.prepare('DELETE FROM oauth_codes WHERE expires<=?').run(now());db.prepare('DELETE FROM oauth_tokens WHERE authenticated+?<=?').run(lifetime,now());};
  clean();const timer=setInterval(clean,60000);timer.unref();
  const bindingName=localTest?'110lab_oauth_test':'__Host-110lab_oauth';
  const cookie=(binding)=>`${bindingName}=${binding}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${localTest?'':'; Secure'}`;
  const binding=header=>{const values=String(header||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(bindingName+'='));return values.length===1&&secret(values[0].slice(bindingName.length+1))?values[0].slice(bindingName.length+1):'';};
  const getRequest=(id,header)=>{const row=secret(id)&&db.prepare('SELECT * FROM oauth_requests WHERE id=? AND expires>?').get(hash(id),now());if(!row||!binding(header)||row.binding!==hash(binding(header)))throw new InvalidGrantError('Authorization page expired. Start again from 110lab.');return row;};
  // Keep same-origin POST Origin intact without forwarding OAuth URL query parameters.
  const respond=(res,title,content,status=200)=>{res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'strict-origin','X-Robots-Tag':'noindex, nofollow','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · 110lab</title><style>body{background:#f5f7fa;color:#202a38;font:15px/1.7 system-ui;margin:0;padding:48px 20px}main{max-width:440px;margin:auto;padding:28px;background:white;border:1px solid #e1e6ee;border-radius:16px}h1{font-size:23px;margin:0 0 12px}p{overflow-wrap:anywhere;color:#58677b}button{font:inherit;border:0;border-radius:9px;background:#23304b;color:white;padding:10px 18px;cursor:pointer}form{margin-top:22px}</style><main><h1>${title}</h1>${content}</main></html>`);};
  const form=(id,endpoint,label)=>`<form method="post" action="${endpoint}"><input type="hidden" name="request" value="${id}"><button>${label}</button></form>`;
  // Chromium applies form-action to the entire redirect chain. Finish the
  // same-origin POST first, then navigate without forwarding a form or referrer.
  const navigate=(res,destination)=>{
    const url=new URL(destination);
    if(url.username||url.password||!(url.origin==='https://accounts.feishu.cn'&&url.pathname==='/open-apis/authen/v1/authorize'||allowedMailRedirect(url.origin+url.pathname)))throw new InvalidRequestError('Invalid navigation destination');
    const target=escapeHTML(url.href);
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','Content-Security-Policy':"default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"});
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><title>正在继续登录 · 110lab</title><p>正在继续登录</p><a href="${target}" rel="noreferrer">继续</a></html>`);
  };
  const mint=(row,family=nonce())=>{const accessToken=nonce(),refreshToken=nonce(),absolute=row.authenticated+lifetime,expires=Math.min(now()+30*60000,absolute);if(expires<=now())throw new InvalidGrantError('Sign in again');for(const [token,kind,expiry]of [[accessToken,'access',expires],[refreshToken,'refresh',absolute]])db.prepare('INSERT INTO oauth_tokens VALUES(?,?,?,?,?,?,?,0)').run(hash(token),kind,row.client,family,row.subject,row.authenticated,expiry);return {access_token:accessToken,token_type:'Bearer',expires_in:Math.floor((expires-now())/1000),refresh_token:refreshToken,scope:MAIL_HOST_SCOPE};};
  const checkResource=resource=>{if(resource?.href!==MAIL_RESOURCE)throw new InvalidRequestError('Invalid resource');};
  const provider={
    clientsStore:{
      getClient(id){if(typeof id!=='string'||id.length>100)return undefined;const row=db.prepare('SELECT data FROM oauth_clients WHERE id=?').get(id);return row?JSON.parse(row.data):undefined;},
      registerClient(client){
        if(!Array.isArray(client.redirect_uris)||!client.redirect_uris.length||client.redirect_uris.length>4||!client.redirect_uris.every(allowedMailRedirect)||!['none','client_secret_post'].includes(client.token_endpoint_auth_method||'client_secret_post')||client.scope&&client.scope!==MAIL_HOST_SCOPE||(client.grant_types||[]).some(v=>!['authorization_code','refresh_token'].includes(v))||(client.response_types||[]).some(v=>v!=='code')||db.prepare('SELECT count(*) AS n FROM oauth_clients').get().n>=500)throw new InvalidClientMetadataError('Unsupported client registration');
        const saved={...client,client_id:nonce(),client_id_issued_at:Math.floor(now()/1000),scope:MAIL_HOST_SCOPE};
        // Do not persist unbounded or irrelevant caller-controlled URLs/text.
        for(const key of Object.keys(saved))if(!['client_id','client_id_issued_at','client_secret','client_secret_expires_at','token_endpoint_auth_method','redirect_uris','grant_types','response_types','scope'].includes(key))delete saved[key];
        db.prepare('INSERT INTO oauth_clients VALUES(?,?,?)').run(saved.client_id,JSON.stringify(saved),now());return saved;
      }
    },
    async authorize(client,params,res){
      checkResource(params.resource);if(params.scopes?.some(v=>v!==MAIL_HOST_SCOPE))throw new InvalidScopeError('Unsupported scope');if(!secret(params.codeChallenge)||typeof params.state!=='string'||params.state.length<8||params.state.length>1024)throw new InvalidRequestError('PKCE and state are required');
      const id=nonce(),bind=nonce();db.prepare('INSERT INTO oauth_requests VALUES(?,?,?,?,?,?,NULL,NULL,NULL,?,?)').run(hash(id),hash(bind),client.client_id,params.redirectUri,params.state,params.codeChallenge,'created',now()+10*60000);
      res.setHeader('Set-Cookie',cookie(bind));respond(res,'连接 110lab 公共邮箱',`<p>使用飞书企业身份登录插件<br>此连接仅用于公共邮箱身份验证 不授予发信权限</p>${form(id,'/mail/oauth/login','使用飞书继续')}`);
    },
    skipLocalPkceValidation:true,
    async challengeForAuthorizationCode(){throw new InvalidGrantError('PKCE is verified atomically during exchange');},
    async exchangeAuthorizationCode(client,code,verifier,redirectUri,resource){
      checkResource(resource);const row=secret(code)&&db.prepare('SELECT * FROM oauth_codes WHERE key=? AND expires>?').get(hash(code),now());
      if(!row||row.client!==client.client_id||redirectUri!==row.redirect||typeof verifier!=='string'||!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)||createHash('sha256').update(verifier).digest('base64url')!==row.challenge)throw new InvalidGrantError('Invalid authorization code or PKCE verifier');
      db.exec('BEGIN IMMEDIATE');try{if(db.prepare('DELETE FROM oauth_codes WHERE key=? AND expires>?').run(hash(code),now()).changes!==1)throw new InvalidGrantError('Authorization code already used or expired');const result=mint(row);db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}
    },
    async exchangeRefreshToken(client,token,scopes,resource){
      checkResource(resource);if(scopes?.some(v=>v!==MAIL_HOST_SCOPE))throw new InvalidScopeError('Unsupported scope');
      let result,reused=false;
      // Read and consume under one write lock, including across HTTP processes.
      // A concurrent replay must revoke the winner's newly issued token family.
      db.exec('BEGIN IMMEDIATE');try{const row=secret(token)&&db.prepare("SELECT * FROM oauth_tokens WHERE key=? AND kind='refresh'").get(hash(token));if(!row||row.client!==client.client_id||row.expires<=now())throw new InvalidGrantError('Refresh token expired');if(row.used){db.prepare('DELETE FROM oauth_tokens WHERE family=?').run(row.family);reused=true;}else{db.prepare('UPDATE oauth_tokens SET used=1 WHERE key=?').run(hash(token));result=mint(row,row.family);}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
      if(reused)throw new InvalidGrantError('Refresh token reused');return result;
    },
    async verifyAccessToken(token){
      const row=secret(token)&&db.prepare("SELECT * FROM oauth_tokens WHERE key=? AND kind='access' AND expires>?").get(hash(token),now());if(!row||row.used)throw new InvalidTokenError('Sign in required');
      return {token,clientId:row.client,scopes:[MAIL_HOST_SCOPE],expiresAt:Math.floor(row.expires/1000),resource:new URL(MAIL_RESOURCE),extra:{subject:row.subject,authenticatedAt:row.authenticated,family:row.family}};
    },
    async revokeToken(client,{token}){if(!secret(token))return;const row=db.prepare('SELECT family FROM oauth_tokens WHERE key=? AND client=?').get(hash(token),client.client_id);if(row)db.prepare('DELETE FROM oauth_tokens WHERE family=?').run(row.family);}
  };
  const hostIdentity=async(header,{fresh=false}={})=>{
    if(typeof header!=='string'||!/^Bearer [\w-]{43}$/.test(header))throw new InvalidTokenError('Sign in required');
    const info=await provider.verifyAccessToken(header.slice(7));
    if(fresh&&now()-info.extra.authenticatedAt>5*60000){await provider.revokeToken({client_id:info.clientId},{token:info.token});throw new InvalidTokenError('Fresh sign in required');}
    return info;
  };
  const app=express();app.disable('x-powered-by');app.set('trust proxy',ip=>trustedProxies.includes(ip));
  app.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');next();});
  app.use(express.json({limit:'8kb'}),express.urlencoded({extended:false,limit:'8kb',parameterLimit:20}));
  const metadata={issuer:MAIL_ISSUER,authorization_response_iss_parameter_supported:true,authorization_endpoint:MAIL_ISSUER+'/authorize',token_endpoint:MAIL_ISSUER+'/token',registration_endpoint:MAIL_ISSUER+'/register',revocation_endpoint:MAIL_ISSUER+'/revoke',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none','client_secret_post'],revocation_endpoint_auth_methods_supported:['none','client_secret_post'],scopes_supported:[MAIL_HOST_SCOPE]};
  app.get('/.well-known/oauth-authorization-server',(_req,res)=>res.set('Access-Control-Allow-Origin','*').json(metadata));
  app.get(['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp','/.well-known/oauth-protected-resource/mcp/workbench-v6-1'],(_req,res)=>res.set('Access-Control-Allow-Origin','*').json({resource:MAIL_RESOURCE,authorization_servers:[MAIL_ISSUER],scopes_supported:[MAIL_HOST_SCOPE],resource_name:'110lab 公共邮箱登录'}));
  // The SDK validates registered redirects before issuing protocol errors.
  // Add RFC 9207 issuer identification to both success and error redirects.
  app.use('/authorize',(req,res,next)=>{const redirect=res.redirect.bind(res);res.redirect=(status,url)=>{if(typeof status==='string'){url=status;status=302;}if(allowedMailRedirect(url.split('?')[0])){const u=new URL(url);u.searchParams.set('iss',MAIL_ISSUER);url=u.href;}return redirect(status,url);};next();},authorizationHandler({provider}));
  app.use('/token',tokenHandler({provider}));app.use('/register',clientRegistrationHandler({clientsStore:provider.clientsStore}));app.use('/revoke',revocationHandler({provider}));
  const sameOrigin=req=>req.headers.origin===MAIL_ISSUER&&(!req.headers['sec-fetch-site']||req.headers['sec-fetch-site']==='same-origin');
  app.post('/mail/oauth/login',(req,res)=>{
    try{if(!sameOrigin(req))throw new InvalidRequestError('Use the authorization page');const id=req.body.request,row=getRequest(id,req.headers.cookie);if(row.status!=='created')throw new InvalidGrantError('Authorization already started');
      if(db.prepare("UPDATE oauth_requests SET status='starting' WHERE id=? AND status='created'").run(hash(id)).changes!==1)throw new InvalidGrantError('Authorization already started');
      const started=auth.start(req.headers.cookie,{ip:req.ip});const launch=auth.launch(started.state);if(db.prepare("UPDATE oauth_requests SET status='launched',flow=? WHERE id=? AND status='starting'").run(hash(started.state),hash(id)).changes!==1)throw new InvalidGrantError('Authorization unavailable');res.append('Set-Cookie',launch.cookie);navigate(res,launch.url);
    }catch{respond(res,'登录未完成','<p>此授权页面已失效 请返回插件重新登录</p>',400);}
  });
  app.post('/mail/oauth/approve',(req,res)=>{
    try{if(!sameOrigin(req))throw new InvalidRequestError('Use the authorization page');const id=req.body.request,row=getRequest(id,req.headers.cookie);if(row.status!=='verified'||!row.subject)throw new InvalidGrantError('Verify your identity first');
      const client=provider.clientsStore.getClient(row.client);if(!client||!client.redirect_uris.some(r=>redirectUriMatches(row.redirect,r)))throw new InvalidGrantError('Client unavailable');
      const code=nonce();db.exec('BEGIN IMMEDIATE');try{if(db.prepare("UPDATE oauth_requests SET status='consumed' WHERE id=? AND status='verified'").run(hash(id)).changes!==1)throw new InvalidGrantError('Authorization already completed');db.prepare('INSERT INTO oauth_codes VALUES(?,?,?,?,?,?,?)').run(hash(code),row.client,row.redirect,row.challenge,row.subject,row.authenticated,now()+60000);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
      const url=new URL(row.redirect);url.searchParams.set('code',code);url.searchParams.set('state',row.state);url.searchParams.set('iss',MAIL_ISSUER);navigate(res,url.href);
    }catch{respond(res,'连接未完成','<p>此授权页面已失效 请返回插件重新登录</p>',400);}
  });
  app.use((_error,_req,res,_next)=>res.status(400).json({error:'invalid_request',error_description:'Invalid OAuth request'}));
  const paths=new Set(['/authorize','/token','/register','/revoke','/mail/oauth/login','/mail/oauth/approve','/.well-known/oauth-authorization-server','/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp','/.well-known/oauth-protected-resource/mcp/workbench-v6-1']);
  return {provider,
    async authorized(header,options){try{await hostIdentity(header,options);return true;}catch(e){if(e instanceof InvalidTokenError)return false;throw e;}},
    handle(req,res,path,host){if(!paths.has(path))return false;if(host!=='internal.110-lab.cn'&&!(localTest&&host==='127.0.0.1')){res.writeHead(404);res.end();return true;}app(req,res);return true;},
    finishCallback(state,profile,req,res,consumeIdentity){
      const row=db.prepare('SELECT * FROM oauth_requests WHERE flow=? AND expires>?').get(hash(state),now());if(!row)return false;
      if(row.status!=='launched'||!binding(req.headers.cookie)||hash(binding(req.headers.cookie))!==row.binding){respond(res,'连接未完成','<p>请在发起授权的浏览器完成登录</p>',401);return true;}
      consumeIdentity();
      const id=nonce(); // Replace the URL's request nonce after authenticating.
      if(db.prepare("UPDATE oauth_requests SET id=?,subject=?,authenticated=?,status='verified' WHERE id=? AND status='launched'").run(hash(id),profile.subject,now(),row.id).changes!==1){respond(res,'连接未完成','<p>授权已处理 请返回插件</p>',409);return true;}
      // Explicit consent prevents silent grants to a remotely initiated client.
      const destination=new URL(row.redirect).hostname==='chatgpt.com'?'ChatGPT':'此电脑上的 Codex';
      respond(res,'确认连接',`<p>${escapeHTML(profile.name)}<br>${escapeHTML(profile.email)}</p><p>将此飞书身份用于${destination}的 110lab 公共邮箱管理</p>${form(id,'/mail/oauth/approve','连接并返回插件')}`);return true;
    },
    async handoff(header,state,{fresh=false}={}){
      try{const info=await hostIdentity(header,{fresh});access.me(info.extra.subject);const result=auth.completeForHost(state,info.extra);return {content:[{type:'text',text:'登录身份已验证'}],_meta:{mailHandoff:result}};
      }catch(e){if(e instanceof InvalidTokenError)return mailAuthChallenge();return {isError:true,content:[{type:'text',text:'登录已失效 请重新点击飞书登录'}]};}
    },
    close(){clearInterval(timer);db.close();}
  };
}
