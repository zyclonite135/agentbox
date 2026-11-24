#!/usr/bin/env node
// Chat Markdown and fenced code rendering with the bundled KaTeX and Prism; static files only.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchBrowser} from './playwright-launch.mjs';

const root=resolve(fileURLToPath(new URL('../internal/web/static/',import.meta.url)));
const server=createServer(async(req,res)=>{
 try{
  const rel=new URL(req.url,'http://fixture').pathname.replace(/^\/_v\/[^/]+/,'');
  const file=resolve(root,'.'+(rel==='/'?'/index.html':rel));if(!file.startsWith(root+sep)){res.writeHead(403).end();return;}
  let data=await readFile(file);
  // chat-render.js needs the page's dialogs and KaTeX, not the app: drop main.js so nothing calls the API.
  if(rel==='/')data=data.toString().replace(/<script type="module" src="[^"]*\/js\/main.js"><\/script>/,'');
  res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream');res.end(data);
 }catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await launchBrowser();
try{
 const page=await browser.newPage();page.setDefaultTimeout(15000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.waitForFunction(()=>!!window.katex);
 // Renders md and describes each block: lists by item, everything else by class and text.
 const render=md=>page.evaluate(async md=>{
  const {formatText}=await import('/js/chat-render.js');
  const box=document.createElement('div');box.appendChild(formatText(md));document.body.appendChild(box);
  const rawText=el=>[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('');
  const out=[...box.children].map(el=>el.matches('ul,ol')?{list:el.tagName.toLowerCase(),items:[...el.children].map(li=>({
   display:[...li.querySelectorAll(':scope > .math-display')].map(m=>({katex:!!m.querySelector('.katex-display'),error:!!m.querySelector('.katex-error'),tex:m.querySelector('annotation')?.textContent||''})),
   inline:li.querySelectorAll('.math-inline .katex').length,raw:rawText(li),
  }))}:{cls:el.className,katex:!!el.querySelector('.katex-display'),text:el.textContent});
  box.remove();return out;
 },md);

 // The reply that showed raw LaTeX: an indented $$ … $$ block continuing a bullet.
 let r=await render(String.raw`**常见变形**

- **权方和形式**（分式形式）：当 $b_i > 0$ 时，
  $$
  \frac{a_1^2}{b_1} + \cdots + \frac{a_n^2}{b_n} \ge \frac{(a_1+\cdots+a_n)^2}{b_1+\cdots+b_n}
  $$
- **积分形式**：$\left(\int_a^b f g\,dx\right)^2 \le \int_a^b f^2\,dx \cdot \int_a^b g^2\,dx$
- **一般内积空间**：$|\langle u,v\rangle|^2 \le \langle u,u\rangle\,\langle v,v\rangle$

结尾段落。`);
 assert.equal(r.length,3,JSON.stringify(r));
 assert.equal(r[1].list,'ul');
 assert.equal(r[1].items.length,3,'the display block must not split the list');
 const [first,second,third]=r[1].items;
 assert.equal(first.display.length,1);
 assert.deepEqual({katex:first.display[0].katex,error:first.display[0].error},{katex:true,error:false});
 assert.match(first.display[0].tex,/^\\frac\{a_1\^2\}\{b_1\}.*\\ge \\frac/);
 assert.equal(first.inline,1);
 assert.doesNotMatch(first.raw,/\$|\\frac/,'no delimiter or LaTeX may leak as text');
 for(const item of [second,third]){assert.equal(item.display.length,0);assert.equal(item.inline,1);assert.doesNotMatch(item.raw,/\$/);}
 assert.deepEqual(r[2],{cls:'md-p',katex:false,text:'结尾段落。'});

 // \[ … \] across lines, one-line $$ … $$, an ordered list, and a deeper indent all stay inside their item.
 r=await render(String.raw`1. 向量形式：
   \[
   |\vec a\cdot\vec b| \le |\vec a|\,|\vec b|
   \]
2. 单行：
    $$ x^2 + y^2 = z^2 $$
3. 收尾`);
 assert.equal(r.length,1,JSON.stringify(r));
 assert.equal(r[0].list,'ol');
 assert.deepEqual(r[0].items.map(i=>i.display.length),[1,1,0]);
 assert.ok(r[0].items.slice(0,2).every(i=>i.display[0].katex&&!i.display[0].error));
 assert.match(r[0].items[0].display[0].tex,/\\vec a\\cdot\\vec b/);
 assert.equal(r[0].items[1].display[0].tex,'x^2 + y^2 = z^2');
 assert.doesNotMatch(r[0].items.map(i=>i.raw).join(''),/\$|\\\[|\\\]/);

 // Ordinary continuation lines and dollar amounts are untouched; an unclosed $$ stays text and keeps the list going.
 r=await render(String.raw`- 普通续行
  第二行文字 $a+b$
- 价格 $5 和 $10 不是公式
- 没闭合：
  $$
  x + 1
- 下一项`);
 assert.equal(r.length,1,JSON.stringify(r));
 const items=r[0].items;
 assert.equal(items.length,4);
 assert.deepEqual(items.map(i=>i.display.length),[0,0,0,0]);
 assert.equal(items[0].inline,1);
 assert.equal(items[0].raw,'普通续行\n第二行文字 ');
 assert.deepEqual({inline:items[1].inline,raw:items[1].raw},{inline:0,raw:'价格 $5 和 $10 不是公式'});
 assert.equal(items[2].raw,'没闭合：\n$$\nx + 1');
 assert.equal(items[3].raw,'下一项');

 // Top-level display math keeps rendering as its own block.
 r=await render('前文\n\n$$\n\\sum_{i=1}^n a_i b_i\n$$\n\n后文');
 assert.deepEqual(r.map(b=>b.cls),['md-p','math-display','md-p']);
 assert.equal(r[1].katex,true);

 const code = 'const html = "<b>& x\u00a0y</b>";\n  console.log(html);';
 const ticks = '\x60'.repeat(3);
 const examples = [
  {lang:'JS', info:'JS title="example.js"', source:code, token:'keyword'},
  {lang:'python', source:'def double(x):\n    return x * 2', token:'keyword'},
  {lang:'python', eol:'\r\n', source:'def double(x):\r\n    return x * 2', token:'keyword'},
  {lang:'html', source:'<p title="a & b">Example</p>', token:'tag'},
  {lang:'c++', source:'int main() { return 0; }', token:'keyword'},
  {lang:'C#', source:'class Example {}'},
  {lang:'js', source:'const marker = "'+ticks+'";', token:'keyword'},
  {lang:'text', delimiter:ticks+'\x60', source:[ticks+'js',code,ticks].join('\n')},
  {lang:'js', delimiter:'~~~', source:code, token:'keyword'},
  {lang:'', source:code},
  {lang:'unrecognized-language', source:code},
  {lang:'extend', source:code},
  {lang:'js', source:'x'.repeat(100_001)},
 ];
 const highlights = await page.evaluate(async examples=>{
  const {renderAnswerContents,renderEvent}=await import('/js/chat-render.js');
  const {createChatStream}=await import('/js/features/chat/stream.js');
  const fence=(info,source,delimiter='\x60\x60\x60',eol='\n')=>[delimiter+info,source,delimiter].join(eol);
  const results=examples.map(({lang,info=lang,source,token,delimiter,eol},i)=>{
   const reply=document.createElement('div');
   renderAnswerContents(reply,fence(info,source,delimiter,eol));
   document.body.append(reply);
   const block=reply.querySelector('code');
   const colored=token&&block.querySelector('.token.'+token);
   const result={
    exact:block.textContent===source,
    tokens:!!block.querySelector('.token'),
    colored:!!colored&&getComputedStyle(colored).color!==getComputedStyle(block).color,
    literal:!block.querySelector('b,p'),
    label:reply.querySelector('.cb-lang').textContent,
    blocks:reply.querySelectorAll('.codeblock').length,
   };
   if(i===0)reply.id='highlight-copy-fixture'; else reply.remove();
   return result;
  });
  const live=document.createElement('div');
  const stream=createChatStream({
   append:node=>live.append(node), working:()=>{}, state:()=>'running',
   footer:()=>null, log:()=>live, nearBottom:()=>false,
  });
  const send=event=>stream.event({type:'stream_event',event});
  send({type:'content_block_start',content_block:{type:'text'}});
  send({type:'content_block_delta',delta:{type:'text_delta',text:fence('js',examples[0].source).slice(0,-4)}});
  send({type:'content_block_stop'});
  const streaming=!!live.querySelector('.token');
  stream.settle();
  const stopped=!!live.querySelector('.token.keyword');
  const [tool]=renderEvent({type:'item.completed',item:{
   type:'command_execution',id:'plain-output',command:'fixture',aggregated_output:examples[0].source,status:'completed',
  }});
  const output=tool.querySelector('.tc-out');
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedCode=text;}}});
  return {results,streaming,stopped,outputTokens:!!output.querySelector('.token'),outputText:output.textContent};
 },examples);
 assert.deepEqual(highlights.results,examples.map(({token,lang})=>({
  exact:true,tokens:!!token,colored:!!token,literal:true,label:lang||'code',blocks:1,
 })));
 assert.equal(highlights.streaming,false,'streaming updates stay plain until they settle');
 assert.equal(highlights.stopped,true,'stopping preserves and highlights the code already rendered');
 assert.equal(highlights.outputTokens,false,'command output stays plain');
 assert.equal(highlights.outputText,code);
 await page.locator('#highlight-copy-fixture .cb-copy').click();
 assert.equal(await page.evaluate(()=>window.copiedCode),code,'copy writes the original source');

 assert.deepEqual(errors,[]);
 console.log('Chat Markdown: display math inside list items ($$ and \\[ across lines, one-line $$, ordered/deeper indent), unclosed $$ fallback, plain continuations, dollar amounts and top-level blocks passed');
 console.log('Chat code: language tokens and theme colors, safe literal markup, unsupported and large fallbacks, streaming settlement, exact copy and plain command output passed');
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
