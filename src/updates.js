import {createUpdatesSync} from './updates-sync.js';
function text(tag,value){const node=document.createElement(tag);node.textContent=value;return node;}
function appendInline(node,spans){
  for(const span of spans){
    let item=text(span.bold?'strong':'span',span.text);
    if(span.href){
      const url=new URL(span.href);
      if(url.protocol==='https:'&&!url.username&&!url.password){const a=document.createElement('a');a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';a.append(item);item=a;}
    }
    node.append(item);
  }
}
function card(update){
  const article=document.createElement('article');article.className='update-card';
  const date=new Date(update.updatedAt),time=text('time',date.toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'}));time.dateTime=update.updatedAt;
  article.append(time,text('h3',update.title));
  if(update.summary)article.append(text('p',update.summary));
  if(update.body.length){
    const details=document.createElement('details'),body=document.createElement('div');body.className='update-body';
    details.append(text('summary','查看详情'));
    for(const block of update.body){
      if(block.type==='list'){const ul=document.createElement('ul');for(const item of block.items){const li=document.createElement('li');appendInline(li,item);ul.append(li);}body.append(ul);}
      else{const p=document.createElement(block.type==='heading'?'h4':'p');appendInline(p,block.content);body.append(p);}
    }
    details.append(body);article.append(details);
  }
  if(update.link){const link=text('a','查看相关项目');link.className='update-link';const url=new URL(update.link);if(url.protocol==='https:'&&!url.username&&!url.password){link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';article.append(link);}}
  return article;
}
export function initPublicUpdates(){
  const section=document.querySelector('#updates');if(!section)return;
  const grid=section.querySelector('.updates-grid'),status=section.querySelector('.updates-status');
  let snapshot=null;
  const clear=message=>{
    snapshot=null;grid.replaceChildren();grid.hidden=true;
    status.hidden=false;status.textContent=message;
  };
  const sync=createUpdatesSync({
    async request(signal){
      const response=await fetch('/api/updates',{cache:'no-cache',signal});
      if(!response.ok)throw new Error('Updates unavailable');
      const data=await response.json();
      if(!Array.isArray(data.updates)||data.updates.length>50)throw new Error('Invalid updates response');
      return data.updates;
    },
    onData(updates){
      const next=JSON.stringify(updates);
      if(next===snapshot)return; // Preserve expanded details and focus on 304/revalidation.
      const cards=updates.map(card);grid.replaceChildren(...cards);grid.hidden=cards.length===0;
      status.textContent=cards.length?'':'暂无公开动态';status.hidden=cards.length>0;
      snapshot=next;
    },
    onFailure:()=>clear('公开动态暂时无法加载'),
    onResume:()=>clear('正在更新公开动态'),
  });
  document.addEventListener('visibilitychange',sync.visibilityChanged);
  const resume=event=>{if(event.persisted){clear('正在更新公开动态');sync.start();}};
  const suspend=()=>sync.stop();
  window.addEventListener('pageshow',resume);
  window.addEventListener('pagehide',suspend);
  sync.start();
  return ()=>{
    sync.stop();document.removeEventListener('visibilitychange',sync.visibilityChanged);
    window.removeEventListener('pageshow',resume);window.removeEventListener('pagehide',suspend);
  };
}
