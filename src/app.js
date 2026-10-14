import { App } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions } from '@openai/mcp-extensions/app';
import { initWorkbench } from './workbench.js';
import config from './projects.json';
import { EMBEDDED_APPS, initEmbeddedWorkspace } from './embedded-workspace.js';
import {updateOutcome} from './plugin-release.js';

const portal=initWorkbench(config,{embeddedIds:Object.keys(EMBEDDED_APPS)});
const workspace=initEmbeddedWorkspace();
// The same compiled resource can be previewed outside an MCP host.
if(window.parent!==window){
  const app=new App({name:'110lab',version:'0.19.0'},{},{autoResize:false});
  new OpenAIExtensions(app);
  app.ontoolresult=()=>{}; // The catalog is already in this resource; never re-call its opener.
  try{
    await app.connect();
    portal.setExternalOpener(url=>app.openLink({url}));
    portal.setUpdater(async()=>{
      const reply=await app.callServerTool({name:'open_110lab',arguments:{}},{timeout:15000});
      if(reply.isError)throw new Error('检查更新失败');const value=reply.structuredContent;
      const outcome=updateOutcome(value?.release,value?.installedPluginVersion);
      portal.refreshApps(value.apps);
      if(outcome==='current')return '工作台已刷新 · 已是最新版本';
      const opened=await app.openLink({url:value.release.url});if(opened?.isError)throw new Error('无法打开更新页');
      return '工作台已刷新，请在客户端完成插件更新';
    });
    workspace?.setExternalOpener(url=>app.openLink({url}));
    workspace?.setFileDownloader(app.getHostCapabilities()?.downloadFile?params=>app.downloadFile(params,{timeout:120000}):null);
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
