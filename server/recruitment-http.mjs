import {renameSync,unlinkSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {join} from 'node:path';
import {isIP} from 'node:net';
import {openRecruitmentStore,RecruitmentError,MAX_FILE_BYTES,GROUPS,keyHash} from './recruitment-store.mjs';
import {readApplication} from './recruitment-files.mjs';

const json=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
const safeRemove=path=>{if(!path)return;try{unlinkSync(path);}catch(error){if(error.code!=='ENOENT')throw error;}};
async function readReceiptBody(req){
  if(req.headers['content-type']!=='application/json')throw new RecruitmentError(415,'INVALID_BODY','请求格式无效');
  const chunks=[];let size=0;
  await new Promise((resolve,reject)=>{
    let done=false;
    const finish=error=>{if(done)return;done=true;clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',abort);req.off('aborted',abort);if(error){req.resume();reject(error);}else resolve();};
    const data=chunk=>{size+=chunk.length;if(size>1024)finish(new RecruitmentError(413,'INVALID_BODY','请求过大'));else chunks.push(chunk);};
    const end=()=>finish(),abort=()=>finish(new RecruitmentError(400,'INVALID_BODY','请求中断'));
    const timer=setTimeout(()=>finish(new RecruitmentError(408,'INVALID_BODY','请求超时')),8000);timer.unref();
    req.on('data',data);req.once('end',end);req.once('error',abort);req.once('aborted',abort);
  });
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{throw new RecruitmentError(400,'INVALID_BODY','请求格式无效');}
  if(!body||Object.keys(body).length!==1||!(typeof body.id==='string'||body.id===null))throw new RecruitmentError(400,'INVALID_BODY','回执格式无效');return body;
}

export function createRecruitmentHttp({store,directory=process.env.PORTAL_RECRUITMENT_DATA,enabled=process.env.PORTAL_RECRUITMENT_ENABLED==='true',origins=['https://110-lab.cn'],trustedProxies=(process.env.PORTAL_RECRUITMENT_TRUSTED_PROXY_IPS||'').split(',').filter(Boolean),uploadTimeoutMs=180000}={}){
  if(enabled&&!store&&!directory)throw new Error('Enabled recruitment requires a private data directory');
  const ownStore=enabled&&!store,queue=enabled?(store||openRecruitmentStore(directory)):null;
  const allowedOrigins=new Set(origins),proxies=new Set(trustedProxies);
  if([...proxies].some(ip=>!isIP(ip)))throw new Error('Trust only exact proxy IP addresses');
  let active=0;
  const cleanup=queue?setInterval(()=>{try{queue.recoverInterrupted();queue.cleanup();}catch{console.error('Recruitment cleanup failed');}},15*60000):null;
  cleanup?.unref();
  return {
    get enabled(){return !!queue;},
    labInbox(){return queue?{state:'ready',items:queue.listForLab()}:{state:'disabled',items:[]};},
    close(){clearInterval(cleanup);if(ownStore)queue.close();},
    async handle(req,res,path,host){
      if(!path.startsWith('/api/recruitment/'))return false;
      try{
        const localHost=['localhost','127.0.0.1','[::1]'].includes(host)&&[...allowedOrigins].some(value=>{const origin=new URL(value);return origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname);});
        if(host!=='110-lab.cn'&&!localHost)throw new RecruitmentError(404,'NOT_FOUND','Not found');
        if(path==='/api/recruitment/config'&&req.method==='GET'){
          json(res,200,{enabled:!!queue,available:!!queue&&queue.workerReady(),maxFileBytes:MAX_FILE_BYTES,groups:GROUPS});return true;
        }
        if(!queue)throw new RecruitmentError(503,'RECRUITMENT_DISABLED','在线投递暂未开放 请使用下方邮箱投递');
        if(req.method!=='POST'||!['/api/recruitment/submissions','/api/recruitment/status','/api/recruitment/retry'].includes(path))throw new RecruitmentError(404,'NOT_FOUND','Not found');
        if(!allowedOrigins.has(req.headers.origin)||(req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin'))throw new RecruitmentError(403,'ORIGIN_REJECTED','请通过官网表单投递');
        keyHash(req.headers.authorization);
        if(path==='/api/recruitment/submissions'){
          if(!queue.workerReady())throw new RecruitmentError(503,'DELIVERY_UNAVAILABLE','发信服务暂不可用 请稍后重试或使用邮箱投递');
          const remote=req.socket.remoteAddress||'unknown';
          let ip=remote;
          if(proxies.has(remote)){
            const forwarded=String(req.headers['x-forwarded-for']||'').split(',')[0].trim();
            if(isIP(forwarded))ip=forwarded;
          }
          queue.beginUpload(ip);
          if(active>=2)throw new RecruitmentError(503,'UPLOAD_BUSY','投递繁忙 请稍后再试');
          let upload,moved;
          active++;
          try{
            upload=await readApplication(req,queue.root,{timeoutMs:uploadTimeoutMs});
            const receipt=queue.accept({...upload,ip,authorization:req.headers.authorization,moveFile:blob=>{
              const source=openSync(upload.path,'r');try{fsyncSync(source);}finally{closeSync(source);}
              moved=join(queue.root,'files',blob);renameSync(upload.path,moved);
              const directory=openSync(join(queue.root,'files'),'r');try{fsyncSync(directory);}finally{closeSync(directory);}
            }});
            moved=null;json(res,receipt.reused?200:201,receipt);
          }finally{active--;safeRemove(upload?.path);safeRemove(moved);}
        }else{
          const body=await readReceiptBody(req);
          json(res,200,path.endsWith('/retry')?queue.retry(body.id,req.headers.authorization):queue.receipt(body.id,req.headers.authorization));
        }
      }catch(error){
        req.resume();if(res.headersSent||res.destroyed)return true;
        const known=error instanceof RecruitmentError;
        if(!known)console.error('Recruitment request failed',error.code||error.name);
        json(res,known?error.status:503,{code:known?error.code:'SERVICE_UNAVAILABLE',error:known?error.message:'投递服务暂时不可用 请稍后再试'});
      }
      return true;
    },
  };
}
