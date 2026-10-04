// Isolated recruitment rehearsal. This module has no network or mail adapter.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,chmodSync,openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {nextRecruitmentStage} from './recruitment-test-machine.mjs';

export const TEST_RESUME_RETENTION_MS=30*86400000;
const MAX_STORED_RESUME_BYTES=100*1024*1024;

export class RecruitmentTestError extends Error {constructor(status,message){super(message);this.status=status;}}
const fail=(status,message)=>{throw new RecruitmentTestError(status,message);};
export function requireRecruitmentAdmin(actor){
  if(!actor?.subject)fail(401,'请先通过飞书登录');
  if(!['admin','super_admin'].includes(actor.role))fail(403,'仅实验室管理员可使用招新测试空间');
  return actor;
}
const text=(max,min=0)=>z.string().trim().min(min).max(max).refine(v=>!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v));
const email=z.email().max(254).transform(v=>v.toLowerCase()).refine(v=>{
  const host=v.split('@')[1];return ['example.com','example.net','example.org'].includes(host)||host.endsWith('.test');
},'仅允许 example.com 或 .test 等虚构邮箱');
const createSchema=z.object({requestId:z.uuid(),name:text(80,1),group:text(60,1),email,summary:text(2000)}).strict();
const common={requestId:z.uuid(),revision:z.number().int().min(1)};
const actionSchema=z.discriminatedUnion('action',[
  z.object({...common,action:z.literal('screen'),assessmentRequired:z.boolean(),note:text(2000)}).strict(),
  ...['assessment','interview'].map(action=>z.object({...common,action:z.literal(action),score:z.number().min(0).max(100),note:text(2000,1)}).strict()),
  z.object({...common,action:z.literal('schedule'),at:z.iso.datetime(),interviewer:text(80,1),location:text(500,1)}).strict(),
  ...['approve_notice','archive'].map(action=>z.object({...common,action:z.literal(action)}).strict()),
  z.object({...common,action:z.literal('simulate_notice'),fail:z.boolean()}).strict(),
  ...['accept','reject'].map(action=>z.object({...common,action:z.literal(action),note:text(2000,1)}).strict()),
]);
const actionLabels={create:'建立测试候选人',resume:'上传测试简历',screen:'完成初筛',assessment:'记录考核',schedule:'安排面试',approve_notice:'审核模拟通知',simulate_notice:'模拟通知',interview:'记录面试',accept:'测试录取',reject:'测试未通过',archive:'归档'};
function privateFile(path){
  try{closeSync(openSync(path,'wx',0o600));}catch(e){if(e.code!=='EEXIST')throw e;}
  const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Unsafe recruitment test file');
  chmodSync(path,0o600);
}
export function openRecruitmentTestStore({directory,now=Date.now}){
  mkdirSync(directory,{recursive:true,mode:0o700});
  const stat=lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Unsafe recruitment test directory');
  chmodSync(directory,0o700);
  const path=join(directory,'recruitment-test.sqlite');privateFile(path);
  // DELETE journal keeps this small rehearsal database self-contained for backups.
  const db=new DatabaseSync(path);
  try{db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS test_candidates(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS test_requests(actor TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, candidate_id TEXT NOT NULL, PRIMARY KEY(actor,request_id));
    CREATE TABLE IF NOT EXISTS test_resumes(candidate_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, content BLOB NOT NULL);`);
  }catch(e){db.close();throw e;}
  const get=id=>{const row=db.prepare('SELECT data FROM test_candidates WHERE id=?').get(id);if(!row)fail(404,'候选人不存在');return JSON.parse(row.data);};
  const put=c=>db.prepare('INSERT INTO test_candidates(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(c.id,JSON.stringify(c));
  const visible=c=>({...c,resume:c.resume&&Date.parse(c.resume.expiresAt)>now()?c.resume:null});
  const cleanup=()=>db.prepare('DELETE FROM test_resumes WHERE expires_at<=?').run(now());
  cleanup();
  function mutation(actor,input,target,fn){
    requireRecruitmentAdmin(actor);
    const fingerprint=createHash('sha256').update(JSON.stringify({target,input})).digest('hex');
    db.exec('BEGIN IMMEDIATE');
    try{
      const previous=db.prepare('SELECT * FROM test_requests WHERE actor=? AND request_id=?').get(actor.subject,input.requestId);
      if(previous){if(previous.fingerprint!==fingerprint)fail(409,'请求已改变 请刷新后重试');const c=get(previous.candidate_id);db.exec('COMMIT');return visible(c);}
      if(Number(db.prepare('SELECT COUNT(*) n FROM test_requests').get().n)>=50000)fail(429,'测试操作已达上限');
      const c=fn();put(c);
      db.prepare('INSERT INTO test_requests VALUES(?,?,?,?)').run(actor.subject,input.requestId,fingerprint,c.id);
      db.exec('COMMIT');return visible(c);
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  function event(c,actor,action,note=''){
    c.updatedAt=new Date(now()).toISOString();
    c.events.push({id:randomUUID(),at:c.updatedAt,actor:actor.name,action:actionLabels[action],note});
  }
  return {close(){db.close();},cleanup,list(actor){requireRecruitmentAdmin(actor);return {mode:'test',items:db.prepare("SELECT json_remove(data,'$.events','$.assessment','$.interview','$.decisionNote','$.notification.body') data FROM test_candidates ORDER BY rowid DESC").all().map(r=>visible(JSON.parse(r.data)))};},get(actor,id){requireRecruitmentAdmin(actor);return visible(get(id));},
    create(actor,raw){requireRecruitmentAdmin(actor);const input=createSchema.parse(raw);return mutation(actor,input,'create',()=>{
      if(Number(db.prepare('SELECT COUNT(*) n FROM test_candidates').get().n)>=200)fail(429,'测试空间最多保留 200 位候选人');
      const {requestId,...fields}=input;
      const duplicate=db.prepare('SELECT id FROM test_candidates WHERE json_extract(data,\'$.email\')=? AND json_extract(data,\'$.group\')=?').get(fields.email,fields.group);
      if(duplicate)fail(409,'该邮箱已在此组别建立候选人 请搜索后继续处理');
      const c={...fields,id:randomUUID(),stage:'screening',revision:1,createdAt:new Date(now()).toISOString(),updatedAt:null,assessment:null,interview:null,notification:null,resume:null,decisionNote:'',archived:false,events:[]};
      event(c,actor,'create');return c;
    });},
    attachResume(actor,id,file){
      requireRecruitmentAdmin(actor);
      const input=z.object({...common,filename:text(180,1),bytes:z.number().int().min(1).max(10*1024*1024),extension:z.enum(['pdf','docx']),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse({requestId:file.requestId,revision:file.revision,filename:file.filename,bytes:file.bytes,extension:file.extension,sha256:file.sha256});
      if(!Buffer.isBuffer(file.buffer)||file.buffer.length!==input.bytes||createHash('sha256').update(file.buffer).digest('hex')!==input.sha256)fail(400,'文件校验失败');
      return mutation(actor,input,'resume:'+id,()=>{
        const c=get(id);
        if(c.revision!==input.revision)fail(409,'内容已被其他管理员更新 请刷新后重试');
        if(c.archived)fail(409,'候选人已归档');
        if(c.events.length>=200)fail(429,'单个测试候选人的操作已达上限');
        cleanup();
        const used=Number(db.prepare('SELECT COALESCE(SUM(length(content)),0) n FROM test_resumes WHERE candidate_id<>?').get(id).n);
        if(used+file.bytes>MAX_STORED_RESUME_BYTES)fail(429,'测试简历存储已达上限 请等待到期清理');
        const expires=now()+TEST_RESUME_RETENTION_MS;
        db.prepare('INSERT INTO test_resumes VALUES(?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET expires_at=excluded.expires_at,content=excluded.content').run(id,expires,file.buffer);
        c.resume={filename:input.filename,bytes:input.bytes,sha256:input.sha256,extension:input.extension,uploadedAt:new Date(now()).toISOString(),expiresAt:new Date(expires).toISOString()};
        c.revision++;event(c,actor,'resume',input.filename);return c;
      });
    },
    readResume(actor,id){requireRecruitmentAdmin(actor);const c=visible(get(id));const row=db.prepare('SELECT content FROM test_resumes WHERE candidate_id=? AND expires_at>?').get(id,now());if(!c.resume||!row)fail(404,'简历不存在或已到期清理');return {...c.resume,buffer:Buffer.from(row.content)};},
    act(actor,id,raw){requireRecruitmentAdmin(actor);const input=actionSchema.parse(raw);return mutation(actor,input,id,()=>{
      const c=get(id);
      if(c.revision!==input.revision)fail(409,'内容已被其他管理员更新 请刷新后重试');
      if(c.archived)fail(409,'候选人已归档');
      if(c.events.length>=200)fail(429,'单个测试候选人的操作已达上限');
      const nextStage=nextRecruitmentStage(c,input);
      if(!nextStage)fail(409,'当前阶段或通知状态不允许此操作 请先完成前置步骤');
      let note=input.note||'';
      switch(input.action){
        case 'screen':note=(input.assessmentRequired?'进入考核':'跳过考核 进入面试')+(note?' · '+note:'');break;
        case 'assessment':c.assessment={score:input.score,note:input.note};break;
        case 'schedule':{
          const at=Date.parse(input.at);
          if(at<=now()||at>now()+366*86400000)fail(400,'面试时间需在未来一年内');
          c.interview={at:input.at,interviewer:input.interviewer,location:input.location};
          const time=new Date(at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
          c.notification={subject:`[测试面试邀请] ${c.name}-${c.group}`,body:`${c.name}：\n面试组别：${c.group}\n面试时间：${time}（北京时间）\n面试官：${input.interviewer}\n地点：${input.location}\n\n仅供 110lab 流程测试 不会向 ${c.email} 发送邮件`,status:'draft',attempts:0};
          note='面试安排已更新 通知需重新审核';break;
        }
        case 'approve_notice':c.notification.status='approved';note='当前通知内容已审核';break;
        case 'simulate_notice':
          c.notification.status=input.fail?'failed':'simulated';c.notification.attempts++;note=input.fail?'模拟发送失败 可重试':'模拟发送成功 未发送真实邮件';break;
        case 'interview':c.interview={...c.interview,score:input.score,note:input.note};break;
        case 'accept':case 'reject':c.decisionNote=input.note;break;
        case 'archive':c.archived=true;break;
      }
      c.stage=nextStage;c.revision++;event(c,actor,input.action,note);return c;
    });}
  };
}
