import {z} from 'zod';
import {openRecruitmentTestStore,RecruitmentTestError,requireRecruitmentAdmin} from './recruitment-test-store.mjs';
import {MailAuthError} from './mail-auth.mjs';
import {MailAccessError} from './mail-access-store.mjs';
import {readTestResume} from './recruitment-test-upload.mjs';
import {resumeTypes} from './recruitment-files.mjs';
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Robots-Tag':'noindex'});res.end(JSON.stringify(value));};
async function body(req){
  if(String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json')throw new RecruitmentTestError(415,'请求格式无效');
  if(Number(req.headers['content-length']||0)>16384)throw new RecruitmentTestError(413,'内容过长');
  const chunks=[];let size=0;
  await new Promise((resolve,reject)=>{
    let done=false;
    const finish=error=>{if(done)return;done=true;clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',abort);req.off('aborted',abort);if(error){req.resume();reject(error);}else resolve();};
    const data=c=>{size+=c.length;if(size>16384)finish(new RecruitmentTestError(413,'内容过长'));else chunks.push(c);};
    const end=()=>finish(),abort=()=>finish(new RecruitmentTestError(400,'请求中断'));
    const timer=setTimeout(()=>finish(new RecruitmentTestError(408,'请求超时')),8000);timer.unref();
    req.on('data',data);req.once('end',end);req.once('error',abort);req.once('aborted',abort);
  });
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new RecruitmentTestError(400,'请求格式无效');}
}
export function createRecruitmentTestHttp({mail,localTest=false,now=Date.now,directory=mail?.workspaceDirectory}={}){
  const enabled=!!mail?.enabled&&!!directory,store=enabled?openRecruitmentTestStore({directory,now}):null,writes=new Map(),uploads=new Set();
  const cleanup=store?setInterval(()=>{try{store.cleanup();}catch(e){console.error('Recruitment test cleanup failed',e.code||e.name);}},300000):null;
  cleanup?.unref();
  return {enabled,close(){clearInterval(cleanup);store?.close();},async handle(req,res,path,host){
    if(!path.startsWith('/api/recruitment-test/'))return false;
    try{
      if(host!=='internal.110-lab.cn'&&!(localTest&&['localhost','127.0.0.1'].includes(host)))throw new RecruitmentTestError(404,'Not found');
      if(!enabled)throw new RecruitmentTestError(503,'实验室登录尚未配置');
      if(!['GET','POST'].includes(req.method))throw new RecruitmentTestError(405,'请求方式无效');
      const embedded=path.startsWith('/api/recruitment-test/embedded/'),prefix='/api/recruitment-test/'+(embedded?'embedded/':''),route=path.slice(prefix.length),write=req.method==='POST';
      if(write&&(req.headers.origin!==(localTest?'http://'+req.headers.host:'https://internal.110-lab.cn')||req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin'))throw new RecruitmentTestError(403,'请通过招新测试页面操作');
      let actor=mail.identity(req,{embedded,write});
      // Show an authenticated member's own role without exposing applicant data.
      if(!write&&route==='session'){json(res,200,actor);return true;}
      requireRecruitmentAdmin(actor);
      if(!write){
        if(route==='candidates')json(res,200,store.list(actor));
        else if(/^candidates\/[a-f0-9-]{36}\/resume$/.test(route)){
          const file=store.readResume(actor,route.split('/')[1]);
          res.writeHead(200,{'Content-Type':resumeTypes[file.extension],'Content-Length':file.bytes,'Content-Disposition':"attachment; filename=resume."+file.extension+"; filename*=UTF-8''"+encodeURIComponent(file.filename),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'X-Robots-Tag':'noindex'});res.end(file.buffer);
        }
        else{const m=/^candidates\/([a-f0-9-]{36})$/.exec(route);if(!m)throw new RecruitmentTestError(404,'Not found');json(res,200,store.get(actor,m[1]));}
      }else{
        const time=now();for(const [key,v] of writes)if(time-v.at>=60000)writes.delete(key);
        const count=writes.get(actor.subject)||{at:time,count:0};if(++count.count>60)throw new RecruitmentTestError(429,'操作频繁 请稍后再试');writes.set(actor.subject,count);
        const attachment=/^candidates\/([a-f0-9-]{36})\/resume$/.exec(route);
        if(attachment){
          if(uploads.size>=2||uploads.has(actor.subject))throw new RecruitmentTestError(429,'已有简历正在上传 请稍后重试');
          // Authorize the target before accepting a potentially large body.
          const candidate=store.get(actor,attachment[1]);if(candidate.archived)throw new RecruitmentTestError(409,'候选人已归档');
          const subject=actor.subject;uploads.add(subject);
          try{
            const file=await readTestResume(req);
            actor=requireRecruitmentAdmin(mail.identity(req,{embedded,write:true}));
            if(actor.subject!==subject)throw new RecruitmentTestError(403,'登录身份已改变 请重新上传');
            json(res,200,store.attachResume(actor,attachment[1],file));
          }finally{uploads.delete(subject);}
          return true;
        }
        const input=await body(req);
        // Re-evaluate live administrator rights after the asynchronous body read.
        actor=requireRecruitmentAdmin(mail.identity(req,{embedded,write:true}));
        if(route==='candidates')json(res,201,store.create(actor,input));
        else{const m=/^candidates\/([a-f0-9-]{36})\/actions$/.exec(route);if(!m)throw new RecruitmentTestError(404,'Not found');json(res,200,store.act(actor,m[1],input));}
      }
    }catch(e){
      req.resume();if(res.headersSent||res.destroyed)return true;
      if(e instanceof RecruitmentTestError)json(res,e.status,{error:e.message});
      else if(e instanceof MailAuthError||e instanceof MailAccessError)json(res,e.status,{error:e.status===401?'请先通过飞书登录':'实验室身份或权限已变更 请重新登录'});
      else if(e instanceof z.ZodError)json(res,400,{error:e.issues.some(issue=>issue.path.includes('email'))?'测试邮箱请使用 example.com 或 .test 等虚构地址':'填写内容无效 请检查必填项、字数和分数范围'});
      else{console.error('Recruitment test failed',e.code||e.name);json(res,503,{error:'测试空间暂不可用 请稍后重试'});}
    }
    return true;
  }};
}
