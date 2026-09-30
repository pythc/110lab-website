import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {registerAppResource,registerAppTool,RESOURCE_MIME_TYPE} from '@modelcontextprotocol/ext-apps/server';
import {OpenAIExtensions} from '@openai/mcp-extensions/server';
import {readFile} from 'node:fs/promises';
import {z} from 'zod';

export const UI_URI='ui://110lab/workbench/v0.5.0';
export async function createPortalServer(){
  const [html,config]=await Promise.all([
    readFile(new URL('../dist/mcp-app.html',import.meta.url),'utf8'),
    readFile(new URL('../src/projects.json',import.meta.url),'utf8').then(JSON.parse)
  ]);
  const catalog=()=>config.projects.filter(p=>!p.reserved).map(p=>({id:p.id,title:p.title,description:p.description,url:p.url||null,tags:p.tags}));
  const server=new McpServer({name:'110lab',version:'0.5.0'});
  new OpenAIExtensions(server);
  registerAppResource(server,'110lab-workbench-v5',UI_URI,{description:'110 实验室工作台'},async()=>({contents:[{
    uri:UI_URI,mimeType:RESOURCE_MIME_TYPE,text:html,
    _meta:{ui:{csp:{connectDomains:[],resourceDomains:[]}},'openai/ui':{preferredDisplayMode:'fullscreen',availableDisplayModes:['fullscreen']}}
  }]}));
  registerAppTool(server,'open_110lab',{
    title:'110lab',description:'打开 110 实验室工作台，进入批改系统内网版、批改系统外网版、考核系统或需求平台。',inputSchema:{},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
    _meta:{ui:{resourceUri:UI_URI,visibility:['app','model']},'openai/ui':{entrypoints:[{type:'global'}]}}
  },async()=>({content:[{type:'text',text:'110lab 工作台已准备好。'}],structuredContent:{systems:config.systems,appCount:config.apps.length,projectCount:catalog().length}}));
  server.registerTool('search_110lab_projects',{
    title:'搜索 110lab 项目',description:'根据名称或介绍查找 110 实验室首页展示的项目及入口。',
    inputSchema:{query:z.string().max(200).default('')},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
  },async({query})=>{const q=query.toLocaleLowerCase();const projects=catalog().filter(p=>(p.title+' '+p.description+' '+p.tags).toLocaleLowerCase().includes(q));return {content:[{type:'text',text:JSON.stringify(projects)}],structuredContent:{projects}};});
  return server;
}
