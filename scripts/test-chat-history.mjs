import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatHistory } from '../internal/web/static/js/features/chat/history.js';
import { describeAgentDiagnostic } from '../internal/web/static/js/features/chat/agent-diagnostics.js';
import { interpolate } from '../internal/web/static/js/i18n/core.js';
import ru from '../internal/web/static/js/locales/ru-dynamic.js';

function deferred() { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; }
const value = {entries:[], thread:null};

test('external diagnostics use exact codes or known text and keep identifiers for support', () => {
  const cases = [
    ['error', {}, 'Missing environment variable: "CODEX_LB_API_KEY".', 'Не задана переменная окружения CODEX_LB_API_KEY.'],
    ['error', {error:{code:'invalid_api_key'}}, 'raw', 'Провайдер отклонил ключ API. Проверьте настройки аккаунта.'],
    ['error', {error:{code:'expired_token'}}, 'raw', 'Срок авторизации истёк. Подключите аккаунт заново.'],
    ['error', {}, 'unexpected status 403 Forbidden', 'Провайдер отказал в доступе к этому запросу.'],
    ['error', {}, 'The model "gpt-6-sol" does not exist', 'Модель gpt-6-sol недоступна для этого аккаунта.'],
    ['error', {}, 'unexpected status 503: {"error":{"code":"no_plan_support_for_model","message":"No accounts with a plan supporting model \'gpt-5.5\'"}}', 'Среди подключённых к прокси аккаунтов нет ни одного с доступом к модели gpt-5.5.'],
    ['error', {error:{codexErrorInfo:'rateLimitExceeded'}}, 'raw', 'Слишком много запросов. Попробуйте чуть позже.'],
    ['error', {}, 'API Error: 429 {"error":{"code":"insufficient_quota","type":"rate_limit_error"}}', 'Квота у провайдера исчерпана.'],
    ['error', {}, 'exceeded retry limit, last status: 429 Too Many Requests, request id: req_test-837', 'Провайдер отклонил запрос после нескольких попыток (HTTP 429).'],
    ['error', {}, 'unexpected status 429 Too Many Requests', 'Провайдер отклонил запрос (HTTP 429).'],
    ['error', {}, 'API Error: 529 {"error":{"type":"overloaded_error"}}', 'Провайдер временно перегружен. Попробуйте позже.'],
    ['error', {}, 'unexpected status 504 Gateway Timeout', 'Провайдер не ответил вовремя.'],
    ['retry', {error:{codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:null}}}}, 'raw', 'Связь прервалась. Агент повторяет запрос.'],
    ['error', {}, 'connection refused', 'Не удалось подключиться к провайдеру.'],
    ['error', {error:{codexErrorInfo:'contextWindowExceeded'}}, 'raw', 'В диалоге слишком много текста для этой модели. Сократите запрос или начните новый диалог.'],
    ['error', {}, 'API Error: 400 - File is too large', 'Файл слишком большой. Прикрепите файл меньшего размера.'],
    ['error', {error:{code:'unsupported_file_format'}}, 'raw', 'Провайдер не поддерживает этот формат файла.'],
    ['warning', {}, 'Model metadata for "gpt-6-luna" not found.', 'Codex не нашёл метаданные модели gpt-6-luna и использует резервные.'],
    ['warning', {}, 'This session was recorded with model "gpt-6-luna" but is resuming with "gpt-6.2-sol".', 'Диалог начат с моделью gpt-6-luna и продолжен с gpt-6.2-sol. Смена модели может повлиять на результат.'],
    ['warning', {}, 'unrecognized warning', 'Агент сообщил о предупреждении.'],
    ['error', {}, 'unexpected status 503 Service Unavailable', 'При выполнении запроса произошла ошибка.'],
  ];
  for (const [tone, event, raw, expected] of cases) {
    const diagnostic = describeAgentDiagnostic(event, raw, tone);
    assert.equal(interpolate(ru[diagnostic.source], diagnostic.params), expected, raw);
    assert.equal(diagnostic.raw, raw);
  }
  const diagnostic = describeAgentDiagnostic({
    error:{codexErrorInfo:{responseTooManyFailedAttempts:{httpStatusCode:429}}, request_id:'req_fixture', additionalDetails:'raw details'},
  }, 'no response', 'error');
  assert.equal(diagnostic.code, 'responseTooManyFailedAttempts');
  assert.equal(diagnostic.status, '429');
  assert.equal(diagnostic.requestID, 'req_fixture');
  assert.equal(diagnostic.extra, 'raw details');
});

