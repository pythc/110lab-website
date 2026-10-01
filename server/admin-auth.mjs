import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,chmodSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,createHash,createHmac,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {z} from 'zod';

const derive=promisify(scrypt),hash=value=>createHash('sha256').update(value).digest('hex');
export class AdminError extends Error {constructor(status,message){super(message);this.status=status;}}
const configSchema=z.object({username:z.string().regex(/^[a-zA-Z0-9_-]{3,40}$/),salt:z.string().regex(/^[a-f0-9]{64}$/),passwordHash:z.string().regex(/^[a-f0-9]{128}$/),rateSecret:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export async function createAdminConfig(username,password){
  if(typeof password!=='string'||Buffer.byteLength(password)<12||Buffer.byteLength(password)>256)throw new Error('Use a password between 12 and 256 bytes');
  const salt=randomBytes(32).toString('hex');
  const passwordHash=(await derive(password,Buffer.from(salt,'hex'),64,{N:32768,r:8,p:1,maxmem:64*1024*1024})).toString('hex');
  return configSchema.parse({username,salt,passwordHash,rateSecret:randomBytes(32).toString('hex')});
}
export function openAdminAuth({directory,config,configPath,now=Date.now,localTest=false}={}){
  if(!directory)throw new Error('Admin authentication requires private storage');
  if(!config){const info=lstatSync(configPath);if(!info.isFile()||info.isSymbolicLink()||info.mode&0o077)throw new Error('Admin config must be a private regular file');config=JSON.parse(readFileSync(configPath,'utf8'));}
  const account=configSchema.parse(config),configId=hash(JSON.stringify(account));
  mkdirSync(directory,{recursive:true,mode:0o700});const info=lstatSync(directory);
  if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Unsafe admin storage');chmodSync(directory,0o700);
  const path=join(directory,'sessions.sqlite');try{if(lstatSync(path).isSymbolicLink())throw new Error('Unsafe admin database');}catch(e){if(e.code!=='ENOENT')throw e;}
  const db=new DatabaseSync(path);chmodSync(path,0o600);
  db.exec('PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,created_at INTEGER NOT NULL,last_seen INTEGER NOT NULL,expires_at INTEGER NOT NULL,config_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS login_budget(scope TEXT NOT NULL,key TEXT NOT NULL,bucket INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(scope,key,bucket));');
  db.prepare('DELETE FROM sessions WHERE config_id<>?').run(configId);
  const cookieName=localTest?'110lab_admin_test':'__Host-110lab_admin';let active=0;
  const budget=(scope,key,limit,window)=>{const count=db.prepare('INSERT INTO login_budget VALUES(?,?,?,1) ON CONFLICT(scope,key,bucket) DO UPDATE SET count=count+1 RETURNING count').get(scope,key,Math.floor(now()/window)).count;if(count>limit)throw new AdminError(429,'登录尝试较多 请稍后再试');};
  const cleanup=()=>{db.prepare('DELETE FROM sessions WHERE expires_at<=? OR last_seen<?').run(now(),now()-30*60000);db.prepare("DELETE FROM login_budget WHERE (scope='ip' AND bucket<?) OR (scope='global' AND bucket<?)").run(Math.floor(now()/(15*60000))-1,Math.floor(now()/3600000)-1);};
  cleanup();const timer=setInterval(cleanup,5*60000);timer.unref();
  const cookie=(token,maxAge=8*3600)=>`${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${localTest?'':'; Secure'}`;
  return {cookieName,
    async login(username,password,ip){
      budget('global','all',60,3600000);budget('ip',createHmac('sha256',account.rateSecret).update(ip).digest('hex'),8,15*60000);
      if(active>=2)throw new AdminError(429,'登录繁忙 请稍后再试');
      active++;let result;
      try{result=await derive(password,Buffer.from(account.salt,'hex'),64,{N:32768,r:8,p:1,maxmem:64*1024*1024});}finally{active--;}
      if(!timingSafeEqual(result,Buffer.from(account.passwordHash,'hex'))||username!==account.username)throw new AdminError(401,'账号或密码错误');
      const token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url'),time=now();
      db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(hash(token),csrf,time,time,time+8*3600000,configId);
      return {cookie:cookie(token),session:{username:account.username,csrf,expiresAt:new Date(time+8*3600000).toISOString()}};
    },
    session(header){
      if(typeof header!=='string'||header.length>4096)throw new AdminError(401,'请登录管理员账号');
      const matches=header.split(';').map(x=>x.trim()).filter(x=>x.startsWith(cookieName+'='));
      if(matches.length!==1)throw new AdminError(401,'请登录管理员账号');
      const token=matches[0].slice(cookieName.length+1);if(!/^[\w-]{43}$/.test(token))throw new AdminError(401,'请登录管理员账号');
      const key=hash(token),row=db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(key);
      if(!row||row.config_id!==configId||row.expires_at<=now()||row.last_seen<now()-30*60000){db.prepare('DELETE FROM sessions WHERE token_hash=?').run(key);throw new AdminError(401,'登录已过期 请重新登录');}
      if(now()-row.last_seen>=60000)db.prepare('UPDATE sessions SET last_seen=? WHERE token_hash=?').run(now(),key);
      return {key,username:account.username,csrf:row.csrf,expiresAt:new Date(row.expires_at).toISOString()};
    },
    csrf(session,value){if(typeof value!=='string'||!/^[-A-Za-z0-9_]{43}$/.test(value)||!timingSafeEqual(Buffer.from(value),Buffer.from(session.csrf)))throw new AdminError(403,'页面已失效 请刷新后重试');},
    logout(session){db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.key);return cookie('',0);},
    close(){clearInterval(timer);db.close();}
  };
}
