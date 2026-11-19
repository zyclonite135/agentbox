import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createI18n, normalizeLanguage, detectLanguage, interpolate } from '../internal/web/static/js/i18n/core.js';
import enStatic from '../internal/web/static/js/locales/en-static.js';
import twStatic from '../internal/web/static/js/locales/zh-TW-static.js';
import ruStatic from '../internal/web/static/js/locales/ru-static.js';
import enDynamic from '../internal/web/static/js/locales/en-dynamic.js';
import twDynamic from '../internal/web/static/js/locales/zh-TW-dynamic.js';
import ruDynamic from '../internal/web/static/js/locales/ru-dynamic.js';
import panelEn from '../internal/linkapp/static/locales/en.js';
import panelTw from '../internal/linkapp/static/locales/zh-TW.js';
import panelRu from '../internal/linkapp/static/locales/ru.js';

test('language normalization respects script, regions and ordered browser preferences', () => {
  for (const [source, expected] of Object.entries({ zh:'zh-CN', 'zh-SG':'zh-CN', 'zh-Hans-HK':'zh-CN',
    'zh-TW':'zh-TW', 'zh_HK':'zh-TW', 'zh-MO':'zh-TW', 'zh-Hant-CN':'zh-TW', 'en-US':'en', 'en-GB':'en',
    ru:'ru', 'ru-RU':'ru', 'RU_by':'ru' })) {
    assert.equal(normalizeLanguage(source), expected, source);
  }
  assert.equal(normalizeLanguage('english'), undefined);
  assert.equal(detectLanguage(['fr-FR', 'zh-HK', 'en']), 'zh-TW');
  assert.equal(detectLanguage(['fr-FR', 'ru-RU', 'en']), 'ru');
  assert.equal(detectLanguage(['fr-FR']), 'en');
});

test('saved preference wins, switches persist, denied storage still works', () => {
  const stored = new Map([['agentbox.language', 'zh-TW']]);
  const locale = createI18n({ catalogs: { en: { '保存':'Save' }, 'zh-TW': { '保存':'儲存' } },
    systemLanguages: () => ['en-US'], storage: { getItem: k => stored.get(k) ?? null, setItem: (k,v) => stored.set(k,v) } });
  assert.equal(locale.locale, 'zh-TW');
  assert.equal(locale.t('保存'), '儲存');
  let changes = 0;
  const unsubscribe = locale.subscribe(() => changes++);
  locale.setLanguage('zh-CN'); assert.equal(locale.t('保存'), '保存');
  locale.setLanguage('system'); assert.equal(locale.t('保存'), 'Save');
  assert.equal(stored.get('agentbox.language'), 'system');
  assert.equal(changes, 2);
  locale.setLanguage('system'); assert.equal(changes, 2);
  unsubscribe(); locale.setLanguage('zh-TW'); assert.equal(changes, 2);
  locale.dispose();
  const denied = createI18n({ catalogs:{}, storage:{ getItem(){throw Error('denied');}, setItem(){throw Error('denied');} }, systemLanguages:()=>['zh-CN'] });
  assert.equal(denied.locale, 'zh-CN');
  denied.setLanguage('en'); assert.equal(denied.locale, 'en');
  denied.dispose();
});

test('fallback and interpolation preserve arbitrary user values exactly', () => {
  const locale = createI18n({ catalogs:{en:{'删除 {name}':'Delete {name}'}}, storage:null, systemLanguages:()=>['en'] });
  assert.equal(locale.t('未知消息'), '未知消息');
  assert.equal(locale.t('constructor'), 'constructor');
  assert.equal(locale.t('删除 {name}', {name:'保存 <script>{other}</script>'}), 'Delete 保存 <script>{other}</script>');
  assert.equal(interpolate('{a} {b}',{a:'{b}',b:0}), '{b} 0');
  assert.equal(interpolate('{missing}'), '{missing}');
  locale.dispose();
});

const placeholders = value => [...value.matchAll(/\{([a-zA-Z][\w]*)\}/g)].map(m=>m[1]).sort();
for (const [name, en, tw, ru] of [['web static',enStatic,twStatic,ruStatic],
  ['web dynamic',enDynamic,twDynamic,ruDynamic], ['panel',panelEn,panelTw,panelRu]]) {
  test(`${name}: complete catalogs with matching placeholders`, () => {
    const keys = Object.keys(en).sort();
    for (const [language,catalog] of [['en',en],['zh-TW',tw],['ru',ru]]) {
      assert.deepEqual(Object.keys(catalog).sort(), keys, language);
      for (const key of keys) {
        assert.equal(typeof catalog[key], 'string', `${language}: ${key}`);
        assert.ok(catalog[key].trim(), `${language}: empty ${key}`);
        assert.deepEqual(placeholders(catalog[key]), placeholders(key), `${language}: ${key}`);
      }
    }
  });
}

test('all marked static web text and attributes have translations', async () => {
  const html = await readFile(new URL('../internal/web/static/index.html', import.meta.url),'utf8');
  const decode = value => value.replaceAll('&quot;','"').replaceAll('&#x27;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
  for (const match of html.matchAll(/data-i18n="([^"]*)"/g)) {
    const key=decode(match[1]);
    assert.ok(Object.hasOwn(enStatic,key)||Object.hasOwn(enDynamic,key), `Missing English: ${key}`);
    assert.ok(Object.hasOwn(twStatic,key)||Object.hasOwn(twDynamic,key), `Missing Traditional: ${key}`);
    assert.ok(Object.hasOwn(ruStatic,key)||Object.hasOwn(ruDynamic,key), `Missing Russian: ${key}`);
  }
  for (const match of html.matchAll(/data-i18n-(text|attrs)="([^"]*)"/g)) {
    const data = JSON.parse(decode(match[2]));
    for (const key of (Array.isArray(data) ? data : Object.values(data))) {
      assert.ok(Object.hasOwn(enStatic,key.trim()), `Missing English: ${key}`);
      assert.ok(Object.hasOwn(twStatic,key.trim()), `Missing Traditional: ${key}`);
      assert.ok(Object.hasOwn(ruStatic,key.trim()), `Missing Russian: ${key}`);
    }
  }
});

test('standalone panel core is exactly the generated shared core', async () => {
  const [web,panel] = await Promise.all([
    readFile(new URL('../internal/web/static/js/i18n/core.js',import.meta.url),'utf8'),
    readFile(new URL('../internal/linkapp/static/i18n-core.js',import.meta.url),'utf8'),
  ]);
  assert.equal(panel,web);
});
