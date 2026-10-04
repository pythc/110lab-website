import {parentPort,workerData} from 'node:worker_threads';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {WorkerMessageHandler} from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import yauzl from 'yauzl';
import {XMLParser} from 'fast-xml-parser';
import {validateResume} from './recruitment-files.mjs';

// Only bytes from an authorized business object enter this worker. No URLs,
// scripting, rendering, OCR, external relationships or document actions run.
globalThis.fetch=async()=>{throw new Error('Network disabled in attachment reader');};
globalThis.pdfjsWorker={WorkerMessageHandler};
const limit=100000,buffer=Buffer.from(workerData.buffer),mime=workerData.mime;
async function docx(){
  await validateResume(buffer,'attachment.docx',mime);
  const xml=await new Promise((resolve,reject)=>yauzl.fromBuffer(buffer,{lazyEntries:true},(error,zip)=>{
    if(error)return reject(error);zip.on('error',reject);zip.on('end',()=>reject(new Error('Missing document')));
    zip.on('entry',entry=>{if(entry.fileName!=='word/document.xml'){zip.readEntry();return;}zip.openReadStream(entry,(error,stream)=>{if(error){zip.close();reject(error);return;}const parts=[];stream.on('data',b=>parts.push(b));stream.on('error',reject);stream.on('end',()=>{zip.close();resolve(Buffer.concat(parts).toString('utf8'));});});});zip.readEntry();
  }));
  const nodes=new XMLParser({preserveOrder:true,ignoreAttributes:true,processEntities:true,trimValues:false}).parse(xml),paragraphs=[];
  const walk=children=>{for(const node of children||[])for(const [key,values]of Object.entries(node)){
    if(key==='w:p'){let text='';const collect=ns=>{for(const n of ns||[])for(const [k,v]of Object.entries(n)){if(k==='#text')text+=v;else if(k==='w:tab')text+='\t';else if(k==='w:br')text+='\n';else if(Array.isArray(v))collect(v);}};collect(values);paragraphs.push(text);}
    else if(Array.isArray(values))walk(values);
  }};walk(nodes);let used=0;
  return {status:'EXTRACTED',segments:paragraphs.map((text,index)=>({paragraph:index+1,text})).filter(s=>{if(used>=limit)return false;s.text=s.text.slice(0,limit-used);used+=s.text.length;return true;}),truncated:paragraphs.join('').length>limit};
}
async function pdf(){
  const task=getDocument({data:new Uint8Array(buffer),verbosity:0,isEvalSupported:false,useSystemFonts:false,disableFontFace:true,useWorkerFetch:false,useWasm:false,enableXfa:false,stopAtErrors:true,disableAutoFetch:true,disableStream:true,disableRange:true});
  try{const doc=await task.promise,segments=[];let used=0;for(let page=1;page<=Math.min(doc.numPages,50)&&used<limit;page++){
    const p=await doc.getPage(page),content=await p.getTextContent();const text=content.items.filter(i=>typeof i.str==='string').map(i=>i.str+(i.hasEOL?'\n':' ')).join('').slice(0,limit-used);used+=text.length;segments.push({page,text});p.cleanup();
  }return {status:used?'EXTRACTED':'NO_TEXT_LAYER',segments,totalPages:doc.numPages,truncated:doc.numPages>segments.length||used>=limit};}finally{await task.destroy();}
}
try{let result;if(mime==='application/pdf')result=await pdf();else if(mime==='application/vnd.openxmlformats-officedocument.wordprocessingml.document')result=await docx();else if(mime==='text/plain'){const value=new TextDecoder('utf8',{fatal:true}).decode(buffer);result={status:'EXTRACTED',segments:[{text:value.slice(0,limit)}],truncated:value.length>limit};}else result={status:'UNSUPPORTED',reason:'此类型请读取附带的原始文件 图片不自动 OCR'};parentPort.postMessage(result);}catch{parentPort.postMessage({status:'UNREADABLE',reason:'文件无法在限定资源内解析 可能已加密或格式损坏 请查看原始附件'});}
