import { App } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions } from '@openai/mcp-extensions/app';
import { initWorkbench } from './workbench.js';
import config from './projects.json';
import { EMBEDDED_APPS, initEmbeddedWorkspace } from './embedded-workspace.js';

const portal=initWorkbench(config,{embeddedIds:Object.keys(EMBEDDED_APPS)});
const workspace=initEmbeddedWorkspace();
// The same compiled resource can be previewed outside an MCP host.
if(window.parent!==window){
  const app=new App({name:'110lab',version:'0.8.0'},{},{autoResize:false});
  new OpenAIExtensions(app);
  app.ontoolresult=()=>{}; // The catalog is already in this resource; never re-call its opener.
  try{
    await app.connect();
    workspace?.setDiagnosticsReporter(info=>app.sendMessage({role:'user',content:[{type:'text',text:'110lab 连接诊断\n'+JSON.stringify(info)}]}));
    portal.setExternalOpener(url=>app.openLink({url}));
    const context=app.getHostContext();
    if(context?.displayMode!=='fullscreen'&&context?.availableDisplayModes?.includes('fullscreen')){
      await app.requestDisplayMode({mode:'fullscreen'});
    }
  }catch(error){
    console.error('110lab host connection failed',error);
    // Keep normal HTTPS anchors usable if the host bridge is unavailable.
  }
}
