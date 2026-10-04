import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const runtime=await build({entryPoints:[resolve(root,'server/http.mjs')],bundle:true,write:false,platform:'node',target:'node24',format:'esm',minify:true,banner:{js:'import {createRequire as __createRequire} from "node:module";const require=__createRequire(import.meta.url);'}});
await writeFile(resolve(root,'server/runtime.mjs'),runtime.outputFiles[0].text);
for(const [source,target] of [['server/recruitment-workflow-worker-cli.mjs','server/recruitment-workflow-worker-runtime.mjs'],['server/mail-membership-worker.mjs','server/mail-membership-worker-runtime.mjs'],['server/recruitment-worker.mjs','server/recruitment-worker-runtime.mjs'],['scripts/recruitment.mjs','server/recruitment-ops-runtime.mjs'],['scripts/admin-init.mjs','server/admin-init-runtime.mjs']]){
 const bundled=await build({entryPoints:[resolve(root,source)],bundle:true,write:false,platform:'node',target:'node24',format:'esm',minify:true,banner:{js:'import {createRequire as __createRequire} from "node:module";const require=__createRequire(import.meta.url);'}});
 await writeFile(resolve(root,target),bundled.outputFiles[0].text);
}
const notices=[];
for(const entry of await readdir(resolve(root,'node_modules'),{withFileTypes:true})){
 if(!entry.isDirectory()||entry.name.startsWith('.'))continue;
 const packages=entry.name.startsWith('@')?(await readdir(resolve(root,'node_modules',entry.name))).map(x=>entry.name+'/'+x):[entry.name];
 for(const name of packages){for(const license of ['LICENSE','LICENSE.md','LICENSE.txt','LICENCE']){try{const text=await readFile(resolve(root,'node_modules',name,license),'utf8');notices.push('Package: '+name+'\n'+text);break;}catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw error;}}}
}
await writeFile(resolve(root,'vendor/RUNTIME-LICENSES.txt'),notices.join('\n\n'));
const paths=['dist/recruitment.html','server/recruitment-workflow-worker-runtime.mjs','dist/index.html','dist/workbench.html','dist/mcp-app.html','dist/admin.html','dist/mail.html','dist/recruitment-test.html','server/runtime.mjs','server/mail-membership-worker-runtime.mjs','server/recruitment-worker-runtime.mjs','server/recruitment-ops-runtime.mjs','server/admin-init-runtime.mjs','src/projects.json','src/assets/110lab-icon.png','src/assets/glass-loop-v2.png','src/assets/zhiping-logo.png','src/assets/recruitment-qq-2026.png','src/assets/zhiping-poster.jpg','src/assets/zhiping-promo.mp4','src/assets/zhiping-promo-1080p30.mp4','src/assets/zhiping-public-0.2.2.apk','src/assets/zhiping-public-release.json','vendor/RUNTIME-LICENSES.txt','vendor/GLINUI-LICENSE','vendor/KOKONUT-LICENSE','vendor/MAGICUI-LICENSE'];
const files={};
for(const path of paths){const bytes=await readFile(resolve(root,path));files[path]={sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length};}
const contentHash=createHash('sha256').update(JSON.stringify(files)).digest('hex');
const releaseId=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d+Z/,'Z')+'-'+contentHash.slice(0,10);
let sourceCommit=null,sourceTree=null,sourceDirty=true;try{
 sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
 sourceTree=execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
 sourceDirty=!!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
}catch{}
const version=JSON.parse(await readFile(resolve(root,'package.json'),'utf8')).version;
const release={sourceCommit,sourceTree,sourceDirty,service:'110lab-homepage',version,contentManagement:false,dynamicManagementDefaultEnabled:false,mailManagementDefaultEnabled:false,recruitmentDefaultEnabled:false,releaseId,contentHash,files};
await writeFile(resolve(root,'release.json'),JSON.stringify(release,null,2)+'\n');
await mkdir(resolve(root,'artifacts/deployment'),{recursive:true});
console.log(JSON.stringify({releaseId,contentHash,bytes:Object.values(files).reduce((s,x)=>s+x.size,0)}));
