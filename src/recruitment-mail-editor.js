const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function mailPreview(session,payload,container){
  const frame=node('iframe');frame.className='rt-mail-preview';frame.title='完整邮件预览';frame.setAttribute('sandbox','');container.append(frame);
  const doc=new DOMParser().parseFromString(payload.html||'<p>'+escape(payload.body).replace(/\n/g,'<br>')+'</p>','text/html');
  for(const img of doc.querySelectorAll('img')){const id=/^cid:lab-([a-f0-9]{64})$/.exec(img.getAttribute('src')||'')?.[1];if(!id){img.remove();continue;}try{const blob=await session.download('images/'+id);img.src=await dataUrl(blob);}catch{img.replaceWith(document.createTextNode('[图片暂时无法加载]'));}}
  frame.srcdoc='<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'"><style>body{font:15px/1.75 system-ui;padding:20px;color:#243047}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{padding:8px}a{color:#5145ba}</style>'+doc.body.innerHTML;
}
const dataUrl=blob=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(blob);});
export function mailEditor(session,template,container,onError){
  const events=new AbortController();let savedRange=null,pickerRange=null,uploading=false,disabled=false,disposed=false;
  const toolbar=node('div');toolbar.className='rt-editor-toolbar';toolbar.setAttribute('role','toolbar');toolbar.setAttribute('aria-label','邮件正文排版');
  const editor=node('div');editor.className='rt-rich-editor';editor.contentEditable='true';editor.setAttribute('role','textbox');editor.setAttribute('aria-label','邮件富文本正文');editor.setAttribute('aria-multiline','true');
  // Saved HTML has already been sanitized by the server. Never paste arbitrary HTML.
  editor.innerHTML=template.html||'<p>'+escape(template.body).replace(/\n/g,'<br>')+'</p>';
  const contains=range=>range&&editor.contains(range.startContainer)&&editor.contains(range.endContainer);
  const remember=()=>{const selection=getSelection();if(selection.rangeCount&&contains(selection.getRangeAt(0)))savedRange=selection.getRangeAt(0).cloneRange();};
  const restore=(range=savedRange)=>{
    editor.focus({preventScroll:true});
    if(!contains(range)){range=document.createRange();range.selectNodeContents(editor);range.collapse(false);}
    const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return range;
  };
  const buttons=[];
  const add=(group,label,fn)=>{const b=node('button',label);b.type='button';b.className='rt-button';b.addEventListener('mousedown',e=>e.preventDefault());b.addEventListener('click',()=>{if(!disabled)fn();});group.append(b);buttons.push(b);return b;};
  const group=label=>{const g=node('div');g.className='rt-editor-group';g.setAttribute('role','group');g.setAttribute('aria-label',label);toolbar.append(g);return g;};
  const styles=group('文字样式'),alignment=group('段落与图片对齐'),insert=group('插入内容');
  const toggles=[];
  const command=(name,value)=>{restore();document.execCommand(name,false,value);remember();update();};
  for(const [label,name]of [['加粗','bold'],['斜体','italic'],['下划线','underline'],['列表','insertUnorderedList']]){
    const b=add(styles,label,()=>command(name));toggles.push([b,name]);
  }
  for(const [label,name]of [['左对齐','justifyLeft'],['居中','justifyCenter'],['右对齐','justifyRight']]){
    const b=add(alignment,label,()=>{restore();const previous=document.queryCommandState('styleWithCSS');document.execCommand('styleWithCSS',false,true);try{command(name);}finally{document.execCommand('styleWithCSS',false,previous);}});toggles.push([b,name]);
  }
  function update(){
    if(disposed)return;
    const selection=getSelection(),range=selection.rangeCount?selection.getRangeAt(0):null;
    for(const [b,name]of toggles)b.setAttribute('aria-pressed',String(!!contains(range)&&document.queryCommandState(name)));
    for(const img of editor.querySelectorAll('img'))img.classList.remove('rt-selected-image');
    if(contains(range)&&range.startContainer===range.endContainer&&range.endOffset===range.startOffset+1){
      const selected=range.startContainer.childNodes[range.startOffset];if(selected?.tagName==='IMG')selected.classList.add('rt-selected-image');
    }
  }
  document.addEventListener('selectionchange',()=>{remember();update();},{signal:events.signal});
  editor.addEventListener('input',()=>{remember();update();});
  editor.addEventListener('paste',e=>{e.preventDefault();if(!disabled)command('insertText',e.clipboardData.getData('text/plain'));});
  editor.addEventListener('drop',e=>e.preventDefault());
  editor.addEventListener('click',e=>{
    if(e.target.tagName!=='IMG')return;
    const range=document.createRange();range.selectNode(e.target);restore(range);remember();update();
  });
  add(insert,'插入链接',()=>{remember();const value=prompt('请输入 HTTPS 链接');if(!value)return;try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password)throw Error();command('createLink',u.href);}catch{onError('请输入有效的 HTTPS 链接');}});
  const file=node('input');file.type='file';file.accept='image/png,image/jpeg,image/gif,image/webp';file.hidden=true;
  const upload=add(insert,'插入图片',()=>{remember();pickerRange=restore().cloneRange();file.click();});
  const notice=node('p');notice.className='rt-editor-status';notice.setAttribute('role','status');notice.hidden=true;
  file.addEventListener('change',async()=>{
    const f=file.files[0];if(!f||uploading||disabled)return;
    if(f.size>2*1024*1024){onError('图片需小于 2 MB');file.value='';return;}
    const insertion=pickerRange?.cloneRange()||restore().cloneRange();insertion.collapse(false);
    uploading=true;file.disabled=true;upload.disabled=true;notice.textContent='正在上传图片';notice.hidden=false;
    try{
      const url=await dataUrl(f),meta=await session.request('images',{method:'POST',data:{requestId:crypto.randomUUID(),data:url.split(',')[1]}});
      if(disposed)return;
      if(!contains(insertion))throw Error('插入位置已改变 请重新选择位置后插入图片');
      if(!/^[a-f0-9]{64}$/.test(meta.id))throw Error('图片上传结果无效 请重试');
      restore(insertion);
      // Block markup lets the image align independently; native editing keeps undo/redo.
      const html='<p><img src="'+escape(url)+'" alt="'+escape(f.name)+'" width="480" data-mail-image="'+meta.id+'"></p><p><br></p>';
      if(!document.execCommand('insertHTML',false,html))throw Error('无法插入图片 请重新选择正文位置');
      remember();update();notice.textContent='图片已插入';
    }catch(e){if(!disposed){notice.hidden=true;onError(e.message);}}
    finally{uploading=false;file.disabled=disabled;upload.disabled=disabled;file.value='';pickerRange=null;}
  });
  for(const img of editor.querySelectorAll('img')){
    const id=/^cid:lab-([a-f0-9]{64})$/.exec(img.getAttribute('src')||'')?.[1];if(!id){img.remove();continue;}
    img.dataset.mailImage=id;session.download('images/'+id).then(dataUrl).then(url=>{if(!disposed)img.src=url;}).catch(()=>{if(!disposed)img.alt='图片加载失败';});
  }
  const help=node('p','在正文中放置光标后插入图片 选中文字或点击图片可设置对齐 每张图片不超过 2 MB');help.className='rt-help';
  container.append(toolbar,editor,file,notice,help);
  return {
    destroy(){disposed=true;events.abort();},
    setDisabled(value){disabled=value;editor.contentEditable=String(!value);for(const b of buttons)b.disabled=value;file.disabled=value||uploading;upload.disabled=value||uploading;},
    value(){
      if(uploading)throw Error('请等待图片上传完成');
      const clone=editor.cloneNode(true);
      // Some browser engines emit align attributes. Persist a single safe CSS representation.
      for(const block of clone.querySelectorAll('[align]')){const value=block.getAttribute('align');if(['left','center','right'].includes(value))block.style.textAlign=value;block.removeAttribute('align');}
      for(const img of clone.querySelectorAll('img')){
        if(!/^[a-f0-9]{64}$/.test(img.dataset.mailImage||'')){img.remove();continue;}
        img.setAttribute('src','cid:lab-'+img.dataset.mailImage);img.removeAttribute('data-mail-image');img.classList.remove('rt-selected-image');if(!img.className)img.removeAttribute('class');
      }
      return {html:clone.innerHTML,body:editor.innerText.trim()||'请使用支持 HTML 的邮件客户端查看此邮件'};
    }
  };
}