test('saved timeout changes apply to subsequent requests, preserving an in-flight deadline', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let timeout=30_000;
  const requests=[];
  const history=new ChatHistory((_path,signal)=>{
    const pending=deferred(); requests.push({...pending,signal}); return pending.promise;
  },()=> 'a',()=>timeout);
  const first=history.load('a','/a',async()=>{},()=>{});
  timeout=60_000;
  t.mock.timers.tick(30_000);
  assert.equal(requests[0].signal.aborted,true);
  requests[0].resolve(value);
  assert.equal((await first).state,'failed');
  const second=history.load('a','/a',async()=>{},()=>{});
  t.mock.timers.tick(30_000);
  assert.equal(requests[1].signal.aborted,false);
  requests[1].resolve(value);
  assert.equal((await second).state,'loaded');
});

test('slow history remains loadable after 15 seconds and expires at 120 seconds', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const requests=[];
  const history=new ChatHistory((_path,signal)=>{
    const pending=deferred(); requests.push({...pending,signal}); return pending.promise;
  },()=> 'a');
  let rendered=0;
  const first=history.load('a','/a',async()=>{},()=>rendered++);
  t.mock.timers.tick(119_999);
  assert.equal(requests[0].signal.aborted,false);
  requests[0].resolve(value);
  assert.equal((await first).state,'loaded');
  assert.equal(rendered,1);

  const second=history.load('a','/a',async()=>{},()=>rendered++);
  t.mock.timers.tick(119_999);
  assert.equal(requests[1].signal.aborted,false);
  t.mock.timers.tick(1);
  assert.equal(requests[1].signal.aborted,true);
  requests[1].resolve(value);
  const result=await second;
  assert.equal(result.state,'failed');
  assert.equal(result.timedOut,true);
  assert.equal(rendered,1,'late success must not overwrite history');
});

test('workspace changes and logout discard delayed responses and cancel transport', async () => {
  let current = 'a'; const requests=[]; const applied=[];
  const history = new ChatHistory((path,signal)=>{const reply=deferred(); requests.push({path,signal,...reply}); return reply.promise;},()=>current);
  const first=history.load('a','/a',async()=>{}, v=>applied.push(v));
  current='b'; const second=history.load('b','/b',async()=>{},v=>applied.push(v));
  assert.equal(requests[0].signal.aborted,true);
  requests[0].resolve(value); assert.equal((await first).state,'stale'); assert.equal(applied.length,0);
  history.cancel(); requests[1].resolve(value); assert.equal((await second).state,'stale'); assert.equal(applied.length,0);
});

test('superseded draft preparation cannot render into another thread', async () => {
  const prepare=deferred(), entered=deferred(), rendered=[];
  const history=new ChatHistory(async()=>value,()=> 'a');
  const first=history.load('a','/a',async()=>{entered.resolve(); await prepare.promise;},()=>rendered.push('old'));
  await entered.promise;
  const second=history.load('a','/a',async()=>{},()=>rendered.push('new'));
  const result=await second; assert.equal(result.state,'loaded');
  prepare.resolve(); assert.equal((await first).state,'stale'); assert.deepEqual(rendered,['new']);
  history.cancel(); assert.equal(result.current(),false,'even settled callbacks must respect logout');
});

test('deadlines abort the request and late transport success does not render', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const pending=deferred(); let signal, rendered=false;
  const history=new ChatHistory(async(_path,s)=>{signal=s;return pending.promise;},()=> 'a',10);
  const load=history.load('a','/a',async()=>{},()=>{rendered=true;});
  t.mock.timers.tick(10); assert.equal(signal.aborted,true);
  pending.resolve(value); const result=await load;
  assert.equal(result.state,'failed'); assert.equal(result.timedOut,true); assert.equal(rendered,false);
});

test('polling replacement of the session object keeps history loading valid', async () => {
  let session={id:'a'}; const pending=deferred(); let applied=false;
  const history=new ChatHistory(()=>pending.promise,()=>session?.id);
  const load=history.load('a','/a',async()=>{},()=>{applied=true;});
  session={id:'a'}; pending.resolve(value);
  assert.equal((await load).state,'loaded'); assert.equal(applied,true);
});
