import assert from 'node:assert/strict';

// System announcements on the synthetic API: the administrator sees who a
// restart would affect, posts a release with a lead time, every page shows the
// countdown banner after the push notice, a dismissed banner stays hidden until
// the release completes, and withdrawing it removes the banner.
export async function announcementSmoke(page, liveSocket) {
  let announcement = null;
  const puts = [], deletes = [];
  const view = () => ({ announcement, now: Date.now() });
  const routes = {
    '**/api/announcement': async route => {
      const method = route.request().method();
      if (method === 'PUT') {
        const body = route.request().postDataJSON();
        puts.push(body);
        announcement = { version: 1, id: 'ann-1', posted_at: Date.now(), posted_by: 'fixture', from_version: 'v1', ...body };
      } else if (method === 'DELETE') {
        deletes.push(true);
        announcement = null;
      }
      await route.fulfill({ json: view() });
    },
    '**/api/announcement/activity': route => route.fulfill({ json: {
      now: Date.now(),
      online: [{ user: 'alice', pages: 2 }, { user: 'fixture', pages: 1 }],
      workspaces: [{ id: 'w1', name: 'Busy workspace', user: 'alice', agent: 'claude', attached: 1, active_turns: 1, last_active: Date.now() - 60000 }],
    } }),
  };
  for (const [pattern, handler] of Object.entries(routes)) await page.route(pattern, handler);
  const push = async () => {
    for (let i = 0; !liveSocket() && i < 100; i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(liveSocket(), 'signed-in page keeps the push socket open for announcements');
    liveSocket().send(JSON.stringify({ type: 'announcement', sessions: null }));
  };
  const bar = page.locator('#announce-bar');
  try {
    await page.evaluate(() => localStorage.removeItem('agentbox_announcement_dismissed'));
    await page.evaluate(() => { location.hash = '#/settings/announce'; });
    await page.locator('#sec-announce').waitFor();
    await page.locator('#ann-online').filter({ hasText: 'alice（2 个页面）' }).waitFor();
    await page.locator('#ann-tbody').filter({ hasText: 'Busy workspace' }).waitFor();
    assert.match(await page.locator('#ann-tbody').innerText(), /1 个对话回合在运行/);
    assert.equal(await page.locator('#ann-current').innerText(), '暂无通告');
    assert.equal(await page.locator('#ann-clear').isHidden(), true);
    assert.equal(await bar.isHidden(), true, 'no banner without an announcement');

    // A notice needs text; the release fields hide for it.
    await page.evaluate(() => {
      const kind = document.getElementById('ann-kind');
      kind.value = 'notice';
      kind.dispatchEvent(new Event('change'));
    });
    assert.equal(await page.locator('#ann-release-fields').isHidden(), true, 'release fields hide for a notice');
    await page.locator('#ann-post').click();
    await page.locator('.toast').filter({ hasText: '普通通知需要填写内容' }).waitFor();
    assert.equal(puts.length, 0);

    await page.evaluate(() => {
      const kind = document.getElementById('ann-kind');
      kind.value = 'release';
      kind.dispatchEvent(new Event('change'));
    });
    await page.locator('#ann-duration').fill('3');
    await page.locator('#ann-message').fill('本次更新登录限速');
    const before = Date.now();
    await page.locator('#ann-post').click();
    await page.locator('#dlg-ask').waitFor({ state: 'visible' });
    await page.locator('#ask-ok').click();
    await page.locator('#ann-current').filter({ hasText: '发版升级' }).waitFor();
    assert.equal(puts.length, 1);
    assert.equal(puts[0].kind, 'release');
    assert.equal(puts[0].duration_min, 3);
    assert.equal(puts[0].message, '本次更新登录限速');
    assert.ok(Math.abs(puts[0].starts_at - (before + 10 * 60000)) < 30000, 'default lead time is 10 minutes');

    // Every page learns of it through the push socket.
    await push();
    await bar.waitFor({ state: 'visible' });
    assert.equal(await bar.getAttribute('data-phase'), 'scheduled');
    assert.equal(await page.locator('#announce-title').innerText(), '已计划发版升级');
    assert.equal(await page.locator('#announce-date').getAttribute('datetime'), new Date(puts[0].starts_at).toISOString());
    assert.match(await page.locator('#announce-details').innerText(), /预计中断约 3 分钟/);
    assert.match(await page.locator('#announce-remaining').innerText(), /^1[01] 分钟$/);
    assert.equal(await page.locator('#announce-msg').innerText(), '本次更新登录限速');

    const viewport = page.viewportSize();
    const setLanguage = value => page.evaluate(async value => (await import('/_v/{{BUILD}}/js/i18n.js')).i18n.setLanguage(value), value);
    await setLanguage('ru');
    assert.equal(await page.locator('#announce-title').innerText(), 'Запланировано обновление');
    assert.match(await page.locator('#announce-date').innerText(), /\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/);
    assert.match(await page.locator('#announce-remaining').innerText(), /^1[01] мин$/);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 840 });
      const fits = await bar.evaluate((element, mobile) => {
        const card = element.getBoundingClientRect();
        const copy = element.querySelector('.announce-text').getBoundingClientRect();
        const countdown = element.querySelector('.announce-countdown').getBoundingClientRect();
        const close = element.querySelector('.announce-close').getBoundingClientRect();
        return element.scrollWidth <= element.clientWidth + 1
          && [copy, countdown, close].every(part => part.left >= card.left && part.right <= card.right)
          && (mobile ? countdown.top >= copy.bottom && close.width >= 44 && close.height >= 44 : countdown.left >= copy.right);
      }, width < 760);
      assert.ok(fits, `announcement layout overflows or puts the countdown in the wrong place at ${width}px`);
    }
    await page.setViewportSize(viewport);
    await setLanguage('zh-CN');

    // Dismissed stays dismissed for the same announcement…
    await page.locator('#announce-close').click();
    await bar.waitFor({ state: 'hidden' });
    await push();
    await page.waitForTimeout(300);
    assert.equal(await bar.isHidden(), true, 'dismissed banner came back without a change');
    // …until the release completes.
    announcement = { ...announcement, completed_at: Date.now(), completed_version: 'v2' };
    await push();
    await bar.waitFor({ state: 'visible' });
    assert.equal(await bar.getAttribute('data-phase'), 'done');
    assert.match(await page.locator('#announce-title').innerText(), /已升级到 v2/);
    assert.equal(await page.locator('#announce-msg').isHidden(), true);
    assert.equal(await page.locator('#announce-date').isHidden(), true);
    assert.equal(await page.locator('#announce-countdown').isHidden(), true);

    await page.locator('#ann-clear').click();
    await page.locator('#dlg-ask').waitFor({ state: 'visible' });
    await page.locator('#ask-ok').click();
    await page.locator('#ann-current').filter({ hasText: '暂无通告' }).waitFor();
    assert.equal(deletes.length, 1);
    await push();
    await bar.waitFor({ state: 'hidden' });
    console.log('System announcements: activity list, notice validation, release post, pushed countdown banner, dismiss until completion, and withdrawal passed');
  } finally {
    for (const [pattern, handler] of Object.entries(routes)) await page.unroute(pattern, handler);
    await page.evaluate(() => localStorage.removeItem('agentbox_announcement_dismissed'));
  }
}
