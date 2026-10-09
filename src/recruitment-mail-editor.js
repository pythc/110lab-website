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
  const toolbar=node('div');toolbar.className='rt-editor-toolbar';const editor=node('div');editor.className='rt-rich-editor';editor.contentEditable='true';editor.setAttribute('role','textbox');editor.setAttribute('aria-label','邮件富文本正文');editor.setAttribute('aria-multiline','true');
  // Server-sanitized saved markup only. Clipboard and drop never insert HTML.
  editor.innerHTML=template.html||'<p>'+escape(template.body).replace(/\n/g,'<br>')+'</p>';
  editor.addEventListener('paste',e=>{e.preventDefault();document.execCommand('insertText',false,e.clipboardData.getData('text/plain'));});editor.addEventListener('drop',e=>e.preventDefault());
  const add=(label,fn)=>{const b=node('button',label);b.type='button';b.className='rt-button';b.addEventListener('mousedown',e=>e.preventDefault());b.addEventListener('click',fn);toolbar.append(b);};
  for(const [label,command]of [['加粗','bold'],['斜体','italic'],['下划线','underline'],['列表','insertUnorderedList']])add(label,()=>{editor.focus();document.execCommand(command);});
  add('插入链接',()=>{const value=prompt('请输入 HTTPS 链接');if(!value)return;try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password)throw Error();editor.focus();document.execCommand('createLink',false,u.href);}catch{onError('请输入有效的 HTTPS 链接');}});
  const file=node('input');file.type='file';file.accept='image/png,image/jpeg,image/gif,image/webp';file.hidden=true;
  add('上传图片',()=>file.click());file.addEventListener('change',async()=>{const f=file.files[0];if(!f)return;if(f.size>2*1024*1024){onError('图片需小于 2 MB');return;}file.disabled=true;try{const url=await dataUrl(f),meta=await session.request('images',{method:'POST',data:{requestId:crypto.randomUUID(),data:url.split(',')[1]}});const img=node('img');img.src=url;img.alt=f.name;img.dataset.mailImage=meta.id;editor.append(img,node('p',''));}catch(e){onError(e.message);}finally{file.disabled=false;file.value='';}});
  for(const img of editor.querySelectorAll('img')){const id=/^cid:lab-([a-f0-9]{64})$/.exec(img.getAttribute('src')||'')?.[1];if(!id){img.remove();continue;}img.dataset.mailImage=id;session.download('images/'+id).then(dataUrl).then(url=>{img.src=url;}).catch(()=>{img.alt='图片加载失败';});}
  container.append(toolbar,editor,file,node('p','支持文字样式、变量和内嵌图片 每张图片 2 MB 内 每封最多 8 张共 8 MB 音视频可通过封面和 HTTPS 链接展示'));
  return {value(){if(file.disabled)throw Error('请等待图片上传完成');const clone=editor.cloneNode(true);for(const img of clone.querySelectorAll('img')){if(!/^[a-f0-9]{64}$/.test(img.dataset.mailImage||'')){img.remove();continue;}img.setAttribute('src','cid:lab-'+img.dataset.mailImage);img.removeAttribute('data-mail-image');}return {html:clone.innerHTML,body:editor.innerText.trim()||'请使用支持 HTML 的邮件客户端查看此邮件'};}};
}
