import {readFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {isIP} from 'node:net';
import {z} from 'zod';
import {openRecruitmentWorkflowStore} from './recruitment-workflow-store.mjs';
import {RecruitmentTestError,requireRecruitmentAdmin} from './recruitment-test-store.mjs';
import {RecruitmentError,GROUPS,keyHash} from './recruitment-store.mjs';
import {MailAuthError} from './mail-auth.mjs';
import {MailAccessError} from './mail-access-store.mjs';
import {readApplication,resumeTypes} from './recruitment-files.mjs';
import {readTestResume} from './recruitment-test-upload.mjs';
import {runWorkflowDeliveryOnce} from './recruitment-workflow-worker.mjs';
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','X-Robots-Tag':'noindex'});res.end(JSON.stringify(value));};
async function body(req){
  if(String(req.headers['content-type']||'').split(';')[0]!=='application/json')throw new RecruitmentTestError(415,'请求格式无效');
  if(Number(req.headers['content-length']||0)>131072)throw new RecruitmentTestError(413,'内容过长');
  const chunks=[];let size=0;
  await new Promise((resolve,reject)=>{
    let done=false;
    const finish=e=>{if(done)return;done=true;clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',abort);req.off('aborted',abort);if(e){req.resume();reject(e);}else resolve();};
    const data=c=>{if((size+=c.length)>131072)finish(new RecruitmentTestError(413,'内容过长'));else chunks.push(c);};
    const end=()=>finish(),abort=()=>finish(new RecruitmentTestError(400,'请求中断'));
    const timer=setTimeout(()=>finish(new RecruitmentTestError(408,'请求超时')),8000);timer.unref();
    req.on('data',data);req.once('end',end);req.once('error',abort);req.once('aborted',abort);
  });
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new RecruitmentTestError(400,'请求格式无效');}
}
export function createRecruitmentWorkflowHttp({mail,enabled=process.env.PORTAL_RECRUITMENT_WORKFLOW_ENABLED==='true',directory=process.env.PORTAL_RECRUITMENT_WORKFLOW_DATA||(mail?.workspaceDirectory&&join(mail.workspaceDirectory,'recruitment')),deliveryMode=process.env.PORTAL_RECRUITMENT_WORKFLOW_MODE||'dry-run',store:provided,mailProfiles=(process.env.PORTAL_RECRUITMENT_WORKFLOW_SENDERS||'').split(',').filter(Boolean).map(address=>({address,configured:true})),legacyReceipt,localTest=false,origins=['https://110-lab.cn'],trustedProxies=(process.env.PORTAL_RECRUITMENT_TRUSTED_PROXY_IPS||'').split(',').filter(Boolean),now=Date.now}={}){
  if(enabled&&(!mail?.enabled||!directory))throw new Error('Recruitment workflow requires laboratory identity and private storage');
  const store=enabled?(provided||openRecruitmentWorkflowStore({directory,deliveryMode,mailProfiles,now})):null;
  const proxies=new Set(trustedProxies);if([...proxies].some(ip=>!isIP(ip)))throw new Error('Invalid recruitment trusted proxy');
  const writes=new Map(),uploads=new Set();let active=0,busy=false,stopped=false,activeJob;
  const tick=async()=>{if(!store||busy||stopped||deliveryMode!=='dry-run')return;busy=true;try{activeJob=runWorkflowDeliveryOnce(store,{mode:'dry-run',roleForSubject:s=>mail.roleForSubject(s),intervalMs:0});await activeJob;}catch(e){console.error('Recruitment simulation failed',e.code||e.name);}finally{busy=false;}};
  const timer=store&&deliveryMode==='dry-run'?setInterval(tick,1000):null;timer?.unref();
  const cleanup=store?setInterval(()=>{try{store.cleanup();}catch(e){console.error('Recruitment workflow cleanup failed',e.code||e.name);}},300000):null;cleanup?.unref();
  return {enabled:!!store,store,labInbox:()=>store?.labInbox()||{state:'disabled',items:[]},async close(){stopped=true;clearInterval(timer);clearInterval(cleanup);await activeJob?.catch(()=>{});if(!provided)store?.close();},async handle(req,res,path,host){
    const publicRoute=path.startsWith('/api/recruitment/'),privateRoute=path.startsWith('/api/recruitment-admin/');
    if(!privateRoute&&!(store&&publicRoute))return false;
    try{
      const local=localTest&&['localhost','127.0.0.1'].includes(host);
      if(publicRoute?host!=='110-lab.cn'&&!local:host!=='internal.110-lab.cn'&&!local)throw new RecruitmentTestError(404,'Not found');
      if(!store)throw new RecruitmentTestError(503,'招新管理尚未启用');
      if(publicRoute){
        if(req.method==='GET'&&path==='/api/recruitment/config'){json(res,200,{...store.publicConfig(),groups:GROUPS});return true;}
        if(req.method!=='POST'||!['/api/recruitment/submissions','/api/recruitment/status','/api/recruitment/retry'].includes(path))throw new RecruitmentTestError(404,'Not found');
        if(!(origins.includes(req.headers.origin)||local&&req.headers.origin==='http://'+req.headers.host)||(req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin'))throw new RecruitmentTestError(403,'请通过官网投递');
        keyHash(req.headers.authorization);
        if(path==='/api/recruitment/submissions'){
          const remote=req.socket.remoteAddress||'unknown',forwarded=String(req.headers['x-forwarded-for']||'').split(',')[0].trim(),ip=proxies.has(remote)&&isIP(forwarded)?forwarded:remote;
          store.beginUpload(ip);if(active>=2)throw new RecruitmentTestError(429,'投递繁忙 请稍后再试');
          active++;let upload;
          try{
            upload=await readApplication(req,store.root);const value=store.acceptApplication({...upload,buffer:readFileSync(upload.path),intakeRevision:Number(upload.fields.intakeRevision),authorization:req.headers.authorization,ip});
            json(res,value.reused?200:201,value);
          }finally{active--;if(upload?.path)try{unlinkSync(upload.path);}catch(e){if(e.code!=='ENOENT')throw e;}}
        }else{
          const value=z.object({id:z.uuid().nullable()}).strict().parse(await body(req));
          // Keep old receipt access delegated to the existing isolated queue.
          if(!store.hasReceipt(value.id,req.headers.authorization)&&legacyReceipt){json(res,200,legacyReceipt(value.id,req.headers.authorization,path.endsWith('/retry')));return true;}
          if(path.endsWith('/retry'))throw new RecruitmentTestError(409,'资料已保存 邮件由招新管理员处理 无需重新投递');
          json(res,200,store.receipt(value.id,req.headers.authorization));
        }
        return true;
      }
      if(!['GET','POST'].includes(req.method))throw new RecruitmentTestError(405,'请求方式无效');
      const embedded=path.startsWith('/api/recruitment-admin/embedded/'),route=path.slice(('/api/recruitment-admin/'+(embedded?'embedded/':'')).length),write=req.method==='POST';
      if(write&&(!(req.headers.origin==='https://internal.110-lab.cn'||local&&req.headers.origin==='http://'+req.headers.host)||(req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin')))throw new RecruitmentTestError(403,'请在招新管理页面操作');
      let actor=mail.identity(req,{embedded,write});
      if(!write&&route==='session'){json(res,200,actor);return true;}requireRecruitmentAdmin(actor);
      if(!write){
        if(route==='candidates')json(res,200,store.list(actor));
        else if(route==='settings')json(res,200,store.settings(actor));
        else if(route==='templates')json(res,200,store.templates(actor));
        else{
          const match=/^candidates\/([a-f0-9-]{36})(?:\/(resume|preview-application|preview-feishu|preview-interview))?$/.exec(route);
          if(!match)throw new RecruitmentTestError(404,'Not found');
          if(match[2]==='resume'){
            const f=store.readResume(actor,match[1]);res.writeHead(200,{'Content-Type':resumeTypes[f.extension],'Content-Length':f.bytes,'Content-Disposition':"attachment; filename=resume."+f.extension+"; filename*=UTF-8''"+encodeURIComponent(f.filename),'Cache-Control':'private, no-store','Content-Security-Policy':"default-src 'none'; sandbox",'X-Content-Type-Options':'nosniff'});res.end(f.buffer);
          }else json(res,200,match[2]?store.preview(actor,match[1],match[2].slice(8)):store.get(actor,match[1]));
        }
      }else{
        const time=now();for(const [key,value]of writes)if(time-value.at>=60000)writes.delete(key);
        const count=writes.get(actor.subject)||{at:time,count:0};if(++count.count>60)throw new RecruitmentTestError(429,'操作频繁 请稍后再试');writes.set(actor.subject,count);
        const attachment=/^candidates\/([a-f0-9-]{36})\/resume$/.exec(route);
        if(attachment){
          if(uploads.size>=2||uploads.has(actor.subject))throw new RecruitmentTestError(429,'已有简历正在上传');
          const candidate=store.get(actor,attachment[1]);if(candidate.archived)throw new RecruitmentTestError(409,'候选人已归档');
          const subject=actor.subject;uploads.add(subject);
          try{const upload=await readTestResume(req);actor=requireRecruitmentAdmin(mail.identity(req,{embedded,write:true}));if(actor.subject!==subject)throw new RecruitmentTestError(403,'登录身份已改变');json(res,200,store.attachResume(actor,candidate.id,upload));}finally{uploads.delete(subject);}
        }else{
          const input=await body(req);actor=requireRecruitmentAdmin(mail.identity(req,{embedded,write:true}));
          if(route==='candidates')json(res,201,store.create(actor,input));
          else if(route==='settings')json(res,200,store.saveSettings(actor,input));
          else if(route==='templates')json(res,200,store.saveTemplate(actor,input));
          else{const match=/^candidates\/([a-f0-9-]{36})\/actions$/.exec(route);if(!match)throw new RecruitmentTestError(404,'Not found');json(res,200,store.act(actor,match[1],input));}
          void tick();
        }
      }
    }catch(e){
      req.resume();if(res.headersSent||res.destroyed)return true;
      if(e instanceof z.ZodError)json(res,400,{error:e.issues.find(v=>v.code==='custom')?.message||'填写内容无效 请检查必填项与格式'});
      else if([RecruitmentTestError,RecruitmentError,MailAuthError,MailAccessError].some(cls=>e instanceof cls))json(res,e.status,{error:e.message,...(e.code?{code:e.code}:{})});
      else{console.error('Recruitment workflow request failed',e.code||e.name);json(res,503,{error:'服务暂时不可用 请稍后重试'});}
    }
    return true;
  }};
}
