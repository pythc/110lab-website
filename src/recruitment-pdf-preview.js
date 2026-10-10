import {getDocument,GlobalWorkerOptions} from 'pdfjs-dist/build/pdf.mjs';
GlobalWorkerOptions.workerSrc='/assets/recruitment-pdf-worker-6.4.299.mjs';
// Render private bytes to canvas, with no public URL and no active PDF content.
export async function previewPdf(blob,target,isCurrent){
  const task=getDocument({data:new Uint8Array(await blob.arrayBuffer()),isEvalSupported:false,useSystemFonts:true});
  try{
    const pdf=await task.promise;if(!isCurrent())return;
    const toolbar=document.createElement('div'),pages=document.createElement('div');pages.className='rw-pdf-pages';
    const previous=document.createElement('button'),next=document.createElement('button'),label=document.createElement('span');for(const b of [previous,next]){b.type='button';b.className='rt-button';}
    previous.textContent='上一页';next.textContent='下一页';toolbar.className='rt-inline-actions';toolbar.append(previous,label,next);target.replaceChildren(toolbar,pages);
    let pageNumber=1,rendering=false;
    async function show(n){if(rendering||!isCurrent())return;rendering=true;previous.disabled=next.disabled=true;
      try{const page=await pdf.getPage(n);if(!isCurrent())return;const canvas=document.createElement('canvas'),base=page.getViewport({scale:1}),scale=Math.min(2,1200/base.width,1800/base.height),viewport=page.getViewport({scale});canvas.width=viewport.width;canvas.height=viewport.height;canvas.setAttribute('role','img');canvas.setAttribute('aria-label','简历第 '+n+' 页');await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;if(!isCurrent())return;pages.replaceChildren(canvas);label.textContent=n+' / '+pdf.numPages;pageNumber=n;}
      catch{if(isCurrent())pages.textContent='此 PDF 无法预览，请下载查看。';}
      finally{rendering=false;previous.disabled=pageNumber<=1;next.disabled=pageNumber>=pdf.numPages;}
    }
    previous.onclick=()=>void show(pageNumber-1);next.onclick=()=>void show(pageNumber+1);await show(1);
    return ()=>{void task.destroy();};
  }catch(e){void task.destroy();throw e;}
  finally{if(!isCurrent())void task.destroy();}
}
