import {readFileSync,openSync,fstatSync,closeSync,constants} from 'node:fs';
import {ImapFlow} from 'imapflow';
import {simpleParser} from 'mailparser';
import nodemailer from 'nodemailer';
import {z} from 'zod';
import {digest} from './durable-command.mjs';
import {fail} from './business-state.mjs';

const endpoint=z.object({host:z.string().min(1).max(253),port:z.number().int().min(1).max(65535),secure:z.literal(true),user:z.email(),pass:z.string().min(1).max(2048)}).strict();
const configSchema=z.object({mode:z.enum(['dry-run','live']).default('dry-run'),mailboxes:z.array(z.object({address:z.enum(['noreply@110-lab.cn','noreply@notify.110-lab.cn']),enabled:z.boolean(),imap:endpoint.optional(),smtp:endpoint.optional()}).strict()).max(2)}).strict();
const messageKey=z.object({folder:z.string().min(1).max(200).refine(v=>!/[\r\n\0]/.test(v)),validity:z.string().regex(/^\d+$/),uid:z.number().int().positive()}).strict();
const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
const decode=id=>{try{return messageKey.parse(JSON.parse(Buffer.from(id,'base64url').toString()));}catch{fail('NOT_FOUND','邮件不存在',404);}};
const MAX_MESSAGE=15*1024*1024;
const addresses=value=>(value||[]).map(v=>({name:String(v.name||'').slice(0,200),address:String(v.address||'').slice(0,254)}));
export function readBusinessMailConfig(path) {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const st=fstatSync(fd);if(!st.isFile()||(st.mode&0o077)||st.size>32768)throw new Error('Mail configuration must be a private regular file');
    return configSchema.parse(JSON.parse(readFileSync(fd,'utf8')));
  }finally{closeSync(fd);}
}
export function createBusinessMailProvider({config={mode:'dry-run',mailboxes:[]},makeImap=o=>new ImapFlow(o),makeSmtp=o=>nodemailer.createTransport(o),sendDeadlineMs=60000}={}) {
  const parsed=configSchema.parse(config);
  if(new Set(parsed.mailboxes.map(m=>m.address)).size!==parsed.mailboxes.length)throw new Error('Duplicate mailbox');
  for(const p of parsed.mailboxes)for(const [kind,expected]of [['imap','imap.feishu.cn'],['smtp','smtp.feishu.cn']])if(p[kind]&&(p[kind].host!==expected||p[kind].user!==p.address||p[kind].port!==(kind==='imap'?993:465)))throw new Error('Only the configured Feishu mailbox endpoint and exact sender are allowed');
  const revision=digest(parsed),active=new Set();
  function profile(address,kind){const p=parsed.mailboxes.find(p=>p.enabled&&p.address===address);if(!p||!p[kind])fail('PROVIDER_NOT_READY','此邮箱的收发服务尚未配置',503);return p[kind];}
  async function imap(address,fn){const p=profile(address,'imap'),c=makeImap({host:p.host,port:p.port,secure:true,auth:{user:p.user,pass:p.pass},logger:false,logRaw:false,disableAutoIdle:true,connectionTimeout:15000,greetingTimeout:10000,socketTimeout:15000});
    if(active.size>=4)fail('RATE_LIMITED','邮箱请求繁忙 请稍后再试',429);
    active.add(c);c.on('error',()=>{});const timer=setTimeout(()=>c.close(),30000);timer.unref();
    try{await c.connect();return await fn(c);}finally{clearTimeout(timer);c.close();active.delete(c);}
  }
  const locked=async(c,folder,fn)=>{const lock=await c.getMailboxLock(folder,{readOnly:true});try{return await fn();}finally{lock.release();}};
  async function read(address,id){const key=decode(id);return imap(address,c=>locked(c,key.folder,async()=>{
    if(String(c.mailbox.uidValidity)!==key.validity)fail('NOT_FOUND','邮箱已重建 请重新查询',404);
    const info=await c.fetchOne(key.uid,{size:true,envelope:true},{uid:true});if(!info)fail('NOT_FOUND','邮件不存在',404);if(info.size>MAX_MESSAGE)fail('ATTACHMENT_TOO_LARGE','邮件过大 请在飞书邮箱查看',413);
    const row=await c.fetchOne(key.uid,{source:true},{uid:true});if(!row?.source||row.source.length>MAX_MESSAGE)fail('ATTACHMENT_TOO_LARGE','邮件过大',413);
    const value=await simpleParser(row.source,{skipHtmlToText:false,skipTextToHtml:true,skipImageLinks:true,maxHtmlLengthToParse:200000});
    return {id,subject:value.subject||'',from:addresses(value.from?.value),to:addresses(value.to?.value),cc:addresses(value.cc?.value),replyTo:addresses(value.replyTo?.value),date:value.date?.toISOString()||null,body:(value.text||'').slice(0,100000),truncated:(value.text||'').length>100000,messageId:value.messageId||'',references:value.references||[],attachments:value.attachments||[]};
  }));}
  return {
    revision,mode:parsed.mode,
    mailboxes:()=>parsed.mailboxes.map(p=>({address:p.address,enabled:p.enabled,canRead:p.enabled&&!!p.imap,canSend:p.enabled&&!!p.smtp,state:p.enabled&&(p.imap||p.smtp)?'configured':'provider_not_ready'})),
    async list(address,args){return imap(address,c=>locked(c,args.folder,async()=>{
      const validity=String(c.mailbox.uidValidity),hash=digest({address,folder:args.folder,query:args.query,from:args.from,to:args.to});let before=Number(c.mailbox.uidNext)-1;
      if(args.cursor){try{const cur=JSON.parse(Buffer.from(args.cursor,'base64url').toString());if(cur.validity!==validity||cur.hash!==hash||!Number.isSafeInteger(cur.before)||cur.before<0||cur.before>before)throw new Error();before=cur.before;}catch{fail('CURSOR_STALE','邮箱列表已改变 请重新查询');}}
      if(before<=0)return {items:[],nextCursor:null};
      const low=Math.max(1,before-4999),criteria={uid:`${low}:${before}`,...args.query?{text:args.query}:{},...args.from?{since:new Date(args.from)}:{},...args.to?{before:new Date(new Date(args.to).getTime()+86400000)}:{}};
      const ids=((await c.search(criteria,{uid:true}))||[]).filter(uid=>uid>=low&&uid<=before).sort((a,b)=>b-a),chosen=ids.slice(0,args.limit),items=[];
      if(chosen.length)for await(const r of c.fetch(chosen,{envelope:true,size:true,flags:true},{uid:true})){const e=r.envelope||{};items.push({id:encode({folder:args.folder,validity,uid:r.uid}),uid:r.uid,subject:e.subject||'',from:addresses(e.from),to:addresses(e.to),date:e.date?.toISOString()||null,bytes:r.size,unread:!r.flags.has('\\Seen')});}
      const next=ids.length>chosen.length?chosen.at(-1)-1:low-1;
      return {items:items.sort((a,b)=>b.uid-a.uid),nextCursor:next>0?encode({before:next,validity,hash}):null,partial:low>1};
    }));},
    async get(address,id){const r=await read(address,id);return {...r,attachments:r.attachments.map((a,index)=>({index,filename:a.filename||'attachment',mime:a.contentType,bytes:a.size,sha256:digest(a.content.toString('base64'))}))};},
    async attachment(address,id,index){const r=await read(address,id),a=r.attachments[index];if(!a)fail('NOT_FOUND','附件不存在',404);return {filename:a.filename||'attachment',mime:a.contentType,bytes:a.size,buffer:a.content};},
    async send(address,payload,attachments,id){const p=profile(address,'smtp'),transport=makeSmtp({host:p.host,port:p.port,secure:true,auth:{user:p.user,pass:p.pass},logger:false,debug:false,connectionTimeout:15000,greetingTimeout:10000,socketTimeout:30000});
      let timer;const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{transport.close();reject(Object.assign(new Error('SMTP result unconfirmed'),{code:'DELIVERY_UNCONFIRMED'}));},sendDeadlineMs);timer.unref();});
      try{const r=await Promise.race([deadline,transport.sendMail({from:address,to:payload.to,cc:payload.cc,bcc:payload.bcc,replyTo:payload.replyTo||address,subject:payload.subject,text:payload.body,attachments:attachments.map(a=>({filename:a.filename,content:a.buffer,contentType:a.mime})),messageId:`<110lab-${id}@110-lab.cn>`,...(payload.inReplyTo?{inReplyTo:payload.inReplyTo,references:payload.references}:{}),disableFileAccess:true,disableUrlAccess:true})]);
        return {accepted:r.accepted||[],rejected:r.rejected||[],messageId:r.messageId};
      }finally{clearTimeout(timer);transport.close();}
    },
    close(){for(const c of active)c.close();active.clear();},
  };
}
