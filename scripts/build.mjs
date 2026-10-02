import {readFile,mkdir,writeFile,cp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {renderWorkbench} from '../server/render.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const config=JSON.parse(await readFile(resolve(root,'src/projects.json'),'utf8'));
const ids=new Set();for(const p of config.apps){if(!p.id||ids.has(p.id))throw new Error('App ids must be unique');ids.add(p.id);}
for(const value of [...Object.values(config.systems),...config.apps.map(p=>p.url),...config.projects.map(p=>p.url)].filter(Boolean)){
 const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password)throw new Error('Destinations must be HTTPS without embedded credentials');
}
const bundle=async entry=>(await build({entryPoints:[resolve(root,entry)],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',minify:true})).outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
await mkdir(resolve(root,'dist'),{recursive:true});
const [template,baseCSS,motionCSS,homepageCSS,redesignCSS,polishCSS,colorCSS,refinementCSS,js]=await Promise.all(['src/index.html','src/portal.css','src/motion.css','src/homepage-v5.css','src/homepage-v6.css','src/homepage-polish.css','src/homepage-colors.css','src/homepage-refinement.css'].map(p=>readFile(resolve(root,p),'utf8')).concat(bundle('src/standalone.js')));
const homepageMotionCSS=await readFile(resolve(root,'src/homepage-motion.css'),'utf8');
const recruitmentCSS=(await Promise.all(['node_modules/@uppy/core/dist/style.min.css','node_modules/@uppy/dashboard/dist/style.min.css','src/recruitment.css'].map(p=>readFile(resolve(root,p),'utf8')))).join('\n');
await writeFile(resolve(root,'dist/index.html'),template.replaceAll('/* HERO_ASSET */','/assets/glass-loop-v2.png').replace('/* PORTAL_CSS */',()=>baseCSS+'\n'+motionCSS+'\n'+homepageCSS+'\n'+redesignCSS+'\n'+polishCSS+'\n'+colorCSS+'\n'+refinementCSS+'\n'+recruitmentCSS+'\n'+homepageMotionCSS).replace('/* PORTAL_SCRIPT */',()=>js));
const [workbenchHTML,workbenchCSS,workbenchJS,appJS]=await Promise.all([
 readFile(resolve(root,'src/workbench.html'),'utf8'),readFile(resolve(root,'src/workbench.css'),'utf8'),bundle('src/workbench-standalone.js'),bundle('src/app.js')
]);
const workbenchTemplate=renderWorkbench(workbenchHTML,config).replace('/* WORKBENCH_CSS */',()=>workbenchCSS);
await writeFile(resolve(root,'dist/workbench.html'),workbenchTemplate.replace('/* WORKBENCH_SCRIPT */',()=>workbenchJS));
await writeFile(resolve(root,'dist/mcp-app.html'),workbenchTemplate.replace('/* WORKBENCH_SCRIPT */',()=>appJS));
const [adminHTML,adminCSS,adminJS]=await Promise.all([readFile(resolve(root,'src/admin.html'),'utf8'),readFile(resolve(root,'src/admin.css'),'utf8'),bundle('src/admin.js')]);
await writeFile(resolve(root,'dist/admin.html'),adminHTML.replace('/* ADMIN_CSS */',()=>adminCSS).replace('/* ADMIN_SCRIPT */',()=>adminJS));
const [mailHTML,mailCSS,mailJS]=await Promise.all([readFile(resolve(root,'src/mail.html'),'utf8'),readFile(resolve(root,'src/mail.css'),'utf8'),bundle('src/mail.js')]);
await writeFile(resolve(root,'dist/mail.html'),mailHTML.replace('/* MAIL_CSS */',()=>mailCSS).replace('/* MAIL_SCRIPT */',()=>mailJS));
await rm(resolve(root,'dist/assets'),{recursive:true,force:true});
await cp(resolve(root,'src/assets'),resolve(root,'dist/assets'),{recursive:true});
console.log('110lab built: static homepage + workbench + MCP App');
