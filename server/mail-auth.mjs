import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,chmodSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';

export const LAB_LOGIN_LIFETIME=30*24*3600000;
export class MailAuthError extends Error {constructor(status,message){super(message);this.status=status;}}
const hash=s=>createHash('sha256').update(s).digest('hex'),nonce=()=>randomBytes(32).toString('base64url');
export const MAIL_SCOPE='contact:user.employee:readonly';
export const MAIL_CALLBACK='https://internal.110-lab.cn/mail/auth/callback';
const settings=z.object({appId:z.string().regex(/^cli_[a-zA-Z0-9]{8,64}$/),appSecret:z.string().min(16).max(256),tenantKey:z.string().regex(/^[a-zA-Z0-9_-]{4,80}$/),bootstrapUnionId:z.string().regex(/^on_[a-zA-Z0-9_-]{10,100}$/),bootstrapEmail:z.string().email().max(254).regex(/^[a-zA-Z0-9._+-]+@110-lab\.cn$/i),bootstrapName:z.string().min(1).max(80)}).strict();
export function readMailConfig(path){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077))throw new Error('Mail login config must be a private regular file');return settings.parse(JSON.parse(readFileSync(path,'utf8')));}
export function parseMailConfig(value){return settings.parse(value);}
export function bootstrapMailOwner(config){return {subject:config.tenantKey+':'+config.bootstrapUnionId,email:config.bootstrapEmail.toLowerCase(),name:config.bootstrapName};}

