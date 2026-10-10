import {isRecruitmentIm} from './recruitment-notifications.mjs';
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import MailComposer from 'nodemailer/lib/mail-composer';
import {readFileSync,lstatSync} from 'node:fs';
import {z} from 'zod';
import {resumeTypes} from './recruitment-files.mjs';
import {classifyDeliveryError,MAX_MIME_BYTES} from './recruitment-mail.mjs';
import {mailboxSchema,RECRUITMENT_FEISHU_APP_ID} from './recruitment-templates.mjs';

export async function composeWorkflowMail(job,attachment=null,images=[]){
  const p=job.payload,from=mailboxSchema.parse(p.from),to=mailboxSchema.parse(p.to),replyTo=mailboxSchema.parse(p.replyTo);
  if(typeof p.subject!=='string'||/[\r\n]/.test(p.subject)||typeof p.body!=='string')throw Object.assign(new Error('Invalid mail'),{code:'INVALID_MAIL',command:'CONN'});
  const composer=new MailComposer({from,to,replyTo,subject:p.subject,text:p.body,html:p.html||undefined,messageId:`<110lab-recruitment-${job.id}@110-lab.cn>`,headers:{'X-110lab-Delivery':job.id},
    attachments:[...(attachment?[{filename:attachment.filename,content:attachment.buffer,contentType:resumeTypes[attachment.extension]}]:[]),...images.map(i=>({filename:'image.'+i.extension,content:i.buffer,contentType:i.mime,cid:'lab-'+i.id,contentDisposition:'inline'}))],disableFileAccess:true,disableUrlAccess:true});
  const compiled=composer.compile(),raw=await compiled.build();
  if(raw.length>MAX_MIME_BYTES)throw Object.assign(new Error('Mail too large'),{code:'MIME_SIZE'});
  return {raw,envelope:{from,to:[to]}};
}
export function createWorkflowSmtpProvider(profiles,{localTest=false}={}){
  const schema=z.array(z.object({address:mailboxSchema,host:z.string().min(1).max(253),port:z.number().int().min(1).max(65535).default(465),secure:z.boolean().default(true),user:z.string().min(1),pass:z.string().min(1)}).strict()).max(10);
  const parsed=schema.parse(profiles);
  if(parsed.some(p=>!localTest&&!p.secure||localTest&&!['localhost','127.0.0.1','::1'].includes(p.host)))throw new Error('Use verified TLS SMTP endpoints');
  if(new Set(parsed.map(p=>p.address)).size!==parsed.length)throw new Error('Duplicate SMTP profile');
  const connections=new Set();let closed=false;
  return {
    profiles:parsed.map(p=>({address:p.address,configured:true})),
    send(job,message){
      const config=parsed.find(p=>p.address===job.payload.from);
      if(!config||closed)throw Object.assign(new Error('Sender unavailable'),{code:'SENDER_NOT_CONFIGURED',command:'CONN'});
      return new Promise((resolve,reject)=>{
        const connection=new SMTPConnection({host:config.host,port:config.port,secure:config.secure,ignoreTLS:localTest,connectionTimeout:15000,greetingTimeout:15000,socketTimeout:60000,logger:false,debug:false});connections.add(connection);let done=false;
        const finish=(e,value)=>{if(done)return;done=true;connections.delete(connection);connection.close();e?reject(e):resolve(value);};
        connection.once('error',e=>finish(e));connection.once('end',()=>finish(Object.assign(new Error('No SMTP confirmation'),{code:'ECONNECTION'})));
        connection.connect(()=>connection.login({user:config.user,pass:config.pass},error=>{
          if(error)return finish(error);
          connection.send(message.envelope,message.raw,(e,result)=>{
            if(!e&&(result.rejected?.length||!result.accepted?.includes(job.payload.to)))e=Object.assign(new Error('Recipient unconfirmed'),{code:'UNCONFIRMED',command:'DATA'});
            finish(e,result);
          });
        }));
      });
    },
    abort(){for(const c of connections)c.close();},
    close(){closed=true;for(const c of connections)c.close();},
  };
}
export async function runWorkflowDeliveryOnce(store,{mode='dry-run',smtp,feishu,roleForSubject,simulate,allowedEmails,allowedSubjects,intervalMs=60000,deadlineMs=180000}={}){
  if(!['dry-run','live'].includes(mode))throw new Error('Invalid delivery mode');
  store.recoverInterrupted();store.scheduleNotifications?.();const job=store.claim({mode,intervalMs});if(!job)return null;
  let timer,result;const abort=new AbortController();
  try{
    const role=['website','recruitment-system'].includes(job.actor)?'member':await roleForSubject(job.actor),attachment=store.validateDelivery(job,role);
    const im=isRecruitmentIm(job.kind);
    const message=im?null:await composeWorkflowMail(job,attachment,store.mailImages?.(job.payload)||[]);
    if(mode==='live'&&((im&&allowedSubjects&&!allowedSubjects.includes(job.payload.subject))||(!im&&allowedEmails&&!allowedEmails.includes(job.payload.to))))throw Object.assign(new Error('Test recipient is outside allowlist'),{code:'RECIPIENT_NOT_ALLOWED',command:'CONN'});
    if(mode==='dry-run'){
      // This branch never authenticates with a provider and cannot fall through
      // to a network adapter, even when credentials happen to be configured.
      if(simulate)await simulate(job,message);
      result={status:'SIMULATED'};
    }else{
      // Validate again immediately before the network operation, after MIME work.
      store.validateDelivery(job,['website','recruitment-system'].includes(job.actor)?'member':await roleForSubject(job.actor));
      const operation=im?feishu?.send(job,{signal:abort.signal}):smtp?.send(job,message);
      if(!operation)throw Object.assign(new Error('Provider unavailable'),{code:'PROVIDER_NOT_CONFIGURED',command:'CONN'});
      const value=await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>{abort.abort();smtp?.abort();reject(Object.assign(new Error('Provider confirmation timeout'),{code:'SEND_TIMEOUT',command:'DATA'}));},deadlineMs);})]);
      result={status:'SENT',result:im?{messageId:value.messageId||null}:null};
    }
  }catch(e){
    if(e.status===403||e.status===409||['PROVIDER_NOT_CONFIGURED','SENDER_NOT_CONFIGURED','FEISHU_NOT_CONFIGURED','INVALID_MAIL','RECIPIENT_NOT_ALLOWED'].includes(e.code))result={status:'FAILED',code:e.status===403?'PERMISSION_REVOKED':e.status===409?'PREVIEW_CHANGED':e.code};
    else if(isRecruitmentIm(job.kind))result={status:e.confirmedRejected?'FAILED':'UNKNOWN',code:e.code||'FEISHU_UNCONFIRMED'};
    else result=classifyDeliveryError(e);
    if(result.status==='RETRYING'){if(job.attempts>=8)result.status='FAILED';else result.retryDelay=Math.min(12*3600000,60000*5**Math.min(job.attempts-1,5));}
  }finally{clearTimeout(timer);}
  store.finish(job,result);return {id:job.id,...result};
}
export function readWorkflowProviderConfig(path){
  const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077)throw new Error('Provider configuration must be private mode 0600');
  const value=JSON.parse(readFileSync(path,'utf8'));
  if(value.testAllowlist)value.testAllowlist=z.object({emails:z.array(mailboxSchema).min(1).max(10),subjects:z.array(z.string().regex(/^[^:]+:on_[a-zA-Z0-9_-]{10,100}$/)).min(1).max(10)}).strict().parse(value.testAllowlist);
  if(value.feishu&&value.feishu.appId!==RECRUITMENT_FEISHU_APP_ID)throw new Error('Use the verified recruitment app');
  return value;
}
