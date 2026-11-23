import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

// Shared synthetic browser suite: Codex tool rows — commands named the way the
// CLI parses them (Read / Search / List / Shell), exit codes and durations,
// expandable output and diffs, live output under a running command that then
// completes in place, rows left running by an interrupted turn, and old records
// without the rich fields. No provider calls.
export async function chatCodexItemsSmoke(page, { setHistory, send, socket, setAgent }) {
 const reload = async () => {
  const before = socket();
  await page.reload();
  await page.locator('#chat-log .turn, #chat-hero:not(.hidden)').first().waitFor();
  for (let i = 0; socket() === before; i++) { assert.ok(i < 100, 'chat socket did not reconnect'); await page.waitForTimeout(20); }
 };
 const until = async (fn, what) => {
  for (let i = 0; !(await fn()); i++) { assert.ok(i < 150, what); await page.waitForTimeout(20); }
 };
 const ts = '2026-10-19T08:00:01Z';
 const turn = id => ({id, model:'gpt-5.5', effort:'medium', control:'effort'});
 const ev = (type, item) => ({kind:'event', ts, event:{type, item}});
 const read = {type:'command_execution', id:'c1', command:"/bin/bash -lc 'sed -n 1,80p src/app.ts'",
  actions:[{type:'read', command:'sed -n 1,80p src/app.ts', name:'app.ts', path:'src/app.ts'}]};
 const head = Array.from({length:20}, (_, i) => 'head ' + i).join('\n');
 setAgent('codex');
 setHistory([
  {kind:'user', ts, text:'看下项目', turn:turn('t1')},
  ev('item.completed', {type:'reasoning', text:'**Scanning the repo**\n\nLooking at the entry point.'}),
  ev('item.started', read),
  ev('item.completed', {...read, status:'completed', exit_code:0, duration_ms:42, output_lines:80,
   aggregated_output:head, output_tail:'tail 1\ntail 2', output_truncated:true}),
  // Records written before the rich fields: no id, no output; paired by command.
  ev('item.started', {type:'command_execution', command:"/bin/bash -lc 'npm run lint'"}),
  ev('item.completed', {type:'command_execution', command:"/bin/bash -lc 'npm run lint'", exit_code:1, status:'failed'}),
  ev('item.completed', {type:'file_change', id:'f1', status:'completed', changes:[{path:'/workspace/src/app.ts', kind:'update',
   added:2, removed:1, diff:'@@ -1,2 +1,3 @@\n-old\n+new\n+<b>more</b>\n ctx'}]}),
  ev('item.completed', {type:'web_search', id:'w1', query:'xterm touch scroll', result_count:2,
   results:[{title:'xterm.js', url:'https://xtermjs.org', domain:'xtermjs.org'}, {title:'<i>bad</i>', url:'javascript:alert(1)'}]}),
  ev('item.completed', {type:'mcp_tool_call', id:'m1', server:'docs', tool:'search', arguments:'{"q":"x"}', status:'failed',
   error:{message:'boom'}, duration_ms:1500}),
  // The turn was interrupted while this ran: it must not spin forever.
  ev('item.started', {type:'command_execution', id:'c9', command:"/bin/bash -lc 'sleep 100'"}),
  ev('item.completed', {type:'agent_message', text:'看完了。'}),
  {kind:'event', ts, event:{type:'turn.completed', usage:{input_tokens:10, output_tokens:2}}},
  {kind:'status', ts, state:'idle'},
 ]);
 await reload();
 const rows = page.locator('#chat-log .tool-call');
 await rows.first().waitFor();
 const names = () => rows.evaluateAll(list => list.map(r => [r.querySelector('.name').textContent, r.querySelector('.sum')?.textContent || '']));
 assert.deepEqual(await names(), [
  ['Read', 'app.ts'], ['Shell', 'npm run lint'], ['Edit', '/workspace/src/app.ts'],
  ['WebSearch', 'xterm touch scroll'], ['docs.search', '{"q":"x"}'], ['Shell', 'sleep 100'],
 ], 'one row per item, named like the CLI, legacy start/end paired');
 assert.match(await rows.nth(1).locator('.tc-badge.err').innerText(), /退出码 1/);
 assert.equal(await rows.nth(0).locator('.tc-meta').count(), 0, 'instant commands carry no duration');
 assert.equal(await rows.nth(2).locator('.tc-stat').textContent(), '+2−1');
 assert.equal(await rows.nth(4).locator('.tc-meta').innerText(), '1.5s');
 assert.equal(await rows.nth(5).getAttribute('data-status'), 'unfinished');
 assert.equal(await page.locator('#chat-log .tc-spin').count(), 0, 'nothing spins once the turn is over');
 assert.equal(await page.locator('#chat-log .think-peek').first().innerText(), 'Scanning the repo');

 // Expanding shows the full command and the head / omitted / tail of the output.
 await rows.nth(0).locator('summary').click();
 assert.equal(await rows.nth(0).locator('.tc-cmd').innerText(), '$sed -n 1,80p src/app.ts');
 assert.equal(await rows.nth(0).locator('.tc-out').count(), 2);
 assert.match(await rows.nth(0).locator('.tc-gap').innerText(), /省略 58 行/);
 // Old records never stored output: say nothing rather than "no output".
 await rows.nth(1).locator('summary').click();
 assert.equal(await rows.nth(1).locator('.tc-note, .tc-out').count(), 0);
 // Diffs and search results are text; only http(s) results become links.
 await rows.nth(2).locator('summary').click();
 assert.equal(await rows.nth(2).locator('.dl.add').count(), 2);
 assert.equal(await rows.nth(2).locator('.dl.del').count(), 1);
 await rows.nth(3).locator('summary').click();
 assert.deepEqual(await rows.nth(3).locator('a').evaluateAll(list => list.map(a => a.href)), ['https://xtermjs.org/']);
 assert.equal(await page.locator('#chat-log .tool-call b, #chat-log .tool-call i').count(), 0, 'model text stays text');
 await rows.nth(4).locator('summary').click();
 assert.equal(await rows.nth(4).locator('.tc-out.err').innerText(), 'boom');

 // Live: a running command shows a spinner, the working line names it, its
 // output streams underneath, and completion updates the same row.
 const count = await rows.count();
 send({type:'user_message', text:'跑下测试', turn:turn('t2'), ts:'2026-10-19T08:05:00Z'});
 send({type:'status', state:'running'});
 const test = {type:'command_execution', id:'c5', command:"/bin/bash -lc 'npm test'", actions:[{type:'unknown', command:'npm test'}]};
 send({type:'agent_event', event:{type:'item.started', item:test}});
 const live = rows.nth(count);
 await until(async () => await rows.count() === count + 1, 'running row appears');
 assert.equal(await live.getAttribute('data-status'), 'running');
 assert.equal(await live.locator('.tc-spin').count(), 1);
 await until(async () => await page.locator('.turn.working .work-label').textContent() === '执行 npm test…', 'working line names the command');
 for (const line of ['> test', 'ok 1', 'ok 2', 'ok 3', 'ok 4\n'])
  send({type:'agent_event', event:{type:'stream_event', event:{type:'item_output_delta', item_id:'c5', delta:line + '\n'}}});
 await until(async () => await live.locator('.tc-live').textContent() === 'ok 1\nok 2\nok 3\nok 4', 'live output keeps the last lines');
 await mkdir('output/playwright', {recursive:true});
 await page.screenshot({path:'output/playwright/chat-codex-running.png', animations:'disabled'});
 send({type:'agent_event', event:{type:'item.completed', item:{...test, status:'completed', exit_code:0, duration_ms:6840, output_lines:0}}});
 await until(async () => await live.getAttribute('data-status') === 'completed', 'completion updates the row in place');
 assert.equal(await rows.count(), count + 1);
 assert.equal(await live.locator('.tc-live, .tc-spin').count(), 0);
 assert.equal(await live.locator('.tc-meta').innerText(), '6.8s');
 await live.locator('summary').click();
 assert.equal(await live.locator('.tc-note').innerText(), '（无输出）');
 // A command still running when the turn ends stops spinning.
 send({type:'agent_event', event:{type:'item.started', item:{type:'command_execution', id:'c6', command:'sleep 5'}}});
 await until(async () => await rows.count() === count + 2, 'second running row');
 send({type:'status', state:'idle'});
 await until(async () => await rows.nth(count + 1).getAttribute('data-status') === 'unfinished', 'settled when idle');

 // Narrow screens: long commands and output scroll inside their rows.
 await page.setViewportSize({width:390, height:844});
 await rows.nth(0).scrollIntoViewIfNeeded();
 assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
 await page.screenshot({path:'output/playwright/chat-codex-items-mobile.png', animations:'disabled'});
 await page.setViewportSize({width:1280, height:900});
 await page.screenshot({path:'output/playwright/chat-codex-items.png', animations:'disabled'});

 const generated = '/home/agent/.codex/generated_images/thread/image.png';
 const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFbcAAAAASUVORK5CYII=', 'base64');
 const serveGenerated = async route => {
  assert.equal(new URL(route.request().url()).searchParams.get('path'), 'thread/image.png');
  await route.fulfill({contentType:'image/png', body:png});
 };
 await page.route('**/chat/image?*', serveGenerated);
 const generatedItem = {type:'image_generation', id:'g1', saved_path:generated, status:'completed'};
 const viewItem = {type:'image_view', path:'file://' + generated};
 setHistory([
  {kind:'user', ts, text:'画一张图', turn:turn('t3')},
  ev('item.started', {type:'image_generation', id:'g1'}),
  ev('item.completed', generatedItem),
  ev('item.completed', viewItem),
  ev('item.completed', {type:'agent_message', text:'图片已生成。'}),
 ]);
 await reload();
 const images = page.locator('#chat-log .turn-body > .chat-tool-image .tc-image');
 await images.first().waitFor();
 await until(() => images.first().evaluate(img => img.naturalWidth > 0), 'history image loads inline');
 assert.equal(await images.count(), 1, 'ImageGen and ViewImage show one image in the same turn');
 await images.first().click();
 const preview = page.locator('#lb-img');
 const close = page.locator('#lb-close');
 await preview.waitFor();
 for (const [width, height, viewport] of [[640, 1500, {width:1280, height:900}], [1500, 640, {width:390, height:844}]]) {
  await page.setViewportSize(viewport);
  await preview.evaluate(async (img, [width, height]) => {
   const canvas = document.createElement('canvas');
   canvas.width = width;
   canvas.height = height;
   img.src = canvas.toDataURL('image/png');
   await img.decode();
  }, [width, height]);
  const imageBox = await preview.boundingBox();
  const closeBox = await close.boundingBox();
  assert.ok(Math.abs(imageBox.x + imageBox.width - closeBox.x - closeBox.width - 10) < 2, 'close is inset from the right edge of the displayed image');
  assert.ok(Math.abs(closeBox.y - imageBox.y - 10) < 2, 'close is inset from the top edge of the displayed image');
 }
 await close.click();
 await page.locator('#dlg-img').waitFor({state:'hidden'});
 await page.setViewportSize({width:1280, height:900});
 await images.first().click();
 await page.keyboard.press('Escape');
 await page.locator('#dlg-img').waitFor({state:'hidden'});
 await images.first().click();
 await page.mouse.click(2, 2);
 await page.locator('#dlg-img').waitFor({state:'hidden'});
 send({type:'user_message', text:'再看一下', turn:turn('t4'), ts});
 send({type:'status', state:'running'});
 const generationEvent = (type, item) => send({type:'agent_event', event:{type, item}});
 const progress = page.locator('#chat-log .chat-image-progress');
 generationEvent('item.started', {type:'image_generation', id:'g1'});
 await progress.waitFor();
 assert.equal(await progress.innerText(), '正在生成图片…');
 const indicator = progress.locator('svg');
 assert.equal(await indicator.evaluate(node => getComputedStyle(node).animationName), 'none');
 await page.emulateMedia({reducedMotion:'no-preference'});
 await until(async () => await indicator.evaluate(node => getComputedStyle(node).animationName) === 'work-breathe', 'the generation icon pulses');
 generationEvent('item.completed', generatedItem);
 await progress.waitFor({state:'hidden'});
 await until(async () => await images.count() === 2, 'the same image is visible in a later live turn');
 await until(() => images.last().evaluate(img => img.naturalWidth > 0), 'live image loads inline');
 await until(() => images.last().evaluate(img => img.classList.contains('chat-image-reveal')), 'image fades in after loading');
 await page.emulateMedia({reducedMotion:'reduce'});
 generationEvent('item.started', {type:'image_generation', id:'g2'});
 await progress.waitFor();
 generationEvent('item.completed', {type:'image_generation', id:'g2', status:'failed'});
 await progress.waitFor({state:'hidden'});
 assert.equal(await page.locator('#chat-log .tool-call[data-status="failed"] .tc-badge.err').last().innerText(), '✗ 失败');
 generationEvent('item.started', {type:'image_generation', id:'g3'});
 await progress.waitFor();
 send({type:'status', state:'idle'});
 await progress.waitFor({state:'hidden'});
 assert.equal(await page.locator('#chat-log .tool-call[data-status="unfinished"] .tc-badge').last().innerText(), '未完成');

 // A replaying Codex message delays insertion of later tool rows. The idle
 // event must still retire an image card queued behind that message.
 send({type:'user_message', text:'再画一张', turn:turn('t5'), ts});
 send({type:'status', state:'running'});
 generationEvent('item.completed', {type:'agent_message', text:'准备生成。'.repeat(140)});
 generationEvent('item.started', {type:'image_generation', id:'g4'});
 send({type:'status', state:'idle'});
 const pendingBadge = page.locator('#chat-log .turn').last().locator('.tool-call[data-status="unfinished"] .tc-badge');
 await pendingBadge.waitFor();
 assert.equal(await pendingBadge.innerText(), '未完成');
 assert.equal(await progress.count(), 0, 'no generating card remains after the queued replay');

 const joinedRows = await page.evaluate(async () => {
  const entry = document.querySelector('script[src$="/js/main.js"]');
  const {joinTurn} = await import(new URL('./features/chat/turns.js', entry.src).href);
  const older = document.createElement('div'), newer = document.createElement('div');
  older.className = newer.className = 'turn';
  older.innerHTML = '<div class="turn-body"><div data-image-generation-id="g1" data-status="unfinished"></div>' +
    '<div data-image-generation-id="g2" data-status="unfinished"></div></div>';
  newer.innerHTML = '<div class="turn-body"><div data-image-generation-id="g1" data-status="completed"></div></div>';
  joinTurn(older, newer);
  return Array.from(newer.querySelectorAll('[data-image-generation-id]'), row =>
   [row.dataset.imageGenerationId, row.dataset.status]);
 });
 assert.deepEqual(joinedRows, [['g2', 'unfinished'], ['g1', 'completed']],
  'joining split history pages keeps only the completed row when both halves share a generation ID');
 await page.unroute('**/chat/image?*', serveGenerated);

 // Leave the workspace as Codex, as the tasks suite does: later suites expect it.
 setHistory([]);
 console.log('Chat Codex items: commands named like the CLI (Read/Shell, legacy rows paired by command), exit/duration/diff stats, expandable output head/tail and diffs, text-only results with http(s) links only, live spinner + streamed output completing in place, unfinished rows settled when idle, mobile passed');
}
