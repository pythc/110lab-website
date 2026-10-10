import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openResumePreview} from '../src/resume-preview.js';
class Element{
  constructor(tag){this.tag=tag;this.children=[];this.events={};}
  append(...children){this.children.push(...children);}
  setAttribute(k,v){this[k]=v;}
  addEventListener(k,v){this.events[k]=v;}
  showModal(){this.open=true;}
  close(){this.open=false;}
  remove(){this.removed=true;}
  focus(){this.focused=true;}
}
const env=()=>({document:{body:new Element('body'),createElement:t=>new Element(t)},crypto:{randomUUID}});
const pdf=()=>new Blob(['%PDF-1.4 fixture'],{type:'application/pdf'});
const flush=()=>new Promise(r=>setImmediate(r));
test('preview chooses PDF or DOCX without a navigation or external document URL',async()=>{
 for(const [filename,type,kind]of [['cv.pdf','application/pdf','pdf'],['简历.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document','docx']]){
  const e=env();let rendered=null,closed=0;
  const render=k=>async(blob,target,current)=>{assert.equal(blob.type,type);assert.equal(current(),true);rendered=k;return()=>{closed++;};};
  const v=openResumePreview({filename,load:async()=>new Blob(['fictional'],{type})},e,async()=>({previewPdf:render('pdf'),previewDocx:render('docx')}));await v.ready;
  assert.equal(rendered,kind);const dialog=e.document.body.children[0];assert.equal(dialog.open,true);assert.equal(dialog.children[0].children[0].textContent,filename);
  dialog.children[0].children[1].onclick();assert.equal(dialog.removed,true);assert.equal(closed,1);v.destroy();assert.equal(closed,1);
 }
});
test('closing or losing identity during fetch never renders late candidate data',async()=>{
 for(const close of [true,false]){
  const e=env();let deliver,current=true,rendered=0;const v=openResumePreview({filename:'cv.pdf',load:()=>new Promise(r=>deliver=r),current:()=>current},e,async()=>({previewPdf:async()=>{rendered++;}}));
  if(close)v.destroy();else current=false;deliver(pdf());await v.ready;assert.equal(rendered,0);assert.equal(e.document.body.children[0].removed,true);
 }
});
test('a renderer completing after closure is cleaned exactly once',async()=>{
 const e=env();let finish,cleaned=0;const v=openResumePreview({filename:'cv.pdf',load:async()=>pdf()},e,async()=>({previewPdf:()=>new Promise(r=>finish=r)}));await flush();v.destroy();finish(()=>{cleaned++;});await v.ready;assert.equal(cleaned,1);
});
test('authorization and invalid-file failures have safe visible errors and no renderer call',async()=>{
 for(const load of [async()=>{throw new Error('secret internal details');},async()=>new Blob([],{type:'application/pdf'}),async()=>new Blob(['<script>'],{type:'text/html'})]){
  const e=env();let calls=0;const v=openResumePreview({filename:'cv.pdf',load},e,async()=>({previewPdf:async()=>calls++}));await v.ready;
  const body=e.document.body.children[0].children[1];assert.match(body.textContent,/无法预览/);assert.ok(!body.textContent.includes('secret'));assert.equal(calls,0);v.destroy();
 }
});
