import {createRecruitmentRoles} from './recruitment-roles.mjs';
import {createRecruitmentNotifications,isRecruitmentIm,AUTOMATIC_RECRUITMENT_KINDS} from './recruitment-notifications.mjs';
import {createRecruitmentLifecycle} from './recruitment-lifecycle.mjs';
import {invalidateOutcome,decisionContext} from './recruitment-workspace.mjs';
import {cleanMailHtml,imageIds} from './recruitment-rich-mail.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,chmodSync,openSync,closeSync,readFileSync,writeFileSync,readdirSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,randomBytes,createHmac,createHash} from 'node:crypto';
import {z} from 'zod';
import {nextRecruitmentStage} from './recruitment-test-machine.mjs';
import {RecruitmentTestError,requireRecruitmentAdmin as requireLabAdministrator} from './recruitment-test-store.mjs';
import {keyHash,RecruitmentError,MAX_FILE_BYTES} from './recruitment-store.mjs';
import {DEFAULT_RECRUITMENT_MAILBOX,RECRUITMENT_FEISHU_APP_ID,workflowText as text,mailboxSchema,templateSchema,defaultInterviewTemplate,defaultRecruitmentTemplates,renderInterviewTemplate,previewHash} from './recruitment-templates.mjs';

const fail=(status,message)=>{throw new RecruitmentTestError(status,message);};
const superAdmin=actor=>{requireLabAdministrator(actor);if(actor.role!=='super_admin')fail(403,'仅超级管理员可配置邮箱和飞书联动');};
const common={requestId:z.uuid(),revision:z.number().int().min(1)};
const labels={create:'建立候选人',intake:'官网简历投递',resume:'更新简历',screen:'完成初筛',assessment:'记录考核',schedule:'安排面试',prepare_notice:'生成邮件预览',send_notice:'确认面试邮件',interview:'记录面试',accept:'录取',reject:'未通过',archive:'归档',retry_delivery:'重试投递',confirm_forward:'确认简历转送',sync_feishu:'确认飞书联动',resolve_delivery:'核实投递结果'};
const createSchema=z.object({requestId:z.uuid(),name:text(80,1),group:text(60,1),email:mailboxSchema,summary:text(2000)}).strict();
const settingsSchema=z.object({
  ...common,mailboxes:z.array(z.object({address:mailboxSchema,label:text(80,1),enabled:z.boolean()}).strict()).min(1).max(10),
  sender:mailboxSchema,recipient:mailboxSchema,receiptTemplateId:z.uuid().default('11011011-0110-4110-8110-110110110111'),
  feishu:z.object({appToken:z.string().regex(/^[A-Za-z0-9]{10,80}$/).or(z.literal('')),tableId:z.string().regex(/^tbl[A-Za-z0-9]{5,60}$/).or(z.literal(''))}).strict().default({appToken:'',tableId:''}),
}).strict().superRefine((s,ctx)=>{
  if(new Set(s.mailboxes.map(m=>m.address)).size!==s.mailboxes.length)ctx.addIssue({code:'custom',message:'邮箱重复'});
  if(![s.sender,s.recipient].every(a=>s.mailboxes.some(m=>m.address===a&&m.enabled)))ctx.addIssue({code:'custom',message:'收件与发件邮箱必须是已启用邮箱'});
  if(!!s.feishu.appToken!==!!s.feishu.tableId)ctx.addIssue({code:'custom',message:'飞书表格参数需同时填写'});
});
const actionSchema=z.discriminatedUnion('action',[
  z.object({...common,action:z.literal('screen'),assessmentRequired:z.boolean(),note:text(2000)}).strict(),
  ...['assessment','interview'].map(action=>z.object({...common,action:z.literal(action),score:z.number().min(0).max(100),note:text(2000,1)}).strict()),
  z.object({...common,action:z.literal('schedule'),at:z.iso.datetime(),interviewer:text(80,1),email:mailboxSchema,contact:text(500,1),location:text(500,1)}).strict(),
  ...['accept','reject'].map(action=>z.object({...common,action:z.literal(action),note:text(2000,1)}).strict()),
  z.object({...common,action:z.literal('archive')}).strict(),
  z.object({...common,action:z.literal('prepare_notice'),templateId:z.uuid(),templateRevision:z.number().int().positive(),sender:mailboxSchema.optional(),values:z.record(z.string(),text(1000))}).strict(),
  ...['send_notice','send_receipt','confirm_forward','sync_feishu'].map(action=>z.object({...common,action:z.literal(action),previewHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()),
  z.object({...common,action:z.literal('retry_delivery'),deliveryId:z.uuid()}).strict(),
  z.object({...common,action:z.literal('resolve_delivery'),deliveryId:z.uuid(),outcome:z.enum(['sent','not_sent']),note:text(2000,1)}).strict(),
]);
const publicReceipt=row=>({id:row.id,status:'RECEIVED',receivedAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.created_at).toISOString(),mailStatus:'NOT_SENT',retriesRemaining:0});
function privateFile(path){
  try{closeSync(openSync(path,'wx',0o600));}catch(e){if(e.code!=='EEXIST')throw e;}
  const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Unsafe recruitment workflow file');chmodSync(path,0o600);
}

// The public intake and administrator workflow commit to one database. No
// cross-database copy, background import or automatic retention deletion.
export function openRecruitmentWorkflowStore({directory,now=Date.now,maxStoredBytes=Number(process.env.PORTAL_RECRUITMENT_WORKFLOW_STORAGE_BYTES||1024*1024*1024),deliveryMode='dry-run',mailProfiles=[],liveTestEmails=[],liveTestSubjects=[]}={}){
  if(!['dry-run','live'].includes(deliveryMode))throw new Error('Invalid delivery mode');
  liveTestEmails=z.array(mailboxSchema).max(10).parse(liveTestEmails);liveTestSubjects=z.array(z.string().regex(/^[^:]+:on_[a-zA-Z0-9_-]{10,100}$/)).max(10).parse(liveTestSubjects);
  if(liveTestEmails.length&&!liveTestSubjects.length)throw new Error('Test delivery requires explicit Feishu recipients');
  if(!Number.isSafeInteger(maxStoredBytes)||maxStoredBytes<1)throw new Error('Invalid recruitment storage limit');
  for(const path of [directory,join(directory,'tmp')]){
    mkdirSync(path,{recursive:true,mode:0o700});const stat=lstatSync(path);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Unsafe recruitment workflow directory');chmodSync(path,0o700);
  }
  const saltPath=join(directory,'intake-salt');
  try{writeFileSync(saltPath,randomBytes(32),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
  privateFile(saltPath);const salt=readFileSync(saltPath);if(salt.length!==32)throw new Error('Invalid intake salt');
  const filename=join(directory,'recruitment.sqlite');privateFile(filename);
  const db=new DatabaseSync(filename);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS mail_images(id TEXT PRIMARY KEY,metadata TEXT NOT NULL,content BLOB NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS resumes(candidate_id TEXT PRIMARY KEY,content BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS resume_history(candidate_id TEXT NOT NULL,sha256 TEXT NOT NULL,metadata TEXT NOT NULL,content BLOB NOT NULL,PRIMARY KEY(candidate_id,sha256));
    CREATE TABLE IF NOT EXISTS requests(actor TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(actor,request_id));
    CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS templates(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,at INTEGER NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS intake_receipts(id TEXT PRIMARY KEY,key_hash TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,candidate_id TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS intake_fingerprints ON intake_receipts(fingerprint,created_at);
    CREATE TABLE IF NOT EXISTS budgets(scope TEXT NOT NULL,key TEXT NOT NULL,bucket INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(scope,key,bucket));
    CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL,kind TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,actor TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,lease TEXT,lease_until INTEGER,next_at INTEGER NOT NULL,error TEXT,result TEXT);
    CREATE INDEX IF NOT EXISTS delivery_candidate_kind_time ON deliveries(candidate_id,kind,created_at DESC);
    CREATE TABLE IF NOT EXISTS delivery_events(id INTEGER PRIMARY KEY,delivery_id TEXT NOT NULL,at INTEGER NOT NULL,status TEXT NOT NULL,code TEXT);
    CREATE TABLE IF NOT EXISTS delivery_clock(id INTEGER PRIMARY KEY CHECK(id=1),next_at INTEGER NOT NULL);
    INSERT OR IGNORE INTO delivery_clock VALUES(1,0);`);
  const initial={revision:1,mailboxes:[{address:DEFAULT_RECRUITMENT_MAILBOX,label:'110实验室公共邮箱',enabled:true}],sender:DEFAULT_RECRUITMENT_MAILBOX,recipient:DEFAULT_RECRUITMENT_MAILBOX,feishu:{appToken:'',tableId:''}};
  db.prepare('INSERT OR IGNORE INTO settings VALUES(1,?)').run(JSON.stringify(initial));
  for(const template of defaultRecruitmentTemplates())db.prepare('INSERT OR IGNORE INTO templates VALUES(?,?)').run(template.id,JSON.stringify(template));
  const settings=()=>JSON.parse(db.prepare('SELECT data FROM settings WHERE id=1').get().data);
  const stamp=()=>new Date(now()).toISOString();
  const get=id=>{const row=db.prepare('SELECT data FROM candidates WHERE id=?').get(id);if(!row)fail(404,'候选人不存在');return JSON.parse(row.data);};
  const put=c=>db.prepare('INSERT INTO candidates VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(c.id,JSON.stringify(c));
  const event=(c,actor,action,note='')=>{c.updatedAt=stamp();c.events.push({id:randomUUID(),at:c.updatedAt,actor:actor.name||actor.subject,subject:actor.subject,action:labels[action]||action,note});};
  const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
  const hash=value=>createHmac('sha256',salt).update(value).digest('hex');
  const audit=(actor,action,data)=>db.prepare('INSERT INTO audit VALUES(?,?,?,?,?)').run(randomUUID(),now(),actor.subject,action,JSON.stringify(data));
  const roles=createRecruitmentRoles({db,now,tx,fail,audit});
  const requireRecruitmentAdmin=roles.requireOperator;
  const mutate=(actor,input,target,fn)=>{
    requireRecruitmentAdmin(actor);const fingerprint=previewHash({target,input});
    return tx(()=>{
      requireRecruitmentAdmin(actor);
      const old=db.prepare('SELECT fingerprint,result FROM requests WHERE actor=? AND request_id=?').get(actor.subject,input.requestId);
      if(old){if(old.fingerprint!==fingerprint)fail(409,'同一请求内容已改变 请重新操作');return JSON.parse(old.result);}
      const result=fn();db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(actor.subject,input.requestId,fingerprint,JSON.stringify(result));return result;
    });
  };
  const file=(id,buffer,metadata)=>{
    if(!Buffer.isBuffer(buffer)||buffer.length!==metadata.bytes||previewHashBytes(buffer)!==metadata.sha256)fail(400,'简历完整性校验失败');
    const previous=db.prepare('SELECT content FROM resumes WHERE candidate_id=?').get(id);
    if(previous){const old=get(id).resume;if(old&&old.sha256!==metadata.sha256)db.prepare('INSERT OR IGNORE INTO resume_history VALUES(?,?,?,?)').run(id,old.sha256,JSON.stringify(old),previous.content);}
    const used=Number(db.prepare('SELECT COALESCE(SUM(length(content)),0) n FROM resumes WHERE candidate_id<>?').get(id).n)+Number(db.prepare('SELECT COALESCE(SUM(length(content)),0) n FROM resume_history').get().n);
    if(used+buffer.length>maxStoredBytes)fail(503,'简历存储空间不足 请联系管理员扩容');
    db.prepare('INSERT INTO resumes VALUES(?,?) ON CONFLICT(candidate_id) DO UPDATE SET content=excluded.content').run(id,buffer);
  };
  const baseCandidate=(id,fields,source)=>({...fields,id,source,stage:'screening',revision:1,createdAt:stamp(),updatedAt:stamp(),assessment:null,interview:null,notification:null,resume:null,decisionNote:'',archived:false,events:[]});
  const getTemplate=id=>{const row=db.prepare('SELECT data FROM templates WHERE id=?').get(id);if(!row)fail(404,'邮件模板不存在');return JSON.parse(row.data);};
  const settingsView=()=>({...settings(),mode:deliveryMode,testDeliveryEnabled:liveTestEmails.length>0,retention:'permanent',feishuAppId:RECRUITMENT_FEISHU_APP_ID,profiles:mailProfiles.map(p=>({address:p.address,configured:p.configured===true}))});
  const readResume=id=>{const c=get(id),row=db.prepare('SELECT content FROM resumes WHERE candidate_id=?').get(id);if(!c.resume||!row)fail(404,'简历不存在');return {...c.resume,buffer:Buffer.from(row.content)};};
  const receiptValue=row=>{
    const value=publicReceipt(row),mail=db.prepare("SELECT status,updated_at FROM deliveries WHERE candidate_id=? AND kind='receipt' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(row.candidate_id);
    if(mail){value.mailStatus=mail.status;value.updatedAt=new Date(mail.updated_at).toISOString();if(mail.status==='SENT')value.status='SENT';}
    return value;
  };
  const appPreview=c=>{
    const s=settings();return {kind:'application',candidateId:c.id,candidateRevision:c.revision,settingsRevision:s.revision,from:s.sender,to:s.recipient,replyTo:c.email,subject:`[招新简历] ${c.name}-${c.group}`,body:`110 实验室官网简历投递\n\n姓名：${c.name}\n应聘组别：${c.group}\n联系邮箱：${c.email}\n编号：${c.id}\n\n资料已保存在实验室招新系统。`,attachment:c.resume?{sha256:c.resume.sha256,filename:c.resume.filename}:null};
  };
  const feishuPreview=c=>{
    const s=settings();return {kind:'feishu',candidateId:c.id,candidateRevision:c.revision,settingsRevision:s.revision,appId:RECRUITMENT_FEISHU_APP_ID,target:s.feishu,fields:{'110lab编号':c.id,'姓名':c.name,'应聘组别':c.group,'阶段':c.stage,'邮箱':c.email,'工作台链接':{text:'查看候选人',link:'https://internal.110-lab.cn/recruitment?candidate='+c.id}},recordId:previewHash(c.feishu?.target||{})===previewHash(s.feishu)?c.feishu?.recordId||null:null};
  };
  const deliveryView=row=>({id:row.id,kind:row.kind,mode:row.mode,status:row.status,attempts:row.attempts,error:row.error,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),payload:JSON.parse(row.payload),events:db.prepare('SELECT at,status,code FROM delivery_events WHERE delivery_id=? ORDER BY id').all(row.id)});
  const deliveryEvent=(id,status,code=null)=>db.prepare('INSERT INTO delivery_events(delivery_id,at,status,code) VALUES(?,?,?,?)').run(id,now(),status,code);
  const enqueue=(c,actor,kind,payload)=>{
    if(db.prepare("SELECT id FROM deliveries WHERE candidate_id=? AND kind=? AND status IN ('QUEUED','SENDING','RETRYING','UNKNOWN')").get(c.id,kind))fail(409,'已有待处理或结果待核实的任务 请先处理原任务');
    const s=settings();
    if(!isRecruitmentIm(kind)&&(!s.mailboxes.some(m=>m.enabled&&m.address===payload.from)))fail(409,'发件邮箱已停用 请重新预览');
    if(modeFor(c)==='live'&&!isRecruitmentIm(kind)&&!mailProfiles.some(p=>p.address===payload.from&&p.configured))fail(409,'此邮箱尚未配置服务器发信凭证');
    if(kind==='feishu')fail(409,'招新数据已改为工作台管理 请分配面试官');
    const id=randomUUID(),time=now(),taskMode=modeFor(c);
    if(taskMode==='live'&&deliveryMode!=='live'&&isRecruitmentIm(kind)&&!liveTestSubjects.includes(payload.subject))fail(403,'测试阶段只能通知指定的本人飞书身份');
    db.prepare('INSERT INTO deliveries(id,candidate_id,kind,mode,status,payload,actor,created_at,updated_at,next_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,c.id,kind,taskMode,'QUEUED',JSON.stringify(payload),actor.subject,time,time,time);
    deliveryEvent(id,'QUEUED');return id;
  };
  const consume=(scope,key,limit,window)=>{
    const bucket=Math.floor(now()/window),row=db.prepare('INSERT INTO budgets VALUES(?,?,?,1) ON CONFLICT(scope,key,bucket) DO UPDATE SET count=count+1 RETURNING count').get(scope,key,bucket);
    if(row.count>limit)throw new RecruitmentError(429,'RATE_LIMITED','投递次数较多 请稍后再试');
  };
  const modeFor=c=>liveTestEmails.includes(c.email)?'live':deliveryMode;
  const validateReceiptTemplate=t=>{if(t.kind!=='receipt')fail(400,'请选择投递回执模板');try{renderInterviewTemplate(t,{id:randomUUID(),name:'候选人',group:'组别',email:'fixture@example.com'});}catch{fail(400,'自动回执仅可使用投递信息 自定义必填变量需设置默认值');}};
  const receiptStatus=id=>db.prepare("SELECT status FROM deliveries WHERE candidate_id=? AND kind='receipt' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(id)?.status||null;
  const notifications=createRecruitmentNotifications({db,now,tx,get,roles,modeFor,deliveryEvent,fail});
  const lifecycle=createRecruitmentLifecycle({db,now,stamp,get,put,event,tx,mutate,enqueue,settings,getTemplate,fail,requireAdmin:requireRecruitmentAdmin,mode:deliveryMode,modeFor,deliveryEvent,readResume});
  return {
    ...lifecycle,...notifications,
    canManage:roles.canManage,requireOperator:roles.requireOperator,recruitmentSession:roles.session,listHr:roles.listHr,setHr:roles.setHr,
    root:directory,mode:deliveryMode,close:()=>db.close(),
    publicConfig:()=>({workflow:true,enabled:true,available:true,maxFileBytes:MAX_FILE_BYTES,recipient:settings().recipient,intakeRevision:settings().revision,retention:'permanent',deliveryMode}),
    beginUpload(ip){consume('upload',hash(ip),30,600000);},
    acceptApplication({authorization,ip,fields,buffer,extension,bytes,sha256,intakeRevision}){
      const supplied=keyHash(authorization),fingerprint=hash(JSON.stringify([fields.name,fields.group,fields.email,sha256]));
      return tx(()=>{
        const old=db.prepare('SELECT * FROM intake_receipts WHERE key_hash=?').get(supplied);
        if(old){if(old.fingerprint!==fingerprint)throw new RecruitmentError(409,'RECEIPT_CONFLICT','同一回执不能用于不同资料');return {...receiptValue(old),reused:true};}
        if(intakeRevision!==settings().revision)throw new RecruitmentError(409,'INTAKE_SETTINGS_CHANGED','投递信息已更新 请刷新表单后重新确认');
        if(db.prepare('SELECT id FROM intake_receipts WHERE fingerprint=? AND created_at>?').get(fingerprint,now()-86400000))throw new RecruitmentError(409,'DUPLICATE_SUBMISSION','这份资料已接收 无需重复投递');
        consume('accepted-ip',hash(ip),30,3600000);consume('accepted-email',hash(fields.email),3,86400000);consume('accepted-all','all',100,86400000);
        const id=randomUUID(),c=baseCandidate(id,{name:fields.name,email:fields.email,group:fields.group,summary:''},'website');
        c.consent={at:stamp(),version:'110lab-recruitment-permanent-v1',recipient:settings().recipient};
        c.resume={filename:`${fields.name}-${fields.group}-简历.${extension}`,bytes,extension,sha256,uploadedAt:stamp(),expiresAt:null};
        file(id,buffer,c.resume);event(c,{subject:'website',name:'官网投递'},'intake');put(c);notifications.recordIntake(c);
        // Only new explicitly enabled intakes queue a candidate receipt. Existing held
        // and simulated tasks remain in their original mode after deployment.
        const payload=lifecycle.receiptPayload(c),job=randomUUID(),time=now(),taskMode=modeFor(c),initialStatus=taskMode==='live'?'QUEUED':'HELD';
        db.prepare('INSERT INTO deliveries(id,candidate_id,kind,mode,status,payload,actor,created_at,updated_at,next_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(job,id,'receipt',taskMode,initialStatus,JSON.stringify(payload),'website',time,time,time);
        deliveryEvent(job,initialStatus);
        db.prepare('INSERT INTO intake_receipts VALUES(?,?,?,?,?)').run(id,supplied,fingerprint,id,time);
        return receiptValue(db.prepare('SELECT * FROM intake_receipts WHERE id=?').get(id));
      });
    },
    receipt(id,authorization){
      const supplied=keyHash(authorization),row=id===null?db.prepare('SELECT * FROM intake_receipts WHERE key_hash=?').get(supplied):db.prepare('SELECT * FROM intake_receipts WHERE id=? AND key_hash=?').get(id,supplied);
      if(!row)throw new RecruitmentError(404,'RECEIPT_NOT_FOUND','找不到此回执');return receiptValue(row);
    },
    hasReceipt(id,authorization){const supplied=keyHash(authorization);return !!(id===null?db.prepare('SELECT id FROM intake_receipts WHERE key_hash=?').get(supplied):db.prepare('SELECT id FROM intake_receipts WHERE id=? AND key_hash=?').get(id,supplied));},
    labInbox(){return {state:'ready',items:db.prepare('SELECT data FROM candidates ORDER BY rowid DESC LIMIT 1000').all().map(({data})=>{const c=JSON.parse(data);return {id:c.id,name:c.name,group:c.group,receivedAt:c.createdAt,deliveryStatus:'RECEIVED'};})};},
    list(actor){if(!roles.canManage(actor))return {mode:'managed',deliveryMode,items:lifecycle.interviewerList(actor).items};return {mode:'managed',deliveryMode,testDeliveryEnabled:liveTestEmails.length>0,retention:'permanent',items:db.prepare("SELECT json_remove(data,'$.draftHistory','$.interviewHistory','$.assignmentHistory','$.resultNotification.html','$.resultNotification.body','$.assignment.feedback.note','$.notification.html','$.events','$.notification.body','$.notification.variables','$.summary','$.assessment.note','$.interview.note','$.decisionNote') data FROM candidates ORDER BY rowid DESC LIMIT 10000").all().map(r=>{const c=JSON.parse(r.data);return {...c,receiptStatus:receiptStatus(c.id)};})};},
    get(actor,id){if(!roles.canManage(actor)){const c=get(id);return lifecycle.interviewerGet(actor,c.assignment?.id||'');}const c=get(id);return {...c,receiptStatus:receiptStatus(c.id),resultDraftValid:c.resultNotification?.status==='draft'&&c.resultNotification.contextHash===decisionContext(c),deliveries:db.prepare('SELECT * FROM deliveries WHERE candidate_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100').all(id).map(deliveryView)};},
    settings(actor){requireRecruitmentAdmin(actor);return settingsView();},
    saveSettings(actor,raw){superAdmin(actor);const input=settingsSchema.parse(raw);return mutate(actor,input,'settings',()=>{
      if(input.revision!==settings().revision)fail(409,'配置已更新 请刷新后重试');
      validateReceiptTemplate(getTemplate(input.receiptTemplateId));
      const {requestId,...value}=input;value.revision++;db.prepare('UPDATE settings SET data=? WHERE id=1').run(JSON.stringify(value));audit(actor,'settings',{revision:value.revision});return settingsView();
    });},
    templates(actor){requireRecruitmentAdmin(actor);return {items:db.prepare('SELECT data FROM templates ORDER BY rowid').all().map(r=>JSON.parse(r.data))};},
    saveTemplate(actor,raw){requireRecruitmentAdmin(actor);const input=z.object({requestId:z.uuid(),template:templateSchema}).strict().parse(raw);return mutate(actor,input,'template:'+input.template.id,()=>{
      const old=db.prepare('SELECT data FROM templates WHERE id=?').get(input.template.id),revision=old?JSON.parse(old.data).revision:0;
      if(revision!==input.template.revision)fail(409,'模板已更新 请刷新后重试');
      if(!old&&Number(db.prepare('SELECT COUNT(*) n FROM templates').get().n)>=50)fail(429,'最多保留 50 个模板');
      if(input.template.id===(settings().receiptTemplateId||'11011011-0110-4110-8110-110110110111')){validateReceiptTemplate(input.template);}
      const html=cleanMailHtml(input.template.html);for(const id of imageIds(html))lifecycle.readImage(actor,id);
      const value={...input.template,html,revision:revision+1,updatedAt:stamp(),updatedBy:actor.name};db.prepare('INSERT INTO templates VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id,JSON.stringify(value));audit(actor,'template',{id:value.id,revision:value.revision});return value;
    });},
    create(actor,raw){const input=createSchema.parse(raw);return mutate(actor,input,'create',()=>{
      const {requestId,...fields}=input,c=baseCandidate(randomUUID(),fields,'manual');event(c,actor,'create');put(c);return c;
    });},
    readResume(actor,id){if(!roles.canManage(actor))return lifecycle.interviewerResume(actor,id);return readResume(id);},
    attachResume(actor,id,upload){
      const input=z.object({...common,filename:text(180,1),bytes:z.number().int().min(1).max(MAX_FILE_BYTES),extension:z.enum(['pdf','docx']),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse({requestId:upload.requestId,revision:upload.revision,filename:upload.filename,bytes:upload.bytes,extension:upload.extension,sha256:upload.sha256});
      return mutate(actor,input,'resume:'+id,()=>{
        const c=get(id);if(c.revision!==input.revision||c.archived)fail(409,'候选人已更新或归档');
        if(db.prepare("SELECT id FROM deliveries WHERE candidate_id=? AND kind='application' AND status IN ('QUEUED','SENDING','RETRYING','UNKNOWN')").get(id))fail(409,'简历转送尚未结束 暂不能替换附件');
        file(id,upload.buffer,input);c.resume={filename:input.filename,bytes:input.bytes,extension:input.extension,sha256:input.sha256,uploadedAt:stamp(),expiresAt:null};c.revision++;event(c,actor,'resume',input.filename);put(c);return c;
      });
    },
    preview(actor,id,kind){requireRecruitmentAdmin(actor);const c=get(id),payload=kind==='receipt'?lifecycle.receiptPayload(c):kind==='application'?appPreview(c):kind==='feishu'?feishuPreview(c):c.notification;
      if(kind==='feishu')fail(409,'已停用表格同步 请分配面试官');
      if(!payload)fail(409,'请先生成邮件预览');return {payload,previewHash:previewHash(payload),mode:modeFor(c)};
    },
    act(actor,id,raw){const input=actionSchema.parse(raw);return mutate(actor,input,id,()=>{
      const c=get(id);if(c.revision!==input.revision)fail(409,'资料已更新 请刷新后重新预览');if(c.archived&&input.action!=='resolve_delivery')fail(409,'候选人已归档');
      let note=input.note||'';
      const action=input.action;
      if(action==='reject'&&db.prepare("SELECT id FROM deliveries WHERE candidate_id=? AND kind='interview' AND status='SENDING'").get(id))fail(409,'面试邮件正在交付 请等待结果后再结束流程');
      if(action==='prepare_notice'){
        invalidateOutcome(c,stamp());
        if(c.assignment){if(c.assignment.status!=='submitted')fail(409,'请等待面试官提交安排');c.interview={...c.assignment.proposal};}
        if(c.stage!=='interview'||!c.interview)fail(409,'请先安排面试');
        if(db.prepare("SELECT id FROM deliveries WHERE candidate_id=? AND kind='interview' AND status IN ('QUEUED','SENDING','RETRYING','UNKNOWN')").get(id))fail(409,'邮件任务尚未结束 请先处理原任务');
        const template=getTemplate(input.templateId);if(template.revision!==input.templateRevision)fail(409,'模板已更新 请重新选择');
        if((template.kind||'interview')!=='interview')fail(400,'请选择面试邀请模板');
        let rendered;try{rendered=lifecycle.mailPayload(c,template,input.values);}catch(e){fail(400,e.message);}
        const s=settings(),sender=input.sender||s.sender;if(!s.mailboxes.some(m=>m.address===sender&&m.enabled))fail(400,'请选择超级管理员已启用的发件邮箱');c.notification={...rendered,from:sender,to:c.email,status:'draft',attempts:0,templateId:template.id,templateRevision:template.revision,settingsRevision:s.revision};
      }else if(['send_notice','send_receipt','confirm_forward','sync_feishu'].includes(action)){
        const kind=action==='send_notice'?'interview':action==='send_receipt'?'receipt':action==='confirm_forward'?'application':'feishu';
        const payload=kind==='interview'?c.notification:kind==='receipt'?lifecycle.receiptPayload(c):kind==='application'?appPreview(c):feishuPreview(c);
        if(!payload||previewHash(payload)!==input.previewHash)fail(409,'预览已改变 请重新检查');
        if(payload.settingsRevision!==settings().revision)fail(409,'邮箱或联动配置已改变 请重新预览');
        if(kind==='interview'){
          if(c.stage!=='interview'||payload.status!=='draft')fail(409,'请先生成新的面试邮件预览');
          if(Date.parse(c.interview.at)<=now())fail(409,'面试时间已过 请让面试官更新安排后重新审核');
          if(getTemplate(payload.templateId).revision!==payload.templateRevision)fail(409,'模板已改变 请重新生成预览');
        }
        if(kind==='receipt'){const last=db.prepare("SELECT status FROM deliveries WHERE candidate_id=? AND kind='receipt' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(c.id);if(!last||!['FAILED','HELD','SIMULATED'].includes(last.status))fail(409,'回执已发送或尚在处理 不可重复发送');}
        const job=enqueue(c,actor,kind,payload);
        if(kind==='interview'){c.notification={...c.notification,status:'queued',deliveryId:job};if(c.assignment){c.assignment.status='approved';c.assignment.revision++;c.assignment.approvedAt=stamp();}}
        note=(modeFor(c)==='dry-run'?'模拟任务 ':'发送任务 ')+job;
      }else if(action==='resolve_delivery'){
        const row=db.prepare('SELECT * FROM deliveries WHERE id=? AND candidate_id=?').get(input.deliveryId,id);
        if(!row||row.status!=='UNKNOWN')fail(409,'仅结果待核实的任务可人工确认');
        const status=input.outcome==='sent'?'SENT':'FAILED';
        db.prepare('UPDATE deliveries SET status=?,error=?,updated_at=? WHERE id=?').run(status,'MANUALLY_VERIFIED',now(),row.id);
        deliveryEvent(row.id,status,'MANUALLY_VERIFIED');
        if(row.kind==='interview'&&c.notification?.deliveryId===row.id)c.notification.status=input.outcome==='sent'?'sent':'failed';
        if(row.kind==='outcome'&&c.resultNotification?.deliveryId===row.id)c.resultNotification.status=input.outcome==='sent'?'sent':'failed';
        if(row.kind==='interviewer'&&c.assignment?.deliveryId===row.id)c.assignment.notificationStatus=status;
        note=(input.outcome==='sent'?'核实已发送':'核实未发送')+' · '+input.note;
      }else if(action==='retry_delivery'){
        const row=db.prepare('SELECT * FROM deliveries WHERE id=? AND candidate_id=?').get(input.deliveryId,id);
        if(!row||row.status!=='FAILED')fail(409,'仅明确失败的任务可重试 待核实任务不能自动重发');
        if(!AUTOMATIC_RECRUITMENT_KINDS.includes(row.kind)&&db.prepare("SELECT id FROM deliveries WHERE candidate_id=? AND kind=? AND status IN ('QUEUED','SENDING','RETRYING','UNKNOWN')").get(id,row.kind))fail(409,'已有未结束的任务 请先核实');
        if(row.kind==='interview'&&c.notification?.deliveryId!==row.id)fail(409,'面试通知已重新生成 请使用最新预览');
        if(row.kind==='outcome'&&c.resultNotification?.deliveryId!==row.id)fail(409,'结果邮件已重新生成 请使用最新预览');
        if(row.kind==='interviewer'&&c.assignment?.deliveryId!==row.id)fail(409,'面试官通知已重新生成');
        if(row.kind==='receipt'&&db.prepare("SELECT id FROM deliveries WHERE candidate_id=? AND kind='receipt' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(id)?.id!==row.id)fail(409,'已有更新的回执 请使用最新任务');
        if(row.mode!==modeFor(c))fail(409,'发送模式已改变 请生成新的预览');
        if(row.attempts>=8)fail(429,'此任务已达到重试上限');
        const payload=JSON.parse(row.payload);if(!AUTOMATIC_RECRUITMENT_KINDS.includes(row.kind)&&payload.settingsRevision!==settings().revision)fail(409,'配置已改变 请重新生成预览');
        db.prepare("UPDATE deliveries SET status='QUEUED',actor=?,updated_at=?,next_at=?,error=NULL WHERE id=?").run(actor.subject,now(),now(),row.id);deliveryEvent(row.id,'QUEUED');
        if(row.kind==='interview')c.notification={...c.notification,status:'queued',deliveryId:row.id};
        if(row.kind==='outcome'&&c.resultNotification?.deliveryId===row.id)c.resultNotification.status='queued';
        if(row.kind==='interviewer'&&c.assignment?.deliveryId===row.id)c.assignment.notificationStatus='QUEUED';
      }else{
        // Assigned interviewers own feedback. Legacy unassigned interviews keep
        // their administrator entrypoint for backwards compatibility.
        if(action==='interview'&&c.assignment)fail(409,'请由已分配的面试官填写评价');
        if(action==='schedule'&&c.assignment)fail(409,'已分配的面试须由面试官回填');
        if(action==='schedule'&&db.prepare("SELECT id FROM deliveries WHERE candidate_id=? AND kind='interview' AND status IN ('QUEUED','SENDING','RETRYING','UNKNOWN')").get(id))fail(409,'邮件任务尚未结束 暂不能调整面试');
        const machineCandidate={...c,notification:c.notification&&{...c.notification,status:c.notification.status==='sent'?'simulated':c.notification.status}};
        const next=nextRecruitmentStage(machineCandidate,input);if(!next)fail(409,'当前阶段不允许此操作');c.stage=next;
        if(['screen','assessment','schedule','interview'].includes(action))invalidateOutcome(c,stamp());
        if(action==='screen')note=(input.assessmentRequired?'进入考核':'进入面试')+(note?' · '+note:'');
        if(action==='assessment')c.assessment={score:input.score,note};
        if(action==='schedule'){
          const at=Date.parse(input.at);if(at<=now()||at>now()+366*86400000)fail(400,'面试时间应在未来一年内');
          c.interview={at:input.at,interviewer:input.interviewer,email:input.email,contact:input.contact,location:input.location};c.notification=null;note='面试安排已更新 请生成邮件预览';
        }
        if(action==='interview')c.interview={...c.interview,score:input.score,note};
        if(['accept','reject'].includes(action))c.decisionNote=note;
        if(action==='archive')c.archived=true;
      }
      c.revision++;event(c,actor,action,note);put(c);return c;
    });},
    recoverInterrupted(){return tx(()=>{
      const rows=db.prepare("SELECT * FROM deliveries WHERE status='SENDING' AND lease_until<=?").all(now());
      for(const row of rows){db.prepare("UPDATE deliveries SET status='UNKNOWN',error='WORKER_INTERRUPTED',lease=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(now(),row.id);deliveryEvent(row.id,'UNKNOWN','WORKER_INTERRUPTED');const c=get(row.candidate_id);if(row.kind==='interview'&&c.notification?.deliveryId===row.id)c.notification.status='unknown';if(row.kind==='outcome'&&c.resultNotification?.deliveryId===row.id)c.resultNotification.status='unknown';if(row.kind==='interviewer'&&c.assignment?.deliveryId===row.id)c.assignment.notificationStatus='UNKNOWN';c.revision++;event(c,{subject:'system',name:'发送服务'},'发送结果待核实');put(c);}
      return rows.length;
    });},
    claim({mode=deliveryMode,intervalMs=60000}={}){return tx(()=>{
      if(db.prepare("SELECT id FROM deliveries WHERE status='SENDING'").get()||db.prepare('SELECT next_at FROM delivery_clock WHERE id=1').get().next_at>now())return null;
      const row=db.prepare("SELECT * FROM deliveries WHERE mode=? AND status IN ('QUEUED','RETRYING') AND next_at<=? ORDER BY CASE WHEN actor='recruitment-system' THEN 1 ELSE 0 END,created_at,rowid LIMIT 1").get(mode,now());if(!row)return null;
      const lease=randomUUID();db.prepare("UPDATE deliveries SET status='SENDING',attempts=attempts+1,lease=?,lease_until=?,updated_at=? WHERE id=?").run(lease,now()+300000,now(),row.id);
      db.prepare('UPDATE delivery_clock SET next_at=? WHERE id=1').run(now()+intervalMs);deliveryEvent(row.id,'SENDING');
      return {...row,status:'SENDING',attempts:row.attempts+1,lease,payload:JSON.parse(row.payload)};
    });},
    validateDelivery(row,role){
      const c=get(row.candidate_id),s=settings();
      if(notifications.validateNotification(row,c))return null;
      if(!(['application','receipt'].includes(row.kind)&&row.actor==='website')&&!roles.canManage({subject:row.actor,role}))fail(403,'确认人的招新权限已撤销');
      if(c.archived)fail(409,'候选人已归档');
      if(row.payload.settingsRevision!==s.revision)fail(409,'配置已改变 请重新预览');
      if(row.kind==='interview'&&(c.stage!=='interview'||c.notification?.deliveryId!==row.id||getTemplate(row.payload.templateId).revision!==row.payload.templateRevision))fail(409,'邮件模板或预览已改变');
      if(row.kind==='feishu')fail(409,'表格同步已停用');
      if(row.kind==='application'&&row.payload.attachment?.sha256!==c.resume?.sha256)fail(409,'简历附件已改变');
      if(!isRecruitmentIm(row.kind)&&!s.mailboxes.some(m=>m.enabled&&m.address===row.payload.from))fail(409,'发件邮箱已停用');
      if(row.kind==='receipt'&&getTemplate(row.payload.templateId).revision!==row.payload.templateRevision)fail(409,'回执模板已改变');
      if(row.kind==='outcome'&&(c.stage!==row.payload.outcome||c.resultNotification?.deliveryId!==row.id||getTemplate(row.payload.templateId).revision!==row.payload.templateRevision))fail(409,'结果邮件已改变');
      if(row.kind==='interviewer'&&(c.stage!=='interview'||c.assignment?.id!==row.payload.assignmentId||c.assignment?.subject!==row.payload.subject||c.assignment?.deliveryId!==row.id||!['requested','changes_requested'].includes(c.assignment?.status)))fail(409,'面试官安排已改变');
      return row.kind==='application'&&row.payload.attachment?readResume(c.id):null;
    },
    finish(row,{status,code=null,retryDelay=0,result=null}){return tx(()=>{
      if(!['SENT','SIMULATED','FAILED','RETRYING','UNKNOWN'].includes(status))throw new Error('Invalid delivery result');
      if(!db.prepare("SELECT id FROM deliveries WHERE id=? AND status='SENDING' AND lease=?").get(row.id,row.lease))return false;
      const safeCode=code&&/^[A-Z0-9_]{1,64}$/.test(code)?code:code?'DELIVERY_ERROR':null;
      db.prepare('UPDATE deliveries SET status=?,error=?,result=?,updated_at=?,next_at=?,lease=NULL,lease_until=NULL WHERE id=?').run(status,safeCode,result?JSON.stringify(result):null,now(),now()+retryDelay,row.id);deliveryEvent(row.id,status,safeCode);
      const c=get(row.candidate_id);
      if(row.kind==='interview'&&c.notification?.deliveryId===row.id)c.notification={...c.notification,status:({SENT:'sent',SIMULATED:'simulated',FAILED:'failed',RETRYING:'queued',UNKNOWN:'unknown'})[status],attempts:row.attempts};
      if(row.kind==='outcome'&&c.resultNotification?.deliveryId===row.id)c.resultNotification.status=({SENT:'sent',SIMULATED:'simulated',FAILED:'failed',RETRYING:'queued',UNKNOWN:'unknown'})[status];
      if(row.kind==='interviewer'&&c.assignment?.deliveryId===row.id)c.assignment.notificationStatus=status;
      if(row.kind==='feishu'&&status==='SENT'&&result?.recordId)c.feishu={recordId:result.recordId,target:row.payload.target,at:stamp()};
      c.revision++;event(c,{subject:'system',name:'发送服务'},isRecruitmentIm(row.kind)?'飞书通知结果':'邮件处理结果',({SENT:'服务商已接收',SIMULATED:'模拟完成 未对外发送',FAILED:'发送失败',RETRYING:'暂时失败 等待重试',UNKNOWN:'结果待核实 已停止自动重试'})[status]);put(c);return true;
    });},
    commandCommitted(actor,requestId){requireRecruitmentAdmin(actor);return !!db.prepare('SELECT 1 FROM requests WHERE actor=? AND request_id=?').get(actor.subject,requestId);},
    inspectDelivery(actor,id){requireRecruitmentAdmin(actor);const row=db.prepare('SELECT * FROM deliveries WHERE id=?').get(id);if(!row)fail(404,'任务不存在');return deliveryView(row);},
    cleanup(){for(const name of readdirSync(join(directory,'tmp'))){if(!/^[a-f0-9-]{36}\.upload$/.test(name))continue;const path=join(directory,'tmp',name),st=lstatSync(path);if(st.isFile()&&!st.isSymbolicLink()&&st.mtimeMs<now()-86400000)unlinkSync(path);}
      db.prepare('DELETE FROM budgets WHERE (scope IN (\'accepted-email\',\'accepted-all\') AND bucket<?) OR (scope=\'accepted-ip\' AND bucket<?) OR (scope=\'upload\' AND bucket<?)').run(Math.floor(now()/86400000)-2,Math.floor(now()/3600000)-48,Math.floor(now()/600000)-12);},
  };
}
const previewHashBytes=buffer=>createHash('sha256').update(buffer).digest('hex');
