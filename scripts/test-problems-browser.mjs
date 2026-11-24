import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import en from '../internal/web/static/js/locales/en-dynamic.js';
import tw from '../internal/web/static/js/locales/zh-TW-dynamic.js';
import {problemMessages} from '../internal/web/static/js/problems.js';

const id = '0123456789abcdef0123456789abcdef';
const language = (page, locale) => page.evaluate(async locale => {
  const {i18n} = await import('/_v/{{BUILD}}/js/i18n.js');
  i18n.setLanguage(locale);
}, locale);
const expected = (code, locale) => problemMessages[code].map(text => locale === 'en' ? en[text] : locale === 'zh-TW' ? tw[text] : text);
const problem = code => ({code, error:'synthetic-secret /private/config.json',hint:'synthetic-secret',operation_id:id,action:'contact_admin',retryable:false});

async function mobileDeliverySmoke(page) {
  const scope='a'.repeat(64), thread='mobile-receipt-thread';
  const mePath='**/api/me', historyPath=/\/sessions\/fixture-space\/history(?:\?|$)/;
  const receiptPath=/\/sessions\/fixture-space\/chat\/requests(?:[/?]|$)/;
  const me=route=>route.fulfill({json:{user:'fixture',role:'admin',timezone:'UTC',draft_protocol:1,draft_scope:scope,chat_protocol:1,chat_scope:scope}});
  const history=route=>route.fulfill({json:{entries:[],active_thread:thread}});
  const receipts=route=>route.fulfill({status:503,json:{code:'internal_error'}});
  await page.route(mePath,me);
  await page.route(historyPath,history);
  await page.route(receiptPath,receipts);
  try {
    await page.reload();
    await language(page,'en');
    const delivery=page.locator('#chat-delivery');
    const status=page.locator('#chat-delivery-status');
    await status.filter({hasText:'Message status unavailable'}).waitFor();
    await page.evaluate(()=>{
      Object.defineProperty(navigator,'onLine',{configurable:true,value:false});
      window.dispatchEvent(new Event('offline'));
    });
    await delivery.waitFor({state:'hidden'});
    await page.evaluate(({scope,thread,id})=>{
      const key='agentbox.chat-outbox.v1.'+scope+'.'+id;
      localStorage.setItem(key,JSON.stringify({version:1,id,session:'fixture-space',thread,created:Date.now(),
        input:{scope,thread_id:thread,text:'Saved example',model:'fixture',effort:'',effort_control:''},draft:null,revision:0,state:'unconfirmed'}));
      window.dispatchEvent(new StorageEvent('storage',{key}));
    },{scope,thread,id});
    await status.filter({hasText:'Message saved'}).waitFor();
    await delivery.getByRole('button',{name:'Check status'}).waitFor();
    await page.evaluate(()=>{
      const getItem=Storage.prototype.getItem;
      Storage.prototype.getItem=function(key) {
        if (key.startsWith('agentbox.chat-draft.v1.') && key.endsWith('.enabled')) {
          throw new DOMException('Synthetic storage failure','SecurityError');
        }
        return getItem.call(this,key);
      };
      try { window.dispatchEvent(new Event('offline')); }
      finally { Storage.prototype.getItem=getItem; }
    });
    await status.filter({hasText:en['本机待确认副本保存失败，请保留本页并检查存储设置。']}).waitFor();
    assert.ok(await delivery.isVisible(),'connection status must not hide a local storage error');
  } finally {
    await page.evaluate(({scope,id})=>{
      Reflect.deleteProperty(navigator,'onLine');
      window.dispatchEvent(new Event('online'));
      localStorage.removeItem('agentbox.chat-outbox.v1.'+scope+'.'+id);
    },{scope,id});
    await page.unroute(receiptPath,receipts);
    await page.unroute(historyPath,history);
    await page.unroute(mePath,me);
    await page.reload();
    await page.locator('#chat-input').waitFor({state:'visible'});
  }
}

