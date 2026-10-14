import {initWorkbench} from './workbench.js';
import config from './projects.json';
import {initWorkspace} from './workspace.js';
import {EMBEDDED_APPS} from './embedded-workspace.js';
import {updateOutcome} from './plugin-release.js';
const embedded=['/workbench/embedded','/projects/embedded'].includes(location.pathname);
const projectPage=['/projects','/projects/','/projects/embedded'].includes(location.pathname);
if(projectPage){
  document.title='项目立项 · 110lab';
  document.querySelector('.brand-product').textContent='项目立项';
  document.querySelector('#apps').hidden=true;
  const skip=document.querySelector('.skip-link');skip.href='#ws-panel-projects';skip.textContent='跳到项目';
  const back=document.createElement('a');back.href='/workbench';back.textContent='工作台';back.className='workspace-back';
  back.addEventListener('click',event=>{if(embedded&&window.parent!==window){event.preventDefault();window.parent.postMessage({type:'110lab-workspace-open-app',id:'workbench'},'*');}});
  document.querySelector('.masthead-inner').append(back);
}

const portal=initWorkbench(config,{embeddedIds:embedded?Object.keys(EMBEDDED_APPS):[]});
portal.setUpdater(async()=>{const response=await fetch('/api/plugin/release',{cache:'no-store',signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error();const value=await response.json();updateOutcome(value.release);portal.refreshApps(value.apps);return '工作台已刷新 · 最新插件 v'+value.release.version;});
if(embedded&&window.parent!==window){
  portal.setExternalOpener(url=>window.parent.postMessage({type:'110lab-workspace-open-link',url},'*'));
  document.addEventListener('click',event=>{
    if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    const id=event.target instanceof Element?event.target.closest('.app-card[data-app-id]')?.dataset.appId:null;
    if(id&&Object.hasOwn(EMBEDDED_APPS,id)){event.preventDefault();window.parent.postMessage({type:'110lab-workspace-open-app',id},'*');}
  },{capture:true});
}
initWorkspace();
