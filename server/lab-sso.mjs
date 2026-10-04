import {DatabaseSync} from 'node:sqlite';
import {chmodSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {MailAuthError} from './mail-auth.mjs';

export const LAB_SSO_ISSUER='https://internal.110-lab.cn';
export const ASSESSMENT_CALLBACK='https://exam.110-lab.cn/api/auth/feishu/callback';
const hash=value=>createHash('sha256').update(value).digest('hex');
const nonce=()=>randomBytes(32).toString('base64url');
const valid=value=>typeof value==='string'&&/^[\w-]{43}$/.test(value);

// A separate audience-bound grant, never a Feishu access token or a browser cookie.
export function openLabSso({directory,auth,access,now=Date.now}){
  const filename=join(directory,'lab-sso.sqlite');
  try{const s=lstatSync(filename);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077))throw new Error('Unsafe SSO database');}catch(e){if(e.code!=='ENOENT')throw e;}
  const db=new DatabaseSync(filename);chmodSync(filename,0o600);
  db.exec(`PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS assessment_codes(code TEXT PRIMARY KEY,session_key TEXT NOT NULL,challenge TEXT NOT NULL,state TEXT NOT NULL,embedded INTEGER NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS assessment_grants(token TEXT PRIMARY KEY,session_key TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS assessment_codes_session ON assessment_codes(session_key);`);
  const clean=()=>{db.prepare('DELETE FROM assessment_codes WHERE expires<=?').run(now());db.prepare('DELETE FROM assessment_grants WHERE expires<=?').run(now());};
  const timer=setInterval(clean,60000);timer.unref();clean();
  function profile(key){
    const session=auth.sessionByKey(key),p=access.me(session.subject);
    if(!['admin','super_admin'].includes(p.role))throw new MailAuthError(403,'需要实验室管理员权限');
    return {issuer:LAB_SSO_ISSUER,audience:'assessment',subject:p.subject,name:p.name,email:p.email,role:p.role,expiresAt:session.expiresAt};
  }
  return {
    authorize(session,{state,challenge,embedded}){
      if(!valid(state)||!valid(challenge)||typeof embedded!=='boolean')throw new MailAuthError(400,'登录请求无效');
      profile(session.key);clean();
      if(db.prepare('SELECT count(*) AS n FROM assessment_codes WHERE session_key=?').get(session.key).n>=10)throw new MailAuthError(429,'登录请求较多 请稍后重试');
      const code=nonce();db.prepare('INSERT INTO assessment_codes VALUES(?,?,?,?,?,?)').run(hash(code),session.key,challenge,state,Number(embedded),now()+60000);
      const url=new URL(ASSESSMENT_CALLBACK);url.searchParams.set('code',code);url.searchParams.set('state',state);if(embedded)url.searchParams.set('embedded','1');
      return {redirectUrl:url.href};
    },
    exchange({code,verifier,state,redirectUri}){
      if(!valid(code)||!valid(verifier)||!valid(state)||redirectUri!==ASSESSMENT_CALLBACK)throw new MailAuthError(401,'考核登录验证失败');
      const challenge=createHash('sha256').update(verifier).digest('base64url');
      const row=db.prepare('DELETE FROM assessment_codes WHERE code=? AND challenge=? AND state=? AND expires>? RETURNING *').get(hash(code),challenge,state,now());
      if(!row)throw new MailAuthError(401,'登录请求已失效 请重新进入考核系统');
      const p=profile(row.session_key),token=nonce();
      db.prepare('INSERT INTO assessment_grants VALUES(?,?,?)').run(hash(token),row.session_key,Date.parse(p.expiresAt));
      return {...p,token};
    },
    inspect(token){
      if(!valid(token))throw new MailAuthError(401,'考核登录已失效');
      const row=db.prepare('SELECT * FROM assessment_grants WHERE token=? AND expires>?').get(hash(token),now());
      if(!row)throw new MailAuthError(401,'考核登录已失效');
      return profile(row.session_key);
    },
    close(){clearInterval(timer);db.close();}
  };
}
