// Browser regression for caret placement, formatting and saved email HTML. No external delivery.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {cleanMailHtml} from '../server/recruitment-rich-mail.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const png=await readFile(new URL('../src/assets/110lab-icon.png',import.meta.url)),id=createHash('sha256').update(png).digest('hex');
const server=createServer(async(req,res)=>{
 if(req.url==='/editor.js'){res.setHeader('Content-Type','text/javascript');res.end(await readFile(new URL('../src/recruitment-mail-editor.js',import.meta.url)));return;}
 if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end((await readFile(new URL('../src/recruitment-test.css',import.meta.url),'utf8'))+(await readFile(new URL('../src/recruitment-mail-editor.css',import.meta.url),'utf8')));return;}
 if(req.url==='/image'){res.setHeader('Content-Type','image/png');res.end(png);return;}
 res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><style>body{margin:0;padding:24px;background:#f5f7fb}main{max-width:720px;margin:auto;display:grid;gap:12px}#host{display:grid;gap:12px}#outside{padding:10px}</style><main><h2>招新邮件模板</h2><input id="outside" placeholder="主题"><div id="host"></div><div id="preview"></div></main><script type="module">
 import {mailEditor,mailPreview} from '/editor.js';
 window.errors=[];window.requests=0;
 const session={request:async()=>{window.requests++;return await new Promise(r=>window.finishUpload=()=>r({id:'${id}'}));},download:async()=>await (await fetch('/image')).blob()};
 window.loadEditor=html=>{window.editor?.destroy();document.querySelector('#host').replaceChildren();window.editor=mailEditor(session,{html,body:'测试正文'},document.querySelector('#host'),e=>window.errors.push(e));};
 window.previewMail=async payload=>{document.querySelector('#preview').replaceChildren();await mailPreview(session,payload,document.querySelector('#preview'));};
 loadEditor('<p>开头 {{name}}</p><p>正文 ABCD</p><p>结尾</p>');
 </script>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});const page=await browser.newPage({viewport:{width:960,height:1000}});const failures=[];page.on('pageerror',e=>failures.push(e.message));
const editor=page.getByRole('textbox',{name:'邮件富文本正文'});
const select=async(paragraph,start,end=start)=>page.evaluate(({paragraph,start,end})=>{const e=document.querySelector('.rt-rich-editor');e.focus();let n=e.querySelectorAll('p')[paragraph].firstChild;while(n.nodeType!==Node.TEXT_NODE)n=n.firstChild;const r=document.createRange();r.setStart(n,start);r.setEnd(n,end);getSelection().removeAllRanges();getSelection().addRange(r);document.dispatchEvent(new Event('selectionchange'));},{paragraph,start,end});
const upload=async()=>{await page.evaluate(()=>window.finishUpload=null);const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'插入图片',exact:true}).click();await(await chooser).setFiles({name:'测试图片.png',mimeType:'image/png',buffer:png});await page.waitForFunction(()=>!!window.finishUpload);};
try{
 await page.goto('http://127.0.0.1:'+server.address().port);await editor.waitFor();
 await select(1,5);await upload();
 assert.equal(await page.evaluate(()=>{try{window.editor.value();return false;}catch{return true;}}),true,'Cannot save before upload completes');
 await page.locator('#outside').fill('失焦后仍保留插入点');await page.evaluate(()=>window.finishUpload());await editor.locator('img').waitFor();
 const html=await editor.innerHTML();assert.ok(html.indexOf('AB')<html.indexOf('<img')&&html.indexOf('<img')<html.indexOf('CD'),'Image must split text at selected caret');
 await editor.locator('img').click();await page.getByRole('button',{name:'居中',exact:true}).click();
 const centered=await editor.locator('img').evaluate(img=>({align:getComputedStyle(img.parentElement).textAlign,text:img.parentElement.textContent}));assert.equal(centered.align,'center');assert.equal(centered.text.trim(),'','Image alignment must not center surrounding text');
 const imageHtml=await editor.innerHTML();assert.ok(imageHtml.includes('text-align: center'));
 await select(0,0,2);await page.getByRole('button',{name:'右对齐',exact:true}).click();
 const payload=await page.evaluate(()=>window.editor.value());const safe=cleanMailHtml(payload.html);assert.match(safe,/text-align:right/);assert.match(safe,/text-align:center/);assert.ok(safe.includes('cid:lab-'+id));assert.ok(!safe.includes('data:image'));assert.ok(!safe.includes('data-mail-image'));
 await page.evaluate(html=>window.loadEditor(html),safe);await page.waitForFunction(()=>document.querySelector('.rt-rich-editor img')?.src.startsWith('data:'));
 assert.equal(await editor.locator('img').evaluate(img=>getComputedStyle(img.parentElement).textAlign),'center');
 await page.evaluate(payload=>window.previewMail(payload),{...payload,html:safe});
 const preview=page.frameLocator('iframe[title="完整邮件预览"]');await preview.locator('img').waitFor();assert.equal(await preview.locator('img').evaluate(img=>getComputedStyle(img.parentElement).textAlign),'center');
 await page.screenshot({path:'artifacts/mail-editor/desktop.png',fullPage:true});
 // Alignment must not change how subsequent inline styles are serialized.
 await select(0,0,2);await page.getByRole('button',{name:'下划线',exact:true}).click();assert.ok(cleanMailHtml(await editor.innerHTML()).includes('<u>'));
 // Keyboard formatting must restore the prior body selection, not alter the subject.
 await select(0,0,2);await page.getByRole('button',{name:'左对齐',exact:true}).focus();await page.keyboard.press('Enter');assert.equal(await editor.locator('p').first().evaluate(p=>getComputedStyle(p).textAlign),'left');
 // Switching templates during upload must not insert into the replacement editor.
 await page.evaluate(()=>window.loadEditor('<p>新模板</p>'));await select(0,1);await upload();await page.evaluate(()=>{window.loadEditor('<p>另一个模板</p>');window.finishUpload();});await page.waitForTimeout(80);assert.equal(await editor.innerText(),'另一个模板');assert.equal(await editor.locator('img').count(),0);
 // An image can be placed before the first character and participates in native undo/redo.
 await select(0,0);await upload();await page.evaluate(()=>window.finishUpload());await editor.locator('img').waitFor();assert.ok((await editor.innerHTML()).indexOf('<img')<(await editor.innerHTML()).indexOf('另一个模板'));
 await editor.focus();await page.keyboard.press((process.platform==='darwin'?'Meta':'Control')+'+z');assert.equal(await editor.locator('img').count(),0);await page.keyboard.press((process.platform==='darwin'?'Meta':'Control')+'+Shift+z');assert.equal(await editor.locator('img').count(),1);
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'artifacts/mail-editor/mobile.png',fullPage:true});
 assert.deepEqual(await page.evaluate(()=>window.errors),[]);assert.deepEqual(failures,[]);console.log(JSON.stringify({passed:true,checks:['caret insertion with async upload and focus change','text and image alignment','save and reload','sanitized preview','keyboard toolbar','template switch during upload','first-position insertion','undo and redo','mobile width'],screenshots:['desktop.png','mobile.png']}));
}finally{await browser.close();await new Promise(r=>server.close(r));}
