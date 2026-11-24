import {browserEngine, clipboardPermissions, launchBrowser, readClipboard} from './playwright-launch.mjs';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
let raw=''; for await (const chunk of process.stdin) raw+=chunk;
const {base,password,session,token}=JSON.parse(raw);
async function setLocalClipboard(page, text) {
 const scratch = await page.evaluateHandle(value => {
  const field = document.createElement('textarea');
  field.style.cssText = 'position:fixed;left:0;top:0;opacity:0';
  field.value = value;
  document.body.append(field);
  field.select();
  return field;
 }, text);
 try { await page.keyboard.press('ControlOrMeta+C'); }
 finally { await scratch.evaluate(field => field.remove()); await scratch.dispose(); }
}

async function expectRemoteInput(page, text) {
 for (let attempt = 0; attempt < 50; attempt++) {
  const response = await page.request.get(`${base}/api/sessions/${session}/file?path=browser-hits`,
   {headers:{Authorization:'Bearer '+token}});
  if ((await response.text()).includes('/typed?value='+encodeURIComponent(text)+' ')) return;
  await page.waitForTimeout(100);
 }
 throw new Error('Clipboard text did not reach the remote input');
}

async function checkClipboardShortcuts(page, canvas) {
 const fromDevice = 'Местный буфер — 中文 ✓';
 await setLocalClipboard(page, fromDevice);
 await canvas.focus();
 await page.keyboard.press('Control+a');
 await page.keyboard.press('ControlOrMeta+V');
 await expectRemoteInput(page, fromDevice);

 const current = await page.request.get(`${base}/api/sessions/${session}/browser/clipboard?revision=1`,
  {headers:{Authorization:'Bearer '+token}});
 assert.equal(typeof (await current.json()).revision, 'number');
 await setLocalClipboard(page, 'sentinel');
 await canvas.focus();
 await page.keyboard.press('Control+a');
 await page.keyboard.press('ControlOrMeta+C');
 await page.waitForFunction(text => window.acceptedClipboardWrites[0] === text, fromDevice);
 // Windows Playwright WebKit resolves writes but its OS pasteboard is empty
 // even for a direct writeText() probe. Check its accepted payload instead.
 if (browserEngine() !== 'webkit') assert.equal(await readClipboard(page), fromDevice);

 const markerY = await chromeFrameHeight(page, 40, 220);
 const position = {x:105, y:markerY+214};
 async function openNativeMenu() {
  await Promise.all([
   page.waitForResponse(r => r.url().endsWith('/browser/clipboard?revision=1') && r.ok()),
   canvas.click({button:'right',position}),
  ]);
  // The dark Copy label appears over a previously blank part of the textarea.
  await page.waitForFunction(({x,y}) => {
   const canvas = document.querySelector('#browser-screen canvas');
   const pixels = canvas.getContext('2d').getImageData(x+42,y+35,30,16).data;
   return pixels.some((value, index) => index % 4 === 0 && value < 96);
  }, position, {timeout:5000});
 }
 // Chrome for Testing's native editable-field menu begins with Cut, Copy, Paste.
 await setLocalClipboard(page, 'context sentinel');
 await canvas.focus();
 await openNativeMenu();
 await canvas.click({position:{x:position.x+60,y:position.y+44}});
 await page.waitForFunction(text => window.acceptedClipboardWrites[1] === text, fromDevice);
 if (browserEngine() !== 'webkit') assert.equal(await readClipboard(page), fromDevice);

 const staged = 'Меню Paste — 中文 ✓';
 await page.locator('#browser-clipboard').fill(staged);
 await Promise.all([
  page.waitForResponse(r => r.url().endsWith('/browser/clipboard') && r.request().method() === 'POST' && r.ok()),
  page.locator('#browser-stage-clipboard').click(),
 ]);
 await canvas.focus();
 await page.keyboard.press('Control+a');
 await openNativeMenu();
 await canvas.click({position:{x:position.x+60,y:position.y+72}});
 await expectRemoteInput(page, staged);
 console.log('Bidirectional UTF-8 keyboard clipboard, Chrome native Copy and prepared Paste passed');
}
async function waitForFittedDesktop(page, fillPortrait = false) {
 await page.waitForFunction(fillPortrait => {
  const screen = document.querySelector('#browser-screen');
  const canvas = screen.querySelector('canvas');
  if (!canvas) return false;
  const bounds = screen.getBoundingClientRect();
  const image = canvas.getBoundingClientRect();
  const width = Math.max(512, Math.floor(bounds.width));
  const height = fillPortrait ? Math.round(bounds.height * width / bounds.width) : Math.floor(bounds.height);
  return canvas.width === width && canvas.height === height &&
   image.left >= bounds.left - 1 && image.right <= bounds.right + 1 &&
   image.top >= bounds.top - 1 && image.bottom <= bounds.bottom + 1 &&
   (!fillPortrait || (Math.abs(image.width - bounds.width) <= 2 && Math.abs(image.height - bounds.height) <= 2));
 }, fillPortrait, {timeout:10000});
}

