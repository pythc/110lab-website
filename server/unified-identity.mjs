import {DatabaseSync} from 'node:sqlite';
import {chmodSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {MailAuthError} from './mail-auth.mjs';

export const IDENTITY_ISSUER='https://internal.110-lab.cn';
const hash=v=>createHash('sha256').update(v).digest('hex');
const nonce=()=>randomBytes(32).toString('base64url');
const opaque=v=>typeof v==='string'&&/^[\w-]{43}$/.test(v);
export const SERVICES=Object.freeze({
  workbench:{name:'工作台',url:'/workbench'},
  projects:{name:'项目',url:'/projects'},honors:{name:'荣誉',url:'/honors'},
  recruitment:{name:'招新',url:'/recruitment'},mail:{name:'公共邮箱',url:'/mail'},
  updates:{name:'动态',url:'/admin'},assessment:{name:'考核管理',url:'https://exam.110-lab.cn/api/auth/feishu/start'},
  requirements:{name:'需求平台',url:'https://fcncvoyreb8p.feishuapp.com/app/app_17b6pxwde0x'},
  knowledge:{name:'知识库',url:'https://knowledge.110-lab.cn/home'},
});
export function identityRedirect(audience,value,knowledgeCallback='http://127.0.0.1:5840/api/auth/identity/callback'){
  try{const u=new URL(value);if(u.username||u.password||u.search||u.hash)return false;
    if(audience==='knowledge')return value===knowledgeCallback;
    return audience==='requirements'&&u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&u.pathname==='/callback/110lab_requirements'&&!!u.port;
  }catch{return false;}
}
// This is a first-party identity exchange. It never grants document, mailbox,
// recruitment or platform roles; those remain live decisions in each service.
export function openUnifiedIdentity({directory,auth,access,directoryProvider,now=Date.now,knowledgeCallback,localTest=false}){
  const filename=join(directory,'unified-identity.sqlite');
  try{const s=lstatSync(filename);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077))throw new Error('Unsafe identity store');}catch(e){if(e.code!=='ENOENT')throw e;}
  const db=new DatabaseSync(filename);chmodSync(filename,0o600);
  db.exec(`PRAGMA busy_timeout=2000;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS identity_codes(code TEXT PRIMARY KEY,session_key TEXT NOT NULL,audience TEXT NOT NULL,redirect TEXT NOT NULL,state TEXT NOT NULL,challenge TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS identity_grants(token TEXT PRIMARY KEY,session_key TEXT NOT NULL,audience TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS identity_logins(flow TEXT PRIMARY KEY,next TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS identity_budget(bucket INTEGER NOT NULL,key TEXT NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(bucket,key));`);
  const clean=()=>{for(const t of ['identity_codes','identity_grants','identity_logins'])db.prepare('DELETE FROM '+t+' WHERE expires<=?').run(now());db.prepare('DELETE FROM identity_budget WHERE bucket<?').run(Math.floor(now()/60000)-2);};
  const timer=setInterval(clean,60000);timer.unref();clean();
  const budget=(key,max)=>{const n=db.prepare('INSERT INTO identity_budget VALUES(?,?,1) ON CONFLICT(bucket,key) DO UPDATE SET n=n+1 RETURNING n').get(Math.floor(now()/60000),hash(key)).n;if(n>max)throw new MailAuthError(429,'操作较频繁，请稍后重试');};
  const allowedNext=value=>typeof value==='string'&&value.length<3000&&new URL(value,IDENTITY_ISSUER).pathname==='/auth'&&!value.startsWith('//')&&!/[\\\s\x00-\x1f]/.test(value)&&new URL(value,IDENTITY_ISSUER).origin===IDENTITY_ISSUER;
  async function profile(key){
    const session=auth.sessionByKey(key),p=access.me(session.subject);let member;
    if(!directoryProvider&&!localTest)throw new MailAuthError(503,'暂时无法核对成员状态');
    if(directoryProvider){let members;try{members=await directoryProvider.list();}catch{throw new MailAuthError(503,'暂时无法核对成员状态');}member=members.find(m=>m.subject===session.subject);if(!member)throw new MailAuthError(403,'此账号已不在实验室成员范围内');}
    // Revalidate after the asynchronous directory lookup, including logout.
    const current=auth.sessionByKey(key);if(current.subject!==p.subject)throw new MailAuthError(401,'登录身份已变化');
    const pos=p.subject.indexOf(':');
    return {issuer:IDENTITY_ISSUER,subject:p.subject,tenantKey:p.subject.slice(0,pos),unionId:p.subject.slice(pos+1),name:member?.name||p.name,email:p.email,...(member?.avatarUrl?{avatarUrl:member.avatarUrl}:{}),role:access.me(p.subject).role,authenticatedAt:current.created,expiresAt:current.expiresAt};
  }
  return {
    async session(header){return {...await profile(auth.session(header).key),csrf:auth.session(header).csrf};},
    async continuation(header,csrf,{audience,redirectUri,state,challenge}){
      if(!opaque(state)||!opaque(challenge)||!identityRedirect(audience,redirectUri,knowledgeCallback))throw new MailAuthError(400,'连接请求无效');
      const s=auth.session(header);auth.csrf(s,csrf);await profile(s.key);
      // A loopback port alone cannot prove a desktop client's identity. Existing
      // clients reuse their saved grant; new bindings retain explicit consent.
      return {automatic:audience==='knowledge'};
    },
    logout(header,csrf){const session=auth.session(header);auth.csrf(session,csrf);db.prepare('DELETE FROM identity_grants WHERE session_key=?').run(session.key);db.prepare('DELETE FROM identity_codes WHERE session_key=?').run(session.key);return auth.logout(session);},
    start(header,next,ip){if(!allowedNext(next))throw new MailAuthError(400,'返回地址无效');budget('login:'+ip,10);const result=auth.start(header,{ip});db.prepare('INSERT INTO identity_logins VALUES(?,?,?)').run(hash(result.state),next,now()+5*60000);return result;},
    finish(state,pending,res){const flow=db.prepare('DELETE FROM identity_logins WHERE flow=? AND expires>? RETURNING *').get(hash(state),now());if(!flow)return false;
      access.registerIdentity(pending.profile);const completed=pending.complete();res.setHeader('Set-Cookie',completed.cookie);res.writeHead(303,{'Location':flow.next,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();return true;},
    async authorize(header,csrf,{audience,redirectUri,state,challenge}){
      if(!opaque(state)||!opaque(challenge)||!identityRedirect(audience,redirectUri,knowledgeCallback))throw new MailAuthError(400,'连接请求无效');
      const session=auth.session(header);auth.csrf(session,csrf);budget('code:'+session.key,20);await profile(session.key);
      const code=nonce();db.prepare('INSERT INTO identity_codes VALUES(?,?,?,?,?,?,?)').run(hash(code),session.key,audience,redirectUri,state,challenge,now()+60000);
      const url=new URL(redirectUri);url.searchParams.set('code',code);url.searchParams.set('state',state);url.searchParams.set('iss',IDENTITY_ISSUER);return {redirectUrl:url.href};
    },
    async exchange({audience,code,verifier,state,redirectUri}){
      if(!opaque(code)||!opaque(state)||typeof verifier!=='string'||!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)||!identityRedirect(audience,redirectUri,knowledgeCallback))throw new MailAuthError(401,'连接凭证无效');
      const row=db.prepare('DELETE FROM identity_codes WHERE code=? AND audience=? AND redirect=? AND state=? AND challenge=? AND expires>? RETURNING *').get(hash(code),audience,redirectUri,state,createHash('sha256').update(verifier).digest('base64url'),now());
      if(!row)throw new MailAuthError(401,'连接已过期或已使用');
      const p=await profile(row.session_key),token=nonce();db.prepare('INSERT INTO identity_grants VALUES(?,?,?,?)').run(hash(token),row.session_key,audience,Date.parse(p.expiresAt));
      return {...p,audience,token};
    },
    async inspect({audience,token}){if(!opaque(token)||!['knowledge','requirements'].includes(audience))throw new MailAuthError(401,'连接凭证无效');
      const row=db.prepare('SELECT * FROM identity_grants WHERE token=? AND audience=? AND expires>?').get(hash(token),audience,now());if(!row)throw new MailAuthError(401,'连接已失效');return {...await profile(row.session_key),audience};},
    revoke({audience,token}){if(opaque(token)&&['knowledge','requirements'].includes(audience))db.prepare('DELETE FROM identity_grants WHERE token=? AND audience=?').run(hash(token),audience);},
    close(){clearInterval(timer);db.close();}
  };
}
