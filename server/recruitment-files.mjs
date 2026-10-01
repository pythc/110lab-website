import Busboy from 'busboy';
import yauzl from 'yauzl';
import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {createWriteStream,readFileSync,unlinkSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {join,extname} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {crc32} from 'node:zlib';
import {z} from 'zod';
import {RecruitmentError,MAX_FILE_BYTES,GROUPS} from './recruitment-store.mjs';

const fail=(code,message,status=400)=>new RecruitmentError(status,code,message);
const fieldsSchema=z.object({
  name:z.string().trim().min(1).max(60).regex(/^[\p{L}\p{N} ·-]+$/u),
  group:z.enum(GROUPS),email:z.email().max(254).transform(v=>v.toLowerCase()),
  consent:z.literal('true'),website:z.literal(''),
}).strict();
const types={pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
export const resumeTypes=types;
function boundedXml(xml){
  let count=0,depth=0;
  for(const tag of xml.matchAll(/<\/?[A-Za-z_][\w:.-]*\b[^>]*>/g)){
    if(++count>50000)return false;
    if(tag[0].startsWith('</'))depth--;else if(!tag[0].endsWith('/>'))depth++;
    if(depth>128||depth<0)return false;
  }
  return depth===0&&!/<!DOCTYPE|<!ENTITY/i.test(xml)&&XMLValidator.validate(xml)===true;
}

async function validateDocx(buffer){
  const archive=await new Promise((resolve,reject)=>yauzl.fromBuffer(buffer,{lazyEntries:true,validateEntrySizes:true,strictFileNames:true},(error,zip)=>error?reject(error):resolve(zip)));
  return new Promise((resolve,reject)=>{
    const names=new Set(),xmlParts={};let entries=0,total=0,done=false;
    const finish=error=>{if(done)return;done=true;archive.close();error?reject(error):resolve();};
    archive.on('error',finish);
    archive.on('entry',entry=>{
      if(done)return;
      const name=entry.fileName;
      if(++entries>3000||(total+=entry.uncompressedSize)>32*1024*1024||entry.uncompressedSize>32*1024*1024||entry.generalPurposeBitFlag&1||names.has(name)||name.includes('\\')||name.split('/').some(x=>x==='..')||/^(\/|[a-z]:)/i.test(name)||/vbaProject|(^|\/)embeddings\//i.test(name))return finish(fail('INVALID_DOCX','请上传不含宏或嵌入文件的有效 DOCX 简历'));
      names.add(name);
      if(!['word/document.xml','_rels/.rels','[Content_Types].xml'].includes(name)){archive.readEntry();return;}
      const limit=name==='word/document.xml'?1024*1024:128*1024;
      if(entry.uncompressedSize>limit)return finish(fail('INVALID_DOCX','DOCX 格式无效'));
      archive.openReadStream(entry,(error,stream)=>{
        if(error)return finish(error);
        const chunks=[];let bytes=0;
        stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>limit){stream.destroy();finish(fail('INVALID_DOCX','DOCX 格式无效'));}else chunks.push(chunk);});
        stream.on('error',finish);
        stream.on('end',()=>{if(done)return;const content=Buffer.concat(chunks);if(crc32(content)!==entry.crc32)return finish(fail('INVALID_DOCX','DOCX 文件内容损坏 请重新导出简历'));xmlParts[name]=content.toString('utf8');archive.readEntry();});
      });
    });
    archive.on('end',()=>{
      try{
        const contentTypes=xmlParts['[Content_Types].xml'];
        if(Object.keys(xmlParts).length!==3||Object.values(xmlParts).some(xml=>!xml||!boundedXml(xml))||!xmlParts['word/document.xml'].includes('http://schemas.openxmlformats.org/wordprocessingml/2006/main'))throw fail('INVALID_DOCX','DOCX 格式或文档复杂度超出限制 请重新导出或使用 PDF 简历');
        const parsed=new XMLParser({ignoreAttributes:false,processEntities:false}).parse(contentTypes);
        const overrides=[parsed.Types?.Override].flat().filter(Boolean);
        if(overrides.some(v=>/macroEnabled|vbaProject/i.test(v['@_ContentType']||''))||!overrides.some(v=>v['@_PartName']==='/word/document.xml'&&v['@_ContentType']==='application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'))throw fail('INVALID_DOCX','请上传有效的 DOCX 简历');
        finish();
      }catch(error){finish(error);}
    });
    archive.readEntry();
  });
}

