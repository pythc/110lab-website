import SMTPConnection from 'nodemailer/lib/smtp-connection';
import MailComposer from 'nodemailer/lib/mail-composer';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {RECIPIENT} from './recruitment-store.mjs';
import {resumeTypes} from './recruitment-files.mjs';

export const MAX_MIME_BYTES=14500000;
export async function composeApplication(row,root,from){
  const content=readFileSync(join(root,'files',row.blob));
  if(createHash('sha256').update(content).digest('hex')!==row.sha256)throw Object.assign(new Error('Private file changed'),{code:'FILE_INTEGRITY'});
  const mail=new MailComposer({
    from,to:RECIPIENT,replyTo:row.email,
    subject:`[招新简历] ${row.name}-${row.group_name}`,
    messageId:`<110lab-resume-${row.id}@110-lab.cn>`,headers:{'X-110lab-Receipt':row.id},
    text:`110 实验室官网招新简历\n\n姓名：${row.name}\n应聘组别：${row.group_name}\n联系邮箱：${row.email}\n回执编号：${row.id}\n\n候选人已同意将本次资料用于 110 实验室招新评估与联系。简历附于邮件。`,
    attachments:[{filename:`${row.name}-${row.group_name}-简历.${row.extension}`,content,contentType:resumeTypes[row.extension]}],
    disableFileAccess:true,disableUrlAccess:true,
  }).compile();
  const raw=await mail.build();
  if(raw.length>MAX_MIME_BYTES)throw Object.assign(new Error('Encoded mail too large'),{code:'MIME_SIZE'});
  return {raw,envelope:{from:mail.getEnvelope().from,to:[RECIPIENT]}};
}

export function createSmtpSender(config,{localTest=false}={}){
  const {host,port=465,secure=true,user,pass,from}=config;
  const loopback=['127.0.0.1','::1','localhost'].includes(host);
  if(!host||!from||(!localTest&&(!user||!pass))||localTest&&!loopback||!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid SMTP configuration');
  if(/[\r\n]/.test(from)||!/^[^<>\r\n]+@[^<>\s\r\n]+$/.test(from.match(/<([^>]+)>$/)?.[1]||from))throw new Error('Invalid SMTP sender');
  if(!localTest&&secure!==true)throw new Error('Production recruitment SMTP requires implicit TLS');
  const connections=new Set();let closed=false;
  const abort=()=>{for(const connection of connections)connection.close();};
  return {from,
    send(message){return new Promise((resolve,reject)=>{
      if(closed){reject(Object.assign(new Error('Sender is stopped'),{code:'SENDER_STOPPED',command:'CONN'}));return;}
      const connection=new SMTPConnection({host,port,secure,ignoreTLS:localTest,connectionTimeout:15000,greetingTimeout:15000,socketTimeout:60000,logger:false,debug:false});
      connections.add(connection);let settled=false;
      const finish=(error,result)=>{if(settled)return;settled=true;connections.delete(connection);connection.close();error?reject(error):resolve(result);};
      connection.once('error',error=>finish(error));
      connection.once('end',()=>finish(Object.assign(new Error('Connection ended without confirmation'),{code:'ECONNECTION'})));
      const send=()=>connection.send(message.envelope,message.raw,(error,result)=>{
        if(!error&&(result.rejected?.length||!result.accepted?.includes(RECIPIENT)))error=Object.assign(new Error('SMTP did not confirm recipient'),{code:'UNCONFIRMED',command:'DATA'});
        finish(error,result);
      });
      connection.connect(()=>{if(user&&pass)connection.login({user,pass},error=>error?finish(error):send());else send();});
    });},
    abort,
    close(){closed=true;abort();},
  };
}

export function classifyDeliveryError(error){
  const code=/^[A-Z0-9_]{1,40}$/.test(error?.code||'')?error.code:'DELIVERY_ERROR';
  const response=Number(error?.responseCode),command=String(error?.command||'').toUpperCase();
  if(['FILE_INTEGRITY','MIME_SIZE','ENOENT','EAUTH'].includes(code))return {status:'FAILED',code};
  if(response>=500&&response<600)return {status:'FAILED',code:`SMTP_${response}`};
  if(response>=400&&response<500)return {status:'RETRYING',code:`SMTP_${response}`};
  if(['CONN','EHLO','HELO','STARTTLS','AUTH','MAIL FROM','RCPT TO'].some(v=>command===v||command.startsWith(v+' ')))return {status:'RETRYING',code};
  return {status:'UNKNOWN',code};
}
