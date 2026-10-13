import {openSync,fstatSync,readFileSync,closeSync,constants} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {ENDPOINT,loadCredentials} from './requirements-client.mjs';
export function loadUnifiedRequirementCredentials(){const path=join(homedir(),'.config','110lab-requirements','identity.json');let fd;try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(e){if(e.code==='ENOENT')return loadCredentials();throw new Error('需求统一连接不可用');}try{const s=fstatSync(fd);if(!s.isFile()||s.size>32768||s.mode&0o077||process.getuid&&s.uid!==process.getuid())throw new Error();const v=JSON.parse(readFileSync(fd,'utf8'));if(v.version!==2||v.endpoint!==ENDPOINT||!/^[\w-]{43}$/.test(v.identityToken||'')||!v.personalToken?.startsWith('rmcp_v1.')||!v.openApiKey||Date.parse(v.expiresAt)<=Date.now()||!Number.isFinite(Date.parse(v.expiresAt)))throw new Error();return v;}catch{throw new Error('请重新连接需求统一身份');}finally{closeSync(fd);}}
