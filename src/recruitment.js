import Uppy from '@uppy/core';
import Dashboard from '@uppy/dashboard';
import XHRUpload from '@uppy/xhr-upload';
import zh_CN from '@uppy/locales/lib/zh_CN.js';

export async function initRecruitment(){
  const form=document.querySelector('#resume-form');if(!form)return;
  const fieldset=form.querySelector('fieldset'),status=form.querySelector('[data-resume-status]'),submit=form.querySelector('[type=submit]'),retry=form.querySelector('[data-resume-retry]'),reset=form.querySelector('[data-resume-reset]');
  let config,receipt,busy=false,polling=false,timer,authorization,lastUploadError;
  submit.disabled=true;
  const randomKey=()=>`Bearer ${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')}`;
  const say=text=>{status.textContent=text;};
  const save=()=>{try{sessionStorage.setItem('110lab-resume-receipt',JSON.stringify({id:receipt?.id||null,authorization}));}catch{}};
  const clearSaved=()=>{try{sessionStorage.removeItem('110lab-resume-receipt');}catch{}};
  async function request(path,body,authorized=true){
    const response=await fetch('/api/recruitment/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json',...(authorized?{Authorization:authorization}:{})}:{},body:body?JSON.stringify(body):undefined,cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(8000)});
    const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error||'投递服务暂时不可用'),{status:response.status});return data;
  }
  const texts={
    RECEIVED:'提交已接收 · 邮件正在排队 请保留回执编号',
    SENDING:'提交已接收 · 邮件正在发送',
    RETRYING:'提交已接收 · 邮件尚未发送 服务会自动重试',
    SENT:'邮件已发送 · 发信服务已确认接收 最终收件情况以邮箱为准',
    FAILED:'提交已接收 · 邮件发送失败 可使用原资料重试',
    UNKNOWN:'提交已接收 · 发信结果待核实 为避免重复邮件请勿重新投递 可通过下方邮箱联系实验室并提供回执编号',
    EXPIRED:'回执资料已清理 未能确认邮件发送结果 请通过下方邮箱联系实验室并提供回执编号',
  };
  const pending=()=>receipt&&['RECEIVED','SENDING','RETRYING'].includes(receipt.status);
  function render(){
    if(!receipt)return;
    say(!receipt.id?'正在核实上次提交是否已接收 请保留当前标签页':texts[receipt.status]||'回执状态待核实');
    form.querySelector('[data-resume-id]').textContent=receipt.id||'';
    form.querySelector('[data-resume-receipt]').hidden=!receipt.id;
    fieldset.disabled=true;submit.hidden=true;
    form.querySelector('#resume-upload').hidden=true;
    retry.hidden=receipt.status!=='FAILED'||receipt.retriesRemaining===0;
    reset.hidden=!['SENT','EXPIRED'].includes(receipt.status);
    if(receipt.status==='FAILED'&&receipt.retriesRemaining===0)say('提交已接收 · 邮件发送失败 已达到重试上限 请联系实验室并提供回执编号');
    schedule();
  }
  function schedule(){clearTimeout(timer);if(pending()&&!document.hidden)timer=setTimeout(poll,5000);}
  async function poll(){
    if(!receipt||polling||document.hidden)return;polling=true;
    try{receipt=await request('status',{id:receipt.id});save();render();}
    catch(error){if(error.status===404){clearSaved();if(!receipt.id){receipt=null;submit.hidden=false;say('未找到已接收的投递 可以重新填写资料');}else{receipt.status='EXPIRED';render();say('回执已过期或查询凭证无效 请通过邮箱联系实验室并附上回执编号');}}else{say('回执状态暂时无法刷新 请保留当前标签页 稍后会继续查询');schedule();}}
    finally{polling=false;}
  }
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(timer);else if(pending())poll();});
  try{config=await request('config',null,false);}catch{say('在线投递暂时不可用 可使用下方邮箱投递');return;}
  try{
    const saved=JSON.parse(sessionStorage.getItem('110lab-resume-receipt')||'null');
    if(saved&&(typeof saved.id==='string'||saved.id===null)&&/^Bearer [A-Za-z0-9_-]{43}$/.test(saved.authorization)){authorization=saved.authorization;receipt={id:saved.id,status:'RECEIVED'};render();await poll();}
  }catch{clearSaved();}
  if(!config.enabled){if(!receipt)say('在线投递暂未开放 可使用下方邮箱投递');return;}
  if(!receipt){form.querySelector('#resume-upload').hidden=false;if(config.available){fieldset.disabled=false;submit.disabled=false;}}
  const locale={...zh_CN,strings:{...zh_CN.strings,complete:'提交已接收',uploadComplete:'提交已接收',done:'完成上传',dropPasteFiles:'将简历拖到这里 或 %{browseFiles}',browseFiles:'选择文件'}};
  const uppy=new Uppy({id:'110lab-resume',autoProceed:false,allowMultipleUploadBatches:false,restrictions:{maxNumberOfFiles:1,minNumberOfFiles:1,maxFileSize:config.maxFileBytes,allowedFileTypes:['.pdf','.docx']},locale});
  uppy.use(Dashboard,{target:'#resume-upload',inline:true,width:'100%',height:220,hideUploadButton:true,hideRetryButton:true,hideCancelButton:true,showProgressDetails:true,disableThumbnailGenerator:true,note:'一份 PDF 或 DOCX 简历 · 最大 10MB',proudlyDisplayPoweredByUppy:false});
  uppy.use(XHRUpload,{endpoint:'/api/recruitment/submissions',fieldName:'resume',formData:true,allowedMetaFields:['applicantName','group','email','consent','website'],limit:1,timeout:90000,headers:()=>({Authorization:authorization}),shouldRetry:xhr=>xhr.status===0||[408,502,503,504].includes(xhr.status),getResponseData:xhr=>xhr.responseType==='json'?xhr.response:JSON.parse(xhr.responseText)});
  if(!receipt)say(config.available?'填写资料并上传简历 提交后可查看邮件发送状态':'发信服务暂时不可用 可稍后刷新页面或使用下方邮箱投递');
  form.addEventListener('input',()=>{if(!busy&&!receipt)authorization=null;});
  uppy.on('file-added',()=>{if(!busy&&!receipt)authorization=null;});
  uppy.on('file-removed',()=>{if(!busy&&!receipt)authorization=null;});
  uppy.on('upload-success',(_file,response)=>{
    receipt=response.body;save();render();
  });
  uppy.on('upload-error',(_file,_error,response)=>{
    let body;try{body=response?.responseType==='json'?response.response:JSON.parse(response?.responseText||'null');}catch{}
    lastUploadError=body?.error||'未确认提交结果 请保持原资料并重试 同一份提交不会重复发信';say(lastUploadError);
    if(_file&&uppy.getFile(_file.id))uppy.setFileState(_file.id,{error:lastUploadError});
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||receipt||!form.reportValidity())return;
    if(!uppy.getFiles().length){say('请先选择一份 PDF 或 DOCX 简历');return;}
    authorization||=randomKey();
    save();
    const fields=new FormData(form);
    uppy.setMeta({applicantName:String(fields.get('name')).trim(),group:fields.get('group'),email:String(fields.get('email')).trim(),consent:fields.get('consent')==='on'?'true':'false',website:fields.get('website')||''});
    busy=true;lastUploadError=null;fieldset.disabled=true;submit.disabled=true;uppy.getPlugin('Dashboard').setOptions({disabled:true});say('正在上传简历 上传完成后会生成回执');
    try{const result=await uppy.upload();if(result.failed?.length&&!receipt)say(lastUploadError||'未确认提交结果 请保持原资料并重试');}
    catch(error){say(error.message||'上传失败 请重试');}
    finally{busy=false;submit.disabled=false;if(receipt)uppy.clear();else{fieldset.disabled=false;uppy.getPlugin('Dashboard').setOptions({disabled:false});}}
  });
  retry.addEventListener('click',async()=>{
    if(busy||!receipt)return;busy=true;retry.disabled=true;
    try{receipt=await request('retry',{id:receipt.id});save();render();}
    catch(error){say(error.message);}finally{busy=false;retry.disabled=false;}
  });
  reset.addEventListener('click',()=>{
    if(!receipt||!['SENT','EXPIRED'].includes(receipt.status))return;
    clearSaved();clearTimeout(timer);receipt=null;authorization=null;uppy.clear();form.reset();fieldset.disabled=!config.available;submit.disabled=!config.available;submit.hidden=false;retry.hidden=true;reset.hidden=true;form.querySelector('[data-resume-receipt]').hidden=true;form.querySelector('#resume-upload').hidden=false;uppy.getPlugin('Dashboard').setOptions({disabled:false});say(config.available?'可以提交新的资料 请勿重复投递相同简历':'发信服务暂时不可用 请稍后刷新页面');
  });
}
