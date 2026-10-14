import {build} from 'esbuild';
import {cp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PLUGIN_RELEASE} from '../src/plugin-release.js';
const root=fileURLToPath(new URL('../',import.meta.url)),stage=resolve(root,'artifacts/plugin');
await rm(stage,{recursive:true,force:true});await mkdir(stage,{recursive:true});
await cp(resolve(root,'plugin/110lab'),stage,{recursive:true});
for(const n of ['plugin.json','.codex-plugin/plugin.json']){const v=JSON.parse(await readFile(resolve(stage,n),'utf8'));if(v.name!=='110lab'||v.version!==PLUGIN_RELEASE.version)throw new Error('Plugin identity/version mismatch');}
for(const [entry,name] of [['server/local-portal-bridge.mjs','portal'],['server/requirements-identity-bridge.mjs','requirements'],['plugin/110lab/mcp/knowledge-bridge.source.mjs','knowledge']]){
 await build({entryPoints:[resolve(root,entry)],outfile:resolve(stage,'mcp',name+'-bridge.mjs'),bundle:true,format:'esm',platform:'node',target:'node20',minify:true,banner:{js:'import {createRequire as __createRequire} from "node:module";const require=__createRequire(import.meta.url);'}});
}
await cp(resolve(root,'server/requirements-identity-bridge.mjs'),resolve(stage,'mcp/requirements-bridge.source.mjs'));
await cp(resolve(root,'server/requirements-client.mjs'),resolve(stage,'mcp/requirements-client.mjs'));
await mkdir(resolve(root,'dist'),{recursive:true});
const destination=resolve(root,'dist','110lab-plugin-'+PLUGIN_RELEASE.version+'.zip');
// Packaging is local only and uses an explicit source tree, never OAuth caches.
execFileSync('python3',['-c',`import pathlib,zipfile,sys
root=pathlib.Path(sys.argv[1]);out=pathlib.Path(sys.argv[2])
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
 for p in sorted(root.rglob('*')):
  if p.is_symlink():raise RuntimeError('No links in plugin package')
  if p.is_file():
   if p.name.startswith('.env') or p.suffix in ['.sqlite','.db'] or p.name in ['oauth.json','identity.json','credentials.json']:raise RuntimeError('Private file in plugin package')
   z.write(p,p.relative_to(root))
`,stage,destination]);
console.log('110lab plugin '+PLUGIN_RELEASE.version+' packaged');
