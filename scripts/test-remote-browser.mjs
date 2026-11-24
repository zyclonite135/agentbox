import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

// UI state regression with synthetic transport. Real RFB is exercised separately
// by test-remote-browser-live.py against Docker and the embedded noVNC module.
export async function remoteBrowserSmoke(page) {
 let running = false, unavailable = false, clipboard = '', delayResolve;
 const opened = [];
 const operationID = '0123456789abcdef0123456789abcdef';
 await page.route('**/vendor/novnc/core/rfb.js', route => route.fulfill({contentType:'text/javascript',body:`
 export default class extends EventTarget {
 constructor(el,url){
  super();this.el=el;window.testRemoteDesktop=this;
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
  await route.fulfill({json:{available:!unavailable,running,browser:'Google Chrome',proxy:false}});
 });
 await page.route('**/api/sessions/*/browser/clipboard',async route=>{
  if(route.request().method()==='POST')clipboard=route.request().postDataJSON().text;
  await route.fulfill({json:{text:clipboard}});
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
 await fitsOnScreen('[data-browser-url="https://chatgpt.com/"]');
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
 await page.locator('[data-browser-url="https://chatgpt.com/"]').click();
 await mobileState.getByText('Подключено',{exact:true}).waitFor();
 assert.deepEqual(opened.splice(0),['https://chatgpt.com/']);
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
 await page.locator('[data-browser-url="https://claude.ai/"]').click();
 await page.locator('#browser-state').filter({hasText:'已连接'}).waitFor();
 assert.deepEqual(opened,['https://claude.ai/']);
 assert.equal(await page.locator('#browser-screen').getAttribute('data-quality'),'3');
 await page.locator('#browser-quality').evaluate(el=>{el.value='clear';el.dispatchEvent(new Event('change',{bubbles:true}));});
 assert.equal(await page.locator('#browser-screen').getAttribute('data-quality'),'9');
 assert.equal(await page.evaluate(()=>localStorage.getItem('agentbox_browser_quality')),'clear');
 await page.locator('#browser-quality').evaluate(el=>{el.value='smooth';el.dispatchEvent(new Event('change',{bubbles:true}));});
 await page.locator('#browser-url').fill('example.org/test?q=中文');
 await page.locator('#browser-open').click();
 await page.waitForFunction(()=>!document.querySelector('#browser-open').disabled);
 assert.equal(opened.at(-1),'https://example.org/test?q=中文');
 await page.locator('.browser-clipboard summary').click();
 await page.locator('#browser-clipboard').fill('中文输入 ✓');
 await page.locator('#browser-paste').click();
 await page.waitForResponse(r=>r.url().includes('/browser/clipboard')&&r.request().method()==='GET', {timeout:500}).catch(()=>{});
 await page.locator('#browser-copy').click();
 await page.waitForFunction(()=>document.querySelector('#browser-clipboard').value==='中文输入 ✓');
 assert.equal(clipboard,'中文输入 ✓');
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
 // Late startup must not reconnect a desktop after switching workspace/tab.
 let release;
 delayResolve = resolve => {release=resolve;};
 await page.locator('#browser-start').click();
 await page.locator('[data-tab="files"]').click();
 await page.waitForFunction(()=>document.querySelector('#tab-browser').classList.contains('hidden'));
 release(); delayResolve=null;
 await page.waitForTimeout(100);
 assert.equal(await page.locator('#browser-screen').innerText(),'');
 await page.unroute('**/vendor/novnc/core/rfb.js');
 await page.unroute('**/api/sessions/*/browser');
 await page.unroute('**/api/sessions/*/browser/clipboard');
}
