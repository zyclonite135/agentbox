#!/usr/bin/env bash
# Public bootstrap: curl -fsSL <repository>/main/install.sh | sudo bash
# Keep execution in main so a truncated download cannot run a partial installer.
set -euo pipefail

usage() {
  if [[ $language == ru ]]; then
    cat <<'EOF'
Установщик AgentBox для Linux (первая установка)

Запуск: sudo bash install.sh [--version vX.Y.Z] [--listen 0.0.0.0:8180] [--lang en|ru]

Установщик скачивает и проверяет релиз, собирает образ рабочего пространства
с заданными версиями компонентов и запускает службу agentbox.service.
Релизы с v0.1.1 включают пять клиентов abox-link. Go и Node.js на сервере не нужны.
На Ubuntu и Debian недостающие зависимости и Docker устанавливаются через apt.
На других дистрибутивах с systemd заранее установите Python 3.9+, Git, curl,
сертификаты CA, tzdata и локальный Docker Engine. Поддерживаются x86_64 и arm64.
Для обновления существующей установки используйте deploy/release.py.
Язык по умолчанию — английский. Для русского вывода укажите --lang ru.
EOF
  else
    cat <<'EOF'
agentbox Linux installer (new installations only)

Usage: sudo bash install.sh [--version vX.Y.Z] [--listen 0.0.0.0:8180] [--lang en|ru]

Downloads a verified release, builds the pinned workspace image, and starts
agentbox.service. v0.1.1+ also installs all five bundled abox-link clients.
No Go or Node required on the host.
Ubuntu/Debian: missing dependencies and Docker are installed with apt.
Other systemd Linux distributions: install Python 3.9+, Git, curl, CA certificates,
tzdata and a local Docker Engine first. Supports x86_64 and arm64.
Existing installations are preserved; use deploy/release.py for upgrades.
Output is in English by default. Use --lang ru for Russian.
EOF
  fi
}

message() {
  if [[ $language == ru ]]; then printf '%s\n' "$2"; else printf '%s\n' "$1"; fi
}

fail() { message "agentbox: $1" "agentbox: $2" >&2; exit 1; }

main() {
  local repository='zyclonite135/agentbox'
  local version='' listen='0.0.0.0:8180' arch task_tmp distro missing path dependency asset cleanup_cmd
  local language=en help=0 missing_option='' unknown_argument=''
  while (($#)); do
    case "$1" in
      --version|--listen|--lang)
        if (($# < 2)) || [[ $2 == --* || $2 == -h ]]; then
          missing_option=${missing_option:-$1}
          shift
          continue
        fi
        case "$1" in
          --version) version=$2 ;;
          --listen) listen=$2 ;;
          --lang) language=$2 ;;
        esac
        shift 2 ;;
      -h|--help) help=1; shift ;;
      *) unknown_argument=${unknown_argument:-"'$1'"}; shift ;;
    esac
  done
  [[ $language == en || $language == ru ]] || \
    fail "Unsupported language: $language (use en or ru)" "Неподдерживаемый язык $language (укажите en или ru)"
  [[ -z $missing_option ]] || fail "Missing value for $missing_option" "Укажите значение для $missing_option"
  [[ -z $unknown_argument ]] || fail "Unknown argument: $unknown_argument (see --help)" "Неизвестный аргумент $unknown_argument (см. --help)"
  if ((help)); then usage; return; fi
  [[ -z "$version" || "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || \
    fail 'Invalid release version' 'Некорректная версия релиза'
  [[ $(uname -s) == Linux ]] || fail 'Run this installer on the target Linux server' 'Запустите установщик на целевом сервере Linux'
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) fail 'Only x86_64 and arm64 are supported' 'Поддерживаются только x86_64 и arm64' ;;
  esac
  [[ $EUID == 0 ]] || fail 'Root is required; pipe the installer to sudo bash' 'Нужны права root. Передайте скрипт в sudo bash.'
  [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null || \
    fail 'A running systemd host is required' 'На сервере должен работать systemd'
  # Check before installing packages or starting Docker. Never adopt an existing deployment.
  for path in /etc/agentbox /opt/agentbox /var/lib/agentbox /var/cache/agentbox /etc/systemd/system/agentbox.service; do
    [[ ! -e "$path" && ! -L "$path" ]] || \
      fail "Existing installation path: $path. Use deploy/release.py to upgrade or resume; no data was changed." \
           "Обнаружена существующая установка в $path. Для обновления или возобновления используйте deploy/release.py. Данные сохранены."
  done
  [[ -z $(systemctl show agentbox.service --property=FragmentPath --value) ]] || \
    fail 'An agentbox service already exists; use the migration/upgrade instructions' \
         'Служба agentbox уже существует. Воспользуйтесь инструкцией по миграции или обновлению.'

  distro=''
  if [[ -r /etc/os-release ]]; then
    distro=$(. /etc/os-release; echo "${ID:-}")
  fi
  missing=''
  for dependency in curl python3 git; do
    command -v "$dependency" >/dev/null || missing="$missing $dependency"
  done
  [[ -f /etc/ssl/certs/ca-certificates.crt || -f /etc/pki/tls/certs/ca-bundle.crt ]] || missing="$missing ca-certificates"
  [[ -f /usr/share/zoneinfo/Asia/Shanghai ]] || missing="$missing tzdata"
  if [[ -n "$missing" ]]; then
    case "$distro" in
      ubuntu|debian)
        apt-get update
        DEBIAN_FRONTEND=noninteractive apt-get install -y curl python3 git ca-certificates tzdata ;;
      *) fail "Install missing dependencies first:$missing" "Сначала установите недостающие зависимости:$missing" ;;
    esac
  fi
  python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || \
    fail 'Python 3.9+ is required' 'Требуется Python 3.9 или новее'

  if [[ -e /sys/fs/selinux/enforce ]] && ! command -v restorecon >/dev/null; then
    fail 'SELinux requires restorecon; install policycoreutils first' 'Для SELinux нужна команда restorecon. Установите policycoreutils.'
  fi

  umask 077
  task_tmp=$(mktemp -d)
  # EXIT also covers download/checksum failures. Do not remove installation data.
  # EXIT can run after main's locals have unwound; capture a shell-quoted path.
  printf -v cleanup_cmd 'rm -rf -- %q' "$task_tmp"
  trap "$cleanup_cmd" EXIT
  if [[ -z "$version" ]]; then
    message 'Finding the latest stable agentbox release...' 'Поиск последнего стабильного релиза AgentBox…'
    curl --proto '=https' --proto-redir '=https' -fsSL --retry 3 --connect-timeout 15 --max-time 60 \
      "https://api.github.com/repos/$repository/releases/latest" -o "$task_tmp/latest.json" || \
      fail 'No stable release could be downloaded. Check GitHub connectivity, or select a published prerelease with --version.' \
           'Не удалось получить стабильный релиз. Проверьте доступ к GitHub или укажите опубликованную предварительную версию через --version.'
    version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tag_name"])' "$task_tmp/latest.json") || \
      fail 'Could not read the release version from GitHub' 'Не удалось прочитать версию релиза из ответа GitHub'
  fi
  [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || \
    fail 'Release has an invalid version' 'У релиза некорректная версия'
  local archive="agentbox_${version}_linux_${arch}.tar.gz"
  local base="https://github.com/$repository/releases/download/$version"
  message "Downloading $version (linux/$arch)..." "Загрузка $version (linux/$arch)…"
  for asset in SHA256SUMS "$archive"; do
    curl --proto '=https' --proto-redir '=https' -fsSL --retry 3 --connect-timeout 15 --max-time 600 \
      "$base/$asset" -o "$task_tmp/$asset" || fail "Release asset unavailable: $asset" "Файл релиза $asset недоступен"
  done
  # Verify exactly the selected asset, and extract only regular files/directories
  # beneath its expected root. Works on Python 3.9 without tar filter='data'.
  AGENTBOX_INSTALL_LANG="$language" PYTHONIOENCODING=utf-8 python3 - "$task_tmp" "$archive" <<'PY'
import hashlib, os, pathlib, re, sys, tarfile

def fail(en, ru):
    raise SystemExit(ru if os.environ.get('AGENTBOX_INSTALL_LANG') == 'ru' else en)

stage = pathlib.Path(sys.argv[1]); name = sys.argv[2]; root = name[:-7]
matches = []
for line in (stage / 'SHA256SUMS').read_text().splitlines():
    parts = line.split()
    if len(parts) == 2 and parts[1] == name:
        matches.append(parts[0])
if len(matches) != 1 or not re.fullmatch('[0-9a-fA-F]{64}', matches[0]):
    fail('Missing/duplicate/invalid checksum for selected release',
         'Контрольная сумма выбранного релиза отсутствует, повторяется или имеет неверный формат')
digest = hashlib.sha256()
with (stage / name).open('rb') as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b''):
        digest.update(chunk)
