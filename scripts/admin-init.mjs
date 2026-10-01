import {randomBytes} from 'node:crypto';
import {lstatSync,writeFileSync,unlinkSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createAdminConfig} from '../server/admin-auth.mjs';
// Run once in an existing private directory. Credentials never go to stdout.
const [configArg,credentialsArg,username='admin']=process.argv.slice(2);
if(!configArg||!credentialsArg)throw new Error('Usage: admin-init CONFIG_PATH CREDENTIALS_PATH [USERNAME]');
const configPath=resolve(configArg),credentialsPath=resolve(credentialsArg);
if(configPath===credentialsPath)throw new Error('Use separate output files');
for(const path of [configPath,credentialsPath]){
 const parent=lstatSync(dirname(path));
 if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o077))throw new Error('Use a private directory');
 try{lstatSync(path);throw new Error('Output already exists');}catch(e){if(e.code!=='ENOENT')throw e;}
}
const password=randomBytes(24).toString('base64url'),config=await createAdminConfig(username,password);
writeFileSync(credentialsPath,`110lab 动态管理\n地址：https://internal.110-lab.cn/admin\n账号：${username}\n密码：${password}\n`,{flag:'wx',mode:0o600});
try{writeFileSync(configPath,JSON.stringify(config)+'\n',{flag:'wx',mode:0o600});}catch(e){unlinkSync(credentialsPath);throw e;}
console.log('Created private admin configuration and account file');
