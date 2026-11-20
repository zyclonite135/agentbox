#!/usr/bin/env python3
"""First installation from a checksum-verified release; reuse release.py activation."""
import argparse
from dataclasses import dataclass
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import secrets
import socket
import subprocess
import tempfile

import release


def text(en, ru):
    return ru if os.environ.get('AGENTBOX_INSTALL_LANG') == 'ru' else en


@dataclass
class Layout:
    app: Path = Path('/opt/agentbox')
    config: Path = Path('/etc/agentbox/config.json')
    data: Path = Path('/var/lib/agentbox')
    cache: Path = Path('/var/cache/agentbox')
    units: Path = Path('/etc/systemd/system')


def fresh(layout):
    for path in (layout.app, layout.config.parent, layout.data, layout.cache,
                 layout.units / 'agentbox.service'):
        if path.exists() or path.is_symlink():
            raise ValueError(text(
                'Existing installation path: {path}; use release.py to upgrade/resume. No files overwritten.',
                'Обнаружена существующая установка в {path}. Для обновления или возобновления используйте release.py. Данные сохранены.',
            ).format(path=path))
    if release.run('systemctl', 'show', 'agentbox.service', '--property=FragmentPath', '--value', capture=True).strip():
        raise ValueError(text('agentbox.service already exists; migrate the existing installation explicitly',
                              'Служба agentbox.service уже существует. Выполните миграцию существующей установки.'))


def listen_address(value):
    host, _, port = value.rpartition(':')
    invalid_address = text('listen must use an IP address and port', 'В --listen нужно указать IP-адрес и порт')
    try:
        address = ipaddress.ip_address(host.strip('[]'))
    except ValueError as error:
        raise ValueError(invalid_address) from error
    if str(address) != host and f'[{address}]' != host:
        raise ValueError(invalid_address)
    if not port.isascii() or not port.isdigit() or not 1 <= int(port) <= 65535:
        raise ValueError(text('listen port must be between 1 and 65535', 'Порт в --listen должен быть от 1 до 65535'))
    if address.version == 6 and not host.startswith('['):
        raise ValueError(text('IPv6 listen addresses require brackets, e.g. [::]:8180',
                              'Укажите IPv6-адрес в квадратных скобках, например [::]:8180'))
    return address, int(port)


def available(value):
    address, port = listen_address(value)
    family = socket.AF_INET6 if address.version == 6 else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as listener:
        # Match Go's listener: recently closed HTTP sockets can remain in
        # TIME_WAIT after uninstall, but must not prevent immediate reinstall.
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind((str(address), port))