function providerDiagnostic(stage,code=null,extra={}){
  // Never log provider text, URLs, authorization codes, tokens or profiles.
  console.warn('Mail OAuth failed',JSON.stringify({stage,code:Number.isInteger(code)?code:null,...extra}));
}
async function providerJson(url,options,stage){
  let response;
  try{response=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(10000)});}catch{throw new MailAuthError(503,'飞书登录暂时不可用 请稍后再试');}
  const reader=response.body.getReader();let size=0;const parts=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536){await reader.cancel();throw new MailAuthError(502,'飞书登录响应无效');}parts.push(value);}}finally{reader.releaseLock();}
  let value;try{value=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{providerDiagnostic(stage,null,{httpStatus:response.status});throw new MailAuthError(502,'飞书登录响应无效');}
  if(!response.ok){providerDiagnostic(stage,value?.code,{httpStatus:response.status});throw new MailAuthError(502,'飞书登录失败 请重新登录');}
  return value;
}
export async function fetchMailIdentity(config,{code,verifier}){
  // The v1 authorization endpoint currently documents PKCE with v2 token only.
  // Production v3 returned 20049 for these S256-bound codes. Use that documented
  // pairing, retaining PKCE and scope restriction; never retry without PKCE.
  const token=await providerJson('https://open.feishu.cn/open-apis/authen/v2/oauth/token',{method:'POST',headers:{'Content-Type':'application/json; charset=utf-8'},body:JSON.stringify({grant_type:'authorization_code',client_id:config.appId,client_secret:config.appSecret,code,redirect_uri:MAIL_CALLBACK,code_verifier:verifier,scope:MAIL_SCOPE})},'token');
  if(!token||token.error||token.code!==undefined&&token.code!==0||typeof token.access_token!=='string'||token.access_token.length<1||token.access_token.length>16384){providerDiagnostic('token',token?.code);throw new MailAuthError(401,'飞书授权失败 请重新登录');}
  const info=await providerJson('https://open.feishu.cn/open-apis/authen/v1/user_info',{headers:{Authorization:'Bearer '+token.access_token}},'identity');
  if(!info||info.code!==0||!info.data){providerDiagnostic('identity',info?.code);throw new MailAuthError(401,'无法验证飞书身份');}
  const p=info.data;
  // A contact email is not identity proof. Require Feishu's enterprise mailbox
  // and bind permissions to tenant + union_id, never a user-supplied name.
  if(p.tenant_key!==config.tenantKey||!/^on_[a-zA-Z0-9_-]{10,100}$/.test(p.union_id||'')||typeof p.enterprise_email!=='string'||!/^[-a-zA-Z0-9._+]+@110-lab\.cn$/i.test(p.enterprise_email)||typeof p.name!=='string'||!p.name||p.name.length>80||/[\x00-\x1f\x7f]/.test(p.name)){providerDiagnostic('identity-validation',null,{tenantMatches:p.tenant_key===config.tenantKey,unionPresent:typeof p.union_id==='string',enterpriseEmailPresent:typeof p.enterprise_email==='string',namePresent:typeof p.name==='string'});throw new MailAuthError(403,'请使用 110 实验室的飞书企业账号登录');}
  return {subject:p.tenant_key+':'+p.union_id,email:p.enterprise_email.toLowerCase(),name:p.name};
}
export function openMailAuth({directory,config,now=Date.now,localTest=false,fetchIdentity=fetchMailIdentity}){
  config=parseMailConfig(config);mkdirSync(directory,{recursive:true,mode:0o700});const st=lstatSync(directory);
  if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077))throw new Error('Mail authentication requires private storage');
  const path=join(directory,'mail-sessions.sqlite');try{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077))throw new Error('Unsafe mail session database');}catch(e){if(e.code!=='ENOENT')throw e;}
  const db=new DatabaseSync(path);chmodSync(path,0o600);
  db.exec(`PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS mail_sessions(key TEXT PRIMARY KEY,subject TEXT NOT NULL,csrf TEXT NOT NULL,context TEXT NOT NULL,created INTEGER NOT NULL,seen INTEGER NOT NULL,expires INTEGER NOT NULL,config_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mail_flows(state TEXT PRIMARY KEY,binding TEXT NOT NULL,context TEXT NOT NULL,verifier TEXT NOT NULL,expected_subject TEXT,callback_binding TEXT,status TEXT NOT NULL,subject TEXT,expires INTEGER NOT NULL,config_id TEXT NOT NULL,handoff_hash TEXT);
    CREATE TABLE IF NOT EXISTS mail_login_budget(scope TEXT,key TEXT,bucket INTEGER,count INTEGER,PRIMARY KEY(scope,key,bucket));
    CREATE TABLE IF NOT EXISTS mail_host_flows(state TEXT PRIMARY KEY,authenticated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mail_host_flow_grants(state TEXT PRIMARY KEY,family TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mail_session_grants(key TEXT PRIMARY KEY,family TEXT NOT NULL);`);
  const configId=hash(JSON.stringify(config));db.prepare('DELETE FROM mail_sessions WHERE config_id<>?').run(configId);db.prepare('DELETE FROM mail_flows WHERE config_id<>?').run(configId);
  const names={normal:localTest?'110lab_mail_test':'__Host-110lab_mail',embedded:'__Host-110lab_mail_embedded',normalBind:localTest?'110lab_mail_bind_test':'__Host-110lab_mail_bind',embeddedBind:'__Host-110lab_mail_bind_embedded',callback:localTest?'110lab_mail_callback_test':'__Host-110lab_mail_callback'};
  const cookie=(name,value,{embedded=false,age=LAB_LOGIN_LIFETIME/1000,lax=false}={})=>`${name}=${value}; Path=/; HttpOnly; SameSite=${embedded?'None':lax?'Lax':'Strict'}; Max-Age=${age}${localTest&&!embedded?'':'; Secure'}${embedded?'; Partitioned':''}`;
  const value=(header,name)=>{if(typeof header!=='string'||header.length>8192)return null;const a=header.split(';').map(s=>s.trim()).filter(s=>s.startsWith(name+'='));if(a.length!==1)return null;const v=a[0].slice(name.length+1);return /^[\w-]{43}$/.test(v)?v:null;};
  const context=embedded=>embedded?'embedded':'normal';
  function clean(){db.prepare('DELETE FROM mail_sessions WHERE expires<=?').run(now());db.prepare('DELETE FROM mail_flows WHERE expires<=?').run(now());db.prepare('DELETE FROM mail_host_flows WHERE state NOT IN (SELECT state FROM mail_flows)').run();db.exec('DELETE FROM mail_host_flow_grants WHERE state NOT IN (SELECT state FROM mail_flows); DELETE FROM mail_session_grants WHERE key NOT IN (SELECT key FROM mail_sessions);');db.prepare('DELETE FROM mail_login_budget WHERE bucket<?').run(Math.floor(now()/900000)-4);}
  clean();const timer=setInterval(clean,60000);timer.unref();
  function flow(state){if(!/^[\w-]{43}$/.test(state||''))throw new MailAuthError(401,'登录链接已失效 请重新登录');const row=db.prepare('SELECT * FROM mail_flows WHERE state=? AND config_id=? AND expires>?').get(hash(state),configId,now());if(!row)throw new MailAuthError(401,'登录链接已失效 请重新登录');return row;}
  const budget=(scope,key,limit)=>{const bucket=Math.floor(now()/900000),count=db.prepare('INSERT INTO mail_login_budget VALUES(?,?,?,1) ON CONFLICT(scope,key,bucket) DO UPDATE SET count=count+1 RETURNING count').get(scope,key,bucket).count;if(count>limit)throw new MailAuthError(429,'登录尝试较多 请稍后再试');};
  let grants={active:()=>true,revoke:()=>{}};
  function mint(subject,embedded,authenticatedAt=now(),family=null){const token=nonce(),csrf=nonce(),t=now(),expires=authenticatedAt+LAB_LOGIN_LIFETIME;if(authenticatedAt>t||expires<=t)throw new MailAuthError(401,'请重新通过飞书登录');db.prepare('INSERT INTO mail_sessions VALUES(?,?,?,?,?,?,?,?)').run(hash(context(embedded)+':'+token),subject,csrf,context(embedded),authenticatedAt,t,expires,configId);if(family)db.prepare('INSERT INTO mail_session_grants VALUES(?,?)').run(hash(context(embedded)+':'+token),family);return {cookie:cookie(names[context(embedded)],token,{embedded,age:Math.floor((expires-t)/1000)}),session:{subject,csrf,created:authenticatedAt,expiresAt:new Date(expires).toISOString()}};}
  function sessionByKey(key){
    const row=db.prepare('SELECT * FROM mail_sessions WHERE key=? AND config_id=?').get(key,configId);
    const family=db.prepare('SELECT family FROM mail_session_grants WHERE key=?').get(key)?.family;
    if(!row||row.expires<=now()||family&&!grants.active(family))throw new MailAuthError(401,'登录已过期 请重新登录');
    if(now()-row.seen>=60000)db.prepare('UPDATE mail_sessions SET seen=? WHERE key=?').run(now(),key);
    return {key,family,subject:row.subject,csrf:row.csrf,created:row.created,embedded:row.context==='embedded',expiresAt:new Date(row.expires).toISOString()};
  }
  return {names,sessionByKey,bindGrants(store){grants=store;},
    revokeGrantSessions(family){
      db.exec('BEGIN IMMEDIATE');try{
        db.prepare('DELETE FROM mail_sessions WHERE key IN (SELECT key FROM mail_session_grants WHERE family=?)').run(family);
        db.prepare('DELETE FROM mail_flows WHERE state IN (SELECT state FROM mail_host_flow_grants WHERE family=?)').run(family);
        db.prepare('DELETE FROM mail_session_grants WHERE family=?').run(family);
        db.prepare('DELETE FROM mail_host_flow_grants WHERE family=?').run(family);
        db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e;}
    },
    start(header,{embedded=false,ip='unknown',expectedSubject=null}={}){
      clean();budget('global','all',100);budget('ip',hash(ip),10);
      const state=nonce(),binding=nonce(),verifier=nonce();db.prepare('INSERT INTO mail_flows VALUES(?,?,?,?,?,NULL,?,NULL,?,?,NULL)').run(hash(state),hash(binding),context(embedded),verifier,expectedSubject,'created',now()+5*60000,configId);
      return {state,launchUrl:'https://internal.110-lab.cn/mail/auth/launch?state='+state,cookie:cookie(names[embedded?'embeddedBind':'normalBind'],binding,{embedded,age:300})};
    },
    launch(state){const row=flow(state);if(row.status!=='created')throw new MailAuthError(409,'此登录链接已打开 请重新登录');const binding=nonce();if(db.prepare("UPDATE mail_flows SET callback_binding=?,status='launched' WHERE state=? AND status='created'").run(hash(binding),hash(state)).changes!==1)throw new MailAuthError(409,'登录状态已改变');const u=new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');u.search=new URLSearchParams({client_id:config.appId,response_type:'code',redirect_uri:MAIL_CALLBACK,scope:MAIL_SCOPE,state,code_challenge:createHash('sha256').update(row.verifier).digest('base64url'),code_challenge_method:'S256',prompt:'consent'}).toString();return {url:u.href,cookie:cookie(names.callback,binding,{age:300,lax:true})};},
    async callback(state,code,header){
      const row=flow(state),binding=value(header,names.callback);
      if(row.status!=='launched'||!binding||hash(binding)!==row.callback_binding||typeof code!=='string'||! /^[\x21-\x7e]{1,2048}$/.test(code))throw new MailAuthError(401,'登录状态验证失败 请重新登录');
      if(db.prepare("UPDATE mail_flows SET status='exchanging' WHERE state=? AND status='launched'").run(hash(state)).changes!==1)throw new MailAuthError(409,'登录回调已处理');
      try{const profile=await fetchIdentity(config,{code,verifier:row.verifier});
        if(row.expected_subject&&profile.subject!==row.expected_subject)throw new MailAuthError(403,'请使用当前管理员的飞书账号确认身份');
        if(now()>=row.expires)throw new MailAuthError(401,'登录链接已过期');
        return {profile,consumeForHost(){if(db.prepare("UPDATE mail_flows SET status='consumed',subject=?,verifier='' WHERE state=? AND status='exchanging' AND expires>?").run(profile.subject,hash(state),now()).changes!==1)throw new MailAuthError(409,'登录状态已改变');},complete(){const ticket=nonce();if(db.prepare("UPDATE mail_flows SET status='complete',subject=?,handoff_hash=?,verifier='' WHERE state=? AND status='exchanging' AND expires>?").run(profile.subject,hash(ticket),hash(state),now()).changes!==1)throw new MailAuthError(409,'登录状态已改变');return {...mint(profile.subject,false),ticket,state};}};
      }catch(e){db.prepare("UPDATE mail_flows SET status='failed',verifier='' WHERE state=?").run(hash(state));if(e instanceof MailAuthError)throw e;throw new MailAuthError(502,'无法验证飞书身份');}
    },
    // Knowing a flow URL and polling cookie must never be enough to acquire
    // another browser's identity. The independent callback window supplies a
    // second one-use secret via a same-origin opener, or explicit code entry.
    // Called only after MCP bearer verification. The browser cannot supply a
    // subject or turn possession of a flow URL into somebody else's session.
    completeForHost(state,{subject,authenticatedAt,family}){const row=flow(state);if(row.context!=='embedded'||row.status!=='created'||row.expected_subject&&row.expected_subject!==subject)throw new MailAuthError(401,'请使用当前账号重新发起登录');if(!Number.isSafeInteger(authenticatedAt)||authenticatedAt>now()||authenticatedAt+LAB_LOGIN_LIFETIME<=now())throw new MailAuthError(401,'请重新通过飞书登录');if(family&&!grants.active(family))throw new MailAuthError(401,'请重新通过飞书登录');const ticket=nonce();db.exec('BEGIN IMMEDIATE');try{if(db.prepare("UPDATE mail_flows SET status='complete',subject=?,handoff_hash=?,verifier='' WHERE state=? AND status='created'").run(subject,hash(ticket),hash(state)).changes!==1)throw new MailAuthError(409,'登录结果已处理');db.prepare('INSERT INTO mail_host_flows VALUES(?,?)').run(hash(state),authenticatedAt);if(family)db.prepare('INSERT INTO mail_host_flow_grants VALUES(?,?)').run(hash(state),family);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return {state,ticket};},
    redeem(state,ticket,header,{embedded=false}={}){const row=flow(state),binding=value(header,names[embedded?'embeddedBind':'normalBind']);if(row.context!==context(embedded)||!binding||hash(binding)!==row.binding)throw new MailAuthError(401,'请在发起登录的页面完成操作');if(row.status!=='complete'||!row.handoff_hash||!/^[-\w]{43}$/.test(ticket||'')||hash(ticket)!==row.handoff_hash)throw new MailAuthError(401,'登录码无效或已使用');const authenticatedAt=db.prepare('SELECT authenticated_at FROM mail_host_flows WHERE state=?').get(hash(state))?.authenticated_at??now();const family=db.prepare('SELECT family FROM mail_host_flow_grants WHERE state=?').get(hash(state))?.family;if(family&&!grants.active(family))throw new MailAuthError(401,'登录已退出 请重新登录');if(authenticatedAt+LAB_LOGIN_LIFETIME<=now())throw new MailAuthError(401,'请重新通过飞书登录');if(db.prepare("UPDATE mail_flows SET status='consumed',handoff_hash=NULL WHERE state=? AND status='complete'").run(hash(state)).changes!==1)throw new MailAuthError(409,'登录结果已处理');return mint(row.subject,embedded,authenticatedAt,family);},
    session(header,{embedded=false}={}){const token=value(header,names[context(embedded)]);if(!token)throw new MailAuthError(401,'请先使用飞书登录');return sessionByKey(hash(context(embedded)+':'+token));},
    csrf(session,token){if(typeof token!=='string'||!/^[\w-]{43}$/.test(token)||!timingSafeEqual(Buffer.from(token),Buffer.from(session.csrf)))throw new MailAuthError(403,'页面已失效 请重新加载');},
    recent(session){if(now()-session.created>5*60000)throw new MailAuthError(403,'请重新通过飞书确认身份后再修改管理员');},
    logout(session){if(session.family)grants.revoke(session.family);db.prepare('DELETE FROM mail_sessions WHERE key=?').run(session.key);db.prepare('DELETE FROM mail_flows WHERE expected_subject=?').run(session.subject);return cookie(names[context(session.embedded)],'',{embedded:session.embedded,age:0});},
    close(){clearInterval(timer);db.close();}
  };
}
