import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {mkdirSync,lstatSync,readFileSync,writeFileSync,chmodSync,unlinkSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';

export const RECIPIENT='f74974332@gmail.com';
export const MAX_FILE_BYTES=10*1024*1024;
export const GROUPS=['产品组','开发组','测试运维组'];
export const DAY=86400000;
export class RecruitmentError extends Error {
  constructor(status,code,message){super(message);this.status=status;this.code=code;}
}
const reject=(status,code,message)=>{throw new RecruitmentError(status,code,message);};
export function keyHash(key){
  if(typeof key!=='string'||!/^Bearer [A-Za-z0-9_-]{43}$/.test(key))reject(400,'INVALID_RECEIPT_KEY','请重新打开投递表单');
  return createHash('sha256').update(key.slice(7)).digest('hex');
}
const idPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const publicReceipt=row=>({id:row.id,status:row.status,receivedAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),nextRetryAt:row.status==='RETRYING'?new Date(row.next_attempt_at).toISOString():null,retriesRemaining:Math.max(0,2-row.manual_retries)});

export function openRecruitmentStore(directory,{now=Date.now,maxStoredBytes=512*1024*1024,maxAcceptedDay=100,sendInterval=60000}={}){
  const root=resolve(directory);
  for(const path of [root,join(root,'tmp'),join(root,'files')]){
    mkdirSync(path,{recursive:true,mode:0o700});
    if(!lstatSync(path).isDirectory()||lstatSync(path).isSymbolicLink())throw new Error('Recruitment storage must be private real directories');
    chmodSync(path,0o700);
  }
  const saltPath=join(root,'limiter-salt');
  try{writeFileSync(saltPath,randomBytes(32),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
  if(lstatSync(saltPath).isSymbolicLink())throw new Error('Invalid limiter salt');
  const salt=readFileSync(saltPath);if(salt.length!==32)throw new Error('Invalid limiter salt');
  const database=join(root,'submissions.sqlite');
  try{if(lstatSync(database).isSymbolicLink())throw new Error('Invalid database path');}catch(e){if(e.code!=='ENOENT')throw e;}
  const db=new DatabaseSync(database);chmodSync(database,0o600);
  db.exec(`PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,key_hash TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,
      email_hash TEXT NOT NULL,ip_hash TEXT NOT NULL,name TEXT,group_name TEXT,email TEXT,
      extension TEXT NOT NULL,sha256 TEXT NOT NULL,blob TEXT,bytes INTEGER NOT NULL,
      status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,sent_at INTEGER,next_attempt_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,round_attempts INTEGER NOT NULL DEFAULT 0,manual_retries INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,lease_until INTEGER,last_error TEXT,revision INTEGER NOT NULL DEFAULT 1);
    CREATE INDEX IF NOT EXISTS recruitment_pending ON submissions(status,next_attempt_at);
    CREATE INDEX IF NOT EXISTS recruitment_fingerprint ON submissions(fingerprint,created_at);
    CREATE TABLE IF NOT EXISTS delivery_events(id INTEGER PRIMARY KEY,submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,at INTEGER NOT NULL,event TEXT NOT NULL,attempt INTEGER NOT NULL,code TEXT);
    CREATE TABLE IF NOT EXISTS budgets(scope TEXT NOT NULL,key TEXT NOT NULL,bucket INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(scope,key,bucket));
    CREATE TABLE IF NOT EXISTS worker_health(id INTEGER PRIMARY KEY CHECK(id=1),heartbeat INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS delivery_clock(id INTEGER PRIMARY KEY CHECK(id=1),next_send INTEGER NOT NULL);
    INSERT OR IGNORE INTO delivery_clock VALUES(1,0);`);
  const hash=value=>createHmac('sha256',salt).update(value).digest('hex');
  const event=(id,name,attempt=0,code=null)=>db.prepare('INSERT INTO delivery_events(submission_id,at,event,attempt,code) VALUES(?,?,?,?,?)').run(id,now(),name,attempt,code);
  const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
  const consume=(scope,key,limit,window)=>{
    const bucket=Math.floor(now()/window);
    const result=db.prepare('INSERT INTO budgets VALUES(?,?,?,1) ON CONFLICT(scope,key,bucket) DO UPDATE SET count=count+1 RETURNING count').get(scope,key,bucket);
    if(result.count>limit)reject(429,'RATE_LIMITED','投递次数较多 请稍后再试');
  };
  const find=id=>{if(!idPattern.test(id||''))return undefined;return db.prepare('SELECT * FROM submissions WHERE id=?').get(id);};
  const authorize=(id,authorization)=>{
    const supplied=keyHash(authorization),row=id===null?db.prepare('SELECT * FROM submissions WHERE key_hash=?').get(supplied):find(id);
    if(!row||!timingSafeEqual(Buffer.from(row.key_hash,'hex'),Buffer.from(supplied,'hex')))reject(404,'RECEIPT_NOT_FOUND','找不到此回执或回执已过期');
    return row;
  };
  return {
    root,hash,now,
    // Used only behind the lab-admin boundary; never exposes receipt keys/files.
    listForLab() {
      return db.prepare('SELECT id,name,group_name,created_at,status FROM submissions WHERE created_at>? ORDER BY created_at,id LIMIT 3100').all(now()-30*DAY).map(r=>({id:r.id,name:r.name,group:r.group_name,receivedAt:new Date(r.created_at).toISOString(),deliveryStatus:r.status}));
    },
    beginUpload(ip){consume('upload-start',hash(ip),30,10*60000);},
    workerReady(){const row=db.prepare('SELECT heartbeat FROM worker_health WHERE id=1').get();return !!row&&now()-row.heartbeat<120000;},
    heartbeat(){db.prepare('INSERT INTO worker_health VALUES(1,?) ON CONFLICT(id) DO UPDATE SET heartbeat=excluded.heartbeat').run(now());},
    accept({authorization,ip,fields,extension,bytes,sha256,moveFile}){
      const tokenHash=keyHash(authorization),fingerprint=hash(JSON.stringify([fields.name,fields.group,fields.email,sha256]));
      return tx(()=>{
        const existing=db.prepare('SELECT * FROM submissions WHERE key_hash=?').get(tokenHash);
        if(existing){if(existing.fingerprint!==fingerprint)reject(409,'RECEIPT_CONFLICT','同一回执不能用于不同资料 请重新提交');return {...publicReceipt(existing),reused:true};}
        if(db.prepare('SELECT id FROM submissions WHERE fingerprint=? AND created_at>?').get(fingerprint,now()-DAY))reject(409,'DUPLICATE_SUBMISSION','这份资料近期已接收 请查看原回执 无需重复投递');
        consume('accepted-ip',hash(ip),30,60*60000);
        consume('accepted-email',hash(fields.email),3,DAY);
        consume('accepted-global','all',maxAcceptedDay,DAY);
        const stored=db.prepare('SELECT coalesce(sum(bytes),0) AS bytes FROM submissions WHERE blob IS NOT NULL').get().bytes;
        if(stored+bytes>maxStoredBytes)reject(503,'STORAGE_BUSY','暂时无法接收简历 请稍后再试或使用邮箱投递');
        const id=randomUUID(),blob=id+'.'+extension,time=now();
        db.prepare(`INSERT INTO submissions(id,key_hash,fingerprint,email_hash,ip_hash,name,group_name,email,extension,sha256,blob,bytes,status,created_at,updated_at,expires_at,next_attempt_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,tokenHash,fingerprint,hash(fields.email),hash(ip),fields.name,fields.group,fields.email,extension,sha256,blob,bytes,'RECEIVED',time,time,time+7*DAY,time);
        moveFile(blob);event(id,'RECEIVED');return publicReceipt(find(id));
      });
    },
    receipt(id,authorization){return publicReceipt(authorize(id,authorization));},
    retry(id,authorization){return tx(()=>{
      const row=authorize(id,authorization);
      if(row.status!=='FAILED'||!row.blob||row.expires_at<=now())reject(409,'RETRY_UNAVAILABLE','此状态不能重试 请查看回执说明');
      if(row.manual_retries>=2)reject(429,'RETRY_LIMITED','已达到重试上限 请通过邮箱联系实验室并附上回执编号');
      db.prepare("UPDATE submissions SET status='RETRYING',round_attempts=0,manual_retries=manual_retries+1,next_attempt_at=?,updated_at=?,last_error=NULL,revision=revision+1 WHERE id=?").run(now(),now(),id);
      event(id,'MANUAL_RETRY',row.attempts);return publicReceipt(find(id));
    });},
    claim(){return tx(()=>{
      if(db.prepare("SELECT id FROM submissions WHERE status='SENDING'").get())return null;
      const row=db.prepare("SELECT * FROM submissions WHERE status IN ('RECEIVED','RETRYING') AND next_attempt_at<=? AND expires_at>? AND blob IS NOT NULL ORDER BY created_at,id LIMIT 1").get(now(),now());
      if(!row||db.prepare('SELECT next_send FROM delivery_clock WHERE id=1').get().next_send>now())return null;
      const lease=randomUUID();
      db.prepare("UPDATE submissions SET status='SENDING',attempts=attempts+1,round_attempts=round_attempts+1,lease_token=?,lease_until=?,updated_at=?,revision=revision+1 WHERE id=?").run(lease,now()+5*60000,now(),row.id);
      db.prepare('UPDATE delivery_clock SET next_send=? WHERE id=1').run(now()+sendInterval);
      event(row.id,'SENDING',row.attempts+1);return find(row.id);
    });},
    finish(id,lease,{status,code=null,retryDelay=0}){return tx(()=>{
      if(!['SENT','RETRYING','FAILED','UNKNOWN'].includes(status))throw new Error('Invalid delivery result');
      const row=find(id);if(!row||row.status!=='SENDING'||row.lease_token!==lease)return false;
      db.prepare('UPDATE submissions SET status=?,last_error=?,next_attempt_at=?,sent_at=?,lease_token=NULL,lease_until=NULL,updated_at=?,revision=revision+1 WHERE id=?').run(status,code,now()+retryDelay,status==='SENT'?now():null,now(),id);
      event(id,status,row.attempts,code);return true;
    });},
    recoverInterrupted(){return tx(()=>{
      const rows=db.prepare("SELECT * FROM submissions WHERE status='SENDING' AND lease_until<=?").all(now());
      for(const row of rows){db.prepare("UPDATE submissions SET status='UNKNOWN',last_error='WORKER_INTERRUPTED',lease_token=NULL,lease_until=NULL,updated_at=?,revision=revision+1 WHERE id=?").run(now(),row.id);event(row.id,'UNKNOWN',row.attempts,'WORKER_INTERRUPTED');}
      return rows.length;
    });},
    inspect(id){const row=find(id);if(!row)return null;return {...publicReceipt(row),attempts:row.attempts,manualRetries:row.manual_retries,errorCode:row.last_error,revision:row.revision,temporaryFilePresent:!!row.blob,events:db.prepare('SELECT at,event,attempt,code FROM delivery_events WHERE submission_id=? ORDER BY id').all(id)};},
    operatorRetry(id,revision,{confirmUnknown=false}={}){return tx(()=>{
      const row=find(id);if(!row||row.revision!==revision)reject(409,'REVISION_CONFLICT','回执已变化');
      if(!['FAILED','UNKNOWN'].includes(row.status)||!row.blob||row.expires_at<=now())reject(409,'RETRY_UNAVAILABLE','此状态不能重试');
      if(row.status==='UNKNOWN'&&!confirmUnknown)reject(409,'CONFIRM_UNKNOWN','须先核实发信结果并确认可能重复发送');
      db.prepare("UPDATE submissions SET status='RETRYING',round_attempts=0,next_attempt_at=?,updated_at=?,last_error=NULL,revision=revision+1 WHERE id=?").run(now(),now(),id);event(id,'OPERATOR_RETRY',row.attempts);return publicReceipt(find(id));
    });},
    cleanup(){
      const deleted=[];
      const rows=db.prepare("SELECT * FROM submissions WHERE blob IS NOT NULL AND (status<>'SENDING' OR lease_until<=?) AND (expires_at<=? OR (status='SENT' AND sent_at<=?))").all(now(),now(),now()-DAY);
      for(const row of rows){
        try{unlinkSync(join(root,'files',row.blob));}catch(e){if(e.code!=='ENOENT')continue;}
        tx(()=>{db.prepare("UPDATE submissions SET blob=NULL,name=NULL,group_name=NULL,email=NULL,status=CASE WHEN status='SENT' THEN 'SENT' ELSE 'EXPIRED' END,lease_token=NULL,lease_until=NULL,updated_at=?,revision=revision+1 WHERE id=?").run(now(),row.id);event(row.id,'FILE_CLEANED',row.attempts);});deleted.push(row.id);
      }
      for(const folder of ['tmp','files'])for(const entry of readdirSync(join(root,folder),{withFileTypes:true})){
        if(!entry.isFile()||!/^[a-f0-9-]{36}\.(upload|pdf|docx)$/.test(entry.name))continue;
        const path=join(root,folder,entry.name);
        try{if(lstatSync(path).mtimeMs>now()-60*60000)continue;}catch(error){if(error.code==='ENOENT')continue;throw error;}
        if(folder==='files'&&db.prepare('SELECT id FROM submissions WHERE blob=?').get(entry.name))continue;
        try{unlinkSync(path);}catch(error){if(error.code!=='ENOENT')throw error;}
      }
      db.prepare("DELETE FROM submissions WHERE created_at<? AND blob IS NULL AND status IN ('SENT','EXPIRED')").run(now()-30*DAY);
      db.prepare("DELETE FROM budgets WHERE bucket<? AND scope IN ('accepted-email','accepted-global')").run(Math.floor(now()/DAY)-2);
      db.prepare("DELETE FROM budgets WHERE bucket<? AND scope='accepted-ip'").run(Math.floor(now()/(60*60000))-48);
      db.prepare("DELETE FROM budgets WHERE scope='upload-start' AND bucket<?").run(Math.floor(now()/(10*60000))-12);
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');return {deletedFiles:deleted.length};
    },
    close(){db.close();},
  };
}
