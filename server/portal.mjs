import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {registerAppResource,registerAppTool,RESOURCE_MIME_TYPE} from '@modelcontextprotocol/ext-apps/server';
import {OpenAIExtensions} from '@openai/mcp-extensions/server';
import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';

export const UI_URI='ui://110lab/workbench/v0.7.0';
export const PREVIOUS_UI_URI='ui://110lab/workbench/v0.6.1';
export const LEGACY_UI_URI='ui://110lab/home';
export async function createPortalServer(){
  const [html,config,icon]=await Promise.all([
    readFile(new URL('../dist/mcp-app.html',import.meta.url),'utf8'),
    readFile(new URL('../src/projects.json',import.meta.url),'utf8').then(JSON.parse),
    readFile(new URL('../src/assets/110lab-icon.png',import.meta.url))
  ]);
  const catalog=()=>config.projects.filter(p=>!p.reserved).map(p=>({id:p.id,title:p.title,description:p.description,url:p.url||null,tags:p.tags}));
  const server=new McpServer({name:'110lab',version:'0.7.0'});
  new OpenAIExtensions(server);
  const workbenchResource=uri=>({contents:[{
    uri,mimeType:RESOURCE_MIME_TYPE,text:html,
    _meta:{ui:{csp:{connectDomains:[],resourceDomains:[],frameDomains:[
      'https://47.109.176.127',
      'https://fcncvoyreb8p.feishuapp.com',
      'https://fcncvoyreb8p.aiforce.cloud',
      'https://accounts.feishu.cn',
      'https://miaoda.feishu.cn'
    ]}},'openai/ui':{preferredDisplayMode:'fullscreen',availableDisplayModes:['fullscreen']}}
  }]});
  registerAppResource(server,'110lab-workbench-v5',UI_URI,{description:'110 实验室工作台'},async()=>workbenchResource(UI_URI));
  registerAppResource(server,'110lab-workbench-v5-previous',PREVIOUS_UI_URI,{description:'110 实验室工作台兼容入口'},async()=>workbenchResource(PREVIOUS_UI_URI));
  registerAppResource(server,'110lab-workbench-v6-legacy','ui://110lab/workbench/v0.6.0',{description:'110 实验室工作台兼容入口'},async()=>workbenchResource('ui://110lab/workbench/v0.6.0'));
  // Older installed clients may retain the original resource URI in tool discovery.
  // Both addresses serve the workbench; only the versioned address is advertised by the opener.
  registerAppResource(server,'110lab-workbench-v5-1-legacy','ui://110lab/workbench/v0.5.1',{description:'110 实验室工作台兼容入口'},async()=>workbenchResource('ui://110lab/workbench/v0.5.1'));
  registerAppResource(server,'110lab-workbench-v5-legacy','ui://110lab/workbench/v0.5.0',{description:'110 实验室工作台兼容入口'},async()=>workbenchResource('ui://110lab/workbench/v0.5.0'));
  registerAppResource(server,'110lab-workbench-legacy',LEGACY_UI_URI,{description:'110 实验室工作台兼容入口'},async()=>workbenchResource(LEGACY_UI_URI));
  const opener={
    icons:[{src:'data:image/png;base64,'+icon.toString('base64'),mimeType:'image/png',sizes:['256x256']}],
    title:'110lab',description:'打开 110 实验室工作台，进入批改系统内网版、批改系统外网版、考核系统或需求平台。',inputSchema:z.object({}),
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
    _meta:{ui:{resourceUri:UI_URI,visibility:['app','model']},'openai/ui':{entrypoints:[{type:'global'}]}}
  };
  registerAppTool(server,'open_110lab',opener,async()=>({content:[{type:'text',text:'110lab 工作台已准备好。'}],structuredContent:{systems:config.systems,appCount:config.apps.length,projectCount:catalog().length}}));
  const search={
    title:'搜索 110lab 项目',description:'根据名称或介绍查找 110 实验室首页展示的项目及入口。',
    inputSchema:z.object({query:z.string().max(200).default('')}),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
  };
  server.registerTool('search_110lab_projects',search,async({query})=>{const q=query.toLocaleLowerCase();const projects=catalog().filter(p=>(p.title+' '+p.description+' '+p.tags).toLocaleLowerCase().includes(q));return {content:[{type:'text',text:JSON.stringify(projects)}],structuredContent:{projects}};});
  // SDK 1.30's high-level registry drops standard Tool.icons. Use its public
  // low-level discovery API; tool execution and validation stay in McpServer.
  server.server.setRequestHandler(ListToolsRequestSchema,()=>({tools:Object.entries({open_110lab:opener,search_110lab_projects:search}).map(([name,definition])=>({...definition,name,inputSchema:z.toJSONSchema(definition.inputSchema,{target:'draft-7',io:'input'})}))}));
  return server;
}
