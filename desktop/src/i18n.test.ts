import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed } from 'vue';
import { language, languageOptions, locale, messageRef, msg, t } from './i18n';
import en from './locales/en';
import traditional from './locales/zh-TW';
import ru from './locales/ru';
import { comparisonLabels } from './orphan-recovery';
import { progressStages } from './sync-task';
import { TerminalConnection } from './terminal-connection';
import { errorMessage, type TerminalEvent } from './bridge';

const previous = language.value;
afterEach(() => { language.value = previous; });
const placeholders = (value: string) => [...value.matchAll(/\{([a-zA-Z][\w]*)\}/g)].map(match => match[1]).sort();

describe('desktop language integration', () => {
  it('includes complete catalogs with unchanged placeholders', () => {
    for (const [name, catalog] of [['en', en], ['zh-TW', traditional], ['ru', ru]] as const) {
      expect(Object.keys(catalog).sort(), name).toEqual(Object.keys(en).sort());
      for (const [source, translation] of Object.entries(catalog)) {
        expect(translation.trim(), source).not.toBe('');
        if (name !== 'zh-TW') expect(translation, source).not.toMatch(/\p{Script=Han}/u);
        expect(placeholders(translation), source).toEqual(placeholders(source));
      }
    }
  });

  it('updates current labels and preserved messages without changing user content', () => {
    language.value = 'zh-CN';
    const heading = computed(() => t('工作空间'));
    const status = computed(() => comparisonLabels.changed);
    const stage = computed(() => progressStages.applying);
    const notice = messageRef(msg('副本已导出：{p1}', {p1: '工作空间/{p1}.txt'}));
    const raw = messageRef(errorMessage({message: '文件 ~/项目/server.log: unexpected EOF'}));
    language.value = 'en';
    expect(heading.value).toBe('Workspaces');
    expect(status.value).toBe('Current file differs from both its before and after states');
    expect(stage.value).toBe('Applying changes');
    expect(notice.value).toBe('Copy exported: 工作空间/{p1}.txt');
    expect(raw.value).toBe('文件 ~/项目/server.log: unexpected EOF');
    language.value = 'zh-TW';
    expect(locale.value).toBe('zh-TW');
    expect(heading.value).toBe('工作空間');
    expect(notice.value).toContain('工作空间/{p1}.txt');
    language.value = 'ru';
    expect(locale.value).toBe('ru');
    expect(heading.value).toBe('Рабочие пространства');
    expect(notice.value).toBe('Копия экспортирована: 工作空间/{p1}.txt');
    expect(raw.value).toBe('文件 ~/项目/server.log: unexpected EOF');
  });

  it('uses native language names and translates the system preference', () => {
    language.value = 'en';
    expect(languageOptions.value.map(option => option.label)).toEqual(['System', '简体中文', '繁體中文', 'English', 'Русский']);
    language.value = 'zh-TW';
    expect(languageOptions.value[0].label).toBe('跟隨系統');
  });

  it('localizes an active terminal status without reconnecting or changing bytes', async () => {
    language.value = 'zh-CN';
    const callbacks: ((event: TerminalEvent) => void)[] = [];
    const invoke = vi.fn(async (command: string) => command === 'terminal_open' ? 1 : undefined);
    const transport = {invoke, channel: (callback: (event: TerminalEvent) => void) => { callbacks.push(callback); return {}; }};
    const status = messageRef();
    const output = vi.fn((_bytes: Uint8Array, done: () => void) => done());
    const connection = new TerminalConnection(output, text => { status.value = text; }, () => ({cols: 80, rows: 24}), transport as never);
    await connection.open('workspace', 'terminal');
    expect(status.value).toBe('已连接');
    language.value = 'en';
    expect(status.value).toBe('Connected');
    language.value = 'ru';
    expect(status.value).toBe('Подключено');
    const bytes = [0xe4, 0xb8, 0xad, 0x1b, 0x5b, 0x30, 0x6d];
    callbacks[0]({type: 'data', sequence: 1, bytes});
    expect(Array.from(output.mock.calls[0][0])).toEqual(bytes);
    expect(invoke.mock.calls.filter(([command]) => command === 'terminal_open')).toHaveLength(1);
    expect(invoke.mock.calls.filter(([command]) => command === 'terminal_close')).toHaveLength(0);
    callbacks[0]({type: 'closed', code: 4004, message: '服务器原始消息'});
    language.value = 'zh-TW';
    expect(status.value).toBe('服务器原始消息');
    connection.close();
  });

  it('updates a denied terminal error without reconnecting or replaying input', async () => {
    language.value='zh-CN';
    const invoke=vi.fn().mockRejectedValue({kind:'forbidden',code:'quota_exhausted',retryable:false,operation_id:'0123456789abcdef0123456789abcdef'});
    const status=messageRef();
    const connection=new TerminalConnection(()=>{},text=>{status.value=text;},()=>({cols:80,rows:24}),{invoke,channel:()=>({})} as never);
    await connection.open('fixture');
    expect(status.value).toContain(t('额度已用完'));
    language.value='en';expect(status.value).toContain(t('额度已用完'));
    language.value='zh-TW';expect(status.value).toContain(t('额度已用完'));
    expect(status.value).toContain('0123456789abcdef0123456789abcdef');
    connection.resumeAfterSleep();
    expect(invoke).toHaveBeenCalledTimes(1);
    connection.close();
  });

  it('invalidates a typed destructive confirmation after the language changes', () => {
    language.value = 'zh-CN';
    const typed = t('永久清理原内容');
    const allowed = computed(() => typed === t('永久清理原内容'));
    expect(allowed.value).toBe(true);
    language.value = 'en';
    expect(allowed.value).toBe(false);
    expect(t('输入“{p1}”确认', {p1: t('永久清理原内容')})).toBe('Type “Permanently delete original content” to confirm');
  });
});