if digest.hexdigest() != matches[0].lower():
    fail('Release checksum mismatch; installation stopped',
         'Контрольная сумма архива релиза не совпадает. Установка остановлена.')
with tarfile.open(stage / name, 'r:gz') as archive:
    members = archive.getmembers(); seen = set(); total = 0
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if (not path.parts or path.parts[0] != root or path.is_absolute() or '..' in path.parts
                or not (member.isfile() or member.isdir()) or path in seen
                or member.mode & 0o7000 or member.size < 0):
            fail('Unsafe release archive member', 'Архив релиза содержит небезопасный элемент')
        seen.add(path); total += member.size
    if len(members) > 100000 or total > 2 * 1024**3:
        fail('Release archive exceeds extraction limits', 'Архив релиза превышает ограничения на распаковку')
    for member in members:
        archive.extract(member, stage, set_attrs=False)
        (stage / member.name).chmod(member.mode & 0o777)
PY
  local package="$task_tmp/${archive%.tar.gz}"
  [[ -f "$package/deploy/bootstrap.py" ]] || \
    fail 'This release predates the one-command installer; select a newer release' \
         'Этот релиз не поддерживает установку одной командой. Выберите более новый релиз.'
  # Pin every Docker operation to the same local daemon used by systemd.
  unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH
  export DOCKER_HOST=unix:///var/run/docker.sock
  if ! command -v docker >/dev/null; then
    case "$distro" in
      ubuntu|debian)
        message 'Installing Docker Engine from the distribution packages...' 'Установка Docker Engine из пакетов дистрибутива…'
        apt-get update
        DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io ;;
      *) fail 'Install a local Docker Engine first, then run this installer again' \
              'Установите локальный Docker Engine, затем запустите установщик ещё раз' ;;
    esac
  fi
  if ! docker info >/dev/null 2>&1; then
    systemctl enable --now docker.service
  fi
  docker info >/dev/null || fail 'Local Docker Engine is unavailable' 'Локальный Docker Engine недоступен'
  # Older release packages ignore the locale environment variable.
  AGENTBOX_INSTALL_LANG="$language" PYTHONIOENCODING=utf-8 \
    python3 "$package/deploy/bootstrap.py" --package "$package" --listen "$listen"
  # Run cleanup while task_tmp is still in scope, then disarm EXIT.
  rm -rf -- "$task_tmp"
  trap - EXIT
}

main "$@"
