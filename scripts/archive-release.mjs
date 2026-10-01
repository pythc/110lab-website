import {readFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const release=JSON.parse(await readFile('release.json','utf8'));
if(release.sourceDirty!==false)throw new Error('Commit and review the candidate before creating a deployable release archive');
for(const [path,meta] of Object.entries(release.files)){
 if(!/^[a-zA-Z0-9_./-]+$/.test(path)||path.split('/').includes('..'))throw new Error('Unsafe release path');
 const data=await readFile(path);if(createHash('sha256').update(data).digest('hex')!==meta.sha256)throw new Error('File changed after release: '+path);
}
if(!/^[a-zA-Z0-9-]+$/.test(release.releaseId))throw new Error('Invalid release id');
await mkdir('artifacts/deployment',{recursive:true});
const archive=`artifacts/deployment/110lab-${release.releaseId}.tar.gz`;
const result=spawnSync('tar',['-czf',archive,...Object.keys(release.files),'release.json'],{stdio:'inherit'});
if(result.status!==0)throw new Error('Archive failed');console.log(archive);
