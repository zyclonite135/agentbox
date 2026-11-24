import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';

// Shared synthetic browser suite: Claude tool calls drawn the way Claude Code's
// terminal shows them. The history is real stream-json from Claude Code 2.1.280 /
// 2.1.304 (scripts/fixtures/claude-cli-2.1-events.json, ids and local paths
// scrubbed): consecutive tools and reasoning share an activity summary,
// Write / Update show a summary line that opens into numbered content and diffs,
// Fetch / Web Search / Agent their result lines, failures their error. Live events
// then check the running state.
// No provider calls.
export async function chatClaudeToolsSmoke(page, { setHistory, send, socket, setAgent }) {
 const fixture = JSON.parse(await readFile(new URL('./fixtures/claude-cli-2.1-events.json', import.meta.url), 'utf8'));
 const reload = async () => {
  const before = socket();
  await page.reload();
  await page.locator('#chat-log .turn, #chat-hero:not(.hidden)').first().waitFor();
  for (let i = 0; socket() === before; i++) { assert.ok(i < 100, 'chat socket did not reconnect'); await page.waitForTimeout(20); }
 };
 const until = async (fn, what) => {
  for (let i = 0; !(await fn()); i++) { assert.ok(i < 150, what); await page.waitForTimeout(20); }
 };
 const ts = '2026-10-21T08:00:01Z';
 const turn = id => ({id, model:'claude-haiku-5-5', effort:'', control:''});
 const entries = [];
 for (const [name, list] of Object.entries(fixture)) {
  for (const e of list) entries.push(e.kind === 'user' ? {...e, ts, turn:turn(name)} : {...e, ts});
 }
 // What a history page sends after a reload (server/history_tools.go): the
 // tool_result text cut to its first lines, how many were left out, no stdout.
 entries.push({kind:'user', ts, text:'跑全部测试', turn:turn('slim')},
  {kind:'event', ts, event:{type:'assistant', message:{content:[{type:'tool_use', id:'toolu_slim', name:'Bash', input:{command:'npm test'}}]}}},
  {kind:'event', ts, event:{type:'user', message:{role:'user', content:[{type:'tool_result', tool_use_id:'toolu_slim', content:'ok 1\nok 2\nok 3\nok 4', omitted_lines:120}]}}},
  {kind:'event', ts, event:{type:'result', subtype:'success', duration_ms:1000}}, {kind:'status', ts, state:'idle'});
 // A written .html file: its row carries the 预览 button.
 entries.push({kind:'user', ts, text:'做个网页', turn:turn('html')},
  {kind:'event', ts, event:{type:'assistant', message:{content:[{type:'tool_use', id:'toolu_html', name:'Write', input:{file_path:'/workspace/demo.html', content:'<h1>hi</h1>\n'}}]}}},
  {kind:'event', ts, event:{type:'user', message:{role:'user', content:[{type:'tool_result', tool_use_id:'toolu_html', content:'File created successfully at: /workspace/demo.html'}]},
   tool_use_result:{type:'create', filePath:'/workspace/demo.html', content:'<h1>hi</h1>\n', structuredPatch:[], userModified:false}}},
  {kind:'event', ts, event:{type:'result', subtype:'success', duration_ms:1000}}, {kind:'status', ts, state:'idle'});
 setAgent('claude');
 setHistory(entries);
 await reload();
 const turns = page.locator('#chat-log .turn');
 await until(async () => await turns.count() === 5, 'five turns rendered');
 const groups = n => turns.nth(n).locator(':scope > .turn-body > .fold-activity');
 const head = group => group.locator(':scope > summary');

 // Turn 1: Bash / Read / Write / Edit, failures included.
 assert.deepEqual(await groups(0).locator(':scope > summary').allTextContents(), [
  '工作过程 · 列目录 1 次, 读文件 1 次, 搜索次数 1',
  '工作过程 · 搜索次数 2',
  '工作过程 · 列目录 1 次, 文件变更 2 项, 命令 1 条, 读文件 1 次',
 ], 'reply text separates activities, and each group counts its own steps');
 const failed = groups(0).last();
 assert.equal(await failed.locator('.fold-items').isVisible(), false);
 await head(failed).click();
 assert.deepEqual(await failed.locator('.fold-items > .cc-tool > .cc-head').allTextContents(), [
  '●Bash(find /workspace -maxdepth 1 -name "*.txt")', '●Write(a.py)', '●Update(a.py)',
  '●Bash(python3 a.py; exit 3)', '●Read(nope.txt)',
 ]);
 const write = turns.nth(0).locator('.cc-tool[data-tool="Write"]');
 assert.equal(await write.locator('.cc-num').count(), 0, 'written content stays folded until the row is opened');
 await write.locator('.cc-head').click();
 assert.equal(await write.locator('.cc-res .cc-line').first().textContent(), '已写入 1 行到 a.py');
 assert.equal(await write.locator('.cc-num').textContent(), '1 print(1)\n');
 const edit = turns.nth(0).locator('.cc-tool[data-tool="Edit"]');
 assert.equal(await edit.locator('.cc-diff').count(), 0, 'the diff stays folded until the row is opened');
 await edit.locator('.cc-head').click();
 assert.equal(await edit.locator('.cc-res .cc-line').first().textContent(), '新增 1 行，删除 1 行');
 assert.deepEqual(await edit.locator('.cc-diff .dl').evaluateAll(l => l.map(d => d.className + ':' + d.textContent)),
  ['dl del: -print(1)', 'dl add: +print(2)']);
 // A folded group opens into a list of its calls; each call opens into its full output.
 const errors = failed.locator('.cc-tool[data-status="failed"]');
 assert.equal(await errors.locator('.cc-res').count(), 0, 'errors are visible after opening the step');
 for (const row of await errors.locator('.cc-head').all()) await row.click();
 assert.equal(await errors.locator('.cc-pre.err').first().textContent(), 'Error: Exit code 3\n2');
 assert.match(await failed.locator('.cc-tool[data-tool="Read"] .cc-pre.err').textContent(), /^Error: File does not exist/);
 assert.equal(await failed.locator('.cc-tool[data-status="failed"]').count(), 2);

 // Turn 2: ToolSearch is hidden as in the CLI; the sub-agent's own Bash stays inside its row.
 const web = groups(1).filter({has:page.locator('[data-tool="WebSearch"]')});
 await head(web).click();
 assert.equal(await head(web).textContent(), '工作过程 · 搜索次数 1, 工具调用 1 次');
 const agent = turns.nth(1).locator('.cc-tool[data-tool="Agent"]');
 assert.equal(await agent.locator('.cc-res').textContent(), '⎿完成（1 次工具调用 · 17.4k tokens · 4s）');
 await agent.locator('.cc-head').click();
 assert.deepEqual(await agent.locator('.cc-tool > .cc-head').evaluateAll(l => l.map(h => h.textContent)), ['●Bash(uname -a)']);
 assert.match(await agent.locator('.cc-reply').textContent(), /Linux/);
 const search = turns.nth(1).locator('.cc-tool[data-tool="WebSearch"]');
 await search.locator('.cc-head').click();
 assert.equal(await search.locator('.cc-res .cc-line').first().textContent(), '搜索 1 次，用时 9s');
 assert.ok(await search.locator('.cc-links a').count() >= 4, 'search results listed when expanded');
 assert.ok((await search.locator('.cc-links a').evaluateAll(l => l.map(a => a.href))).every(h => /^https:\/\//.test(h)));

 // Turn 3: two edits with their hunks, a background command.
 await head(groups(2).filter({has:page.locator('[data-tool="Edit"]')})).click();
 await turns.nth(2).locator('.cc-tool[data-tool="Edit"]').first().locator('.cc-head').click();
 assert.deepEqual(await turns.nth(2).locator('.cc-tool[data-tool="Edit"]').first().locator('.cc-diff').evaluate(p => p.textContent),
  '1 -export const a = 1;\n1 +export const a = 2;\n2  // TODO fix\n');
 assert.equal(await turns.nth(2).locator(':scope > .turn-body > .cc-tool[data-tool="Bash"] > .cc-res').textContent(), '⎿在后台运行');
 assert.match(await page.locator('#chat-log .chip.bg-task').textContent(), /后台任务完成：Background task: sleep 1 then echo/);
 const slim = groups(3);
 await head(slim).click();
 await slim.locator('.fold-items .cc-head').click();
 assert.equal(await slim.locator('.cc-pre').textContent(), 'ok 1\nok 2\nok 3\nok 4');
 assert.equal(await slim.locator('.cc-out > .cc-line').last().textContent(), '… 还有 120 行', 'lines the page left out are counted');
 // 预览 on a written .html opens the preview window (the click has to reach the
 // #chat-log delegate in preview.ts) and leaves the row folded.
 const html = turns.nth(4).locator('.cc-tool[data-tool="Write"]');
 await head(groups(4)).click();
 assert.equal(await html.locator('.cc-head').textContent(), '●Write(demo.html)预览');
 await html.locator('.cc-head [data-html-preview]').click();
 await page.locator('#dlg-file[open]').waitFor();
 assert.equal(await page.locator('#fv-name').textContent(), 'demo.html');
 assert.equal(await html.locator('.cc-num').count(), 0, 'opening the preview does not unfold the row');
 await page.locator('#fv-close').click();
 await page.locator('#dlg-file[open]').waitFor({state:'detached'});
 await html.locator('.cc-head').click();
 assert.equal(await html.locator('.cc-num').textContent(), '1 <h1>hi</h1>\n', 'the rest of the row still unfolds it');
 assert.equal(await page.locator('#chat-log [data-status="running"]').count(), 0, 'nothing runs once the history is over');
 await mkdir('output/playwright', {recursive:true});
 await turns.nth(0).screenshot({path:'output/playwright/chat-claude-tools-1.png', animations:'disabled'});
 await turns.nth(1).screenshot({path:'output/playwright/chat-claude-tools-2.png', animations:'disabled'});
 await turns.nth(2).screenshot({path:'output/playwright/chat-claude-tools-3.png', animations:'disabled'});

 // Live: a command runs inside a folded group, the working line names it, the
 // heading describes the current action, and the result updates the same row.
 send({type:'user_message', text:'跑下测试', turn:turn('live'), ts});
 send({type:'status', state:'running'});
 const ev = event => send({type:'agent_event', event, ts});
 ev({type:'assistant', message:{content:[{type:'tool_use', id:'toolu_live1', name:'Bash', input:{command:'npm test', description:'Run tests'}}]}});
 const live = page.locator('#chat-log .turn:not(.working)').last();
 const group = live.locator('.fold-activity');
 await group.waitFor();
 assert.equal(await head(group).textContent(), '执行命令…');
 await until(async () => await page.locator('.turn.working .work-label').textContent() === '执行 npm test…', 'working line names the command');
 await page.screenshot({path:'output/playwright/chat-claude-running.png', animations:'disabled'});
 ev({type:'assistant', message:{content:[{type:'tool_use', id:'toolu_live2', name:'Read', input:{file_path:'/workspace/package.json'}}]}});
 await until(async () => await head(group).textContent() === '正在读取文件…', 'the latest running step sets the group heading');
 ev({type:'user', message:{role:'user', content:[{type:'tool_result', tool_use_id:'toolu_live1', content:'ok 1\nok 2', is_error:false}]},
  tool_use_result:{stdout:'ok 1\nok 2', stderr:'', interrupted:false}});
 ev({type:'user', message:{role:'user', content:[{type:'tool_result', tool_use_id:'toolu_live2', content:'1\t{}'}]},
  tool_use_result:{type:'text', file:{filePath:'/workspace/package.json', content:'{}', numLines:1, startLine:1, totalLines:1}}});
 await until(async () => await head(group).textContent() === '工作过程 · 命令 1 条, 读文件 1 次', 'results complete the group in place');
 assert.equal(await live.locator(':scope > .turn-body > .fold-activity').count(), 1);
 // Text ends the group; a sub-agent shows its latest call while it runs.
 ev({type:'assistant', message:{content:[{type:'text', text:'测试通过，再让子 Agent 看下。'}]}});
 ev({type:'assistant', message:{content:[{type:'tool_use', id:'toolu_agent', name:'Agent', input:{description:'检查依赖', prompt:'看看依赖', subagent_type:'general-purpose'}}]}});
 ev({type:'assistant', parent_tool_use_id:'toolu_agent', message:{content:[{type:'tool_use', id:'toolu_sub', name:'Bash', input:{command:'npm ls'}}]}});
 const sub = live.locator('.cc-tool[data-tool="Agent"]');
 await until(async () => await sub.locator('.cc-child').count() === 1, 'sub-agent lists its call');
 assert.equal(await sub.locator('.cc-child').textContent(), 'Bash(npm ls)');
 assert.equal(await live.locator(':scope > .turn-body > .tool-call').count(), 1, 'only the parent sub-agent call is a top-level row');
 // The turn ends while it runs: nothing keeps blinking.
 send({type:'status', state:'idle'});
 await until(async () => await live.locator('[data-status="running"]').count() === 0, 'settled when idle');
 assert.equal(await sub.getAttribute('data-status'), 'unfinished');

 // A long command's heartbeats fold into one row with a count; consecutive thinking folds too.
 send({type:'user_message', text:'部署', turn:turn('beats'), ts});
 send({type:'status', state:'running'});
 ev({type:'assistant', message:{content:[{type:'tool_use', id:'toolu_long', name:'Bash', input:{command:'npm run deploy'}}]}});
 for (const [i, sec] of [30, 60, 90].entries()) ev({type:'tool_progress', tool_use_id:`toolu_long-heartbeat-${i}`, tool_name:'Bash', parent_tool_use_id:'toolu_long', elapsed_time_seconds:sec, heartbeat:true});
 const beats = page.locator('#chat-log .turn:not(.working)').last().locator('.fold-beat');
 await until(async () => await beats.count() === 1 && await beats.locator('.fold-item').count() === 3, 'heartbeats fold into one row');
 assert.equal(await beats.locator('.fold-head').textContent(), '心跳检查 · 3 次 · Bash(npm run deploy) 已运行 1m 30s');
 assert.equal(await page.locator('#chat-log details.raw').count(), 0, 'heartbeats are no longer raw events');
 assert.equal(await beats.locator('.fold-items').isVisible(), false);
 await beats.locator('.fold-head').click();
 assert.deepEqual(await beats.locator('.fold-item > summary').evaluateAll(l => l.map(x => x.textContent)),
  ['Bash(npm run deploy)已运行 30s', 'Bash(npm run deploy)已运行 1m 0s', 'Bash(npm run deploy)已运行 1m 30s']);
 assert.equal(await beats.locator('.beat-raw').first().isVisible(), false);
 await beats.locator('.fold-item > summary').first().click();
 assert.match(await beats.locator('.beat-raw').first().textContent(), /"elapsed_time_seconds": 30/);
 ev({type:'user', message:{role:'user', content:[{type:'tool_result', tool_use_id:'toolu_long', content:'deployed'}]}, tool_use_result:{stdout:'deployed', stderr:''}});
 for (const text of ['Checking the logs.\nMore detail.', 'Looks fine.', 'Writing the summary.']) ev({type:'assistant', message:{content:[{type:'thinking', thinking:text, signature:'sig'}]}});
 const thinks = page.locator('#chat-log .turn:not(.working)').last().locator('.fold-activity').last();
 await until(async () => await thinks.locator('details.think').count() === 3, 'consecutive thinking folds into one row');
 assert.equal(await page.locator('#chat-log .turn:not(.working)').last().locator(':scope > .turn-body > details.think').count(), 0);
 assert.equal(await head(thinks).textContent(), '工作过程 · 推理摘要 3 段');
 await thinks.locator('.fold-head').click();
 assert.deepEqual(await thinks.locator('.think-peek').evaluateAll(l => l.map(x => x.textContent)), ['Checking the logs.', 'Looks fine.', 'Writing the summary.']);
 assert.equal(await thinks.locator('.think-body').first().isVisible(), false, 'each step stays closed until clicked');
 await thinks.locator('details.think > summary').first().click();
 assert.equal(await thinks.locator('.think-body').first().textContent(), 'Checking the logs.\nMore detail.');
 await page.locator('#chat-log .turn:not(.working)').last().screenshot({path:'output/playwright/chat-claude-folds.png', animations:'disabled'});
 send({type:'status', state:'idle'});

 // Narrow screens: long commands and diffs scroll inside their rows.
 await page.setViewportSize({width:390, height:844});
 await head(groups(0).first()).locator('.fold-agent-icon.agent-claude').waitFor({state:'visible'});
 assert.equal(await groups(0).locator('.fold-agent-icon:visible').count(), 1, 'only the first activity summary shows a brand icon');
 assert.equal(await head(groups(0).first()).locator('.fold-agent-icon.agent-claude').isVisible(), true);
 assert.equal(await head(groups(0).last()).locator('.ui-icon').isVisible(), true, 'later summaries keep the tool icon');
 await turns.nth(0).scrollIntoViewIfNeeded();
 assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
 await page.screenshot({path:'output/playwright/chat-claude-tools-mobile.png', animations:'disabled'});
 await page.setViewportSize({width:1280, height:900});
 setHistory([]);
 // Leave the workspace as Codex, as the Codex items suite does: later suites expect it.
 setAgent('codex');
 console.log('Chat Claude tools: activity summaries for live and saved events, expandable outputs and diffs, retained previews, sub-agents and background operations, and mobile layout passed');
}
