import {readFileSync,lstatSync} from 'node:fs';
import {createHash,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {RecruitmentTestError} from './recruitment-test-store.mjs';
import {assessmentOfferAccountSchema,assessmentUserIdSchema} from './recruitment-offers.mjs';

const configSchema=z.object({token:z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),assessmentBaseUrl:z.literal('https://exam.110-lab.cn')}).strict();
export const offerAccountQuerySchema=z.object({query:z.string().trim().min(2).max(100)}).strict();
const digest=s=>createHash('sha256').update(s).digest();
const unavailable=()=>new RecruitmentTestError(503,'考核账号服务暂时不可用 请稍后重试');

export function createOfferIntegration({configPath=process.env.PORTAL_OFFER_INTEGRATION_CONFIG,config,fetchImpl=fetch}={}){
  if(!config&&configPath){
    const stat=lstatSync(configPath);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384||(stat.mode&0o077))throw new Error('Unsafe offer integration config');
    config=JSON.parse(readFileSync(configPath,'utf8'));
  }
  const settings=config?configSchema.parse(config):null;
  async function request(path,input,schema){
    if(!settings)throw unavailable();
    try{
      const response=await fetchImpl(settings.assessmentBaseUrl+path,{method:input?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(4000),headers:{Authorization:'Bearer '+settings.token,Accept:'application/json',...(input?{'Content-Type':'application/json'}:{})},body:input?JSON.stringify(input):undefined});
      if(!response.ok){await response.body?.cancel();if(response.status===404)throw new RecruitmentTestError(404,'考核账号不存在或已停用');throw unavailable();}
      const parts=[];let size=0;
      for await(const chunk of response.body){size+=chunk.length;if(size>65536)throw unavailable();parts.push(Buffer.from(chunk));}
      return schema.parse(JSON.parse(Buffer.concat(parts).toString('utf8')));
    }catch(error){if(error instanceof RecruitmentTestError)throw error;throw unavailable();}
  }
  return {
    configured:!!settings,
    authenticate(req){
      if(!settings)throw new RecruitmentTestError(503,'Offer 校验尚未配置');
      // A candidate browser never supplies the identity used for authorization.
      if(req.headers.origin||req.headers['sec-fetch-site']||!timingSafeEqual(digest(String(req.headers.authorization||'')),digest('Bearer '+settings.token)))throw new RecruitmentTestError(401,'服务身份校验失败');
    },
    async search(raw){const input=offerAccountQuerySchema.parse(raw);const result=await request('/api/internal/offer-users/search',input,z.object({users:z.array(assessmentOfferAccountSchema).max(20)}).strict());return {items:result.users,hasMore:result.users.length===20};},
    async get(userId){const id=assessmentUserIdSchema.parse(userId);const result=await request('/api/internal/offer-users/'+encodeURIComponent(id),null,z.object({user:assessmentOfferAccountSchema}).strict());if(result.user.id!==id)throw unavailable();return result.user;},
  };
}
