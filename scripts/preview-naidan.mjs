// Local-only deterministic review. This entry is not part of the release.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {serveAsset} from '../server/assets.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const {outputFiles}=await build({
  entryPoints:[root+'src/standalone.js'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',
  plugins:[{name:'local-naidan-preview',setup(builder){
    builder.onLoad({filter:/[/\\]standalone\.js$/},async({path})=>({
      contents:(await readFile(path,'utf8')).replace('initNaidan();',
        "try{sessionStorage.removeItem('110lab:naidan-visit:v1');}catch{}initNaidan({random:()=>0});"),
      loader:'js',resolveDir:root+'src'
    }));
  }}]
});
const script=outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
const page=(await readFile(root+'dist/index.html','utf8')).replace(/<script type="module">[\s\S]*?<\/script>/,()=>'<script type="module">'+script+'</script>');
const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(!['localhost','127.0.0.1'].includes((req.headers.host||'').replace(/:\d+$/,''))){res.writeHead(421);res.end();return;}
  if(!['GET','HEAD'].includes(req.method)){req.resume();res.writeHead(405);res.end();return;}
  const path=new URL(req.url,'http://localhost').pathname;
  try{
    if(path==='/'){
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(req.method==='HEAD'?undefined:page);return;
    }
    if(path.startsWith('/assets/')&&await serveAsset(req,res,path.slice(8)))return;
    // This review server never accepts recruitment data or exposes a workbench.
    res.writeHead(404);res.end();
  }catch{if(!res.headersSent)res.writeHead(500);res.end();}
});
server.listen(4178,'127.0.0.1',()=>console.log('Naidan local review: http://127.0.0.1:4178/#about\nKeep the bottom edge of the introduction visible for 8 seconds. Reload to try again.'));
