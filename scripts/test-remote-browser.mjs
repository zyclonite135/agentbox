import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

// UI state regression with synthetic transport. Real RFB is exercised separately
// by test-remote-browser-live.py against Docker and the embedded noVNC module.
export async function remoteBrowserSmoke(page) {
 let running = false, unavailable = false, clipboard = '', delayResolve;
 let hasNavigation = false, rejectClose = false;
 let browserTabs = Array.from({length:36}, (_, i) => ({
  id:`tab-${i}`, title:`Тестовая вкладка ${i+1} с длинным названием`, url:`https://example.org/${i+1}`,
 }));
 let activeTab = browserTabs[0].id;
 const opened = [];
 const operationID = '0123456789abcdef0123456789abcdef';
 await page.route('**/vendor/novnc/core/rfb.js', route => route.fulfill({contentType:'text/javascript',body:`
 export default class extends EventTarget {
 constructor(el,url){
  super();this.el=el;el.tabIndex=0;window.testRemoteDesktop=this;
  if(!window.holdRemoteHandshake)this.timer=setTimeout(()=>{el.textContent='Synthetic remote desktop';this.dispatchEvent(new Event('connect'));},20);
 }
 disconnect(){clearTimeout(this.timer);this.dispatchEvent(new Event('disconnect'));}
 set qualityLevel(value){this.el.dataset.quality=value;}
 set compressionLevel(value){this.el.dataset.compression=value;}
 focus(){} clipboardPasteFrom(){} sendKey(){}
 }`}));
 await page.route('**/api/sessions/*/browser', async route => {
  const method = route.request().method();
  if (method === 'POST') {
   if (unavailable) {
    await route.fulfill({status:409,json:{code:'browser_image_required',error:'当前镜像未安装浏览器',operation_id:operationID}});
    return;
   }
   running = true; opened.push(route.request().postDataJSON().url);
   if (delayResolve) await new Promise(resolve => { delayResolve(resolve); });
  } else if (method === 'DELETE') running = false;
  await route.fulfill({json:{available:!unavailable,running,browser:'Google Chrome',proxy:false,navigation:hasNavigation}});
 });
 await page.route('**/api/sessions/*/browser/navigation*', async route => {
  if (new URL(route.request().url()).searchParams.has('favicon')) {
   await route.fulfill({json:{tabs:[]}});
   return;
  }
  if (route.request().method() === 'POST') {
   const {operation,tab} = route.request().postDataJSON();
   if (operation === 'select') activeTab = tab;
   if (operation === 'close') {
    if (rejectClose) {
     await route.fulfill({status:409,json:{error:'Synthetic close refusal'}});
     return;
    }
    const index = browserTabs.findIndex(item => item.id === tab);
    browserTabs.splice(index, 1);
    if (activeTab === tab) activeTab = browserTabs[Math.min(index, browserTabs.length - 1)].id;
   }
  }
  await route.fulfill({json:{tabs:browserTabs,active:activeTab,back:false,forward:false}});
 });
 const clipboardRoute = /\/api\/sessions\/[^/]+\/browser\/clipboard(?:\?.*)?$/;
 await page.route(clipboardRoute,async route=>{
  if(route.request().method()==='POST')clipboard=route.request().postDataJSON().text;
  const query = new URL(route.request().url()).searchParams;
  const revision = query.has('after') ? 2 : 1;
  await route.fulfill({json:{text:clipboard,revision}});
 });
 await page.evaluate(()=>{location.hash='#/sessions/fixture-space/browser';});
 await page.locator('#tab-browser').waitFor({state:'visible'});
 await page.getByText('浏览器未启动 · 点击启动后继续上次的登录状态',{exact:true}).waitFor();
 const setLanguage = value => page.evaluate(async value => (await import('/_v/{{BUILD}}/js/i18n.js')).i18n.setLanguage(value), value);
 await setLanguage('ru');
 await page.setViewportSize({width:320,height:740});
 const mobileState = page.locator('#browser-mobile-state');
 const errorDetails = page.locator('#browser-error-details');
 const actions = page.locator('#browser-more');
 const clipboardPanel = page.locator('#browser-clipboard-panel');
 const launch = page.locator('#browser-launch');
 const open = page.locator('#browser-open');
 const fitsOnScreen = async selector => {
  const box = await page.locator(selector).boundingBox();
  const {width,height} = page.viewportSize();
  assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= height,
   `${selector} fits ${width}×${height}: ${JSON.stringify(box)}`);
 };
 assert.equal(await page.locator('#browser-start').isVisible(),false);
 assert.equal(await launch.isEnabled(),true);
 assert.equal(await clipboardPanel.isVisible(),false);
 assert.equal(await actions.isVisible(),false);
 await page.waitForFunction(() => document.getElementById('browser-url').placeholder === 'Адрес сайта');
 await fitsOnScreen('#browser-open');
 assert.equal(await page.locator('[data-browser-url], .browser-bookmark').count(),0);
 if (await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) {
  await page.setViewportSize({width:844,height:320});
  assert.equal(await page.locator('#browser-start').isVisible(),false);
  assert.equal(await clipboardPanel.isVisible(),false);
  await fitsOnScreen('#browser-open');
  await fitsOnScreen('#browser-launch');
  await page.setViewportSize({width:320,height:740});
 }
 unavailable = true;
 await launch.click();
 await mobileState.getByText('Ошибка браузера',{exact:true}).waitFor();
 assert.equal(await page.locator('#browser-error-text').isVisible(),false);
 await errorDetails.locator('summary').click();
 assert.match(await errorDetails.innerText(), new RegExp(operationID));
 assert.equal(await page.locator('.toast.show').count(),0);
 unavailable = false;
 await page.locator('#browser-url').fill('example.org/mobile');
 await open.click();
 await mobileState.getByText('Подключено',{exact:true}).waitFor();
 assert.deepEqual(opened.splice(0),['https://example.org/mobile']);
 assert.equal(await errorDetails.isVisible(),false);
 assert.equal(await launch.isVisible(),false);
 assert.equal(await page.locator('#browser-fullscreen').isVisible(),false);
 await actions.click();
 const menu = page.locator('.menu-pop[role="menu"]');
 await menu.getByRole('menuitem',{name:'Качество: Сбалансированный'}).click();
 assert.equal(await page.locator('#browser-screen').getAttribute('data-quality'),'6');
 assert.equal(await page.evaluate(()=>localStorage.getItem('agentbox_browser_quality')),'balanced');
 await actions.click();
 await menu.getByRole('menuitem',{name:'Качество: Быстрый'}).click();
 if (await page.evaluate(() => document.fullscreenEnabled)) {
  await actions.click();
  await menu.getByRole('menuitem',{name:'Полноэкранный режим',exact:true}).click();
  await page.locator('#tab-browser:fullscreen').waitFor();
  await actions.click();
  await page.locator('#tab-browser .menu-pop').getByRole('menuitem',{name:'Выйти из полноэкранного режима'}).click();
  await page.locator('#tab-browser:fullscreen').waitFor({state:'detached'});
 }
 await actions.click();
 await menu.getByRole('menuitem',{name:'Буфер обмена',exact:true}).click();
 assert.equal(await clipboardPanel.isVisible(),true);
 assert.equal(await page.locator('#browser-paste').isEnabled(),true);
 assert.equal(await page.locator('#browser-copy').isVisible(),true);
 await fitsOnScreen('#browser-paste');
 await fitsOnScreen('#browser-copy');
 const clipboardText = '中文输入 ✓';
 await page.locator('#browser-clipboard').fill(clipboardText);
 await Promise.all([
  page.waitForResponse(r=>r.url().endsWith('/browser/clipboard') && r.request().method()==='POST'),
  page.locator('#browser-paste').click(),
 ]);
 assert.equal(clipboard,clipboardText);
 await clipboardPanel.locator('summary').click();
 assert.equal(await clipboardPanel.isVisible(),false);
 await page.setViewportSize({width:568,height:260});
 await actions.click();
 await fitsOnScreen('.menu-pop[role="menu"]');
 await menu.getByRole('menuitem',{name:'Закрыть браузер'}).click();
 await launch.waitFor();
 await page.waitForFunction(() => !document.getElementById('browser-launch').disabled);
 assert.equal(running,false);
 await page.setViewportSize({width:320,height:740});
 // A socket may open without sending a VNC greeting. Bound that wait so the
 // user can start again without reloading or switching tabs.
 await page.clock.install();
 await page.evaluate(() => { window.holdRemoteHandshake=true; window.testRemoteDesktop=null; });
 await launch.click();
 await mobileState.getByText('Подключение к браузеру…',{exact:true}).waitFor();
 await page.waitForFunction(() => window.testRemoteDesktop?.el === document.getElementById('browser-screen') &&
  !document.querySelector('#browser-screen').textContent && document.getElementById('browser-launch').disabled);
 assert.equal(await open.isEnabled(),false);
 await page.clock.fastForward(21_000);
 await mobileState.getByText('Ошибка браузера',{exact:true}).waitFor();
 await errorDetails.locator('summary').click();
 assert.match(await errorDetails.innerText(), /Время подключения к удалённому рабочему столу истекло/);
 assert.equal(await launch.isEnabled(),true);
 assert.deepEqual(opened.splice(0),['']);
 await page.evaluate(() => window.testRemoteDesktop.dispatchEvent(new Event('connect')));
 assert.equal(await actions.isVisible(),false);
 await page.evaluate(() => { window.holdRemoteHandshake=false; });
 await page.locator('#browser-url').fill('example.org/mobile-retry');
 await open.click();
 await mobileState.getByText('Подключено',{exact:true}).waitFor();
 assert.deepEqual(opened.splice(0),['https://example.org/mobile-retry']);
 await actions.click();
 await menu.getByRole('menuitem',{name:'Буфер обмена',exact:true}).click();
 await page.evaluate(() => window.testRemoteDesktop.dispatchEvent(new Event('securityfailure')));
 await mobileState.getByText('Ошибка браузера',{exact:true}).waitFor();
 await errorDetails.locator('summary').click();
 await page.evaluate(() => window.testRemoteDesktop.disconnect());
 await mobileState.getByText('Ошибка браузера',{exact:true}).waitFor();
 assert.equal(await actions.isVisible(),false);
 assert.equal(await clipboardPanel.isVisible(),false);
 assert.equal(await errorDetails.getAttribute('open'),'');
 assert.match(await errorDetails.innerText(), /Не удалось подключиться к удалённому рабочему столу/);
 await launch.click();
 await mobileState.getByText('Подключено',{exact:true}).waitFor();
 assert.equal(await errorDetails.isVisible(),false);
 assert.deepEqual(opened.splice(0),['']);
 await actions.click();
 await menu.getByRole('menuitem',{name:'Закрыть браузер'}).click();
 await launch.waitFor();
 await page.waitForFunction(() => !document.getElementById('browser-launch').disabled);
 await page.setViewportSize({width:1280,height:900});
 await page.getByText('Браузер закрыт · Сеанс входа сохранён',{exact:true}).waitFor();
 unavailable = true;
 await page.locator('#browser-start').click();
 const message = 'В текущем образе агента браузер не установлен. Попросите администратора собрать и выбрать образ agentbox-agent:browser. Затем остановите и снова запустите рабочее пространство. Идентификатор операции: ' + operationID;
 await page.getByText(message,{exact:true}).first().waitFor();
 assert.equal(await page.locator('#browser-state').textContent(),message);
 await page.locator('.toast').filter({hasText:message}).waitFor();
 await setLanguage('zh-CN');
 unavailable = false;
 await page.locator('#browser-start').click();
 await page.locator('#browser-state').filter({hasText:'已连接'}).waitFor();
 assert.deepEqual(opened,['']);
 assert.equal(await page.locator('#browser-screen').getAttribute('data-quality'),'3');
 await page.locator('#browser-quality').evaluate(el=>{el.value='clear';el.dispatchEvent(new Event('change',{bubbles:true}));});
 assert.equal(await page.locator('#browser-screen').getAttribute('data-quality'),'9');
 assert.equal(await page.evaluate(()=>localStorage.getItem('agentbox_browser_quality')),'clear');
 await page.locator('#browser-quality').evaluate(el=>{el.value='smooth';el.dispatchEvent(new Event('change',{bubbles:true}));});
 await page.locator('#browser-url').fill('example.org/test?q=中文');
 await page.locator('#browser-open').click();
 await page.waitForFunction(()=>!document.querySelector('#browser-open').disabled);
 assert.equal(opened.at(-1),'https://example.org/test?q=中文');
 assert.equal(await clipboardPanel.isVisible(),false);
 await page.evaluate(() => {
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async writeText(text) {
   window.remoteClipboardWrite = text;
   if (window.rejectRemoteClipboardWrite) throw new DOMException('Denied','NotAllowedError');
  }}});
 });
 const screen = page.locator('#browser-screen');
 await screen.press('Control+c');
 await page.waitForFunction(text=>window.remoteClipboardWrite === text,clipboardText);
 assert.equal(await clipboardPanel.isVisible(),false);
 await page.evaluate(() => { window.rejectRemoteClipboardWrite = true; });
 await screen.press('Control+c');
 await clipboardPanel.waitFor();
 assert.equal(await page.locator('#browser-clipboard').inputValue(),clipboardText);
 assert.equal(await page.locator('#browser-paste').isVisible(),false);
 assert.equal(await page.locator('#browser-copy').isVisible(),false);
 await fitsOnScreen('#browser-clipboard');
 await page.setViewportSize({width:780,height:740});
 await fitsOnScreen('#browser-clipboard');
 await page.setViewportSize({width:1280,height:900});
 await clipboardPanel.locator('summary').click();
 await clipboardPanel.waitFor({state:'hidden'});
 await screen.press('Control+c');
 await clipboardPanel.waitFor();
 await page.evaluate(() => { window.rejectRemoteClipboardWrite = false; });
 await screen.press('Control+c');
 await clipboardPanel.waitFor({state:'hidden'});
 await page.evaluate(() => { delete navigator.clipboard; });
 for (const theme of ["light","dark"]) {
 await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
 for (const width of [1440,900,390,320]) {
  await page.setViewportSize({width,height:900});
  await page.waitForTimeout(200);
  if (width<600 && await page.locator('#sidebar.open').count()) await page.locator('#btn-sidebar-close').click();
  await page.locator('.toast').waitFor({state:'hidden',timeout:10000}).catch(()=>{});
  assert.equal(await page.locator('body').evaluate(el=>el.scrollWidth<=innerWidth),true,'no page overflow');
  await mkdir('output/playwright',{recursive:true});
  await page.screenshot({path:`output/playwright/remote-browser-${theme}-${width}.png`});
 }
 }
 await page.evaluate(()=>document.documentElement.dataset.theme="light");
 await page.setViewportSize({width:1440,height:900});
 await page.locator('#browser-stop').click();
 await page.locator('#browser-state').filter({hasText:'浏览器已关闭'}).waitFor();
 assert.equal(running,false);

 hasNavigation = true;
 await setLanguage('ru');
 await page.locator('#browser-start').click();
 const strip = page.locator('#browser-tab-strip');
 const list = strip.locator('#browser-tab-list');
 const cards = list.locator('.browser-tab-card');
 const picker = page.locator('#browser-tabs');
 await cards.nth(35).waitFor();
 assert.equal(await picker.isVisible(),false);
 assert.equal(await list.evaluate(el=>el.scrollWidth > el.clientWidth),true);
 assert.equal(await cards.first().locator('.browser-tab-close').evaluate(el=>getComputedStyle(el).opacity),'0');
 const firstTitle = browserTabs[0].title;
 const farTitle = browserTabs.at(-1).title;
 await cards.last().locator('.browser-tab-select').click();
 await strip.getByRole('button',{name:farTitle,pressed:true,exact:true}).waitFor();
 assert.equal(await list.evaluate(el=>el.scrollLeft > 0),true);
 assert.equal(await page.locator('#browser-url').inputValue(),'https://example.org/36');
 await cards.last().hover();
 const closeTab = strip.getByRole('button',{name:`Закрыть вкладку «${farTitle}»`});
 assert.equal(await closeTab.evaluate(el=>getComputedStyle(el).opacity),'1');
 await closeTab.click();
 await strip.getByRole('button',{name:farTitle,exact:true}).waitFor({state:'detached'});
 assert.equal(await cards.count(),35);
 assert.equal(await cards.last().getByRole('button',{pressed:true}).count(),1);
 const addressInput = page.locator('#browser-url');
 const draft = 'https://example.org/draft';
 await addressInput.fill(draft);
 rejectClose = true;
 await Promise.all([
  page.waitForResponse(r=>r.url().endsWith('/browser/navigation') && r.status() === 409),
  cards.last().locator('.browser-tab-close').press('Enter'),
 ]);
 await cards.last().locator('.browser-tab-select[aria-pressed="true"][aria-disabled="false"]').waitFor();
 assert.equal(await addressInput.inputValue(),draft,'a failed close of the current tab preserves the address draft');
 rejectClose = false;
 await cards.first().scrollIntoViewIfNeeded();
 const neighborTitle = browserTabs[1].title;
 await strip.getByRole('button',{name:`Закрыть вкладку «${firstTitle}»`}).press('Enter');
 await strip.getByRole('button',{name:firstTitle,exact:true}).waitFor({state:'detached'});
 assert.equal(await cards.last().getByRole('button',{pressed:true}).count(),1);
 assert.equal(await cards.count(),34);
 assert.deepEqual({address:await addressInput.inputValue(), focus:await page.locator(':focus').textContent()},
  {address:draft,focus:neighborTitle},'closing another tab preserves the address draft and moves keyboard focus to a neighbor');
 await addressInput.press('Escape');
 for (const width of [1440,900,780]) {
  await page.setViewportSize({width,height:900});
  const address = await page.locator('#browser-address').boundingBox();
  const tabs = await strip.boundingBox();
  assert.ok(address.x + address.width <= tabs.x && Math.abs(address.y - tabs.y) < 10,
   `address and tabs share a row at ${width}px`);
  await fitsOnScreen('#browser-new-tab');
  await fitsOnScreen('#browser-fullscreen');
  assert.equal(await page.locator('body').evaluate(el=>el.scrollWidth <= innerWidth),true);
  if (process.env.AGENTBOX_BROWSER_TAB_SCREENSHOTS === '1') {
   await page.locator('.browser-toolbar').screenshot({path:`output/playwright/remote-browser-tabs-${width}.png`});
  }
 }
 await cards.last().locator('.browser-tab-select').focus();
 await page.setViewportSize({width:320,height:740});
 await picker.waitFor();
 assert.equal(await strip.isVisible(),false);
 assert.equal(await picker.evaluate(el=>el === document.activeElement),true,'the mobile tab picker inherits focus from the desktop strip');
 await picker.click();
 const mobileTab = browserTabs[1];
 await menu.getByRole('menuitemradio',{name:mobileTab.title,exact:true}).click();
 await page.waitForFunction(url=>document.querySelector('#browser-url').value === url,mobileTab.url);
 await picker.click();
 await menu.getByRole('menuitem',{name:'Закрыть текущую вкладку',exact:true}).click();
 await page.waitForFunction(url=>document.querySelector('#browser-url').value !== url,mobileTab.url);
 assert.equal(browserTabs.length,33);
 await picker.focus();
 await page.setViewportSize({width:1440,height:900});
 await strip.waitFor();
 assert.equal(await strip.getByRole('button',{pressed:true}).evaluate(el=>el === document.activeElement),true,
  'the desktop active tab inherits focus from the mobile tab picker');
 const remoteTab = browserTabs.at(-1);
 activeTab = remoteTab.id;
 browserTabs = [remoteTab];
 await strip.getByRole('button',{name:remoteTab.title,exact:true,pressed:true}).waitFor();
 assert.equal(await cards.count(),1);
 assert.equal(await cards.first().locator('.browser-tab-close').isDisabled(),true);
 assert.equal(await list.evaluate(el=>el.scrollLeft),0);
 await page.locator('#browser-stop').click();
 await page.waitForFunction(() => !document.getElementById('browser-start').disabled);
 await setLanguage('zh-CN');
 hasNavigation = false;
 // Late startup must not reconnect a desktop after switching workspace/tab.
 let release;
 delayResolve = resolve => {release=resolve;};
 await page.locator('#browser-start').click();
 await page.locator('[data-tab="files"]').click();
 await page.waitForFunction(()=>document.querySelector('#tab-browser').classList.contains('hidden'));
 release(); delayResolve=null;
 await page.waitForTimeout(100);
 assert.equal(await page.locator('#browser-screen').innerText(),'');
 console.log('Browser layouts: desktop clipboard fallback, mobile clipboard controls, responsive tab strip and keyboard focus passed');
 await page.unroute('**/vendor/novnc/core/rfb.js');
 await page.unroute('**/api/sessions/*/browser');
 await page.unroute('**/api/sessions/*/browser/navigation*');
 await page.unroute(clipboardRoute);
}
