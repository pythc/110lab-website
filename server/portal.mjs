import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {registerAppResource,registerAppTool,RESOURCE_MIME_TYPE} from '@modelcontextprotocol/ext-apps/server';
import {OpenAIExtensions} from '@openai/mcp-extensions/server';
import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {MAIL_HOST_SCOPE,mailAuthChallenge} from './mail-oauth.mjs';

// Keep the established resource identity to preserve embedded login partitions.
export const UI_URI='ui://110lab/workbench/v0.8.7';
export const PREVIOUS_UI_URI='ui://110lab/workbench/v0.8.6';
export const LEGACY_UI_URI='ui://110lab/home';
const WIDGET_DOMAIN='https://internal.110-lab.cn';
const EMBED_FRAME_DOMAINS=Object.freeze([
  'https://internal.110-lab.cn',
  'https://47.109.176.127',
  'https://fcncvoyreb8p.feishuapp.com',
  'https://fcncvoyreb8p.aiforce.cloud',
  'https://open.feishu.cn',
  'https://accounts.feishu.cn',
  'https://passport.feishu.cn',
  'https://login.feishu.cn',
  'https://miaoda.feishu.cn'
]);
// Hosted plugin adapters also consume the documented compatibility metadata.
// Keep both forms derived from the same exact origin list.
const WIDGET_CSP=Object.freeze({connect_domains:[],resource_domains:[],frame_domains:EMBED_FRAME_DOMAINS,redirect_domains:[...new Set([
  'https://110-lab.cn','https://internal.110-lab.cn','https://aigrading.110-lab.cn','https://ai-grading.110-lab.cn','https://www.feishu.cn','https://fcncvoyreb8p.feishu.cn',...EMBED_FRAME_DOMAINS
])]});
export async function createPortalServer({mailHandoff}={}){
  const [html,config,icon]=await Promise.all([
    readFile(new URL('../dist/mcp-app.html',import.meta.url),'utf8'),
    readFile(new URL('../src/projects.json',import.meta.url),'utf8').then(JSON.parse),
    readFile(new URL('../src/assets/110lab-icon.png',import.meta.url))
  ]);
  const catalog=()=>config.projects.filter(p=>!p.reserved).map(p=>({id:p.id,title:p.title,description:p.description,url:p.url||null,tags:p.tags}));
  const server=new McpServer({name:'110lab',version:'0.10.0'});
  new OpenAIExtensions(server);
  const workbenchResource=uri=>({contents:[{
    uri,mimeType:RESOURCE_MIME_TYPE,text:html,
    _meta:{ui:{domain:WIDGET_DOMAIN,csp:{connectDomains:[],resourceDomains:[],frameDomains:EMBED_FRAME_DOMAINS}},'openai/widgetDomain':WIDGET_DOMAIN,'openai/widgetCSP':WIDGET_CSP,'openai/ui':{preferredDisplayMode:'fullscreen',availableDisplayModes:['fullscreen']}}
  }]});
  registerAppResource(server,'110lab-workbench-v5',UI_URI,{description:'110 实验室工作台'},async()=>workbenchResource(UI_URI));
  registerAppResource(server,'110lab-workbench-v5-previous',PREVIOUS_UI_URI,{description:'110 实验室工作台兼容入口'},async()=>workbenchResource(PREVIOUS_UI_URI));
  registerAppResource(server,'110lab-workbench-v8-5-legacy','ui://110lab/workbench/v0.8.5',{description:'110 实验室工作台兼容入口'},async()=>workbenchResource('ui://110lab/workbench/v0.8.5'));
  registerAppResource(server,'110lab-workbench-v8-4-legacy','ui://110lab/workbench/v0.8.4',{description:'110 实验室工作台兼容入口'},async()=>workbenchResource('ui://110lab/workbench/v0.8.4'));
  registerAppResource(server,'110lab-workbench-v8-3-legacy','ui://110lab/workbench/v0.8.3',{description:'110 实验室工作台兼容入口'},async()=>workbenchResource('ui://110lab/workbench/v0.8.3'));
  registerAppResource(server,'110lab-workbench-v8-2-legacy','ui://110lab/workbench/v0.8.2',{description:'110 实验室工作台兼容入口'},async()=>workbenchResource('ui://110lab/workbench/v0.8.2'));
  registerAppResource(server,'110lab-workbench-v8-1-legacy','ui://110lab/workbench/v0.8.1',{description:'110 实验室工作台兼容入口'},async()=>workbenchResource('ui://110lab/workbench/v0.8.1'));
  registerAppResource(server,'110lab-workbench-v8-legacy','ui://110lab/workbench/v0.8.0',{description:'110 实验室工作台兼容入口'},async()=>workbenchResource('ui://110lab/workbench/v0.8.0'));
  registerAppResource(server,'110lab-workbench-v7-legacy','ui://110lab/workbench/v0.7.0',{description:'110 实验室工作台兼容入口'},async()=>workbenchResource('ui://110lab/workbench/v0.7.0'));
  registerAppResource(server,'110lab-workbench-v6-1-legacy','ui://110lab/workbench/v0.6.1',{description:'110 实验室工作台兼容入口'},async()=>workbenchResource('ui://110lab/workbench/v0.6.1'));
  registerAppResource(server,'110lab-workbench-v6-legacy','ui://110lab/workbench/v0.6.0',{description:'110 实验室工作台兼容入口'},async()=>workbenchResource('ui://110lab/workbench/v0.6.0'));
  // Older installed clients may retain the original resource URI in tool discovery.
  // Both addresses serve the workbench; only the versioned address is advertised by the opener.
  registerAppResource(server,'110lab-workbench-v5-1-legacy','ui://110lab/workbench/v0.5.1',{description:'110 实验室工作台兼容入口'},async()=>workbenchResource('ui://110lab/workbench/v0.5.1'));
  registerAppResource(server,'110lab-workbench-v5-legacy','ui://110lab/workbench/v0.5.0',{description:'110 实验室工作台兼容入口'},async()=>workbenchResource('ui://110lab/workbench/v0.5.0'));
  registerAppResource(server,'110lab-workbench-legacy',LEGACY_UI_URI,{description:'110 实验室工作台兼容入口'},async()=>workbenchResource(LEGACY_UI_URI));
  const opener={
    icons:[{src:'data:image/png;base64,'+icon.toString('base64'),mimeType:'image/png',sizes:['256x256']}],
    title:'110lab',description:'打开 110 实验室工作台，进入批改系统内网版、批改系统外网版、考核系统或需求平台。',inputSchema:z.object({}),
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},securitySchemes:[{type:'noauth'}],
    _meta:{securitySchemes:[{type:'noauth'}],ui:{resourceUri:UI_URI,visibility:['app','model']},'openai/ui':{entrypoints:[{type:'global'}]}}
  };
  registerAppTool(server,'open_110lab',opener,async()=>({content:[{type:'text',text:'110lab 工作台已准备好。'}],structuredContent:{systems:config.systems,appCount:config.apps.length,projectCount:catalog().length}}));
  const search={
    title:'搜索 110lab 项目',description:'根据名称或介绍查找 110 实验室首页展示的项目及入口。',
    inputSchema:z.object({query:z.string().max(200).default('')}),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},securitySchemes:[{type:'noauth'}],_meta:{securitySchemes:[{type:'noauth'}]}
  };
  server.registerTool('search_110lab_projects',search,async({query})=>{const q=query.toLocaleLowerCase();const projects=catalog().filter(p=>(p.title+' '+p.description+' '+p.tags).toLocaleLowerCase().includes(q));return {content:[{type:'text',text:JSON.stringify(projects)}],structuredContent:{projects}};});
  const schemes=[{type:'oauth2',scopes:[MAIL_HOST_SCOPE]}];
  const mailLogin={title:'登录公共邮箱管理',description:'将当前已验证的飞书身份连接到发起登录的公共邮箱页面。仅供插件页面调用，不授予发信或管理员权限。',inputSchema:z.object({state:z.string().regex(/^[\w-]{43}$/),fresh:z.boolean().default(false)}).strict(),securitySchemes:schemes,annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{securitySchemes:schemes,ui:{visibility:['app']},'openai/widgetAccessible':true,'openai/visibility':'private'}};
  registerAppTool(server,'connect_110lab_mail',mailLogin,async({state,fresh})=>mailHandoff?mailHandoff(state,{fresh}):mailAuthChallenge());
  // SDK 1.30's high-level registry drops standard Tool.icons. Use its public
  // low-level discovery API; tool execution and validation stay in McpServer.
  server.server.setRequestHandler(ListToolsRequestSchema,()=>({tools:Object.entries({open_110lab:opener,search_110lab_projects:search,connect_110lab_mail:mailLogin}).map(([name,definition])=>({...definition,name,inputSchema:z.toJSONSchema(definition.inputSchema,{target:'draft-7',io:'input'})}))}));
  return server;
}
