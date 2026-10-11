const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function mailPreview(session,payload,container,{strictImages=false}={}){
  const frame=node('iframe');frame.className='rt-mail-preview';frame.title='完整邮件预览';frame.setAttribute('sandbox','');container.append(frame);
  const doc=new DOMParser().parseFromString(payload.html||'<p>'+escape(payload.body).replace(/\n/g,'<br>')+'</p>','text/html');
  for(const img of doc.querySelectorAll('img')){const id=/^cid:lab-([a-f0-9]{64})$/.exec(img.getAttribute('src')||'')?.[1];if(!id){img.remove();continue;}try{const blob=await session.download('images/'+id);img.src=await dataUrl(blob);}catch{img.replaceWith(document.createTextNode('[图片暂时无法加载]'));if(strictImages)throw Error('预览图片加载失败 请返回编辑后重新预览');}}
  frame.srcdoc='<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'"><style>body{font:15px/1.75 system-ui;padding:20px;color:#243047}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{padding:8px}a{color:#5145ba}</style>'+doc.body.innerHTML;
}
const dataUrl=blob=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(blob);});
export function mailEditor(session,template,container,onError,onChange=()=>{}){
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
  const command=(name,value)=>{restore();document.execCommand(name,false,value);remember();update();onChange();};
  for(const [label,name]of [['加粗','bold'],['斜体','italic'],['下划线','underline'],['删除线','strikeThrough'],['列表','insertUnorderedList'],['编号列表','insertOrderedList']]){
    const b=add(styles,label,()=>command(name));toggles.push([b,name]);
  }
  for(const [label,name]of [['左对齐','justifyLeft'],['居中','justifyCenter'],['右对齐','justifyRight'],['两端对齐','justifyFull']]){
    const b=add(alignment,label,()=>{restore();const previous=document.queryCommandState('styleWithCSS');document.execCommand('styleWithCSS',false,true);try{command(name);}finally{document.execCommand('styleWithCSS',false,previous);}});toggles.push([b,name]);
  }
  const history=group('撤销与恢复');add(history,'撤销',()=>command('undo'));add(history,'重做',()=>command('redo'));
  const format=node('select');format.setAttribute('aria-label','段落格式');format.append(new Option('正文','p'),new Option('大标题','h2'),new Option('小标题','h3'),new Option('引用','blockquote'));format.addEventListener('change',()=>command('formatBlock',format.value));styles.append(format);
  const extraControls=[];
  const size=node('select');size.setAttribute('aria-label','字号');size.append(new Option('字号',''),...[['10','1'],['13','2'],['16','3'],['18','4'],['24','5'],['32','6'],['36','7']].map(([label,value])=>new Option(label+' px',value)));size.onchange=()=>{if(size.value)command('fontSize',size.value);};styles.append(size);extraControls.push(size);
  for(const [label,cmd,initial]of [['文字颜色','foreColor','#243047'],['文字底色','hiliteColor','#fff2cc']]){const wrap=node('label',label),input=node('input');input.type='color';input.value=initial;input.setAttribute('aria-label',label);input.oninput=()=>command(cmd,input.value);wrap.className='rw-editor-color';wrap.append(input);styles.append(wrap);extraControls.push(input);}
  const spacing=node('select');spacing.setAttribute('aria-label','行距');spacing.append(new Option('行距',''),...[1,1.2,1.5,1.8,2].map(n=>new Option(n+' 倍',String(n))));spacing.onchange=()=>{if(!spacing.value||disabled)return;const range=restore(),blocks=[...editor.querySelectorAll('p,div,h1,h2,h3,h4,li,blockquote')].filter(n=>range.intersectsNode(n));for(const block of blocks)block.style.lineHeight=spacing.value;remember();onChange();};alignment.append(spacing);extraControls.push(spacing);
  add(styles,'清除格式',()=>command('removeFormat'));
  const imageTools=node('div');imageTools.className='rw-image-tools';imageTools.hidden=true;
  const width=node('input');width.type='number';width.min='40';width.max='600';width.step='1';width.setAttribute('aria-label','图片显示宽度');width.title='图片宽度 40–600 px';
  const alt=node('input');alt.type='text';alt.maxLength=180;alt.placeholder='图片说明';alt.setAttribute('aria-label','图片说明');
  let selectedImage=null;
  width.onchange=()=>{if(selectedImage&&!disabled){const n=Number(width.value);if(!Number.isInteger(n)||n<40||n>600)return;selectedImage.width=n;onChange();}};
  alt.oninput=()=>{if(selectedImage&&!disabled){selectedImage.alt=alt.value;onChange();}};
  imageTools.append(node('span','选中图片'),width,alt);add(imageTools,'删除图片',()=>{if(selectedImage){const r=document.createRange();r.selectNode(selectedImage);restore(r);command('delete');imageTools.hidden=true;}});
  function update(){
    if(disposed)return;
    const selection=getSelection(),range=selection.rangeCount?selection.getRangeAt(0):null;
    for(const [b,name]of toggles)b.setAttribute('aria-pressed',String(!!contains(range)&&document.queryCommandState(name)));
    for(const img of editor.querySelectorAll('img'))img.classList.remove('rt-selected-image');
    if(imageTools.contains(document.activeElement))return;
    selectedImage=null;imageTools.hidden=true;
    if(contains(range)&&range.startContainer===range.endContainer&&range.endOffset===range.startOffset+1){
      const selected=range.startContainer.childNodes[range.startOffset];if(selected?.tagName==='IMG'){selected.classList.add('rt-selected-image');selectedImage=selected;imageTools.hidden=false;width.value=String(selected.width||480);alt.value=selected.alt;}
    }
  }
  document.addEventListener('selectionchange',()=>{remember();update();},{signal:events.signal});
  editor.addEventListener('input',()=>{remember();update();onChange();});
  editor.addEventListener('paste',e=>{e.preventDefault();if(!disabled)command('insertText',e.clipboardData.getData('text/plain'));});
  editor.addEventListener('drop',e=>e.preventDefault());
  editor.addEventListener('click',e=>{
    if(e.target.tagName!=='IMG')return;
    const range=document.createRange();range.selectNode(e.target);restore(range);remember();update();
  });
  const panel=node('div');panel.className='rw-editor-panel';panel.hidden=true;
  function linkPanel(asButton=false){
    remember();const range=restore().cloneRange(),selection=getSelection().toString();
    const existing=(range.startContainer.nodeType===1?range.startContainer:range.startContainer.parentElement)?.closest('a');
    const label=node('input'),href=node('input'),message=node('p');label.setAttribute('aria-label','链接文字');label.placeholder='链接文字';label.value=selection||(asButton?'查看详情':'');href.type='url';href.setAttribute('aria-label','链接地址');href.placeholder='https://';href.value=existing?.getAttribute('href')||'';message.setAttribute('role','alert');
    const apply=node('button','确认插入');apply.type='button';apply.className='rt-button rt-primary';const cancel=node('button','取消');cancel.type='button';cancel.className='rt-button';
    apply.onclick=()=>{try{const url=new URL(href.value.trim());if(url.protocol!=='https:'||url.username||url.password)throw Error();restore(range);if(asButton){if(!label.value.trim())throw Error();command('insertHTML','<p><br></p><p style="text-align:center"><a href="'+escape(url.href)+'" style="display:inline-block;padding:12px 24px;background-color:#5745d6;color:#ffffff;border-radius:28px;text-decoration:none;font-weight:bold">'+escape(label.value.trim())+'</a></p><p><br></p>');}else if(range.collapsed){command('insertHTML','<a href="'+escape(url.href)+'">'+escape(label.value.trim()||url.href)+'</a>');}else command('createLink',url.href);panel.hidden=true;}catch{message.textContent='请填写有效的 HTTPS 链接'+(asButton?'和按钮文字':'');}};
    cancel.onclick=()=>{panel.hidden=true;restore(range);};panel.replaceChildren(node('strong',asButton?'插入按钮':'设置链接'),label,href,apply,cancel,message);panel.hidden=false;href.focus();
  }
  add(insert,'插入链接',()=>linkPanel());add(insert,'取消链接',()=>command('unlink'));add(insert,'插入按钮',()=>linkPanel(true));
  add(insert,'分割线',()=>command('insertHorizontalRule'));
  add(insert,'插入表格',()=>{remember();const range=restore().cloneRange();const rows=node('input'),cols=node('input');for(const [input,label,value,max]of [[rows,'表格行数',3,10],[cols,'表格列数',2,4]]){input.type='number';input.min='1';input.max=String(max);input.value=String(value);input.setAttribute('aria-label',label);}const apply=node('button','插入表格'),cancel=node('button','取消');apply.type=cancel.type='button';apply.className=cancel.className='rt-button';apply.onclick=()=>{const r=Number(rows.value),c=Number(cols.value);if(!Number.isInteger(r)||r<1||r>10||!Number.isInteger(c)||c<1||c>4)return;restore(range);command('insertHTML','<table style="width:100%;border-collapse:collapse"><tbody>'+Array.from({length:r},()=>'<tr>'+Array.from({length:c},()=>'<td style="border:1px solid #dce2eb;padding:8px"><br></td>').join('')+'</tr>').join('')+'</tbody></table><p><br></p>');panel.hidden=true;};cancel.onclick=()=>{panel.hidden=true;restore(range);};panel.replaceChildren(node('strong','表格尺寸'),rows,cols,apply,cancel);panel.hidden=false;rows.focus();});
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
      remember();update();notice.textContent='图片已插入';onChange();
    }catch(e){if(!disposed){notice.hidden=true;onError(e.message);}}
    finally{uploading=false;file.disabled=disabled;upload.disabled=disabled;file.value='';pickerRange=null;}
  });
  for(const img of editor.querySelectorAll('img')){
    const id=/^cid:lab-([a-f0-9]{64})$/.exec(img.getAttribute('src')||'')?.[1];if(!id){img.remove();continue;}
    img.dataset.mailImage=id;session.download('images/'+id).then(dataUrl).then(url=>{if(!disposed)img.src=url;}).catch(()=>{if(!disposed)img.alt='图片加载失败';});
  }
  const help=node('p','在正文中放置光标后插入图片 选中文字或点击图片可设置对齐 每张图片不超过 2 MB');help.className='rt-help';
  container.append(toolbar,panel,imageTools,editor,file,notice,help);
  return {
    destroy(){disposed=true;events.abort();},
    setDisabled(value){disabled=value;editor.contentEditable=String(!value);for(const b of [...buttons,...extraControls,...panel.querySelectorAll('input,button')])b.disabled=value;format.disabled=value;width.disabled=value;alt.disabled=value;file.disabled=value||uploading;upload.disabled=value||uploading;},
    insertVariable(key){if(!disabled&&/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key))command('insertText','{{'+key+'}}');},
    get pending(){return uploading;},
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
