import {initWorkbench} from './workbench.js';
import config from './projects.json';
import {initWorkspace} from './workspace.js';
import {EMBEDDED_APPS} from './embedded-workspace.js';
const embedded=location.pathname==='/workbench/embedded';
const portal=initWorkbench(config,{embeddedIds:embedded?Object.keys(EMBEDDED_APPS):[]});
if(embedded&&window.parent!==window){
  portal.setExternalOpener(url=>window.parent.postMessage({type:'110lab-workspace-open-link',url},'*'));
  document.addEventListener('click',event=>{
    if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    const id=event.target instanceof Element?event.target.closest('.app-card[data-app-id]')?.dataset.appId:null;
    if(id&&Object.hasOwn(EMBEDDED_APPS,id)){event.preventDefault();window.parent.postMessage({type:'110lab-workspace-open-app',id},'*');}
  },{capture:true});
}
initWorkspace();
