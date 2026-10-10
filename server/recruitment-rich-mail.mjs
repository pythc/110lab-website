import sanitizeHtml from 'sanitize-html';
import {createHash} from 'node:crypto';

export const escapeHtml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function cleanMailHtml(value){
  return sanitizeHtml(String(value||''),{
    allowedTags:['p','br','div','span','strong','b','em','i','u','s','h1','h2','h3','ul','ol','li','blockquote','a','img','table','tbody','tr','td','th','hr'],
    allowedAttributes:{a:['href','title'],img:['src','alt','width','height'], '*':['style']},
    transformTags:{img:(_tag,attrs)=>{const {height,...safe}=attrs;return {tagName:'img',attribs:{...safe,width:String(Math.min(600,Math.max(1,Number.parseInt(attrs.width,10)||480))),style:'max-width:100%;height:auto'}};}},
    allowedSchemes:['https','mailto'],allowedSchemesByTag:{img:['cid']},allowProtocolRelative:false,
    allowedStyles:{img:{'max-width':[/^100%$/],height:[/^auto$/]},'*':{'text-align':[/^(left|center|right)$/],'color':[/^#[0-9a-f]{3,8}$/i],'background-color':[/^#[0-9a-f]{3,8}$/i],'font-size':[/^(1[0-9]|2[0-9]|3[0-6])px$/],'font-weight':[/^(normal|bold|[1-9]00)$/]}},
    exclusiveFilter:frame=>frame.tag==='img'&&!/^cid:lab-[a-f0-9]{64}$/.test(frame.attribs.src||''),
  });
}
export function imageIds(html){return [...new Set([...cleanMailHtml(html).matchAll(/src="cid:lab-([a-f0-9]{64})"/g)].map(m=>m[1]))];}
export function validateMailImage(buffer){
  if(!Buffer.isBuffer(buffer)||buffer.length<12||buffer.length>2*1024*1024)throw new Error('图片需小于 2 MB');
  let mime,extension;
  if(buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){mime='image/png';extension='png';}
  else if(buffer[0]===255&&buffer[1]===216&&buffer[2]===255){mime='image/jpeg';extension='jpg';}
  else if(/^GIF8[79]a$/.test(buffer.subarray(0,6).toString())){mime='image/gif';extension='gif';}
  else if(buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP'){mime='image/webp';extension='webp';}
  else throw new Error('仅支持 PNG JPEG GIF WebP 图片');
  return {id:createHash('sha256').update(buffer).digest('hex'),mime,extension,bytes:buffer.length};
}
