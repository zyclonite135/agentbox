#!/usr/bin/env node
// Locale behavior against synthetic HTTP/WS only; no real users or model calls.
import {recordNavigations,reduceMotion} from './playwright-launch.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function checkSettingsLayout(page,base,language) {
 const sections=['accounts','proxies','container','models','models/pricing','models/system','decision','interface',
  'icons','security','logins','announce','monitor','about'];
 const overflows=[];
 for (const route of sections) {
  await page.goto(base+'/#/settings/'+route);
  const section=page.locator('#sec-'+route.split('/')[0]);
  await section.waitFor({timeout:5000});
  if (route==='models/pricing') {
   await section.locator('#price-rows tr[data-key]').waitFor({timeout:5000});
   const label=section.locator('#price-rows tr[data-key] td').nth(1);
   assert.equal(await label.getAttribute('data-settings-column'),'Ввод');
   await language('en');
   await label.and(page.locator('[data-settings-column="Input"]')).waitFor({state:'attached',timeout:5000});
   await language('ru');
   await section.locator('#price-catalog-box > summary').click();
  }
  if (route==='security') {
   const jump=section.getByRole('button',{name:'Разрешения и сеть',exact:true});
   await jump.click();
   assert.equal(await section.locator('#settings-agent-access > h3').evaluate(el=>el===document.activeElement),true);
   const disclosure=section.locator('.settings-details').first();
   assert.equal(await disclosure.evaluate(el=>el.open),false);
   await disclosure.locator('summary').click();
   assert.equal(await disclosure.evaluate(el=>el.open),true);
   const toggle=section.locator('#set-tunnel-on');
   const previous=await toggle.isChecked();
   await toggle.press('Space');
   assert.equal(await toggle.isChecked(),!previous);
   await toggle.press('Space');
  }
  for (const width of [320,390,768,1024,1440,2560]) {
   await page.setViewportSize({width,height:900});
   const overflow=await section.evaluate(el=>{
    const root=el.closest('#set-content');
    const extra=Math.max(document.documentElement.scrollWidth-innerWidth,root.scrollWidth-root.clientWidth,el.scrollWidth-el.clientWidth);
    if (extra<=1) return null;
    const right=el.getBoundingClientRect().right;
    const elements=[...el.querySelectorAll('*')].filter(child=>child.getBoundingClientRect().right>right+1);
    return [extra,...elements.slice(0,6).map(child=>child.id || child.getAttribute('class') || child.tagName)].join(' ');
   });
   if (overflow) overflows.push(`${route} at ${width}px: ${overflow}`);
  }
  if (route==='security') {
   await page.setViewportSize({width:320,height:900});
   await page.locator('#mobile-section-btn').click();
   assert.equal(await page.locator('#mobile-section-menu .section-menu-heading').count(),3);
   const option=page.getByRole('menuitemradio',{name:'Безопасность',exact:true});
   const area=await option.boundingBox();
   assert.ok(area.width>=44 && area.height>=44);
   await page.keyboard.press('Escape');
  }
 }
 assert.deepEqual(overflows,[],'Settings must fit without horizontal scrolling');
}

