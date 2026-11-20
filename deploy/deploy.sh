#!/usr/bin/env bash
# 构建 agentbox、替换二进制、重启服务并验证起来了。
# 单元文件不在这里管，那是 install.sh 的事（仓库挪位置后先跑它）。
set -euo pipefail
cd "$(dirname "$0")/.."
APP_DIR=$(pwd -P)

if [[ $EUID -ne 0 ]]; then
  echo "Для развёртывания нужны права root. Запустите sudo $0" >&2
  exit 1
fi

if [[ ! -f /etc/systemd/system/agentbox.service ]]; then
  echo "Служба systemd не установлена. Сначала выполните ./deploy/install.sh." >&2
  exit 1
fi

# 单元里的路径必须和当前目录一致，否则会重启出一个指向别处的实例。
unit_dir=$(sed -n 's|^WorkingDirectory=||p' /etc/systemd/system/agentbox.service)
if [[ "$unit_dir" != "$APP_DIR" ]]; then
  echo "Служба systemd использует каталог $unit_dir, а текущий репозиторий находится в $APP_DIR." >&2
  echo "Сначала выполните ./deploy/install.sh, чтобы обновить файл службы." >&2
  exit 1
fi

command -v go >/dev/null || export PATH=$PATH:/usr/local/go/bin
echo "==> Сборка"
go build -o .agentbox.new ./cmd/agentbox

# 用 rename 换二进制：运行中的进程持有旧 inode 不受影响，且不会像
# 直接覆盖那样撞上 ETXTBSY。
if [[ -f agentbox ]]; then
  cp -p agentbox "agentbox.bak-$(date +%m%d-%H%M)"
  ls -1t agentbox.bak-* 2>/dev/null | tail -n +4 | xargs -r rm --
fi
chmod 0755 .agentbox.new
mv -f .agentbox.new agentbox
echo "==> Исполняемый файл обновлён. Размер в байтах: $(stat -c %s agentbox)"

echo "==> Перезапуск службы"
systemctl restart agentbox

listen=$(python3 -c 'import json;print(json.load(open("config.json"))["listen"])' 2>/dev/null || echo '')
for i in $(seq 1 10); do
  sleep 1
  [[ "$(systemctl is-active agentbox)" == "active" ]] || continue
  [[ -z "$listen" ]] && break
  ss -ltn 2>/dev/null | grep -qF "$listen" && break
done

if [[ "$(systemctl is-active agentbox)" != "active" ]]; then
  echo
  echo "!! Службу не удалось запустить. Последние записи журнала:" >&2
  tail -20 /var/log/agentbox.log >&2
  echo
  echo "Команда отката: mv -f \$(ls -1t agentbox.bak-* | head -1) agentbox && systemctl restart agentbox" >&2
  exit 1
fi

# 端口绑定不代表 HTTP 栈可服务（SQLite 打不开、静态资源哈希构建失败等半死
# 状态探不出来）。用无鉴权的 /api/ping 做应用级探活。
if [[ -n "$listen" ]]; then
  port=${listen##*:}
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/api/ping" || echo 000)
  if [[ "$code" != "204" && "$code" != "200" ]]; then
    echo
    echo "!! /api/ping вернул код $code. Служба не готова. Последние записи журнала:" >&2
    tail -20 /var/log/agentbox.log >&2
    echo
    echo "Команда отката: mv -f \$(ls -1t agentbox.bak-* | head -1) agentbox && systemctl restart agentbox" >&2
    exit 1
  fi
  echo "==> Проверка готовности /api/ping: $code"
fi

echo "==> Служба готова"
systemctl status agentbox --no-pager | head -6
[[ -n "$listen" ]] && ss -ltnp 2>/dev/null | grep -F "$listen" || true