async function waitForRemotePageWidth(page, canvas) {
 const expectedWidth = await canvas.evaluate(el => el.width);
 for (let attempt = 0; attempt < 50; attempt++) {
  const response = await page.request.get(`${base}/api/sessions/${session}/file?path=browser-hits`, {headers:{Authorization:'Bearer '+token}});
  const widths = Array.from((await response.text()).matchAll(/\/viewport\?width=(\d+) /g), match => Number(match[1]));
  if (widths.some(width => width <= expectedWidth && width >= expectedWidth - 16)) return;
  await page.waitForTimeout(100);
 }
 throw new Error(`The remote page did not fit the ${expectedWidth}px framebuffer`);
}

async function chromeFrameHeight(page, min, max) {
 // The colored marker begins at the top of the site, below any native chrome.
 const handle = await page.waitForFunction(({min,max}) => {
  const canvas = document.querySelector('#browser-screen canvas');
  if (!canvas?.width) return false;
  const pixels = canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), 0, 1, Math.min(220, canvas.height)).data;
  for (let y = 0; y < pixels.length / 4; y++) {
   const [r,g,b] = pixels.subarray(y * 4, y * 4 + 3);
   if (r > 200 && g < 75 && b > 100 && b < 200) return y >= min && y <= max ? {y} : false;
  }
  return false;
 }, {min,max}, {timeout:10000});
 return (await handle.jsonValue()).y;
}

async function expectTabFavicon(page) {
 const row = page.getByRole('menuitemradio', {name:'/navigated', exact:true});
 const image = row.locator('img');
 await image.waitFor({timeout:8000});
 assert.equal(await image.evaluate(el => el.getBoundingClientRect().width), 16);
 const pixel = await image.evaluate(el => {
  const canvas = document.createElement('canvas');
  const drawing = canvas.getContext('2d');
  drawing.drawImage(el, 0, 0);
  return [...drawing.getImageData(8, 8, 1, 1).data];
 });
 assert.deepEqual(pixel, [0, 192, 128, 255]);
}

async function checkFaviconMenuLifecycle(page, picker) {
 const filter = url => url.pathname.endsWith('/browser/navigation') && url.searchParams.has('favicon');
 let reads = 0;
 let release;
 const holdResponse = new Promise(resolve => { release = resolve; });
 await page.route(filter, async route => {
  reads++;
  await holdResponse;
  await route.continue();
 });
 try {
  await Promise.all([page.waitForRequest(request => filter(new URL(request.url()))), picker.click()]);
  await picker.click();
  await picker.click();
  release();
  await expectTabFavicon(page);
  assert.equal(reads, 1, 'Reopening the same menu should share the pending favicon lookup');
  await page.evaluate(id => { location.hash = `/sessions/${id}/files`; }, session);
  await page.locator('#tab-files').waitFor();
  assert.equal(await picker.getAttribute('aria-expanded'), 'false', 'The tab menu must close on navigation away');
  await page.evaluate(id => { location.hash = `/sessions/${id}/browser`; }, session);
  await picker.waitFor();
 } finally {
  release();
  await page.unroute(filter);
 }
}

