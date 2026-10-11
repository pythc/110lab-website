const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const button=(title,fn,cls='rt-button')=>{const n=el('button',title,cls);n.type='button';n.onclick=fn;return n;};
const identity=a=>a.name+' · '+a.studentNo+' · '+a.email;

export function createOfferWorkspace({session,root,onStatus}){
  let disposed=false,generation=0,searchGeneration=0,writing=false,items=[],dialog=null;
  const heading=el('div',undefined,'rw-page-heading'),copy=el('div');
  copy.append(el('h2','Offer 名单'),el('p','选择考核账号，允许候选人查看 Offer'));
  const refresh=button('刷新名单',()=>void load());heading.append(copy,refresh);
  const addPanel=el('section',undefined,'rw-panel rw-offer-add'),form=el('form'),searchLabel=el('label',undefined,'rt-field'),search=el('input');
  search.type='search';search.placeholder='输入姓名、学号或邮箱';search.minLength=2;search.maxLength=100;search.required=true;search.id='rw-offer-account-search';
  searchLabel.htmlFor=search.id;searchLabel.append(el('span','添加允许访问的账号'),search);
  const searchButton=el('button','搜索考核账号','rt-button');searchButton.type='submit';form.append(searchLabel,searchButton);
  const results=el('div',undefined,'rw-offer-results');results.setAttribute('aria-live','polite');
  addPanel.append(form,el('p','加入或移出名单不会改变录取状态，也不会发送邮件或飞书通知','rt-help'),results);
  const listPanel=el('section',undefined,'rw-list-card'),toolbar=el('div',undefined,'rt-toolbar'),filter=el('input'),scope=el('select'),count=el('span');
  filter.type='search';filter.placeholder='筛选名单';filter.setAttribute('aria-label','筛选 Offer 名单');scope.setAttribute('aria-label','访问状态');scope.append(new Option('允许访问','enabled'),new Option('已撤销','revoked'),new Option('全部','all'));toolbar.append(filter,scope,count);
  const scroll=el('div',undefined,'rt-table-scroll');scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label','Offer 访问名单');const table=el('table',undefined,'rt-table'),thead=el('thead'),tr=el('tr');
  for(const title of ['考核账号','访问状态','答复','最近变更','备注','操作']){const th=el('th',title);th.scope='col';tr.append(th);}thead.append(tr);const rows=el('tbody');table.append(thead,rows);scroll.append(table);listPanel.append(toolbar,scroll);root.replaceChildren(heading,addPanel,listPanel);
  filter.oninput=render;scope.onchange=render;
  const controls=value=>{for(const n of root.querySelectorAll('button,input,select,textarea'))n.disabled=value;};
  async function load(){
    if(writing||disposed)return;const gen=++generation;refresh.disabled=true;listPanel.setAttribute('aria-busy','true');
    try{const value=await session.request('offers');if(disposed||gen!==generation)return;items=value.items;render();}
    catch(e){if(!disposed&&gen===generation)onStatus(e.message,true);}
    finally{if(!disposed&&gen===generation){refresh.disabled=false;listPanel.removeAttribute('aria-busy');}}
  }
  function render(){
    const q=filter.value.trim().toLowerCase(),visible=items.filter(a=>(scope.value==='all'||a.enabled===(scope.value==='enabled'))&&[identity(a),a.note].join(' ').toLowerCase().includes(q));count.textContent=visible.length+' 人';rows.replaceChildren();
    for(const a of visible){
      const row=el('tr'),person=el('td'),changed=el('td'),action=el('td');person.append(el('strong',a.name),el('p',a.studentNo+' · '+a.email,'rt-help'));changed.append(el('span',a.updatedBy),el('p',new Date(a.updatedAt).toLocaleString('zh-CN'),'rt-help'));
      action.append(button(a.enabled?'撤销访问':'恢复访问',()=>confirmChange(a,!a.enabled)));row.append(person,el('td',a.enabled?'允许访问':'已撤销'),el('td',({PENDING:'待答复',ACCEPTED:'已接受',DECLINED:'已婉拒'})[a.status]||'—'),changed,el('td',a.note||'—','rw-offer-note'),action);rows.append(row);
    }
    if(!visible.length){const row=el('tr'),cell=el('td',items.length?'暂无符合条件的账号':'名单为空，暂未向任何候选人开放 Offer','rt-table-empty');cell.colSpan=6;row.append(cell);rows.append(row);}
  }
  form.onsubmit=async e=>{
    e.preventDefault();if(writing||disposed)return;const q=search.value.trim();if(q.length<2){onStatus('请至少输入两个字符',true);return;}
    const gen=++searchGeneration;searchButton.disabled=true;results.textContent='正在搜索';
    try{
      const value=await session.request('offer-accounts/search',{method:'POST',data:{query:q}});if(disposed||gen!==searchGeneration)return;
      results.replaceChildren();for(const a of value.items){const current=items.find(v=>v.assessmentUserId===a.id),row=el('div',undefined,'rw-hr-row');row.append(el('span',identity(a)));const choose=button(current?.enabled?'已在名单':'选择账号',()=>confirmChange({...a,assessmentUserId:a.id,revision:current?.revision||0,note:current?.note||''},true));choose.disabled=!!current?.enabled;row.append(choose);results.append(row);}
      if(!value.items.length)results.append(el('p','未找到考核账号，请核对姓名、学号或邮箱','rt-help'));
      if(value.hasMore)results.append(el('p','匹配较多，请输入更完整的学号或邮箱','rt-help'));
    }catch(error){if(!disposed&&gen===searchGeneration){results.textContent='搜索失败，请稍后重试';onStatus(error.message,true);}}
    finally{if(!disposed&&gen===searchGeneration)searchButton.disabled=false;}
  };
  function closeDialog(){if(writing)return;dialog?.close();dialog?.remove();dialog=null;}
  function confirmChange(account,enabled){
    if(writing||disposed)return;closeDialog();
    dialog=el('dialog',undefined,'rt-dialog rw-offer-dialog');const current=dialog,content=el('form'),header=el('header',undefined,'rt-dialog-head'),title=el('h2',enabled?'允许此账号查看 Offer':'撤销 Offer 访问');title.id='rw-offer-confirm-title';dialog.setAttribute('aria-labelledby',title.id);header.append(title,button('关闭',closeDialog));
    const body=el('div',undefined,'rt-form-scroll'),label=el('label',undefined,'rt-field'),note=el('textarea');note.maxLength=1000;note.rows=3;note.value=account.note||'';label.append(el('span','备注（可选）'),note);body.append(el('p',identity(account)),el('p',enabled?(account.revision?'恢复后将重新等待候选人答复，历史答复保留在审计记录中':'请核对所选考核账号，确认后该账号登录即可查看 Offer'):'撤销后该账号再次访问或提交 Offer 时将被拒绝','rt-help'),label);
    const error=el('p',undefined,'rt-form-error');error.setAttribute('role','alert');body.append(error);
    const footer=el('footer',undefined,'rt-dialog-footer'),cancel=button('取消',closeDialog),submit=el('button',enabled?'确认允许访问':'确认撤销','rt-button '+(enabled?'rt-primary':'rt-danger'));submit.type='submit';footer.append(cancel,submit);content.append(header,body,footer);dialog.append(content);root.append(dialog);dialog.addEventListener('cancel',e=>{e.preventDefault();closeDialog();});dialog.showModal();
    content.onsubmit=async e=>{
      e.preventDefault();if(writing||disposed)return;writing=true;controls(true);++searchGeneration;error.textContent='';
      try{
        await session.request('offers',{method:'POST',data:{requestId:crypto.randomUUID(),assessmentUserId:account.assessmentUserId,revision:account.revision,enabled,note:note.value.trim()}});
        if(disposed)return;writing=false;closeDialog();results.replaceChildren();onStatus(enabled?'已允许此账号查看 Offer':'已撤销 Offer 访问');await load();
      }catch(e){if(!disposed&&dialog===current)error.textContent=e.message;}
      finally{writing=false;if(!disposed)controls(false);}
    };
  }
  return {load,busy:()=>writing,destroy(){disposed=true;generation++;searchGeneration++;dialog?.close();dialog?.remove();dialog=null;root.replaceChildren();}};
}