export async function loginProblemsSmoke(page) {
  let payload = problem('invalid_credentials');
  const handler = route => route.fulfill({status:401,json:payload});
  await page.route('**/api/login',handler);
  try {
    for (const locale of ['zh-CN','zh-TW','en']) {
      await language(page,locale);
      await page.locator('#login-user').fill('synthetic-user');
      await page.locator('#login-pass').fill('synthetic-password');
      await page.locator('#login-btn').click();
      for (const text of [...expected('invalid_credentials',locale),id]) {
        await page.locator('#login-error').filter({hasText:text}).waitFor();
      }
      assert.ok(!(await page.locator('#login-error').innerText()).includes('synthetic-secret'));
      assert.equal(await page.locator('#login-btn').isDisabled(),false);
    }
    payload = {error:'legacy-login-error'};
    await page.locator('#login-btn').click();
    await page.locator('#login-error').filter({hasText:'legacy-login-error'}).waitFor();
  } finally {
    await page.unroute('**/api/login',handler);
    await language(page,'zh-CN');
  }
}

export async function problemsSmoke(page, base, socket, history) {
  let code='docker_unavailable';
  const handler=route=>route.fulfill({status:500,json:problem(code)});
  await page.route('**/api/sessions/fixture-space/start',handler);
  try {
    await page.goto(base+'/#/sessions/fixture-space/chat');
    await page.locator('#chat-input').waitFor({state:'visible'});
    await page.waitForFunction(()=>!document.querySelector('#chat-input').disabled);
    for (const locale of ['zh-CN','zh-TW','en']) {
      await language(page,locale);
      await page.setViewportSize({width:1280,height:900});
      for (code of ['docker_unavailable','agent_image_missing','storage_full']) {
        await page.locator('#btn-start').click();
        // Toasts use real API -> error formatting -> text rendering.
        for (const text of [...expected(code,locale),id]) await page.getByText(text,{exact:false}).last().waitFor();
        assert.ok(!(await page.locator('body').innerText()).includes('synthetic-secret'));
      }
      for (const width of [1280,390]) {
        await page.setViewportSize({width,height:900});
        for (const wsCode of ['account_access_denied','quota_exhausted']) {
          socket().send(JSON.stringify({type:'error',...problem(wsCode)}));
          const error=page.locator('#chat-log .chip.err').last();
          for (const text of [...expected(wsCode,locale),id]) await error.filter({hasText:text}).waitFor();
          assert.equal(await error.locator('script').count(),0);
          assert.equal(await error.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'error chip overflows');
        }
      }
      history([{kind:'status',state:'error',ts:'2026-10-05T00:00:00Z',...problem('agent_image_missing')}]);
      await page.evaluate(async()=>{const {loadHistory}=await import('/_v/{{BUILD}}/js/chat.js');await loadHistory();});
      for (const text of [...expected('agent_image_missing',locale),id]) await page.locator('#chat-log .chip.err').last().filter({hasText:text}).waitFor();
      // A turn the server's shutdown cut off: one quiet line instead of the CLI's
      // failure and a red error, without the operation ID; live and from history.
      history([{kind:'event',state:'interrupted',ts:'2026-10-05T00:00:00Z',event:{type:'result',subtype:'error_during_execution',is_error:true}},
        {kind:'status',state:'error',ts:'2026-10-05T00:00:01Z',...problem('server_upgraded'),action:'check_result'}]);
      await page.evaluate(async()=>{const {loadHistory}=await import('/_v/{{BUILD}}/js/chat.js');await loadHistory();});
      const stop=page.locator('#chat-log .chip.stopped.turn-stopped').last();
      for (const text of expected('server_upgraded',locale)) await stop.filter({hasText:text}).waitFor();
      assert.ok(!(await stop.innerText()).includes(id));
      assert.equal(await page.locator('#chat-log .chip.err').count(),0);
      assert.ok(!(await page.locator('#chat-log').innerText()).includes('error_during_execution'));
      for (const code of ['server_restarted','chat_turn_timed_out']) {
        socket().send(JSON.stringify({type:'status',state:'error',...problem(code),action:'check_result'}));
        await page.locator('#chat-log .chip.stopped.turn-stopped').filter({hasText:expected(code,locale)[0]}).waitFor();
      }
      assert.equal(await page.locator('#chat-log .chip.err').count(),0);
    }
    history([{kind:'status',state:'error',ts:'2026-10-05T00:00:00Z',error:'legacy-history-error'}]);
    await page.evaluate(async()=>{const {loadHistory}=await import('/_v/{{BUILD}}/js/chat.js');await loadHistory();});
    await page.locator('#chat-log .chip.err').filter({hasText:'legacy-history-error'}).waitFor();

    await page.locator('#toast').waitFor({state:'hidden'});
    if (await page.locator('#sidebar.open').count()) await page.locator('#btn-sidebar-close').click();
    await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().right<=1);
    const reference=new URL(socket().url()).searchParams.get('connection_id');
    assert.match(reference,/^[a-f0-9]{32}$/);
    socket().close({code:4001,reason:'synthetic disconnect'});
    const mobileConnection=page.locator('#mobile-chat-connection');
    const mobileStatus=page.locator('#mobile-chat-connection-status');
    const reason=page.locator('#mobile-chat-connection-reason');
    const offlineBanner=page.locator('#offline-banner');
    await mobileStatus.filter({hasText:'Chat disconnected'}).waitFor();
    assert.ok(await page.locator('#chat-conn').isHidden());
    assert.ok(await reason.isHidden());
    assert.equal(await mobileConnection.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'connection status overflows on narrow screen');
    await mobileConnection.locator('summary').click();
    await reason.filter({hasText:reference}).waitFor();
    await page.locator('#mobile-chat-copy-reference').waitFor();
    await mobileConnection.locator('summary').click();
    const serverUnreachable=route=>route.fulfill({status:503});
    const pingPath=/\/api\/ping(?:\?|$)/;
    const probeAgentBox=()=>page.evaluate(async()=>{
      const {probeServer}=await import('/_v/{{BUILD}}/js/ping.js');
      await probeServer(); await probeServer();
    });
    await page.route(pingPath,serverUnreachable);
    try {
      await probeAgentBox();
      await mobileStatus.filter({hasText:'Cannot reach AgentBox'}).waitFor();
      assert.ok(await offlineBanner.isHidden(),'global banner duplicates the mobile status');
      await page.evaluate(()=>{
        Object.defineProperty(navigator,'onLine',{configurable:true,value:false});
        window.dispatchEvent(new Event('offline'));
      });
      await mobileStatus.filter({hasText:'No internet'}).waitFor();
      assert.ok(await page.locator('#mobile-chat-reconnect').isHidden());
      await mobileConnection.locator('summary').click();
      await reason.filter({hasText:'Check this device’s network connection.'}).waitFor();
      assert.ok((await reason.innerText()).includes(reference));
      await mobileConnection.locator('summary').click();
      await page.evaluate(()=>{
        Reflect.deleteProperty(navigator,'onLine');
        window.dispatchEvent(new Event('online'));
      });
      await mobileStatus.filter({hasText:'Cannot reach AgentBox'}).waitFor();
      await page.setViewportSize({width:1280,height:900});
      await offlineBanner.waitFor({state:'visible'});
      await page.locator('#chat-conn-text').filter({hasText:reference}).waitFor();
      assert.ok(await mobileConnection.isHidden());
      await page.setViewportSize({width:390,height:900});
      await mobileConnection.waitFor({state:'visible'});
    } finally {
      await page.unroute(pingPath,serverUnreachable);
    }
    await mkdir('output/playwright',{recursive:true});
    await page.screenshot({path:'output/playwright/problems-english-mobile.png',animations:'disabled'});
    await page.locator('#mobile-chat-reconnect').click();
    await mobileConnection.waitFor({state:'hidden'});
    const healthySocketID=new URL(socket().url()).searchParams.get('connection_id');
    await page.route(pingPath,serverUnreachable);
    try {
      await probeAgentBox();
      await mobileStatus.filter({hasText:'Cannot reach AgentBox'}).waitFor();
    } finally {
      await page.unroute(pingPath,serverUnreachable);
    }
    await page.locator('#mobile-chat-reconnect').click();
    await mobileConnection.waitFor({state:'hidden'});
    assert.equal(new URL(socket().url()).searchParams.get('connection_id'),healthySocketID,'HTTP retry replaced a healthy chat socket');
    await mobileDeliverySmoke(page);
    console.log('Problems browser: error localization, redaction, mobile connection, details, reconnect, message status and desktop layout passed');
  } finally {
    await page.unroute('**/api/sessions/fixture-space/start',handler);
    history([]);
    await language(page,'zh-CN');
    await page.setViewportSize({width:1280,height:900});
    await page.goto(base+'/#/settings/container');
    await page.locator('#sec-container').waitFor({state:'visible'});
  }
}