async function checkFaviconBatches(page, picker) {
 const filter = url => url.pathname.endsWith('/browser/navigation');
 const tabs = Array.from({length:27}, (_, index) => ({
  id:`tab-${index}`, title:`Synthetic tab ${index}`, url:`http://fixture.invalid/tab-${index}`,
 }));
 const favicon = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFUlEQVR4nGNgONBAGhrVMKph+GoAAJ+3QBAm9UphAAAAAElFTkSuQmCC';
 const batches = [];
 await page.route(filter, async route => {
  const requested = new URL(route.request().url()).searchParams.getAll('favicon');
  if (!requested.length) {
   await route.fulfill({json:{tabs, active:tabs[0].id, back:false, forward:false}});
   return;
  }
  batches.push(requested);
  await route.fulfill({json:{tabs:tabs.filter(tab => requested.includes(tab.id) && tab !== tabs[0])
   .map(tab => ({...tab, url:tab === tabs[1] ? tab.url + '/stale' : tab.url, favicon}))}});
 });
 try {
  await page.waitForFunction(() => document.querySelector('#browser-url').value.endsWith('fixture.invalid/tab-0'));
  await picker.click();
  const rows = page.getByRole('menuitemradio');
  assert.equal(await rows.count(), tabs.length);
  await rows.last().scrollIntoViewIfNeeded();
  await rows.last().locator('img').waitFor();
  await rows.nth(2).locator('img').waitFor();
  assert.equal(await rows.nth(0).locator('.glyph svg').count(), 1);
  assert.equal(await rows.nth(1).locator('.glyph svg').count(), 1);
  assert.deepEqual(batches.map(batch => batch.length).sort((a, b) => a - b), [3, 24]);
  assert.deepEqual(batches.flat().sort(), tabs.map(tab => tab.id).sort());
  await page.keyboard.press('Escape');
 } finally {
  await page.unroute(filter);
 }
 await page.waitForFunction(() => document.querySelector('#browser-url').value.endsWith('/navigated'));
}

