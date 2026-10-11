import {getDocument,GlobalWorkerOptions} from 'pdfjs-dist/build/pdf.mjs';
GlobalWorkerOptions.workerSrc='/assets/recruitment-pdf-worker-6.4.299.mjs';
const button=text=>{const b=document.createElement('button');b.type='button';b.className='rt-button';b.textContent=text;return b;};

// Canvas rendering does not execute PDF actions or publish private document URLs.
export async function previewPdf(blob,target,isCurrent){
  let active=true,renderTask=null;const valid=()=>active&&isCurrent();
  const task=getDocument({data:new Uint8Array(await blob.arrayBuffer()),isEvalSupported:false,useSystemFonts:true,enableXfa:false,useWorkerFetch:false,useWasm:false});
  const destroy=()=>{if(!active)return;active=false;renderTask?.cancel();void task.destroy();};
  try{
    const pdf=await task.promise;if(!valid()){destroy();return destroy;}
    const toolbar=document.createElement('div'),pages=document.createElement('div');pages.className='rw-pdf-pages';
    const previous=button('上一页'),next=button('下一页'),out=button('缩小'),fit=button('适合宽度'),into=button('放大'),label=document.createElement('span');
    toolbar.className='rw-preview-toolbar';toolbar.append(previous,label,next,out,fit,into);target.replaceChildren(toolbar,pages);
    let pageNumber=1,rendering=false,zoom=null,lastScale=1;
    async function show(n){
      if(rendering||!valid())return;rendering=true;pageNumber=n;for(const b of [previous,next,out,fit,into])b.disabled=true;
      try{
        const page=await pdf.getPage(n);if(!valid())return;
        const canvas=document.createElement('canvas'),base=page.getViewport({scale:1}),width=Math.max(240,pages.clientWidth-40);
        const scale=zoom??Math.min(1.5,width/base.width),pixels=Math.min(3,scale*(devicePixelRatio||1),Math.sqrt(12000000/(base.width*base.height)));
        const viewport=page.getViewport({scale:pixels});canvas.width=viewport.width;canvas.height=viewport.height;canvas.style.width=base.width*scale+'px';canvas.style.height=base.height*scale+'px';
        canvas.setAttribute('role','img');canvas.setAttribute('aria-label','简历第 '+n+' 页');
        renderTask=page.render({canvasContext:canvas.getContext('2d'),viewport});await renderTask.promise;if(!valid())return;
        pages.replaceChildren(canvas);pages.scrollTop=0;label.textContent=n+' / '+pdf.numPages+' · '+Math.round(scale*100)+'%';pageNumber=n;lastScale=scale;page.cleanup();
      }catch(e){if(valid())pages.textContent='此页无法预览，请尝试其他页，或独立打开网页版查看原文件。';}
      finally{rendering=false;renderTask=null;if(valid()){previous.disabled=pageNumber<=1;next.disabled=pageNumber>=pdf.numPages;out.disabled=lastScale<=.5;into.disabled=lastScale>=2;fit.disabled=false;}}
    }
    previous.onclick=()=>void show(pageNumber-1);next.onclick=()=>void show(pageNumber+1);
    out.onclick=()=>{zoom=Math.max(.5,lastScale-.25);void show(pageNumber);};into.onclick=()=>{zoom=Math.min(2,lastScale+.25);void show(pageNumber);};fit.onclick=()=>{zoom=null;void show(pageNumber);};
    await show(1);return destroy;
  }catch(e){destroy();throw e;}finally{if(!valid())destroy();}
}

export async function previewDocx(blob,target,isCurrent){
  const frame=document.createElement('iframe');frame.title='DOCX 简历预览';frame.className='rw-docx-frame';
  // Only this bundled renderer may execute. Resume markup has an opaque origin,
  // no external network, no workbench DOM/cookies and no inline event handlers.
  frame.setAttribute('sandbox','allow-scripts');frame.referrerPolicy='no-referrer';
  const loaded=new Promise((resolve,reject)=>{frame.onload=resolve;frame.onerror=reject;});
  frame.srcdoc='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'+__DOCX_PREVIEW_CSP__+'"><style>body{margin:0;background:#edf0f5;font-family:system-ui,sans-serif}.docx-wrapper{padding:20px!important}.docx-wrapper>section.docx{max-width:100%;box-sizing:border-box;overflow-wrap:anywhere}img{max-width:100%}a{pointer-events:none;color:inherit}</style></head><body><main></main><script>'+__DOCX_PREVIEW_SCRIPT__+'</script></body></html>';
  target.replaceChildren(frame);await loaded;
  const channel=new MessageChannel(),destroy=()=>{channel.port1.close();channel.port2.close();frame.remove();};
  if(!isCurrent()){destroy();return destroy;}
  try{
    const bytes=await blob.arrayBuffer();if(!isCurrent()){destroy();return destroy;}
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('DOCX preview timeout')),20000);
      channel.port1.onmessage=e=>{clearTimeout(timer);e.data?.status==='complete'?resolve():reject(new Error('DOCX preview failed'));};
      frame.contentWindow.postMessage({type:'110lab-render-resume',bytes},'*',[bytes,channel.port2]);
    });
    if(!isCurrent())destroy();return destroy;
  }catch(e){destroy();throw e;}
}
