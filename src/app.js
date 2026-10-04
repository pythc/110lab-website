import { App } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions } from '@openai/mcp-extensions/app';
import { initWorkbench } from './workbench.js';
import config from './projects.json';
import { EMBEDDED_APPS, initEmbeddedWorkspace } from './embedded-workspace.js';

const portal=initWorkbench(config,{embeddedIds:Object.keys(EMBEDDED_APPS)});
const workspace=initEmbeddedWorkspace();
// The same compiled resource can be previewed outside an MCP host.
if(window.parent!==window){
  const app=new App({name:'110lab',version:'0.9.0'},{},{autoResize:false});
  new OpenAIExtensions(app);
  app.ontoolresult=()=>{}; // The catalog is already in this resource; never re-call its opener.
  try{
    await app.connect();
    portal.setExternalOpener(url=>app.openLink({url}));
    workspace?.setExternalOpener(url=>app.openLink({url}));
    workspace?.setToolCaller(params=>app.callServerTool(params,{timeout:params.arguments?.cancel?10000:300000}));
    const context=app.getHostContext();
    if(context?.displayMode!=='fullscreen'&&context?.availableDisplayModes?.includes('fullscreen')){
      await app.requestDisplayMode({mode:'fullscreen'});
    }
  }catch(error){
    console.error('110lab host connection failed',error);
    // Keep normal HTTPS anchors usable if the host bridge is unavailable.
  }
}
