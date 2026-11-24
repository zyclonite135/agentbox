import {launchBrowser} from './playwright-launch.mjs';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
let raw=''; for await (const chunk of process.stdin) raw+=chunk;
const {base,password,session,token}=JSON.parse(raw);
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

const browser=await launchBrowser();
try {
 const page=await browser.newPage({locale:'en-US',viewport:{width:1600,height:1100}});
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
 for(let i=0;i<50;i++){
  const response=await page.request.get(`${base}/api/sessions/${session}/file?path=browser-hits`,{headers:{Authorization:'Bearer '+token}});
  if((await response.text()).includes('/typed?value='+encodeURIComponent('真实远程桌面 ✓')))break;
  if(i===49)throw new Error('UTF-8 clipboard did not reach the real browser input');
  await page.waitForTimeout(100);
 }
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
  await page.getByRole('menuitem', {name:'New tab', exact:true}).last().click();
  await page.waitForFunction(() => document.querySelector('#browser-url').value === '');
  await chromeControl.click();
  await page.getByRole('menuitem', {name:'/navigated', exact:true}).click();
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
 await phone.screenshot({path:'output/playwright/remote-browser-live-mobile.png'});
 assert.equal(await phone.locator('body').evaluate(el=>el.scrollWidth<=innerWidth),true);
 await phone.setViewportSize({width:844,height:390});
 await waitForFittedDesktop(phone);
 await phone.setViewportSize({width:390,height:900});
 await waitForFittedDesktop(phone, true);
 assert.deepEqual(errors,[]);
 console.log('Real noVNC: resized framebuffer and remote page, mobile layout and clipboard controls passed');
} finally {await browser.close();}
