#!/usr/bin/env bash
# Public bootstrap: curl -fsSL <repository>/feature/my-change/install.sh | sudo bash
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
На Ubuntu и Debian недостающие зависимости устанавливаются через apt.
Если Docker отсутствует, установщик добавляет официальный репозиторий Docker CE.
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
Ubuntu/Debian: missing dependencies are installed with apt. A fresh Docker
installation uses the official Docker CE repository.
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

ensure_docker() {
  local distro=$1 staging=$2 docker_suite docker_arch docker_repo
  unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH
  export DOCKER_HOST=unix:///var/run/docker.sock
  if docker info >/dev/null 2>&1; then return; fi
  # The CLI may already be present after an interrupted installation.
  if ! command -v dockerd >/dev/null &&
      [[ $(systemctl show docker.service --property=LoadState --value) == not-found ]]; then
    case "$distro" in
      ubuntu|debian) docker_repo="https://download.docker.com/linux/$distro" ;;
      *) fail 'Install a local Docker Engine first, then run this installer again' \
              'Установите локальный Docker Engine, затем запустите установщик ещё раз' ;;
    esac
    docker_suite=$(
      . /etc/os-release
      if [[ $distro == ubuntu ]]; then
        printf '%s' "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
      else
        printf '%s' "${VERSION_CODENAME:-}"
      fi
    )
    [[ $docker_suite =~ ^[a-z0-9][a-z0-9-]*$ ]] || \
      fail 'Could not determine the Linux release codename for the Docker repository' \
           'Не удалось определить кодовое имя выпуска Linux для репозитория Docker'
    docker_arch=$(dpkg --print-architecture)
    message 'Installing Docker Engine from the official Docker repository...' \
            'Установка Docker Engine из официального репозитория Docker…'
    curl --proto '=https' --proto-redir '=https' -fsSL --retry 3 --connect-timeout 15 --max-time 60 \
      "$docker_repo/gpg" -o "$staging/docker.asc" || \
      fail 'Could not download the Docker repository signing key' \
           'Не удалось скачать ключ подписи репозитория Docker'
    install -d -m 0755 /etc/apt/keyrings
    install -m 0644 "$staging/docker.asc" /etc/apt/keyrings/docker.asc
    cat > "$staging/docker.sources" <<EOF
Types: deb
URIs: $docker_repo
Suites: $docker_suite
Components: stable
Architectures: $docker_arch
Signed-By: /etc/apt/keyrings/docker.asc
EOF
    install -m 0644 "$staging/docker.sources" /etc/apt/sources.list.d/docker.sources
    apt-get update --error-on=any || \
      fail 'Could not refresh APT package indexes. Check the repository errors above and retry.' \
           'Не удалось обновить индексы APT. Проверьте ошибки репозиториев выше и повторите установку.'
    # Package installation may start Docker. Publish only complete JSON and preserve existing configuration.
    if [[ ! -e /etc/docker/daemon.json && ! -L /etc/docker/daemon.json ]]; then
      (
        umask 022
        mkdir -p /etc/docker
        daemon_config=$(mktemp /etc/docker/.agentbox-daemon.XXXXXX)
        trap 'rm -f -- "$daemon_config"' EXIT
        printf '{\n  "log-driver": "local"\n}\n' > "$daemon_config" || \
          fail 'Could not write the Docker logging configuration' 'Не удалось записать настройки журналов Docker'
        chmod 0644 "$daemon_config"
        if ! ln -T -- "$daemon_config" /etc/docker/daemon.json 2>/dev/null; then
          if [[ ! -e /etc/docker/daemon.json && ! -L /etc/docker/daemon.json ]]; then
            fail 'Could not create /etc/docker/daemon.json' 'Не удалось создать /etc/docker/daemon.json'
          fi
        fi
      )
    fi
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-remove \
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  if ! docker info >/dev/null 2>&1; then
    systemctl enable --now docker.service
  fi
  docker info >/dev/null || fail 'Local Docker Engine is unavailable' 'Локальный Docker Engine недоступен'
}

prepare_whisper() {
  local distro=$1 stage=$2
  local source_revision=96ec4d9823e9d0211944172da35f9f29134af990 # v1.9.6
  local model_revision=fb5ed9369c26eaf08392504d8446da431e0fffb9
  local model_sha256=60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe
  if ! command -v cmake >/dev/null || ! command -v g++ >/dev/null || ! command -v make >/dev/null; then
    case "$distro" in
      ubuntu|debian)
        apt-get update
        DEBIAN_FRONTEND=noninteractive apt-get install -y --no-remove build-essential cmake ;;
      *) fail 'Install cmake, g++ and make for Whisper' 'Установите cmake, g++ и make для Whisper' ;;
    esac
  fi
  message 'Building whisper.cpp and downloading the multilingual base model...' \
          'Сборка whisper.cpp и загрузка многоязычной модели base…'
  git init --quiet "$stage/whisper-src"
  git -C "$stage/whisper-src" fetch --quiet --depth 1 https://github.com/ggml-org/whisper.cpp.git "$source_revision"
  git -C "$stage/whisper-src" checkout --quiet --detach "$source_revision"
  cmake -S "$stage/whisper-src" -B "$stage/whisper-build" -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=ON
  cmake --build "$stage/whisper-build" --target whisper-server --parallel 2
  curl --proto '=https' --proto-redir '=https' -fsSL --retry 3 --connect-timeout 15 --max-time 600 \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/$model_revision/ggml-base.bin" -o "$stage/ggml-base.bin"
  printf '%s  %s\n' "$model_sha256" "$stage/ggml-base.bin" | sha256sum --check --status || \
    fail 'Whisper base model checksum mismatch' 'Контрольная сумма модели Whisper base не совпадает'
}

