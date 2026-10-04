import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {ListToolsRequestSchema,CallToolRequestSchema,ListResourcesRequestSchema,ReadResourceRequestSchema,ListResourceTemplatesRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {createMailLoginClient,portalFetch,RESOURCE} from './local-portal-client.mjs';
import {fileURLToPath} from 'node:url';
import {realpathSync} from 'node:fs';
import {createRequirementTodos} from './local-requirement-todos.mjs';

export function createLocalPortalBridge({fetchImpl=portalFetch,mail=createMailLoginClient({fetchImpl}),requirementTodos=createRequirementTodos()}={}){
  const upstream=new Client({name:'110lab-local-workbench',version:'0.10.0'});
  const transport=new StreamableHTTPClientTransport(new URL(RESOURCE),{fetch:fetchImpl});
  let connecting;const ready=()=>connecting ||= upstream.connect(transport).catch(e=>{connecting=null;throw e;});
  const server=new Server({name:'110lab',version:'0.10.0'},{capabilities:{tools:{},resources:{}}});
  const privateMeta={securitySchemes:[{type:'noauth'}],ui:{visibility:['app']},'openai/widgetAccessible':true,'openai/visibility':'private'};
  server.setRequestHandler(ListToolsRequestSchema,async()=>{
    await ready();const result=await upstream.listTools();
    result.tools=result.tools.map(tool=>tool.name==='connect_110lab_mail'?{...tool,securitySchemes:privateMeta.securitySchemes,_meta:privateMeta}:{...tool,securitySchemes:tool._meta?.securitySchemes});
    result.tools.push({name:'complete_110lab_mail_login',description:'等待或取消本机 OAuth 回调 仅供发起登录的插件界面调用',inputSchema:{type:'object',properties:{state:{type:'string',pattern:'^[\\w-]{43}$'},cancel:{type:'boolean'}},required:['state'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},securitySchemes:privateMeta.securitySchemes,_meta:privateMeta});
    result.tools.push({name:'get_my_110lab_requirement_todos',description:'读取本机已连接需求账号的当前处理事项及待评审 PR 仅供工作台显示',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},securitySchemes:privateMeta.securitySchemes,_meta:privateMeta});return result;
  });
  server.setRequestHandler(CallToolRequestSchema,async request=>{
    const {name,arguments:args}=request.params;
    if(name==='connect_110lab_mail')return mail.start(args);
    if(name==='complete_110lab_mail_login')return mail.finish(args);
    if(name==='get_my_110lab_requirement_todos'){
      if(args&&Object.keys(args).length)throw new Error('Invalid arguments');
      return {content:[{type:'text',text:'个人需求待办已读取'}],_meta:{requirementTodos:await requirementTodos()}};
    }
    if(!['open_110lab','search_110lab_projects'].includes(name))throw new Error('Unknown tool');
    await ready();return upstream.callTool({name,arguments:args});
  });
  server.setRequestHandler(ListResourcesRequestSchema,async r=>{await ready();return upstream.listResources(r.params);});
  server.setRequestHandler(ListResourceTemplatesRequestSchema,async r=>{await ready();return upstream.listResourceTemplates(r.params);});
  server.setRequestHandler(ReadResourceRequestSchema,async r=>{if(!r.params.uri.startsWith('ui://110lab/'))throw new Error('Unknown resource');await ready();return upstream.readResource(r.params);});
  return {server,async close(){await mail.close();await upstream.close();await server.close();}};
}

// Build this entry as a self-contained plugin file. stdout is MCP JSON only.
if(process.argv[1]&&fileURLToPath(import.meta.url)===realpathSync(process.argv[1])){
  const bridge=createLocalPortalBridge();
  await bridge.server.connect(new StdioServerTransport());
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void bridge.close().finally(()=>process.exit(0));});
  process.stdin.once('end',()=>{void bridge.close();});
}