export async function validateResume(buffer,filename,mime){
  if(!buffer.length||buffer.length>MAX_FILE_BYTES)throw fail('FILE_SIZE','简历大小须大于 0 且不超过 10MB',413);
  const extension=extname(filename||'').slice(1).toLowerCase();
  if(!types[extension]||![types[extension],'application/octet-stream'].includes(mime))throw fail('FILE_TYPE','请上传一份 PDF 或 DOCX 简历',415);
  if(extension==='pdf'){
    if(!/^%PDF-(1\.[0-7]|2\.0)[\r\n]/.test(buffer.subarray(0,16).toString('latin1'))||!buffer.subarray(-2048).includes(Buffer.from('%%EOF')))throw fail('INVALID_PDF','请上传有效的 PDF 简历');
  }else{
    try{await validateDocx(buffer);}catch(error){if(error instanceof RecruitmentError)throw error;throw fail('INVALID_DOCX','请上传有效的 DOCX 简历');}
  }
  return {extension,bytes:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex')};
}

export async function readApplication(req,root,{timeoutMs=180000}={}){
  const path=join(root,'tmp',randomUUID()+'.upload'),fields={};
  let parser,fileInfo,fileJob,fileCount=0,failure,total=0,timer;
  const remove=()=>{try{unlinkSync(path);}catch(error){if(error.code!=='ENOENT')throw error;}};
  try{
    if(Number(req.headers['content-length']||0)>MAX_FILE_BYTES+64*1024)throw fail('FILE_SIZE','请求过大 简历上限为 10MB',413);
    try{parser=Busboy({headers:req.headers,limits:{files:1,fields:5,parts:7,fileSize:MAX_FILE_BYTES+1,fieldSize:1024,headerPairs:100}});}catch{throw fail('INVALID_FORM','请使用站内表单提交简历',415);}
    await new Promise((resolve,reject)=>{
      const stop=error=>{if(failure)return;failure=error;req.unpipe(parser);parser.destroy();req.resume();reject(error);};
      const onData=chunk=>{total+=chunk.length;if(total>MAX_FILE_BYTES+64*1024)stop(fail('FILE_SIZE','请求过大 简历上限为 10MB',413));};
      const onAbort=()=>stop(fail('UPLOAD_INTERRUPTED','上传中断 请重试'));
      const clean=()=>{clearTimeout(timer);req.off('data',onData);req.off('aborted',onAbort);req.off('error',onAbort);};
      timer=setTimeout(()=>stop(fail('UPLOAD_TIMEOUT','上传超时 请重新提交',408)),timeoutMs);timer.unref();
      req.on('data',onData);req.once('aborted',onAbort);req.once('error',onAbort);
      parser.on('field',(name,value,info)=>{
        if(failure)return;
        const key=name==='applicantName'?'name':name;
        if(!['name','applicantName','group','email','consent','website'].includes(name)||Object.hasOwn(fields,key)||info.valueTruncated||info.nameTruncated)return stop(fail('INVALID_FORM','表单资料不完整或格式无效'));
        fields[key]=value;
      });
      parser.on('file',(name,file,info)=>{
        if(failure){file.resume();file.destroy();return;}
        if(name!=='resume'||++fileCount!==1){file.resume();stop(fail('FILE_COUNT','请上传一份简历'));return;}
        fileInfo=info;
        file.once('limit',()=>stop(fail('FILE_SIZE','简历不能超过 10MB',413)));
        fileJob=pipeline(file,createWriteStream(path,{flags:'wx',mode:0o600}));
        fileJob.catch(error=>stop(fail('UPLOAD_FAILED','暂时无法接收文件 请稍后重试',503)));
      });
      for(const event of ['filesLimit','fieldsLimit','partsLimit'])parser.on(event,()=>stop(fail('INVALID_FORM','请完整填写资料并上传一份简历')));
      parser.once('error',()=>stop(fail('INVALID_FORM','上传格式无效 请重试')));
      parser.once('close',async()=>{clean();if(failure)return;try{await fileJob;if(!fileInfo)throw fail('FILE_REQUIRED','请上传一份 PDF 或 DOCX 简历');resolve();}catch(error){reject(error);}});
      req.pipe(parser);
    });
    const parsed=fieldsSchema.safeParse(fields);
    if(!parsed.success)throw fail('INVALID_FIELDS','请填写姓名、应聘组别、有效联系邮箱并同意资料用途说明');
    const metadata=await validateResume(readFileSync(path),fileInfo.filename,fileInfo.mimeType);
    return {path,fields:parsed.data,...metadata};
  }catch(error){if(fileJob)await fileJob.catch(()=>{});remove();throw error;}
  finally{clearTimeout(timer);}
}