export async function webI18nSmoke(browser,{settingsOnly=false}={}) {
 const root = fileURLToPath(new URL('../internal/web/static/', import.meta.url));
 let serverVersion='v0.1.9';
 const server = createServer(async (req,res) => {
  try {
   if (req.url === '/language-peer') { res.setHeader('Content-Type','text/html'); res.end('<!doctype html><title>Language fixture</title>'); return; }
   const rel = new URL(req.url,'http://fixture').pathname.replace(/^\/_v\/[^/]+/,'');
   const path = resolve(root,'.'+(rel==='/'?'/index.html':rel));
   if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
   res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(path)] || 'application/octet-stream');
   const data=await readFile(path);
   res.end(rel==='/'||rel==='/index.html' ? data.toString('utf8').replace('{{SERVER_VERSION}}',serverVersion) : data);
  } catch {res.writeHead(404).end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const context=await browser.newContext({locale:'en-GB', timezoneId:'UTC', viewport:{width:1280,height:900}});
 const page=await context.newPage();
 recordNavigations(page,'web-i18n');
 const errors=[]; page.on('pageerror',e=>errors.push(e.stack||e.message));
 const space={id:'locale-space',name:'保存',agent:'codex',account_id:'fixture',account_label:'取消',status:'running',default_model:'fixture'};
 let sockets=0, writes=0, usageReads=0, terminalSocket;
 let timezone='Asia/Tokyo';
 let meTimezone;
 let meRole='admin';
 let usageDates;
 let holdUsageRead;
 let upgradeJob=null;
 const customTip='保存 <custom tip>';
 const terminalTips={tips:['可直接粘贴图片，路径可点击预览',customTip],interval_sec:4,animation:'scroll'};
 let savedTerminalTips=terminalTips;
 const usageRows=Array.from({length:20},(_,i)=>({id:i+1,ts:Date.now(),user:'保存',session_id:space.id,session_name:space.name,thread_id:'thread',turn_id:'turn-'+i,agent:'claude',account_id:'fixture',model:'保存',kind:'chat',billing:'table',input_tokens:100,output_tokens:1000,cache_read_tokens:80,cache_write_tokens:10,total_tokens:1190,cost_micro_usd:2128,ttft_ms:100,wall_ms:1000,duration_ms:900,rate:{input:1,output:2,cache_read:0.1,cache_write:2,snapshot:true,per_request:true,key:'保存'}}));
 const usageRun='a'.repeat(32);
 Object.assign(usageRows[0],{kind:'delegation',delegation_id:usageRun});
 Object.assign(usageRows[1],{kind:'delegation',delegation_id:'c'.repeat(32)});
 Object.assign(usageRows[2],{kind:'decision',agent:'decision',delegation_id:usageRun});
 await page.routeWebSocket('**/api/sessions/*/term?*',ws=>{sockets++; terminalSocket=ws; ws.send(Buffer.from('保存 Cancel <code>\r\n'));});
 await page.routeWebSocket('**/api/sessions/*/chat?*',()=>{});
 await page.route('**/api/**',async route=>{
  const {pathname:path,searchParams}=new URL(route.request().url());
  if (route.request().method()!=='GET' && path!=='/api/updates/check' && path!=='/api/me/activity') writes++;
  if(path==='/api/usage/events'){
   usageReads++;
   usageDates?.push(searchParams.get('since'));
  }
  let body={};
  if(path==='/api/login')body={token:'synthetic-locale-token'};
  else if(path==='/api/me')body={user:'保存',role:meRole,timezone:meTimezone??timezone,models:{claude:[],codex:[]},quota:{metered:false},terminal_tips:terminalTips};
  else if(path==='/api/sessions')body=[space];
  else if(path==='/api/session-creations')body={version:1,actor_key:'a'.repeat(64),creations:[]};
  else if(path==='/api/onboarding')body={version:1,can_configure:true,can_create:true,has_workspaces:true,accounts:[{id:'fixture',label:'取消',type:'codex',credentials_present:true}],default_models:{codex:'fixture'},container_resources:{cpus:1,memory_mb:512,pids_limit:128}};
  else if(path==='/api/accounts')body=[{id:'fixture',label:'取消',type:'codex',cred_status:'ok',sessions:1}];
  else if(path==='/api/settings'){
   if(route.request().method()==='PUT'){
    const patch=route.request().postDataJSON();
    timezone=patch.timezone??timezone;
    savedTerminalTips=patch.terminal_tips??savedTerminalTips;
   }
   body={listen:'127.0.0.1:8180',agent_image:'fixture',permission_mode:'default',max_upload_mb:20,idle_timeout_min:30,timezone,container:{memory_mb:512,cpus:1,pids_limit:128,network:'none'},resources:{max_running:0,max_running_per_user:0,min_free_bytes:0},models:{claude:[],codex:[]},default_models:{claude:'fixture',codex:'fixture'},terminal_tips:savedTerminalTips,tunnel:{enabled:false},proxy_bridge:{bind:'127.0.0.1:1081'},pricing:{}};
  }
  else if(path.endsWith('/models'))body={models:[],discovery:'available'};
  else if(path==='/api/pricing')body={
   active:{revision:1,prices:{'fixture-model-with-a-long-identifier':{input:2,output:8,long_context:{threshold:200000,input:4,output:12}}},managed:{},catalog:{url:'',auto_check:false,auto_apply:false},history:[]},
   candidate:{catalog:{source:'',version:1},bundled:true},changes:[],warnings:[]
  };
  else if(path.endsWith('/files'))body=[];
  else if(path.endsWith('/chat/threads'))body={threads:[],active:null};
  else if(path.endsWith('/history'))body={entries:[],thread:null,costs:{}};
  else if(path==='/api/git/connections'||path==='/api/users'||path==='/api/tunnel/clients')body=[];
  else if(path==='/api/me/git')body={user:'保存',name:'取消',email:'fixture@example.invalid'};
  else if(path==='/api/me/git/default')body={connection_id:''};
  else if(path==='/api/proxies')body={proxies:[],bridge_up:false,bridge_host:'127.0.0.1'};
  else if(path==='/api/usage/events')body={rows:usageRows,total:{rows:20,turns:20,input_tokens:2000,output_tokens:20000,cache_read_tokens:1600,cache_write_tokens:200,cost_micro_usd:42560},facets:{users:[],agents:[],models:[]},scope:'all',timezone,order:'desc',limit:20,offset:0,sync:{last_scan_at:Date.now(),last_success_at:Date.now(),scanning:false,errors:0}};
  else if(path==='/api/usage/trend')body={granularity:'hour',buckets:[],timezone};
  else if(path==='/api/updates'||path==='/api/updates/check'){
   const checked=path.endsWith('/check') ? Date.now() : 0;
   body={current_version:serverVersion,revision:'0123456789abcdef',built_at:'2026-10-04T08:00:00Z',latest_version:'',available:false,comparable:true,checked_at:checked,attempted_at:checked,error:''};
  }
  else if(path==='/api/updates/components')body={version:1,observed_at:Date.now(),server:{version:'v0.1.9',schema:11,candidate_compatibility:'preflight_required'},image:{reference:'fixture',id:'',claude:'',codex:'',state:'unavailable',observed_at:0},desktop:{installed_version_state:'browser_unknown',server_protocol:1,sync_enabled:false}};
  else if(path==='/api/updates/upgrade')body={supported:!!upgradeJob,current_version:serverVersion,job:upgradeJob,
   reason:upgradeJob?'':'当前部署不是支持在线升级的版本目录安装，请使用手工升级。'};
  if(path==='/api/usage/events' && holdUsageRead){
   const hold=holdUsageRead;
   holdUsageRead=undefined;
   await hold();
  }
  await route.fulfill({json:body});
 });
 const language=async value=>{await page.evaluate(async value=>{const {i18n}=await import('/_v/{{BUILD}}/js/i18n.js');i18n.setLanguage(value);},value);};
 const checkPersonalSettings=async()=>{
  meRole='user';
  await page.goto(base+'/?personal-settings#/settings/container');
  await page.locator('#sec-interface').waitFor();
  await language('ru');
  const title=page.locator('#set-title');
  const description=page.locator('#set-description');
  const grid=page.locator('.interface-preferences');
  assert.equal(await grid.getByRole('heading',{level:2}).count(),3);
  for (const [width,columns] of [[1720,3],[1080,2],[320,1]]) {
   await page.setViewportSize({width,height:900});
   assert.equal(await title.isVisible(),true);
   assert.equal(await title.textContent(),'Личные настройки');
   assert.equal(await description.textContent(),'Изменения применяются сразу в этом браузере.');
   assert.equal(await page.locator('#set-nav').isVisible(),false);
   assert.equal(await page.locator('#mobile-section-btn').isVisible(),false);
   assert.equal(await page.locator('#interface-admin-title').isVisible(),false);
   const layout=await grid.evaluate(el=>({
    columns:getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length,
    overflow:el.scrollWidth-el.clientWidth,
   }));
   assert.equal(layout.columns,columns,`personal settings at ${width}px`);
   assert.ok(layout.overflow<=1,`personal settings overflow at ${width}px`);
  }
  const details=grid.locator('.interface-details').first();
  assert.equal(await details.evaluate(el=>el.open),false);
  await details.locator('summary').click();
  assert.equal(await details.evaluate(el=>el.open),true);
  assert.equal(await grid.locator('.interface-warning:visible').count(),2);
  const suggestion=grid.locator('#chat-suggest-enabled');
  const enabled=await suggestion.isChecked();
  const writesBefore=writes;
  await suggestion.press('Space');
  const followup=grid.locator('#chat-followup-mode');
  await grid.locator('#chat-followup-mode + .select-trigger').click();
  await page.getByRole('option').last().click();
  await page.reload();
  await grid.waitFor();
  assert.equal(await suggestion.isChecked(),!enabled);
  assert.equal(await followup.inputValue(),'steer');
  assert.equal(writes,writesBefore,'personal preferences only change local state');
  await language('en');
  assert.equal(await title.textContent(),'Personal settings');
 };
 try {
  await page.goto(base);
  await page.locator('#login').waitFor({state:'visible'});
  assert.equal(await page.locator('html').getAttribute('lang'),'en');
  assert.equal((await page.locator('#login-btn').textContent()).trim(),'Sign in',await page.locator('#login-btn').evaluate(el=>el.outerHTML));
  await page.locator('#login-user').fill('保存');
  await page.locator('#login-pass').fill('fixture-password');
  // Exercise the visible shared dropdown, not only the runtime API.
  await page.locator('#login-language + .select-trigger').click();
  await page.getByRole('option',{name:'Русский',exact:true}).click();
  assert.equal(await page.locator('html').getAttribute('lang'),'ru');
  assert.equal((await page.locator('#login-btn').textContent()).trim(),'Войти');
  await page.locator('#login-language + .select-trigger').click();
  await page.getByRole('option',{name:'繁體中文',exact:true}).click();
  assert.equal(await page.locator('html').getAttribute('lang'),'zh-TW');
  assert.equal(await page.locator('#login-user').inputValue(),'保存');
  assert.equal(await page.locator('#login-pass').inputValue(),'fixture-password');
  assert.equal(await page.locator('#login-btn svg').count(),1,'switch preserves action icon');
  await language('en');
  await page.reload();
  await page.locator('#login').waitFor({state:'visible'});
  assert.equal(await page.locator('html').getAttribute('lang'),'en');
  await page.locator('#login-user').fill('保存'); await page.locator('#login-pass').fill('fixture-password');
  await page.locator('#login-btn').click();
  await page.locator('#app').waitFor({state:'visible'});
  if (settingsOnly) {
   await language('ru');
   await checkSettingsLayout(page,base,language);
   await checkPersonalSettings();
   assert.deepEqual(errors,[]);
   console.log('Settings layout, navigation, disclosures and switches passed');
   return;
  }
  const afterLoginWrites=writes;
  await page.locator('#btn-new').click();
  await page.locator('#new-name').fill('取消 <draft>');
  await page.locator('#new-name').evaluate(el=>{window.localeDraftInput=el;el.focus();el.setSelectionRange(1,3);});
  await language('zh-CN');
  assert.equal(await page.locator('#new-name').inputValue(),'取消 <draft>');
  assert.equal(await page.locator('#new-name').evaluate(el=>el===window.localeDraftInput && el===document.activeElement && el.selectionStart===1 && el.selectionEnd===3),true);
  assert.equal((await page.locator('#new-title').textContent()).trim(),'创建 Agent 工作空间');
  assert.equal(await page.locator('#new-ok svg').count(),1);
  await language('en');
  assert.equal((await page.locator('#new-title').textContent()).trim(),'Create an Agent workspace');
  assert.equal(await page.locator('#new-name').inputValue(),'取消 <draft>');
  assert.equal(writes,afterLoginWrites,'language switch must not save drafts');
  await page.locator('#new-cancel').click();
  await page.goto(base+'/#/sessions/locale-space/chat');
  const hero=page.locator('#chat-hero');
  const chatInput=page.locator('#chat-input');
  await hero.waitFor();
  await language('ru');
  const beforeQuickPrompts=writes;
  const quickPrompts=[
   ['Изучить репозиторий','Помоги разобраться в структуре этого репозитория. Опиши основные модули и объясни, как организован код.'],
   ['Создать новую функцию','Хочу добавить новую функцию. Она должна '],
   ['Проверить код','Проверь текущий код, найди проблемы и предложи конкретные исправления.'],
   ['Исправить проблему','Помоги исправить ошибку. Она возникает, когда '],
  ];
  for(const [button,prompt] of quickPrompts){
   await chatInput.fill('');
   await hero.getByRole('button',{name:button,exact:true}).click();
   assert.equal(await chatInput.inputValue(),prompt,button);
  }
  await chatInput.fill('');
  await hero.getByRole('button',{name:quickPrompts[0][0],exact:true}).click();
  await hero.getByRole('button',{name:quickPrompts[2][0],exact:true}).click();
  const combinedPrompt=`${quickPrompts[0][1]} ${quickPrompts[2][1]}`;
  assert.equal(await chatInput.inputValue(),combinedPrompt,'consecutive quick prompts are separated');
  await language('en');
  assert.equal(await chatInput.inputValue(),combinedPrompt,'switching the language preserves inserted text');
  await chatInput.fill('My draft.');
  await hero.getByRole('button',{name:'Review the code',exact:true}).click();
  assert.equal(await chatInput.inputValue(),'My draft. Review the current code, identify problems, and suggest specific fixes.');
  assert.equal(writes,beforeQuickPrompts,'quick prompts only insert text');
  await chatInput.fill('');
  await page.goto(base+'/#/sessions/locale-space/term');
  await page.locator('#term-state[data-state="connected"]').waitFor();
  const connected=sockets;
  await page.evaluate(()=>{window.localeTerminal=document.querySelector('.xterm');});
  await language('ru');
  assert.equal(await page.locator('#term-state').textContent(),'Оболочка подключена');
  const tips=page.locator('#term-tips .term-tip');
  const assertTips=async builtIn=>assert.deepEqual(await tips.allTextContents(),[builtIn,customTip,builtIn]);
  await assertTips('Вставляйте изображения прямо в терминал. Нажмите на путь для предпросмотра.');
  await language('zh-TW');
  await assertTips('可直接貼上圖片，點選路徑即可預覽。');
  await language('en');
  await assertTips('Paste images directly into the terminal. Click an image path to preview it.');
  assert.equal(sockets,connected,'language change must not reconnect terminal');
  assert.equal(await page.evaluate(()=>document.querySelector('.xterm')===window.localeTerminal),true);
  assert.equal(await page.locator('#wb-name').textContent(),'保存','user workspace name stays verbatim');
  assert.match(await page.locator('#term-state').textContent(),/connected/i);
  assert.equal(await page.evaluate(async()=>{const {S}=await import('/_v/{{BUILD}}/js/state.js');return S.timeZone;}),'Asia/Tokyo');
  // Server refusal reasons override the generic connection label. Keep the raw
  // diagnostic and terminal buffer intact when the interface language changes.
  const refusal='账号授权已撤销；permission denied <code> 保存';
  await terminalSocket.close({code:4004,reason:refusal});
  await page.waitForFunction(reason=>document.querySelector('#term-state').textContent===reason,refusal);
  const terminalText=()=>page.evaluate(async()=>{
   const {S}=await import('/_v/{{BUILD}}/js/state.js');
   const buffer=S.term.buffer.active;
   return Array.from({length:buffer.length},(_,i)=>buffer.getLine(i)?.translateToString()).join('\n');
  });
  await page.waitForFunction(async reason=>{
   const {S}=await import('/_v/{{BUILD}}/js/state.js');
   const buffer=S.term.buffer.active;
   return Array.from({length:buffer.length},(_,i)=>buffer.getLine(i)?.translateToString()).join('\n').includes(reason);
  },refusal);
  const refusedOutput=await terminalText();
  for (const preference of ['zh-CN','zh-TW','en']) {
   await language(preference);
   assert.equal(await page.locator('#term-state').textContent(),refusal,'language change preserves the raw server refusal reason');
   assert.equal(await page.locator('#term-state').getAttribute('data-state'),'closed');
   assert.equal(await terminalText(),refusedOutput,'language change preserves terminal diagnostics and output');
  }
  assert.equal(sockets,connected,'language change must not reconnect a refused terminal');
  assert.equal(await page.evaluate(()=>document.querySelector('.xterm')===window.localeTerminal),true);
  // Explicit bindings must never translate user content, even if it matches a key.
  await page.evaluate(async()=>{
   const {setText,setTextRender,htmlText,t}=await import('/_v/{{BUILD}}/js/i18n.js');
   const {decorateIcons}=await import('/_v/{{BUILD}}/js/icons.js');
   const {btnBusy}=await import('/_v/{{BUILD}}/js/util.js');
   const host=document.createElement('div');document.body.append(host);
   const button=document.createElement('button');button.id='locale-busy';button.className='btn';button.dataset.icon='save';host.append(button);setText(button,'保存');decorateIcons(host);btnBusy(button,()=>t('读取中…'));
   const ui=document.createElement('span'); ui.id='locale-owned';document.body.append(ui);setText(ui,'保存');
   const raw=document.createElement('span');raw.id='locale-raw';raw.textContent='保存';document.body.append(raw);
   const replaced=document.createElement('span');replaced.id='locale-replaced';document.body.append(replaced);setText(replaced,'保存');replaced.textContent='保存';
   const mixed=document.createElement('span');mixed.id='locale-mixed';document.body.append(mixed);setTextRender(mixed,()=>t('删除 {name}',{name:'保存 <script>'}));
   const html=document.createElement('span');html.id='locale-html';html.innerHTML=htmlText('名称 {name}',{name:'&lt;script&gt;保存&lt;/script&gt;'});document.body.append(html);
  });
  await language('zh-TW');
  assert.equal(await page.locator('#locale-raw').textContent(),'保存');
  assert.equal(await page.locator('#locale-replaced').textContent(),'保存');
  assert.equal(await page.locator('#locale-html script').count(),0);
  await language('en');
  assert.equal(await page.locator('#locale-owned').textContent(),'Save');
  assert.equal((await page.locator('#locale-busy').textContent()).trim(),'Loading…');
  await page.evaluate(async()=>{const {btnDone}=await import('/_v/{{BUILD}}/js/util.js');btnDone(document.querySelector('#locale-busy'));});
  assert.equal((await page.locator('#locale-busy').textContent()).trim(),'Save');
  assert.equal(await page.locator('#locale-busy svg').count(),1,'restore the original icon and translated saved caption');
  await page.locator('#btn-usagelog').click();
  await page.locator('#uf-date-range').waitFor({state:'visible'});
  await page.locator('#usage-rows .u-why').first().waitFor();
  await page.evaluate(()=>{window.localeUsageRow=document.querySelector('#usage-rows tr');});
  const usageCount=usageReads;
  const pageNumber=await page.locator('#usage-page').textContent();
  const usageLabels={
   'zh-CN':{kind:'委派跑腿',decision:'决策调用',chat:'对话',task:'委派 ID：'},
   'zh-TW':{kind:'委派跑腿',decision:'決策呼叫',chat:'對話',task:'委派 ID：'},
   en:{kind:'Delegated work',decision:'Decision call',chat:'Chat',task:'Delegation ID: '},
  };
  const assertUsageLanguage=async preference=>{
   const labels=usageLabels[preference],rows=page.locator('#usage-rows tr');
   const kind=row=>rows.nth(row).locator('td').nth(3);
   assert.equal(await kind(0).locator('.u-kind').innerText(),labels.kind);
   assert.equal(await kind(1).locator('.u-kind').innerText(),labels.kind);
   assert.equal(await kind(2).locator('.u-kind').innerText(),labels.decision);
   assert.equal(await kind(3).locator('.u-kind').innerText(),labels.chat,'ordinary chat keeps its own type');
   assert.equal(await page.locator('#uf-kind option[value="delegation"]').textContent(),labels.kind);
   assert.equal(await rows.first().locator('.u-sess').innerText(),'保存','workspace names stay verbatim');
   assert.equal(usageReads,usageCount,'switching delegation labels must not refetch');
  };
  for(const preference of ['zh-CN','zh-TW','en']){await language(preference);await assertUsageLanguage(preference);}
  assert.equal(usageReads,usageCount,'switching loaded usage must not refetch');
  assert.equal(await page.evaluate(()=>document.querySelector('#usage-rows tr')===window.localeUsageRow),true,'keep loaded row nodes');
  assert.equal(await page.locator('#usage-page').textContent(),pageNumber);
  assert.equal(await page.locator('#usage-rows .u-hit').first().getAttribute('data-l'),'Cache hit rate');
  await page.locator('#usage-rows .u-why').first().click();
  const amounts=await page.locator('#cost-rows td.num').allTextContents();
  await page.locator('#cost-close').focus();
  for(const preference of ['zh-TW','zh-CN','en']){
   await language(preference);await assertUsageLanguage(preference);
   const labels=usageLabels[preference],detail=await page.locator('#cost-head').innerText();
   assert.ok(detail.includes(labels.kind),'open delegation detail translates its type');
   assert.ok(detail.includes(labels.task+usageRun),'open detail translates the delegation label and preserves its ID');
   assert.deepEqual(await page.locator('#cost-rows td.num').allTextContents(),amounts,'cost snapshot and totals must remain identical');
   assert.equal(await page.locator('#cost-close').evaluate(el=>el===document.activeElement),true);
   if(preference==='zh-TW')assert.equal(await page.locator('#cost-rows tr').first().locator('td').first().textContent(),'輸入');
  }
  await page.locator('#cost-close').click();
  await page.locator('#usage-rows tr').nth(2).locator('.u-why').click();
  for(const preference of ['zh-CN','zh-TW','en']){
   await language(preference);
   const labels=usageLabels[preference],detail=await page.locator('#cost-head').innerText();
   assert.ok(detail.includes(labels.decision)&&detail.includes(labels.task+usageRun),'decision detail retains its delegation across languages');
  }
  assert.equal(usageReads,usageCount);
  await page.locator('#cost-close').click();
  await page.locator('#uf-date-range').click();
  const start=page.locator('[data-dr="since-day"]');
  await start.fill('2026/09/22');
  const until=await page.locator('[data-dr="until-day"]').inputValue();
  await language('zh-CN'); await language('en');
  assert.equal(await start.inputValue(),'2026/09/22');
  assert.equal(await page.locator('[data-dr="until-day"]').inputValue(),until);
  assert.equal(await page.locator('[data-dr="zone"]').textContent(),'Asia/Tokyo');
  assert.equal(await page.locator('.dr-weekdays span').first().textContent(),'Sun');
  await language('ru');
  assert.match(await page.locator('.dr-weekdays span').first().textContent(),/^вс\.?$/i);
  assert.equal(await start.inputValue(),'2026/09/22');
  assert.equal(await page.locator('[data-dr="zone"]').textContent(),'Asia/Tokyo');
  await page.locator('[data-dr="cancel"]').click();
  for(const preference of ['ru','en']) {
   await language(preference);
   for(const width of [1280,390,320]) {
    await page.setViewportSize({width,height:900});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${preference} overflow at ${width}px`);
   }
  }
  if (await page.locator('#scrim').evaluate(el=>el.classList.contains('show'))) await page.locator('#btn-sidebar-close').click();
  await mkdir(resolve('output/playwright'),{recursive:true});
  await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().right<=1);
  await page.screenshot({path:resolve('output/playwright/web-i18n-english-mobile.png'),animations:'disabled'});
  await page.goto(base+'/#/settings/security');
  await page.locator('#sec-security').waitFor();
  const securityHeading=page.locator('#sec-security h2');
  await language('ru');
  const scheduledTitle=await page.evaluate(async()=>{
   const {announcementTitle}=await import('/_v/{{BUILD}}/js/announcement.js');
   const starts=Date.UTC(2026,10,19,20,12);
   return announcementTitle({kind:'release',starts_at:starts,duration_min:2},starts-10*60*1000);
  });
  assert.match(scheduledTitle,/20\.11\.2026 05:12/, 'Russian announcement includes the year in the configured Tokyo time zone');
  const settingsLabels={proxies:'IP-прокси',container:'Контейнеры',decision:'Решения',interface:'Интерфейс',
   security:'Безопасность',logins:'Активность',about:'Обновления'};
  for (const [section,label] of Object.entries(settingsLabels)) {
   const button=page.locator(`#set-nav [data-sec="${section}"]`);
   assert.equal(await button.locator('.action-label').textContent(),label);
   assert.equal(await button.getAttribute('aria-label'),label);
  }
  assert.equal(await securityHeading.textContent(),'Безопасность и доступ');
  assert.equal(await page.locator('#set-nav [data-sec="security"]').getAttribute('data-tip'),'Безопасность и доступ');
  for (const width of [761,1024,1280]) {
   await page.setViewportSize({width,height:900});
   const wrapped=await page.locator('#set-nav button:not(.hidden) .action-label').evaluateAll(labels=>labels.flatMap(label=>{
    const range=document.createRange();
    range.selectNodeContents(label);
    return range.getClientRects().length===1 ? [] : [label.textContent];
   }));
   assert.deepEqual(wrapped,[],`Russian settings labels must fit on one line at ${width}px`);
  }
  await page.locator('#set-nav [data-sec="interface"]').click();
  const interfaceSection=page.locator('#sec-interface');
  await interfaceSection.waitFor();
  assert.equal(await interfaceSection.locator('.interface-preferences').getByRole('heading',{level:3}).count(),3);
  assert.equal(await interfaceSection.getByRole('switch').count(),3);
  assert.equal(await interfaceSection.getByRole('switch',{name:'Сохранение черновиков'}).isVisible(),true);
  const draftDetails=interfaceSection.locator('#set-local-saving .interface-details');
  assert.equal(await draftDetails.locator('p').first().isVisible(),false);
  await draftDetails.locator('summary').click();
  assert.equal(await draftDetails.locator('p').first().isVisible(),true);
  await draftDetails.locator('summary').click();
  for (const width of [1280,390,320]) {
   await page.setViewportSize({width,height:900});
   const fits=await interfaceSection.evaluate(el=>{
    const section=el.getBoundingClientRect();
    return el.scrollWidth <= el.clientWidth && [...el.querySelectorAll('[role="switch"], .interface-select-row .select-trigger')]
     .every(control=>control.getBoundingClientRect().right <= section.right);
   });
   assert.equal(fits,true,`interface settings stay within the viewport at ${width}px`);
   if(width!==320) {
    await mkdir('output/playwright',{recursive:true});
    await page.screenshot({path:`output/playwright/interface-settings-${width}.png`,animations:'disabled'});
   }
  }
  await page.setViewportSize({width:390,height:900});
  await page.locator('#mobile-section-btn').click();
  await page.getByRole('menuitemradio',{name:'Интерфейс',exact:true}).click();
  await page.locator('#sec-interface').waitFor();
  assert.equal(await page.locator('#mobile-section-label').textContent(),'Интерфейс');
  const tipsInput=page.locator('#set-tips');
  assert.equal(await tipsInput.isVisible(),false);
  await page.locator('#interface-terminal > summary').click();
  const ruTip='Вставляйте изображения прямо в терминал. Нажмите на путь для предпросмотра.';
  const enTip='Paste images directly into the terminal. Click an image path to preview it.';
  assert.equal(await tipsInput.inputValue(),`${ruTip}\n${customTip}`);
  await language('en');
  assert.equal(await page.locator('#mobile-section-label').textContent(),'Appearance and tips');
  assert.equal(await tipsInput.inputValue(),`${enTip}\n${customTip}`);
  assert.equal(await page.locator('#set-savebar').isVisible(),false,'language changes must not mark settings as edited');
  const draftTips=`${enTip}\n${customTip} 2`;
  await tipsInput.fill(draftTips);
  await language('ru');
  assert.equal(await tipsInput.inputValue(),draftTips,'switching language keeps an unsaved tip draft');
  const tipSave=page.waitForResponse(res=>new URL(res.url()).pathname==='/api/settings' && res.request().method()==='PUT');
  await page.locator('#set-save').click();
  assert.deepEqual((await tipSave).request().postDataJSON(),{terminal_tips:{...terminalTips,tips:[terminalTips.tips[0],`${customTip} 2`]}});
  await page.locator('#set-savebar').waitFor({state:'hidden'});
  assert.equal(await tipsInput.inputValue(),`${ruTip}\n${customTip} 2`);

  await checkSettingsLayout(page,base,language);
  await page.setViewportSize({width:390,height:900});
  await page.goto(base+'/#/settings/about');
  await page.locator('#sec-about').waitFor();
  await language('ru');
  const updatePanel=page.locator('#sec-about .update-panel');
  assert.equal(await updatePanel.locator('[data-update-release]').getAttribute('href'),'https://github.com/zyclonite135/agentbox/releases');
  await updatePanel.locator('[data-update-check]').click();
  await updatePanel.getByText('Стабильных релизов пока нет',{exact:true}).waitFor();
  await updatePanel.getByText('Для обновления из интерфейса нужна стандартная установка на Linux с systemd. Обновите этот экземпляр вручную.',{exact:true}).waitFor();
  assert.equal(await page.locator('#update-install').isVisible(),false);
  upgradeJob={id:usageRun,version:'v0.1.10',phase:'downloading',downloaded:50,total:100};
  await updatePanel.locator('[data-update-check]').click();
  await page.locator('#upgrade-steps .current').filter({hasText:'Скачать'}).waitFor();
  upgradeJob={...upgradeJob,phase:'failed',failed_phase:'backup',error:'正在备份并验证数据时失败。请查看升级任务日志；版本切换后不会自动回退数据库。'};
  await page.locator('#upgrade-refresh').click();
  await page.locator('#upgrade-error').filter({hasText:'Обновление прервалось на этапе «Резервное копирование данных».'}).waitFor();
  assert.equal(await page.locator('#upgrade-meter').isVisible(),true);
  assert.equal(await page.locator('#upgrade-steps .failed').count(),1);
  await page.reload();
  await page.locator('#upgrade-steps .failed').waitFor();

  serverVersion=upgradeJob.version;
  upgradeJob={...upgradeJob,phase:'succeeded',error:''};
  await page.locator('#upgrade-refresh').click();
  await page.locator('#upgrade-reload').waitFor();
  assert.equal(await page.locator('#upgrade-pct').textContent(),'100%');
  const installed=page.locator('#upgrade-support');
  await page.locator('#upgrade-reload').click();
  await installed.filter({hasText:'Установлена версия v0.1.10'}).waitFor();
  for(const id of ['upgrade-progress','upgrade-meter','upgrade-steps','upgrade-reload']){
   assert.equal(await page.locator(`#${id}`).isVisible(),false,`${id} must be hidden on the updated page`);
  }
  await language('en');
  assert.equal(await installed.textContent(),'Version v0.1.10 installed');
  await language('ru');

  await page.setViewportSize({width:1280,height:900});
  const midnightBoundary=Date.UTC(2026,10,19,20,30);
  await page.clock.setFixedTime(midnightBoundary);
  usageRows[0].ts=midnightBoundary;
  const trigger=page.locator('#set-timezone + .select-trigger');
  const saveTimezone=async (zone,label)=>{
   await page.goto(base+'/#/settings/interface');
   await trigger.click();
   await page.getByRole('option',{name:`${label} (${zone})`,exact:true}).click();
   const saved=page.waitForResponse(res=>new URL(res.url()).pathname==='/api/settings' && res.request().method()==='PUT');
   await page.locator('#set-save').click();
   assert.deepEqual((await saved).request().postDataJSON(),{timezone:zone});
   await page.locator('#set-savebar').waitFor({state:'hidden'});
  };
  for (const [zone, label, usageLabel, day, hour] of [
   ['Asia/Yekaterinburg','Екатеринбург','Время Екатеринбурга','2026-11-20','01:30'],
   ['Europe/Moscow','Москва','Московское время','2026-11-19','23:30'],
  ]) {
   await saveTimezone(zone,label);
   await page.reload();
   await trigger.filter({hasText:`${label} (${zone})`}).waitFor();

   await page.locator('#btn-usagelog').click();
   await page.locator('#usage-zone-name').filter({hasText:usageLabel}).waitFor();
   assert.equal(await page.locator('#usage-zone-id').textContent(),zone);
   const time=page.locator('#usage-rows .u-time').first();
   await time.waitFor();
   assert.match(await time.textContent(),new RegExp(`${hour}:00`));
   assert.equal(await time.locator('.u-sub').textContent(),day.replaceAll('-','/'));
   await page.locator('#uf-date-range').click();
   assert.equal(await page.locator('[data-dr="zone"]').textContent(),zone);
   assert.equal(await page.locator('[data-dr="since-day"]').inputValue(),day.replaceAll('-','/'));
   await page.locator('[data-dr="cancel"]').click();
   const downloaded=page.waitForEvent('download');
   await page.locator('#uf-export').click();
   const csv=await readFile(await (await downloaded).path(),'utf8');
   assert.ok(csv.split('\r\n')[0].includes(zone));
   assert.ok(csv.split('\r\n')[1].startsWith(`${day} ${hour},`));
  }

  const pauseNextUsage=()=>{
   const started=Promise.withResolvers();
   const resume=Promise.withResolvers();
   holdUsageRead=()=>{started.resolve();return resume.promise;};
   return {started:started.promise, resume:resume.resolve};
  };
  const staleUsage=pauseNextUsage();
  await page.locator('#uf-refresh').click();
  await staleUsage.started;
  try {
   await saveTimezone('Asia/Yekaterinburg','Екатеринбург');
  } finally {
   staleUsage.resume();
  }
  await page.waitForFunction(()=>document.querySelector('#usage-table-scroll').getAttribute('aria-busy')==='false');
  assert.equal(await page.evaluate(async()=>{const {S}=await import('/_v/{{BUILD}}/js/state.js');return S.timeZone;}),
   'Asia/Yekaterinburg','an older usage response must not override the saved timezone');

  await page.locator('#btn-usagelog').click();
  await page.waitForFunction(()=>document.querySelector('#usage-table-scroll').getAttribute('aria-busy')==='false');
  const staleExport=pauseNextUsage();
  const completedExport=page.waitForEvent('download');
  await page.locator('#uf-export').click();
  await staleExport.started;
  try {
   await saveTimezone('Europe/Moscow','Москва');
  } finally {
   staleExport.resume();
  }
  const csv=await readFile(await (await completedExport).path(),'utf8');
  assert.ok(csv.split('\r\n')[0].includes('Asia/Yekaterinburg'));
  assert.ok(csv.split('\r\n')[1].startsWith('2026-11-20 01:30,'));
  assert.equal(await page.locator('#usage-zone-id').textContent(),'Europe/Moscow','CSV must not change the active usage timezone');

  await page.locator('#btn-usagelog').click();
  await page.waitForFunction(()=>document.querySelector('#usage-table-scroll').getAttribute('aria-busy')==='false');
  // Model a timezone change on the server before this tab polls /me.
  const trendToggle=page.locator('#ut-toggle');
  if(await trendToggle.getAttribute('aria-expanded')==='false') await trendToggle.click();
  await page.waitForFunction(()=>!document.querySelector('#ut-chart').classList.contains('busy'));
  meTimezone=timezone;
  timezone='Asia/Yekaterinburg';
  usageDates=[];
  const updatedTrend=page.waitForResponse(res=>{
   const {pathname,searchParams}=new URL(res.url());
   return pathname==='/api/usage/trend' && searchParams.get('since')==='2026-11-20T00:00';
  });
  await page.locator('#uf-refresh').click();
  await updatedTrend;
  await page.locator('#usage-zone-id').filter({hasText:timezone}).waitFor();
  await page.waitForFunction(()=>document.querySelector('#usage-table-scroll').getAttribute('aria-busy')==='false');
  assert.deepEqual(usageDates,['2026-11-19T00:00','2026-11-20T00:00'],'reapply Today in the newly reported timezone');
  usageDates=undefined;
  meTimezone=undefined;

  await checkPersonalSettings();
  await page.evaluate(async()=>{const {emit}=await import('/_v/{{BUILD}}/js/state.js');emit('unauthorized');});
  await page.locator('#login').waitFor({state:'visible'});
  await language('zh-TW'); await language('en');
  assert.equal(await page.locator('#usage-rows tr').count(),0,'logout clears previous user records');
  // A second same-origin window can change the stored preference without reloading this one.
  const other=await context.newPage(); await other.goto(base+'/language-peer');
  await other.evaluate(()=>localStorage.setItem('agentbox.language','ru'));
  await page.waitForFunction(()=>document.documentElement.lang==='ru');
  await other.close();
  assert.deepEqual(errors,[]);
  console.log('Web locale: detection/persistence, live labels, icons, drafts/focus, timezone, raw content, terminal continuity/refusal diagnostics and responsive layouts passed');
 } finally {await context.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const {chromium}=await import(process.env.AGENTBOX_PLAYWRIGHT_MODULE?pathToFileURL(process.env.AGENTBOX_PLAYWRIGHT_MODULE).href:'playwright');
 const browser=reduceMotion(await chromium.launch({headless:true}));
 try {await webI18nSmoke(browser);} finally {await browser.close();}
}
