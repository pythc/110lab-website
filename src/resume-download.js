export const MAX_RESUME_DOWNLOAD_BYTES=10*1024*1024;
const types={pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
const requestType='110lab-resume-download',resultType=requestType+'-result';
const validId=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
function fileInfo(filename,mimeType,size){
  const extension=String(filename).split('.').at(-1).toLowerCase();
  if(!Object.hasOwn(types,extension)||types[extension]!==mimeType||!Number.isInteger(size)||size<1||size>MAX_RESUME_DOWNLOAD_BYTES)throw new Error('简历文件类型或大小无效');
  const name=String(filename).normalize('NFC').replace(/[\\/<>:"|?*\u0000-\u001f\u007f]/g,'_').replace(/^[. ]+|[. ]+$/g,'').slice(0,170).replace(/\.(pdf|docx)$/i,'');
  return {filename:(name||'简历')+'.'+extension,mimeType};
}
const fallback='当前客户端不支持文件下载，请点击顶部「独立打开」后下载';

// Bytes are fetched by the authenticated application first. No public URL,
// bearer token, cookie or candidate metadata is sent to the host.
export async function saveResumeFile(blob,filename,{embedded=false,current=()=>true,onStatus=()=>{}}={},env=globalThis){
  const info=fileInfo(filename,blob.type,blob.size);
  const active=()=>{if(!current())throw new Error('页面或登录状态已改变，请重新下载');};active();
  if(!embedded||env.window.parent===env.window){
    const url=env.URL.createObjectURL(blob),link=env.document.createElement('a');
    try{link.href=url;link.download=info.filename;env.document.body.append(link);link.click();}
    finally{link.remove();env.setTimeout(()=>env.URL.revokeObjectURL(url),10000);}
    return;
  }
  const bytes=await blob.arrayBuffer();active();
  const requestId=env.crypto.randomUUID(),parent=env.window.parent;
  await new Promise((resolve,reject)=>{
    let timer;
    const done=error=>{env.clearTimeout(timer);env.window.removeEventListener('message',receive);error?reject(error):resolve();};
    const receive=event=>{
      const m=event.data;if(event.source!==parent||m?.type!==resultType||m.requestId!==requestId)return;
      try{active();}catch(e){done(e);return;}
      if(m.status==='started'){env.clearTimeout(timer);timer=env.setTimeout(()=>done(new Error('客户端未返回下载结果，请检查保存窗口或下载列表')),150000);onStatus('正在交由客户端保存简历');return;}
      if(m.status==='complete')done();
      else done(new Error(({unsupported:fallback,cancelled:'下载已取消或被客户端拒绝',busy:'已有简历正在下载，请稍后再试'})[m.status]||'下载未完成，请重试或独立打开后下载'));
    };
    env.window.addEventListener('message',receive);
    timer=env.setTimeout(()=>done(new Error('插件页面尚未支持下载，请关闭后重新打开 110lab，或独立打开后下载')),5000);
    try{parent.postMessage({type:requestType,requestId,...info,bytes},'*',[bytes]);}catch{done(new Error('无法连接客户端下载，请独立打开后下载'));}
  });
}

export async function handleResumeDownloadRequest(event,{frame,downloadFile}){
  if(event.origin!=='https://internal.110-lab.cn'||event.source!==frame?.contentWindow)return false;
  const m=event.data;if(m?.type!==requestType||!validId(m.requestId))return false;
  const reply=status=>event.source.postMessage({type:resultType,requestId:m.requestId,status},event.origin);
  try{
    if(!(m.bytes instanceof ArrayBuffer))throw new Error('Invalid bytes');
    const info=fileInfo(m.filename,m.mimeType,m.bytes.byteLength);
    if(typeof downloadFile!=='function'){reply('unsupported');return true;}
    const bytes=new Uint8Array(m.bytes);let binary='';
    for(let n=0;n<bytes.length;n+=32768)binary+=String.fromCharCode(...bytes.subarray(n,n+32768));
    reply('started');
    const result=await downloadFile({contents:[{type:'resource',resource:{uri:'file:///'+encodeURIComponent(info.filename),mimeType:info.mimeType,blob:btoa(binary)}}]});
    reply(!result||typeof result!=='object'?'failed':result.isError?'cancelled':'complete');
  }catch{reply('failed');}
  return true;
}
