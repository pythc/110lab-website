import {renderAsync} from 'docx-preview';
let accepted=false;
window.addEventListener('message',async event=>{
  if(accepted||event.source!==parent||event.data?.type!=='110lab-render-resume'||!event.ports[0])return;
  accepted=true;const port=event.ports[0];
  try{
    const bytes=event.data.bytes;if(!(bytes instanceof ArrayBuffer)||!bytes.byteLength||bytes.byteLength>10*1024*1024)throw new Error('Invalid file');
    await renderAsync(bytes,document.querySelector('main'),document.head,{inWrapper:true,ignoreHeight:true,ignoreFonts:true,useBase64URL:true,renderAltChunks:false,renderComments:false,renderChanges:false,experimental:false});
    for(const node of document.querySelectorAll('a')){node.removeAttribute('href');node.removeAttribute('target');}
    for(const node of document.querySelectorAll('iframe,object,embed,form'))node.remove();
    port.postMessage({status:'complete'});
  }catch{port.postMessage({status:'failed'});}finally{port.close();}
});
document.addEventListener('click',e=>e.preventDefault(),true);
