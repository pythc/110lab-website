import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,lstatSync,renameSync,openSync,fstatSync,closeSync,constants,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {RESOURCE} from './portal-constants.mjs';
const file=join(homedir(),'.config','110lab-business','oauth.json');
export function credentialFile(path=file){
  const ensureDirectory=()=>{mkdirSync(dirname(path),{recursive:true,mode:0o700});const st=lstatSync(dirname(path));if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)||process.getuid&&st.uid!==process.getuid())throw new Error('Unsafe credential directory');};
  function load(){let fd;try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(e){if(e.code==='ENOENT')return {};throw e;}
    try{const st=fstatSync(fd);if(!st.isFile()||(st.mode&0o077)||st.size>32768||process.getuid&&st.uid!==process.getuid())throw new Error('Unsafe credential file');const data=JSON.parse(readFileSync(fd,'utf8'));if(data.resource!==RESOURCE)throw new Error('Wrong credential resource');return data;}finally{closeSync(fd);}}
  return {load,save(value){ensureDirectory();load();const tmp=path+'.'+randomBytes(8).toString('hex');writeFileSync(tmp,JSON.stringify({...value,resource:RESOURCE}),{mode:0o600,flag:'wx'});renameSync(tmp,path);},
    acquire(){ensureDirectory();const lock=path+'.lock';
      for(let attempt=0;attempt<2;attempt++){
        try{mkdirSync(lock,{mode:0o700});writeFileSync(join(lock,'pid'),String(process.pid),{mode:0o600,flag:'wx'});return ()=>rmSync(lock,{recursive:true,force:true});}
        catch(e){if(e.code!=='EEXIST')throw e;let pid;try{pid=Number(readFileSync(join(lock,'pid'),'utf8'));}catch{}let live=true;if(Number.isSafeInteger(pid)&&pid>0)try{process.kill(pid,0);}catch(err){if(err.code==='ESRCH')live=false;}else if(Date.now()-lstatSync(lock).mtimeMs>600000)live=false;
          if(live)throw Object.assign(new Error('另一个会话正在完成 110lab 授权或业务请求 请完成后重试'),{safe:true});rmSync(lock,{recursive:true,force:true});}
      }throw new Error('Credential lock unavailable');
    }};
}
