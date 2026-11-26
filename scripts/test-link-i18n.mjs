#!/usr/bin/env node
// Standalone abox-link UI fixture. No real pairing, credentials, or tunnel.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import en from '../internal/linkapp/static/locales/en.js';
import zhTW from '../internal/linkapp/static/locales/zh-TW.js';
import ru from '../internal/linkapp/static/locales/ru.js';

export async function linkI18nSmoke(page) {
  page.setDefaultTimeout(10000);
  const root = fileURLToPath(new URL('../internal/linkapp/static/', import.meta.url));
  const failures = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const path = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
      if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
      const data = await readFile(path);
      res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(path)] || 'application/octet-stream');
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let state = { version:"fixture", paired:false, running:false, user:"", server:"", auto_connect:false, insecure:false, folders:[], status:{state:"stopped"}, autostart:{supported:true,installed:false} };
  let holdFolder, folderRequested;
  await page.route("**/api/**", async route => {
    try {
      const req=route.request(), path=new URL(req.url()).pathname;
      assert.equal(req.headers()["x-abox-panel"],"1");
      if(path==="/api/logs") return route.fulfill({json:{latest:0,lines:[]}});
      if(path==="/api/pair"){
        assert.deepEqual(req.postDataJSON(),{code:"ABOX1-fixture",insecure:false});
        state={...state,paired:true,user:"fixture",server:"https://example.invalid"};
      } else if(path==="/api/start"){
        state={...state,running:true,status:{state:"online",since:Date.now(),ping_ms:12}};
      } else if(path==="/api/config"){
        assert.deepEqual(req.postDataJSON(),{auto_connect:true});
        state={...state,auto_connect:true};
      } else if(path==="/api/folders"){
        const folder=req.postDataJSON();
        if(!folder.id) await new Promise(resolve=>{holdFolder=resolve;folderRequested();});
        state={...state,folders:folder.id?[]:[{id:"folder-fixture-01",...folder}]};
      } else if(path==="/api/unpair"){
        state={...state,paired:false,running:false,folders:[],status:{state:"stopped"}};
      } else assert.equal(path,"/api/state");
      await route.fulfill({json:state});
    } catch(error){failures.push(error.message);await route.abort();}
  });
  try {
    await page.goto(base);
    const language=page.locator("#interface-language");
    await page.locator("#card-pair").waitFor({state:"visible"});
    for(const locale of ["en","zh-TW","ru"]){
      await language.selectOption(locale);
      assert.equal(await page.locator("html").getAttribute("lang"),locale);
    }
    assert.equal(await page.title(),"abox-link · Общие папки");
    await page.locator("#btn-pair").click();
    assert.equal(await page.locator("#pair-err").textContent(),"Сначала вставьте код сопряжения");
    await page.locator("#pair-code").fill("ABOX1-fixture");
    await page.locator("#btn-pair").click();
    await page.locator("#panel-body").waitFor({state:"visible"});
    await page.locator("#btn-toggle").click();
    await page.locator("#st-title").filter({hasText:"Устройство подключено"}).waitFor();
    assert.equal(await page.locator("#allow-list,#map-list,#opt-transparent").count(),0);
    await page.locator("#opt-auto").check();
    await page.waitForFunction(()=>!document.querySelector("#opt-auto").disabled);
    const requested=new Promise(resolve=>{folderRequested=resolve;});
    const name=page.locator("#local-folder-name");
    await name.fill("Документы <script>");
    await page.locator("#local-folder-path").fill("C:\\Документы\\Обмен");
    await page.getByRole("button",{name:"Добавить папку"}).click();
    await requested;
    try { await name.fill("Следующая папка"); } finally { holdFolder(); }
    const row=page.locator(".local-folder-row");
    await row.filter({hasText:"Документы <script>"}).waitFor();
    assert.equal(await name.inputValue(),"Следующая папка");
    assert.equal(await row.locator("script").count(),0);
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:900});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    }
    await row.getByRole("button",{name:"Убрать папку"}).click();
    await row.waitFor({state:"detached"});
    page.once("dialog",dialog=>dialog.accept());
    await page.locator("#btn-unpair").click();
    await page.locator("#card-pair").waitFor({state:"visible"});
    for(const t of [en,zhTW,ru]) assert.ok(t["文件共享"]);
    assert.deepEqual(failures,[]);
    assert.deepEqual(errors,[]);
    console.log("abox-link: pairing, connection, shared folders, locale switching and narrow layout passed");
  } finally {
    await page.unroute("**/api/**");
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { chromium } = await import(process.env.AGENTBOX_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.AGENTBOX_PLAYWRIGHT_MODULE).href : 'playwright');
  const browser = await chromium.launch({ headless: true, ...(process.env.AGENTBOX_BROWSER_CHANNEL ? { channel: process.env.AGENTBOX_BROWSER_CHANNEL } : {}) });
  try { await linkI18nSmoke(await browser.newPage()); } finally { await browser.close(); }
}
