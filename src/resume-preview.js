// Shared in-page viewer. Private bytes are loaded through each workspace's
// existing authenticated route, never a public or third-party document URL.
const moduleUrl='/assets/recruitment-pdf-preview-v1.mjs?v=resume-preview-3';
const renderers=()=>import(moduleUrl);

// Candidate status polling must not reset the document, page or zoom. Only a
// different candidate/assignment/attachment (or explicit teardown) invalidates it.
export function createResumePreviewController(open=openResumePreview){
  let key=null,viewer=null,generation=0;
  const identity=c=>c?.resume?JSON.stringify([c.id,c.assignment?.id,c.resume.sha256,c.resume.uploadedAt,c.resume.filename]):null;
  const destroy=()=>{generation++;viewer?.destroy();viewer=null;key=null;};
  return {
    show(candidate,{load,current=()=>true}){
      destroy();key=identity(candidate);const gen=generation;
      viewer=open({filename:candidate.resume.filename,load,current:()=>gen===generation&&current()});
    },
    sync(candidate){if(key!==identity(candidate))destroy();},
    destroy
  };
}
export function openResumePreview({filename,load,current=()=>true},env=globalThis,loadRenderers=renderers){
  const document=env.document,dialog=document.createElement('dialog');dialog.className='rw-resume-dialog';
  const header=document.createElement('header'),title=document.createElement('h2'),close=document.createElement('button'),body=document.createElement('div');
  title.textContent=filename;title.id='resume-preview-'+env.crypto.randomUUID();dialog.setAttribute('aria-labelledby',title.id);
  close.type='button';close.className='rt-button';close.textContent='关闭预览';header.append(title,close);
  body.className='rw-resume-viewer';body.setAttribute('aria-live','polite');body.textContent='正在加载简历';dialog.append(header,body);
  let active=true,cleanup;const valid=()=>active&&current();
  const destroy=()=>{if(!active)return;active=false;cleanup?.();dialog.close();dialog.remove();};
  close.onclick=destroy;dialog.addEventListener('cancel',e=>{e.preventDefault();destroy();});
  document.body.append(dialog);dialog.showModal();close.focus();
  const ready=(async()=>{
    try{
      const [blob,renderer]=await Promise.all([load(),loadRenderers()]);
      if(!valid()){destroy();return;}
      const extension=String(filename).split('.').at(-1).toLowerCase();
      if(!blob.size||blob.size>10*1024*1024)throw new Error('Invalid size');
      const render=extension==='pdf'&&blob.type==='application/pdf'?renderer.previewPdf:extension==='docx'&&blob.type==='application/vnd.openxmlformats-officedocument.wordprocessingml.document'?renderer.previewDocx:null;
      if(!render)throw new Error('Unsupported format');
      cleanup=await render(blob,body,valid);
      if(!valid()){if(active)destroy();else cleanup?.();}
    }catch{if(valid())body.textContent='简历暂时无法预览，请重试；若仍失败，可独立打开网页版下载原文件。';else destroy();}
  })();
  return {destroy,ready};
}