const browser=await launchBrowser();
try {
 const checkClipboard = process.env.AGENTBOX_REQUIRE_BROWSER_CLIPBOARD === '1';
 const page=await browser.newPage({locale:'en-US',viewport:{width:1600,height:1100},permissions:checkClipboard?clipboardPermissions():[]});
 if (checkClipboard) await page.addInitScript(() => {
  const clipboard = navigator.clipboard;
  if (!clipboard?.write) return;
  window.acceptedClipboardWrites = [];
  const write = clipboard.write.bind(clipboard);
  clipboard.write = async items => {
   await write(items);
   window.acceptedClipboardWrites.push(await (await items[0].getType('text/plain')).text());
  };
 });
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${base}/#/sessions/${session}/browser`);
 await page.locator('#login-user').fill('boxadmin');
 await page.locator('#login-pass').fill(password);
 await page.locator('#login-btn').click();
 await page.locator('#tab-browser[data-connected]').waitFor({timeout:30000});
 await waitForFittedDesktop(page);
 // Allow the initial full framebuffer to arrive before checking its pixels.
 await page.waitForFunction(()=>{
  const canvas=document.querySelector('#browser-screen canvas');
  const data=canvas.getContext('2d').getImageData(100,150,200,200).data;
  return data.some((v,i)=>i%4!==3&&v>100);
 });
 const canvas=page.locator('#browser-screen canvas');
 const rect=await canvas.boundingBox();
 await canvas.click({position:{x:rect.width*.25,y:rect.height*.38}});
 await page.locator('.browser-clipboard summary').click();
 await waitForFittedDesktop(page);
 await page.locator('#browser-clipboard').fill('真实远程桌面 ✓');
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/browser/clipboard')&&r.request().method()==='POST'),page.locator('#browser-paste').click()]);
 await expectRemoteInput(page, '真实远程桌面 ✓');
 if (checkClipboard) await checkClipboardShortcuts(page, canvas);
 await page.waitForTimeout(300);
 await mkdir('output/playwright',{recursive:true});
 await page.screenshot({path:'output/playwright/remote-browser-live.png'});
 await page.locator('.browser-clipboard summary').click();
 await page.setViewportSize({width:2120,height:920});
 await waitForFittedDesktop(page);
 await waitForRemotePageWidth(page, canvas);
 const address = page.locator('#browser-url');
 const chromeControl = page.locator('#browser-tabs');
 if (process.env.AGENTBOX_REQUIRE_BROWSER_NAVIGATION === '1') await chromeControl.waitFor({state:'visible'});
 const navigationSupported = await chromeControl.isVisible();
 const requireFavicons = process.env.AGENTBOX_REQUIRE_BROWSER_FAVICONS === '1';
 let beforeFullscreen;
 if (navigationSupported) {
  await page.waitForFunction(() => document.querySelector('#browser-url').value.endsWith('/check'));
  const navigationRoute = '**/api/sessions/*/browser/navigation';
  let releaseNavigation;
  const heldNavigation = new Promise(resolve => { releaseNavigation = resolve; });
  await page.route(navigationRoute, async route => {
   if (route.request().method() === 'POST') await heldNavigation;
   await route.continue();
  });
  await address.fill('http://127.0.0.1:8765/navigated');
  try {
   await Promise.all([
    page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/browser/navigation')),
    address.press('Enter'),
   ]);
   const draft = 'http://127.0.0.1:8765/next';
   await address.fill(draft);
   await address.press('Enter');
   await address.evaluate(el => el.form.dispatchEvent(new Event('submit', {cancelable:true, bubbles:true})));
   assert.equal(await page.locator('#browser-open').isDisabled(), true);
   releaseNavigation();
   await page.waitForFunction(() => !document.querySelector('#browser-back').disabled);
   assert.equal(await address.inputValue(), draft, 'A pending navigation must preserve the next draft');
   await address.press('Escape');
   assert.equal(await address.inputValue(), 'http://127.0.0.1:8765/navigated');
  } finally {
   releaseNavigation();
   await page.unroute(navigationRoute);
  }
  await page.waitForFunction(() => !document.querySelector('#browser-back').disabled);
  await page.locator('#browser-back').click();
  await page.waitForFunction(() => document.querySelector('#browser-url').value.endsWith('/check'));
  await page.locator('#browser-forward').click();
  await page.waitForFunction(() => document.querySelector('#browser-url').value.endsWith('/navigated'));
  await page.locator('#browser-reload').click();
  beforeFullscreen = await chromeFrameHeight(page, 40, 220);
 }
 await page.locator('#browser-fullscreen').click();
 await page.waitForFunction(() => document.fullscreenElement?.id === 'tab-browser');
 await waitForFittedDesktop(page);
 if (navigationSupported) {
  await chromeFrameHeight(page, 0, beforeFullscreen - 40);
  await chromeControl.click();
  assert.equal(await page.getByRole('menuitemradio', {name:'/navigated', exact:true}).getAttribute('aria-checked'), 'true');
  if (requireFavicons) await expectTabFavicon(page);
  await page.getByRole('menuitem', {name:'New tab', exact:true}).last().click();
  await page.waitForFunction(() => document.querySelector('#browser-url').value === '');
  await chromeControl.click();
  if (requireFavicons) {
   const blank = page.getByRole('menuitemradio', {checked:true});
   await blank.locator('.glyph svg').waitFor();
   await expectTabFavicon(page);
   assert.equal(await blank.locator('img').count(), 0);
  }
  await page.getByRole('menuitemradio', {name:'/navigated', exact:true}).click();
  await page.waitForFunction(() => document.querySelector('#browser-url').value.endsWith('/navigated'));
 }
 await page.locator('#browser-fullscreen').click();
 await page.waitForFunction(() => !document.fullscreenElement);
 await waitForFittedDesktop(page);
 if (navigationSupported) {
  await chromeFrameHeight(page, 40, 220);
  await page.locator('#browser-fullscreen').click();
  await chromeFrameHeight(page, 0, beforeFullscreen - 40);
  await page.evaluate(() => document.exitFullscreen());
  await waitForFittedDesktop(page);
  await chromeFrameHeight(page, 40, 220);
  if (requireFavicons) {
   await checkFaviconMenuLifecycle(page, chromeControl);
   await checkFaviconBatches(page, chromeControl);
   console.log('Favicon menu reopens, navigation away and batches over 24 tabs passed');
  }
  console.log('Real Chrome navigation, tabs and native toolbar visibility on fullscreen enter/exit passed');
 }
 const storageState = await page.context().storageState();
 await page.close();
 const phone = await browser.newPage({storageState, isMobile:true, hasTouch:true, deviceScaleFactor:3, viewport:{width:360,height:780}});
 phone.on('pageerror',e=>errors.push(e.message));
 await phone.goto(`${base}/#/sessions/${session}/browser`);
 await phone.locator('#tab-browser[data-connected]').waitFor({timeout:30000});
 await waitForFittedDesktop(phone, true);
 await waitForRemotePageWidth(phone, phone.locator('#browser-screen canvas'));
 if (requireFavicons) {
  await phone.locator('#browser-tabs').click();
  await expectTabFavicon(phone);
  assert.equal(await phone.getByRole('menu').evaluate(el => {
   const bounds = el.getBoundingClientRect();
   return bounds.left >= 0 && bounds.right <= innerWidth;
  }), true);
  await phone.keyboard.press('Escape');
  console.log('Chrome favicon pixels, active tab and blank-tab fallback passed on desktop and mobile layouts');
 }
 await phone.screenshot({path:'output/playwright/remote-browser-live-mobile.png'});
 assert.equal(await phone.locator('body').evaluate(el=>el.scrollWidth<=innerWidth),true);
 await phone.setViewportSize({width:844,height:390});
 await waitForFittedDesktop(phone);
 await phone.setViewportSize({width:390,height:900});
 await waitForFittedDesktop(phone, true);
 assert.deepEqual(errors,[]);
 console.log('Real noVNC: resized framebuffer and remote page, mobile layout and clipboard controls passed');
} finally {await browser.close();}
