#!/usr/bin/env python3
"""First installation only. Later application releases arrive through signed pushes."""
import argparse
import grp
import json
import os
import pwd
import secrets
import shutil
import socket
import subprocess
import time
import uuid
from urllib.parse import urlparse
from pathlib import Path


BASE = Path('/opt/handover-ui')
ETC = Path('/etc/handover-ui')
QUEUE = Path('/var/lib/handover-ui-deploy')
REPOSITORY = 'UnityX103/handover-ui-server'
PORTS = (8024, 8025, 8032)


def run(*args):
    return subprocess.run(args, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT).stdout.strip()


def write(file, content, mode=0o600, group=None):
    file = Path(file)
    file.write_text(content)
    file.chmod(mode)
    if group:
        os.chown(file, 0, grp.getgrnam(group).gr_gid)


def prepare():
    if os.geteuid() != 0:
        raise SystemExit('root required for initial installation')
    public_url = os.environ.get('HANDOVER_PUBLIC_URL', '')
    parsed = urlparse(public_url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment or parsed.port != PORTS[0]:
        raise SystemExit('set HANDOVER_PUBLIC_URL to the HTTPS origin on the public port')
    if not ETC.exists():
        for port in PORTS:
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', port))
    for user, home in [('handover-ui', '/var/lib/handover-ui'), ('handover-hook', str(QUEUE))]:
        try:
            pwd.getpwnam(user)
        except KeyError:
            run('useradd', '--system', '--home-dir', home, '--shell', '/usr/sbin/nologin', user)
        Path(home).mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.chown(home, user, user)
    ETC.mkdir(exist_ok=True)
    ETC.chmod(0o750)
    shutil.chown(ETC, 'root', 'handover-hook')
    for directory in [BASE, BASE / 'ops', BASE / 'releases']:
        directory.mkdir(parents=True, exist_ok=True, mode=0o755)
        directory.chmod(0o755)
    for name in ['pending', 'received', 'results']:
        directory = QUEUE / name
        directory.mkdir(exist_ok=True, mode=0o750)
        shutil.chown(directory, 'handover-hook', 'handover-hook')
    if not (ETC / 'service.env').exists():
        env = {
            'HANDOVER_HOST': '127.0.0.1', 'HANDOVER_PORT': str(PORTS[1]),
            'HANDOVER_PUBLIC_URL': public_url.rstrip('/'),
            'HANDOVER_DATA_DIR': '/var/lib/handover-ui',
            'HANDOVER_ADMIN_TOKEN': secrets.token_urlsafe(48),
            'HANDOVER_VAPID_SUBJECT': os.environ.get('HANDOVER_VAPID_SUBJECT') or public_url.rstrip('/'),
        }
        for key in ('HANDOVER_VAPID_PUBLIC_KEY', 'HANDOVER_VAPID_PRIVATE_KEY'):
            if key in os.environ:
                env[key] = os.environ[key]
        write(ETC / 'service.env', ''.join(f'{key}={value}\n' for key, value in env.items()))
    if not (ETC / 'webhook.secret').exists():
        write(ETC / 'webhook.secret', secrets.token_urlsafe(48) + '\n', 0o640, 'handover-hook')
    if not (ETC / 'hook.env').exists():
        write(ETC / 'hook.env', 'HANDOVER_WEBHOOK_SECRET=' + (ETC / 'webhook.secret').read_text().strip() + '\n')
    if not (ETC / 'deploy_key').exists():
        run('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'handover-ui-readonly', '-f', str(ETC / 'deploy_key'))
    # Official GitHub Ed25519 host key, published in GitHub Docs (also on ssh.github.com:443).
    write(ETC / 'known_hosts', '[ssh.github.com]:443 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n', 0o644)
    config = {
        'base': str(BASE), 'queue_root': str(QUEUE), 'repository': REPOSITORY,
        'ref': 'refs/heads/main', 'hook_port': PORTS[2], 'app_user': 'handover-ui',
        'webhook_secret_file': str(ETC / 'webhook.secret'), 'service': 'handover-ui.service',
        'health_url': f'http://127.0.0.1:{PORTS[1]}/healthz',
        'git_ssh_command': 'ssh -i /etc/handover-ui/deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=/etc/handover-ui/known_hosts -o StrictHostKeyChecking=yes -p 443',
    }
    write(ETC / 'deploy.json', json.dumps(config, indent=2) + '\n', 0o640, 'handover-hook')
    print(json.dumps({'prepared': True, 'public_port': PORTS[0], 'app_port': PORTS[1], 'hook_port': PORTS[2]}))


def activate(source):
    prepare()
    source = Path(source).resolve()
    config = json.loads((ETC / 'deploy.json').read_text())
    env = {**os.environ, 'GIT_SSH_COMMAND': config['git_ssh_command'], 'GIT_TERMINAL_PROMPT': '0'}
    if not (BASE / 'repo.git').exists():
        subprocess.run(['git', 'clone', '--bare', f'ssh://git@ssh.github.com:443/{REPOSITORY}.git', str(BASE / 'repo.git')], env=env, check=True, stdout=subprocess.DEVNULL)
    for name in ['github_hook.py', 'deploy.py']:
        shutil.copyfile(source / name, BASE / 'ops' / name)
        (BASE / 'ops' / name).chmod(0o644)
    for name in ['handover-ui.service', 'handover-ui-hook.service', 'handover-ui-deploy.service', 'handover-ui-deploy.path']:
        shutil.copyfile(source / name, Path('/etc/systemd/system') / name)
    nginx = Path('/etc/nginx/conf.d/handover-ui.conf')
    prior = nginx.read_bytes() if nginx.exists() else None
    domain = urlparse(os.environ['HANDOVER_PUBLIC_URL']).hostname
    if not domain or not all(c.isalnum() or c in '.-' for c in domain):
        raise SystemExit('invalid TLS hostname')
    nginx.write_text((source / 'nginx.conf').read_text().replace('__HANDOVER_DOMAIN__', domain))
    try:
        run('nginx', '-t')
    except Exception:
        if prior is not None:
            nginx.write_bytes(prior)
        else:
            nginx.unlink(missing_ok=True)
        raise
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', 'handover-ui.service', 'handover-ui-hook.service', 'handover-ui-deploy.path')
    # Initial bootstrap uses the same serial release executor; no hook exists yet.
    sha = subprocess.run(['git', '--git-dir=' + str(BASE / 'repo.git'), 'rev-parse', 'refs/heads/main'], env=env, check=True, text=True, stdout=subprocess.PIPE).stdout.strip()
    event = {'delivery': str(uuid.uuid4()), 'sha': sha, 'received_at': time.time(), 'repository': REPOSITORY, 'ref': config['ref'], 'bootstrap': True}
    write(QUEUE / 'pending' / (event['delivery'] + '.json'), json.dumps(event) + '\n', 0o640)
    run('systemctl', 'start', 'handover-ui-deploy.service')
    state = json.loads((BASE / 'deployment.json').read_text())
    if state.get('status') != 'success':
        raise SystemExit('initial deploy failed; inspect journalctl -u handover-ui-deploy.service')
    run('systemctl', 'start', 'handover-ui-hook.service', 'handover-ui-deploy.path')
    run('systemctl', 'reload', 'nginx')
    print(json.dumps({'activated': True, 'sha': state['current'], 'public_port': PORTS[0]}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--activate', action='store_true')
    parser.add_argument('--source', default=str(Path(__file__).resolve().parent))
    args = parser.parse_args()
    if args.activate:
        activate(args.source)
    else:
        prepare()
