import {launchBrowser} from './playwright-launch.mjs';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
let raw=''; for await (const chunk of process.stdin) raw+=chunk;
const {base,password,session,token}=JSON.parse(raw);
async function waitForFittedDesktop(page) {
 await page.waitForFunction(() => {
  const screen = document.querySelector('#browser-screen');
  const canvas = screen.querySelector('canvas');
  if (!canvas) return false;
  const bounds = screen.getBoundingClientRect();
  const image = canvas.getBoundingClientRect();
  return canvas.width === Math.max(512, Math.floor(bounds.width)) && canvas.height === Math.floor(bounds.height) &&
   image.left >= bounds.left - 1 && image.right <= bounds.right + 1 &&
   image.top >= bounds.top - 1 && image.bottom <= bounds.bottom + 1;
 }, null, {timeout:10000});
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

const browser=await launchBrowser();
try {
 const page=await browser.newPage({viewport:{width:1600,height:1100}});
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
 await page.locator('#browser-fullscreen').click();
 await page.waitForFunction(() => document.fullscreenElement?.id === 'tab-browser');
 await waitForFittedDesktop(page);
 await page.locator('#browser-fullscreen').click();
 await page.waitForFunction(() => !document.fullscreenElement);
 await waitForFittedDesktop(page);
 await page.setViewportSize({width:390,height:900});
 await page.waitForTimeout(200);
 if(await page.locator('#sidebar.open').count())await page.locator('#btn-sidebar-close').click();
 await page.waitForFunction(()=>!document.querySelector('#sidebar').classList.contains('open'));
 await waitForFittedDesktop(page);
 await waitForRemotePageWidth(page, canvas);
 await page.screenshot({path:'output/playwright/remote-browser-live-mobile.png'});
 assert.equal(await page.locator('body').evaluate(el=>el.scrollWidth<=innerWidth),true);
 assert.deepEqual(errors,[]);
 console.log('Real noVNC: resized framebuffer and remote page, mobile layout and clipboard controls passed');
} finally {await browser.close();}
