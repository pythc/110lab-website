import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {commandJournal,digest} from './durable-command.mjs';
import {z} from 'zod';

export const fail=(code,message,status=409)=>{throw Object.assign(new Error(message),{code,status});};
export function openBusinessState({directory,now=Date.now}) {
  mkdirSync(directory,{recursive:true,mode:0o700});
  if(lstatSync(directory).isSymbolicLink())throw new Error('Unsafe business directory');
  const file=join(directory,'business.sqlite');
  try{if(!lstatSync(file).isFile()||lstatSync(file).isSymbolicLink())throw new Error('Unsafe business database');}catch(e){if(e.code!=='ENOENT')throw e;}
  const db=new DatabaseSync(file);chmodSync(file,0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS previews(id TEXT PRIMARY KEY,subject TEXT NOT NULL,client TEXT NOT NULL,scope TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,expires INTEGER NOT NULL,result TEXT,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,subject TEXT NOT NULL,client TEXT NOT NULL,purpose TEXT NOT NULL,filename TEXT NOT NULL,mime TEXT NOT NULL,sha TEXT NOT NULL,bytes INTEGER NOT NULL,content BLOB NOT NULL,bound INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mail_drafts(id TEXT PRIMARY KEY,subject TEXT NOT NULL,client TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mail_jobs(id TEXT PRIMARY KEY,subject TEXT NOT NULL,client TEXT NOT NULL,preview TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS business_audit(id INTEGER PRIMARY KEY,subject TEXT NOT NULL,client TEXT NOT NULL,action TEXT NOT NULL,object_id TEXT NOT NULL,at INTEGER NOT NULL);`);
  if(!db.prepare('PRAGMA table_info(mail_jobs)').all().some(c=>c.name==='lease_until'))db.exec('ALTER TABLE mail_jobs ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0');
  const durable=commandJournal(db);
  const audit=(a,action,id)=>db.prepare('INSERT INTO business_audit(subject,client,action,object_id,at) VALUES(?,?,?,?,?)').run(a.subject,a.clientId||'web',action,id,now());
  const transaction=fn=>{db.exec('SAVEPOINT business_state');try{const result=fn();db.exec('RELEASE business_state');return result;}catch(e){db.exec('ROLLBACK TO business_state; RELEASE business_state');throw e;}};
  const scoped=(table,a,id,client=true)=>{z.uuid().parse(id);const r=db.prepare('SELECT * FROM '+table+' WHERE id=? AND subject=?'+(client?' AND client=?':'')).get(id,a.subject,...(client?[a.clientId]:[]));if(!r)fail('NOT_FOUND','记录不存在',404);return r;};
  const view=r=>({id:r.id,operationId:r.id,kind:r.kind,scope:r.scope,state:r.state,expiresAt:new Date(r.expires).toISOString(),preview:JSON.parse(r.payload),fingerprint:r.fingerprint,...r.result?{result:JSON.parse(r.result)}:{},confirmationUrl:'https://internal.110-lab.cn/mcp-confirm?id='+r.id});
  const draft=(a,id)=>{const r=scoped('mail_drafts',a,id);return {id:r.id,revision:r.revision,fields:JSON.parse(r.payload)};};
  const cleanup=()=>{db.prepare('DELETE FROM artifacts WHERE bound=0 AND created<?').run(now()-86400000);};
  cleanup();
  const timer=setInterval(cleanup,300000);timer.unref();
  return {
    durable,audit,
    createPreview(a,{kind,scope,payload,requestId}){
      return durable(a,requestId,'preview:'+kind,{client:a.clientId,kind,scope,payload},()=>{
        const id=randomUUID(),expires=now()+600000;
        db.prepare('INSERT INTO previews VALUES(?,?,?,?,?,?,?,\'PENDING_CONFIRMATION\',?,NULL,?)').run(id,a.subject,a.clientId,scope,kind,JSON.stringify(payload),digest(payload),expires,now());
        audit(a,'preview:'+kind,id);return view(scoped('previews',a,id));
      });
    },
    preview(a,id,{web=false}={}){const r=scoped('previews',a,id,!web);return {...view(r),clientId:r.client};},
    approve(a,id,fingerprint){return transaction(()=>{
      const r=scoped('previews',a,id,false);
      if(r.expires<=now())fail('PREVIEW_STALE','预览已过期 请重新生成');
      if(r.fingerprint!==fingerprint)fail('PREVIEW_STALE','内容已改变 请重新检查');
      if(!['PENDING_CONFIRMATION','APPROVED'].includes(r.state))fail('CONFIRMATION_USED','此确认已执行');
      db.prepare("UPDATE previews SET state='APPROVED' WHERE id=?").run(id);audit(a,'human_confirm:'+r.kind,id);
      return {id,state:'APPROVED'};
    });},
    execute(a,id,kind,fn){
      const r=scoped('previews',a,id);
      if(r.kind!==kind)fail('VALIDATION_ERROR','确认类型不匹配',400);
      if(r.result)return JSON.parse(r.result);
      if(r.expires<=now()&&r.state!=='EXECUTING')fail('PREVIEW_STALE','预览已过期 请重新生成');
      if(!['APPROVED','EXECUTING'].includes(r.state))fail('CONFIRMATION_REQUIRED','请先在确认页面检查并确认');
      // The target store journals with preview ID. A crash between its commit
      // and this receipt can safely recover using the SAME immutable command.
      db.prepare("UPDATE previews SET state='EXECUTING' WHERE id=? AND state='APPROVED'").run(id);
      const result=fn(JSON.parse(r.payload),r.id,{replayOnly:r.expires<=now()});
      if(result?.then)throw new Error('Confirmation effect must be a durable synchronous command');
      transaction(()=>{db.prepare("UPDATE previews SET state='COMPLETED',result=? WHERE id=?").run(JSON.stringify(result),id);audit(a,'execute:'+kind,id);});
      return result;
    },
    putArtifact(a,{requestId,purpose,filename,mime,buffer}){
      const sha=createHash('sha256').update(buffer).digest('hex');
      return durable(a,requestId,'artifact',{client:a.clientId,purpose,filename,mime,sha},()=>{
        const used=db.prepare('SELECT coalesce(sum(bytes),0) n FROM artifacts').get().n;
        if(used+buffer.length>512*1024*1024)fail('QUOTA_EXCEEDED','附件存储已达到上限',429);
        const recent=db.prepare('SELECT count(*) n FROM artifacts WHERE subject=? AND created>?').get(a.subject,now()-86400000).n;
        if(recent>=100)fail('RATE_LIMITED','今日上传次数已达到上限',429);
        const id=randomUUID();db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?,0,?)').run(id,a.subject,a.clientId,purpose,filename,mime,sha,buffer.length,buffer,now());
        return {artifactId:id,filename,mime,bytes:buffer.length,sha256:sha,expiresAt:new Date(now()+86400000).toISOString()};
      });
    },
    artifact(a,id,purpose){const r=scoped('artifacts',a,id);if(r.purpose!==purpose||!r.bound&&r.created<=now()-86400000)fail('NOT_FOUND','附件不存在或已过期',404);return {id:r.id,filename:r.filename,mime:r.mime,sha256:r.sha,bytes:r.bytes,buffer:Buffer.from(r.content)};},
    bindArtifact(a,id,purpose){const r=scoped('artifacts',a,id);if(r.purpose!==purpose)fail('FORBIDDEN','附件用途不匹配',403);db.prepare('UPDATE artifacts SET bound=1 WHERE id=?').run(id);},
    draft,
    saveDraft(a,input){return durable(a,input.requestId,'mail_draft',{client:a.clientId,...input},()=>{
      let id=input.id,revision=1;
      if(id){const old=draft(a,id);if(old.revision!==input.expectedRevision)fail('REVISION_CONFLICT','草稿已更新');revision=old.revision+1;}else{id=randomUUID();if(input.expectedRevision)fail('VALIDATION_ERROR','新草稿不能指定版本',400);}
      db.prepare('INSERT INTO mail_drafts VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload').run(id,a.subject,a.clientId,revision,JSON.stringify(input.fields),now());
      audit(a,'mail_draft_save',id);return draft(a,id);
    });},
    queueMail(a,previewId,payload,{replayOnly=false}={}){return transaction(()=>{
      const old=db.prepare('SELECT id FROM mail_jobs WHERE preview=?').get(previewId);if(old)return {operationId:old.id,state:'QUEUED',mailStatus:'NOT_SENT'};
      if(replayOnly)fail('PREVIEW_STALE','预览已过期且没有投递记录 请重新生成');
      const id=previewId;db.prepare("INSERT INTO mail_jobs(id,subject,client,preview,payload,state,result,created,updated) VALUES(?,?,?,?,?,'QUEUED',NULL,?,?)").run(id,a.subject,a.clientId,previewId,JSON.stringify(payload),now(),now());
      audit(a,'mail_queued',id);return {operationId:id,state:'QUEUED',mailStatus:'NOT_SENT',mode:payload.mode};
    });},
    operation(a,id){const job=db.prepare('SELECT * FROM mail_jobs WHERE id=? AND subject=? AND client=?').get(id,a.subject,a.clientId);if(job)return {operationId:id,scope:'mail:send',kind:'mail.send',state:job.state,mode:JSON.parse(job.payload).mode,...job.result?{result:JSON.parse(job.result)}:{}};return view(scoped('previews',a,id));},
    recoverMail(){db.prepare("UPDATE mail_jobs SET state='UNKNOWN',result=?,updated=? WHERE state='SENDING' AND lease_until<=?").run(JSON.stringify({code:'INTERRUPTED',message:'服务中断 结果待核实 不自动重发'}),now(),now());},
    claimMail(){return transaction(()=>{const r=db.prepare("SELECT * FROM mail_jobs WHERE state='QUEUED' ORDER BY created,id LIMIT 1").get();if(!r)return null;db.prepare("UPDATE mail_jobs SET state='SENDING',updated=?,lease_until=? WHERE id=? AND state='QUEUED'").run(now(),now()+120000,r.id);return {...r,payload:JSON.parse(r.payload)};});},
    finishMail(id,state,result){db.prepare("UPDATE mail_jobs SET state=?,result=?,updated=? WHERE id=? AND state='SENDING'").run(state,JSON.stringify(result),now(),id);},
    close(){clearInterval(timer);db.close();},
  };
}

export function paginate(items,args,subject) {
  const {cursor,limit=20,...filters}=args;
  const rows=[...items].sort((a,b)=>String(a.id||a.subject).localeCompare(String(b.id||b.subject)));
  const fingerprint=digest({subject,filters,rows:rows.map(r=>[r.id||r.subject,r.revision||r.updatedAt||null])});
  let offset=0;
  if(cursor){try{const c=JSON.parse(Buffer.from(cursor,'base64url').toString());if(c.hash!==fingerprint||!Number.isSafeInteger(c.offset)||c.offset<0||c.offset>rows.length)throw new Error();offset=c.offset;}catch{fail('CURSOR_STALE','列表已改变 请从第一页重新查询');}}
  const next=offset+limit;
  return {items:rows.slice(offset,next),total:rows.length,nextCursor:next<rows.length?Buffer.from(JSON.stringify({hash:fingerprint,offset:next})).toString('base64url'):null};
}