def install(package, listen, layout):
    fresh(layout)
    available(listen)
    meta = release.read(package / 'build.json')
    version = meta.get('version', '')
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine())
    if (meta.get('program') != 'agentbox' or meta.get('os') != 'linux' or meta.get('arch') != arch
            or not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?', version)
            or '+dirty' in meta.get('revision', '')):
        raise ValueError(text('Expected a clean Linux release matching this machine',
                              'Нужен релиз для Linux этой архитектуры, собранный без локальных изменений'))
    for relative in ('agentbox', 'deploy/release.py', 'scripts/build-image.sh',
                     'images/agent/versions.env', 'images/agent/Dockerfile',
                     'images/agent/tmux.conf', 'images/agent/bashrc', 'images/agent/vimrc'):
        if not (package / relative).is_file():
            raise ValueError(text('Incomplete release: missing {file}', 'В пакете релиза отсутствует {file}').format(file=relative))

    records = json.loads(release.run('docker', 'network', 'inspect', 'bridge', capture=True))
    gateways = [entry.get('Gateway', '') for entry in records[0]['IPAM']['Config']]
    gateway = next((ip for ip in gateways if ip and ipaddress.ip_address(ip).version == 4), None)
    if not gateway:
        raise ValueError(text('Local Docker bridge needs an IPv4 gateway', 'Для сети bridge локального Docker нужен шлюз IPv4'))
    # Use a per-release tag, leaving all existing workspace images untouched.
    image = 'agentbox-agent:' + version
    password = secrets.token_urlsafe(32)
    config = release.read(package / 'config.example.json')
    config.update(listen=listen, auth_token=password, data_dir=str(layout.data), cache_dir=str(layout.cache),
                  agent_image=image, accounts=[], proxies=[],
                  tunnel={'enabled': False, 'proxy_bind': gateway + ':1080'},
                  proxy_bridge={'bind': gateway + ':1081'})
    config['container']['network'] = 'bridge'
    with tempfile.TemporaryDirectory(prefix='agentbox-config-') as tmp:
        candidate = Path(tmp) / 'config.json'
        release.atomic_json(candidate, config)
        release.run(package / 'agentbox', 'check-config', '--config', candidate)

    print(text('Building the pinned Claude/Codex workspace image (first install may take several minutes)...',
               'Собираем образ рабочего пространства с заданными версиями Claude и Codex. Первая сборка может занять несколько минут…'),
          flush=True)
    subprocess.run(['bash', str(package / 'scripts/build-image.sh')], check=True,
                   env=dict(os.environ, AGENTBOX_IMAGE=image, AGENTBOX_VERSIONED_IMAGE=image,
                            AGENTBOX_CLAUDE_VERSION='', AGENTBOX_CODEX_VERSION='', AGENTBOX_BASE_IMAGE=''))
    # Nothing in the deployment layout is written until downloads/build/preflight succeed.
    fresh(layout)
    available(listen)
    layout.config.parent.mkdir(parents=True, mode=0o700)
    release.atomic_json(layout.config, config)
    layout.cache.mkdir(parents=True, mode=0o700)
    command = ['python3', str(package / 'deploy/release.py'), '--app', str(layout.app),
               '--config', str(layout.config), '--unit-dir', str(layout.units)]
    release.run(*command, 'install', '--package', package)
    # Activate using the installed copy so error recovery never relies on a temp path.
    command[1] = str(layout.app / 'releases' / version / 'deploy/release.py')
    try:
        release.run(*command, 'activate', '--version', version, '--backup-dir', layout.data / 'backups')
    except subprocess.CalledProcessError:
        print(text('Activation failed. Configuration and installed files are retained.',
                   'Не удалось активировать версию. Конфигурация и установленные файлы сохранены.'))
        print(text('Inspect:', 'Посмотреть журнал:') + ' journalctl -u agentbox --no-pager -n 50')
        print(text('Retry:', 'Повторить активацию:') + f' python3 {command[1]} activate --version {version}')
        raise
    address, port = listen_address(listen)
    host = text('<SERVER_IP>', '<IP_СЕРВЕРА>') if address.is_unspecified else (f'[{address}]' if address.version == 6 else str(address))
    print(text('\nAgentBox {version} is installed and running. Startup on boot is enabled.',
               '\nAgentBox {version} установлен и запущен. Автозапуск включён.').format(version=version))
    print(text('Web console:', 'Веб-панель:') + f' http://{host}:{port}')
    print(text('Administrator:', 'Администратор:') + ' boxadmin')
    print(text('Initial password:', 'Начальный пароль:') + ' ' + password)
    print(text('Configuration: {config} (readable only by root). Data: {data}',
               'Конфигурация: {config} (чтение только для root). Данные: {data}').format(config=layout.config, data=layout.data))
    print(text('After signing in, add a Claude or Codex account in System settings → Account pool, then create a workspace.',
               'После входа добавьте аккаунт Claude или Codex в разделе «Настройки → Аккаунты», затем создайте рабочее пространство.'))
    if address.is_unspecified:
        print(text('For direct remote access, allow TCP port {port} in the firewall or security group. '
                   'For ongoing public access, configure an HTTPS reverse proxy.',
                   'Для прямого удалённого доступа откройте TCP-порт {port} в межсетевом экране или облачной группе безопасности. '
                   'Для постоянного доступа из интернета настройте обратный прокси с HTTPS.').format(port=port))
    print(text('Status:', 'Статус:') + ' systemctl status agentbox    ' + text('Logs:', 'Журнал:') + ' journalctl -u agentbox -f')


def main():
    parser = argparse.ArgumentParser(description=text(__doc__, 'Первая установка из проверенного пакета AgentBox.'), add_help=False)
    options = parser.add_argument_group(text('installer options', 'параметры установки'))
    options.add_argument('-h', '--help', action='help', help=text('show this help and exit', 'показать справку и выйти'))
    options.add_argument('--package', required=True, type=Path, metavar='PATH',
                         help=text('path to the extracted release', 'путь к распакованному релизу'))
    options.add_argument('--listen', default='0.0.0.0:8180', metavar='IP:PORT',
                         help=text('IP address and port for the web console', 'IP-адрес и порт веб-панели'))
    args = parser.parse_args()
    if platform.system() != 'Linux' or os.geteuid() != 0 or not Path('/run/systemd/system').is_dir():
        parser.error(text('run as root on the target systemd Linux server',
                          'запустите установщик от root на целевом сервере Linux с systemd'))
    # A CLI context/remote DOCKER_HOST must not build images on a different daemon.
    for key in ('DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'):
        os.environ.pop(key, None)
    os.environ['DOCKER_HOST'] = 'unix:///var/run/docker.sock'
    with release.locked('/run/lock/agentbox-install.lock'):
        install(args.package.resolve(), args.listen, Layout())


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, IndexError, subprocess.CalledProcessError) as error:
        raise SystemExit(text('AgentBox installation failed: ', 'Не удалось установить AgentBox: ') + str(error))