install_whisper() (
  local stage=$1
  local whisper_home=/opt/agentbox-whisper
  local unit=/etc/systemd/system/agentbox-whisper.service
  local dropin=/etc/systemd/system/agentbox.service.d/20-whisper.conf
  local dropin_dir_created=0
  # Reserve the directory before arming cleanup so an existing installation
  # (including a concurrent installer) cannot be removed by this attempt.
  mkdir -m 0755 -- "$whisper_home"
  trap '
    if [[ -f "$unit" ]]; then
      systemctl stop agentbox-whisper.service || :
    fi
    rm -f -- "$dropin" "$unit" "$whisper_home/ggml-base.bin" "$whisper_home/whisper-server"
    rmdir -- "$whisper_home/public" "$whisper_home" 2>/dev/null || :
    if ((dropin_dir_created)); then rmdir -- "${dropin%/*}" 2>/dev/null || :; fi
    systemctl daemon-reload || :
  ' EXIT
  install -d -m 0755 "$whisper_home/public"
  install -m 0755 "$stage/whisper-build/bin/whisper-server" "$whisper_home/whisper-server"
  install -m 0644 "$stage/ggml-base.bin" "$whisper_home/ggml-base.bin"
  cat > "$unit" <<'UNIT'
[Unit]
Description=AgentBox local Whisper speech recognition
[Service]
Type=simple
DynamicUser=yes
WorkingDirectory=/opt/agentbox-whisper
ExecStart=/opt/agentbox-whisper/whisper-server --host 127.0.0.1 --port 18088 --public /opt/agentbox-whisper/public -m /opt/agentbox-whisper/ggml-base.bin -l auto -ng -nc
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
UNIT
  chmod 0644 "$unit"
  if command -v restorecon >/dev/null; then restorecon -R "$whisper_home" "$unit"; fi
  systemctl daemon-reload
  systemctl start agentbox-whisper.service
  curl --noproxy '*' -fsS --retry 15 --retry-connrefused --retry-delay 1 --max-time 2 \
    http://127.0.0.1:18088/health >/dev/null || \
    fail 'Whisper did not become ready; see journalctl -u agentbox-whisper' \
         'Whisper не запустился. Проверьте журнал: journalctl -u agentbox-whisper'
  systemctl is-active --quiet agentbox-whisper.service
  if [[ ! -d "${dropin%/*}" ]]; then
    mkdir -m 0755 -- "${dropin%/*}"
    dropin_dir_created=1
  fi
  cat > "$dropin" <<'UNIT'
[Unit]
Wants=agentbox-whisper.service
After=agentbox-whisper.service
[Service]
Environment=AGENTBOX_WHISPER_PORT=18088
UNIT
  chmod 0644 "$dropin"
  if command -v restorecon >/dev/null; then restorecon -R "${dropin%/*}"; fi
  systemctl daemon-reload
  trap - EXIT
  message 'Local Whisper base is ready on 127.0.0.1:18088.' 'Локальный Whisper base готов на 127.0.0.1:18088.'
)

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
  for path in /opt/agentbox-whisper /etc/systemd/system/agentbox-whisper.service /etc/systemd/system/agentbox.service.d/20-whisper.conf; do
    [[ ! -e "$path" && ! -L "$path" ]] || \
      fail "Whisper installation path already exists: $path" "Обнаружен существующий путь Whisper: $path"
  done
  [[ ! -L /etc/systemd/system/agentbox.service.d ]] || \
    fail 'AgentBox service override directory is a symlink' 'Каталог настроек службы AgentBox является символической ссылкой'
  [[ -z $(systemctl show agentbox-whisper.service --property=FragmentPath --value) ]] || \
    fail 'A Whisper service already exists' 'Служба Whisper уже существует'
  [[ ! ${listen##*:} =~ ^0*18088$ ]] || \
    fail 'Port 18088 is reserved for local Whisper' 'Порт 18088 зарезервирован для локального Whisper'

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
    version=$(PYTHONIOENCODING=utf-8 python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["tag_name"])' \
      "$task_tmp/latest.json" 2>/dev/null) || \
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
for line in (stage / 'SHA256SUMS').read_text(encoding='utf-8').splitlines():
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
  python3 -c 'import mmap,sys
with open(sys.argv[1], "rb") as binary, mmap.mmap(binary.fileno(), 0, access=mmap.ACCESS_READ) as data:
    sys.exit(data.find(b"AGENTBOX_WHISPER_PORT") < 0)' "$package/agentbox" || \
    fail 'This AgentBox release does not support local Whisper; select a compatible release' \
         'Этот релиз AgentBox не поддерживает локальный Whisper. Выберите совместимый релиз.'
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 18088))' || \
    fail 'Local Whisper port 18088 is unavailable' 'Порт 18088 для локального Whisper недоступен'
  prepare_whisper "$distro" "$task_tmp"
  # Pin every Docker operation to the same local daemon used by systemd.
  ensure_docker "$distro" "$task_tmp"
  install_whisper "$task_tmp"
  # Older packages ignore the language selector but still need UTF-8.
  AGENTBOX_INSTALL_LANG="$language" PYTHONUTF8=1 PYTHONIOENCODING=utf-8 \
    python3 "$package/deploy/bootstrap.py" --package "$package" --listen "$listen"
  # Run cleanup while task_tmp is still in scope, then disarm EXIT.
  rm -rf -- "$task_tmp"
  trap - EXIT
}

main "$@"
