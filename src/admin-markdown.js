function inline(value){
  const spans=[],pattern=/\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*/g;let start=0,match;
  while((match=pattern.exec(value))){if(match.index>start)spans.push({text:value.slice(start,match.index)});if(match[1])spans.push({text:match[1],href:match[2]});else spans.push({text:match[3],bold:true});start=pattern.lastIndex;}
  if(start<value.length)spans.push({text:value.slice(start)});return spans.length?spans:[{text:value||' '}];
}
export function parseBody(markdown){
  if(!markdown.trim())return [];
  const blocks=[];let paragraph=[],items=[];
  const flush=()=>{if(paragraph.length){blocks.push({type:'paragraph',content:inline(paragraph.join('\n'))});paragraph=[];}if(items.length){blocks.push({type:'list',items});items=[];}};
  for(const line of markdown.replace(/\r\n?/g,'\n').split('\n')){
    if(!line.trim()){flush();continue;}
    if(line.startsWith('## ')){flush();blocks.push({type:'heading',content:inline(line.slice(3))});}
    else if(line.startsWith('- ')){if(paragraph.length)flush();items.push(inline(line.slice(2)));}
    else{if(items.length)flush();paragraph.push(line);}
  }
  flush();return blocks;
}
export function serializeBody(blocks){const text=spans=>spans.map(s=>s.href?`[${s.text}](${s.href})`:s.bold?`**${s.text}**`:s.text).join('');return blocks.map(b=>b.type==='list'?b.items.map(i=>'- '+text(i)).join('\n'):(b.type==='heading'?'## ':'')+text(b.content)).join('\n\n');}
function text(tag,value){const n=document.createElement(tag);n.textContent=value;return n;}
function appendInline(node,spans){for(const s of spans){let item=text(s.bold?'strong':'span',s.text);if(s.href){const u=new URL(s.href);if(u.protocol==='https:'&&!u.username&&!u.password){const a=text('a','');a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';a.append(item);item=a;}}node.append(item);}}
export function renderPreview(value,target){
  target.replaceChildren(text('h3',value.title));if(value.summary){const p=text('p',value.summary);p.className='preview-summary';target.append(p);}
  for(const b of value.body){if(b.type==='list'){const ul=document.createElement('ul');for(const spans of b.items){const li=document.createElement('li');appendInline(li,spans);ul.append(li);}target.append(ul);}else{const p=document.createElement(b.type==='heading'?'h4':'p');appendInline(p,b.content);target.append(p);}}
  if(value.link){const u=new URL(value.link),a=text('a','查看相关项目');if(u.protocol==='https:'&&!u.username&&!u.password){a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';target.append(a);}}
}
