import {Worker} from 'node:worker_threads';
import {existsSync} from 'node:fs';

let active=0;
export async function extractAttachmentText(buffer,mime,{timeoutMs=12000}={}){
  if(active>=2)return {status:'BUSY',reason:'附件解析繁忙 请稍后重试'};
  if(buffer.length>10*1024*1024)return {status:'TOO_LARGE',reason:'附件超过解析大小限制'};
  if(!['application/pdf','text/plain','application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(mime))return {status:'UNSUPPORTED',reason:'请查看附带的原始文件 图片不自动 OCR'};
  active++;
  try{return await new Promise(resolve=>{
    const source=new URL('./attachment-text-worker.mjs',import.meta.url);
    const worker=new Worker(existsSync(source)?source:new URL('./attachment-text-worker-runtime.mjs',import.meta.url),{execArgv:[],workerData:{buffer,mime},resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16,stackSizeMb:4},stdout:true,stderr:true});
    // Do not leak parser internals or document bytes into common server logs.
    worker.stdout.resume();worker.stderr.resume();let done=false;
    const finish=result=>{if(done)return;done=true;clearTimeout(timer);void worker.terminate().finally(()=>resolve(result));};
    const timer=setTimeout(()=>finish({status:'RESOURCE_LIMIT',reason:'附件解析超时 请查看原始附件'}),timeoutMs);timer.unref();
    worker.once('message',finish);worker.once('error',()=>finish({status:'RESOURCE_LIMIT',reason:'附件解析失败或超过资源限制'}));worker.once('exit',()=>finish({status:'UNREADABLE',reason:'无法解析此附件'}));
  });}finally{active--;}
}
