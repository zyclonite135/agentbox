# Генерация изображений в AgentBox через codex-lb

Инструкция для AgentBox на Linux. Рабочая связка проверена с codex-lb `1.25.0-beta.9` и Codex CLI `0.145.0`.

## 1. Подготовить codex-lb

1. Открой админку codex-lb. В разделе **Accounts** проверь, что аккаунт ChatGPT активен.
2. В **API Keys** открой существующий ключ или создай новый. Для этой настройки оставь **Allowed models** и **Enforced model** пустыми. Если ключ привязан к конкретным аккаунтам, проверь, что нужный аккаунт включён в список.
3. Возьми адрес codex-lb и добавь к нему `/backend-api/codex`. Это Base URL для AgentBox. В примерах ниже замени `192.0.2.10:2455` на свой адрес и порт.

Проверить версию запущенного прокси можно с сервера AgentBox:

```bash
curl -sS -D - -o /dev/null http://192.0.2.10:2455/health | grep -i '^x-app-version:'
```

## 2. Настроить аккаунт Codex в AgentBox

1. Открой **Системные настройки → Пул аккаунтов → нужный аккаунт Codex → Авторизация**.
2. Выбери **Ключ API / прокси-сервис**. Впиши ключ codex-lb, укажи Base URL вида `http://192.0.2.10:2455/backend-api/codex`, выбери **Responses API** и нажми **Сохранить**. Если эти параметры уже заданы, просто закрой окно.
3. В строке того же аккаунта открой **Изменить**. Добавь в поле **Переменные окружения** строку `CODEX_LB_API_KEY=ТВОЙ_КЛЮЧ`, подставив тот же ключ codex-lb. Остальные строки в поле сохрани. Нажми **Сохранить**.

## 3. Изменить `config.toml` аккаунта

На сервере AgentBox выполни команду ниже. Она покажет названия аккаунтов Codex и пути к их `config.toml`. Для нестандартной установки подставь путь к серверному `config.json`.

```bash
sudo python3 - <<'PY'
import json
from pathlib import Path

config = Path('/etc/agentbox/config.json')
for account in json.loads(config.read_text(encoding='utf-8')).get('accounts', []):
    if account.get('type') == 'codex' and account.get('credentials_dir'):
        path = config.parent / account['credentials_dir'] / 'config.toml'
        print(account['id'], account.get('label', ''), path)
PY
```

Открой файл нужного аккаунта. Например, если его ID `codex-1` и используется стандартный каталог данных:

```bash
sudo nano /var/lib/agentbox/creds/codex-1/config.toml
```

Проверь, что в начале файла есть `model_provider = "agentbox"`. В уже существующей секции `[model_providers.agentbox]` выставь параметры ниже. Подставь тот же Base URL, что и в окне авторизации.

```toml
[model_providers.agentbox]
name = "agentbox"
base_url = "http://192.0.2.10:2455/backend-api/codex"
wire_api = "responses"
requires_openai_auth = false
env_key = "CODEX_LB_API_KEY"
http_headers = { "x-openai-actor-authorization" = "codex-lb" }
```

`env_key` содержит точное **имя** переменной `CODEX_LB_API_KEY`. Сам ключ уже сохранён в админке на шаге 2. В `nano` нажми **Ctrl+O**, **Enter**, затем **Ctrl+X**.

При следующем сохранении параметров в окне **Авторизация** AgentBox перезапишет секцию провайдера. Если меняешь адрес или ключ через это окно, снова выполни шаг 3.

## 4. Проверить в чате

1. Останови и снова запусти рабочее пространство, которое использует этот аккаунт Codex.
2. Нажми **Новый диалог** и отправь `$imagegen Сгенерируй котёнка`.
3. Готовое изображение должно появиться прямо в чате.

## Если генерация завершилась ошибкой

- **`Missing environment variable`**. Проверь строку `CODEX_LB_API_KEY=…` в форме **Изменить аккаунт** и `env_key = "CODEX_LB_API_KEY"` в `config.toml`.
- **`503 no_plan_support_for_model`**. codex-lb не нашёл доступный ключу аккаунт с поддержкой внутренней модели генерации. Посмотри имя модели в ошибке и проверь аккаунты, привязанные к ключу. Версия `1.24.0` использует `gpt-5.5`, а `1.25.0-beta.9` предпочитает `gpt-5.6-luna`.

Чтобы увидеть ответ прокси, повтори генерацию в чате и выполни команды **на Docker-хосте codex-lb**. Во второй команде замени `ИМЯ_КОНТЕЙНЕРА` именем контейнера codex-lb из первой команды.

```bash
sudo docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
sudo docker logs --since 5m ИМЯ_КОНТЕЙНЕРА 2>&1 \
  | grep -Ei 'images_route_complete|/images/generations'
```

Успешный запрос виден как `POST /backend-api/codex/images/generations` с `200 OK`.
