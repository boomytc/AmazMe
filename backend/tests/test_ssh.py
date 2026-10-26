"""Pi SSH arguments and Python remote receipts; no external account is contacted."""

import base64
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from amazme_backend.contracts import BackendError, SshTarget
from amazme_backend.execution.remote.client import RemoteClient, daemon_identity
from amazme_backend.execution.remote.ssh import accept_host_key, host_key, scan_host_key, ssh_arguments


def test_ssh_arguments_follow_pi_route_and_do_not_forward(tmp_path: Path) -> None:
    target = SshTarget(host="dev-box", user="builder", port=2222,
                       identity_file='/tmp/a b%identity', config_file='/tmp/ssh config')
    args = ssh_arguments(target, tmp_path / 'known hosts', 'amazme-remote-a')
    assert args[:5] == ['-F', '/tmp/ssh config', '-T', '-a', '-x']
    for option in ['BatchMode=yes', 'ForwardAgent=no', 'ForwardX11=no', 'ClearAllForwardings=yes',
                   'StrictHostKeyChecking=yes', 'ControlMaster=no', 'ControlPath=none',
                   'PermitLocalCommand=no', 'RemoteCommand=none', 'SendEnv=-*', 'IdentitiesOnly=yes']:
        assert option in args
    assert 'IdentityFile="/tmp/a b%%identity"' in args
    assert args[-2:] == ['--', 'dev-box']
    assert args[args.index('-l') + 1] == 'builder'
    assert args[args.index('-p') + 1] == '2222'
    with pytest.raises(BackendError, match='invalid_ssh_user'):
        ssh_arguments(target.model_copy(update={'user': '-proxy'}), tmp_path / 'keys', 'alias')


def test_key_acceptance_is_explicit_and_never_replaces_a_different_key(tmp_path: Path) -> None:
    alias = 'amazme-remote-a'
    line = alias + ' ssh-ed25519 ' + base64.b64encode(b'key-one').decode()
    path = tmp_path / 'keys'
    normalized, fingerprint = host_key(alias, line)
    assert normalized == line and fingerprint.startswith('SHA256:')
    accept_host_key(path, alias, line)
    assert path.stat().st_mode & 0o777 == 0o600
    accept_host_key(path, alias, line)
    with pytest.raises(BackendError, match='ssh_host_key_changed'):
        accept_host_key(path, alias, alias + ' ssh-ed25519 ' + base64.b64encode(b'key-two').decode())
    assert path.read_text().strip() == line
    with pytest.raises(BackendError, match='invalid_ssh_host_key'):
        accept_host_key(path, alias, 'another ssh-ed25519 a2V5')


def test_scan_uses_pi_ssh_route_without_accepting_the_key(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def run(target, path, alias, command, **options):
        assert target.host == 'remote' and command == 'exit 0' and options['scan'] is True
        assert not (tmp_path / 'known_hosts').exists()
        path.write_text(alias + ' ssh-ed25519 a2V5\n')
        raise BackendError('ssh_authentication_failed')
    monkeypatch.setattr('amazme_backend.execution.remote.ssh.run_ssh', run)
    scanned = scan_host_key(SshTarget(host='remote'), 'alias')
    assert scanned[0][0] == 'alias ssh-ed25519 a2V5'
    assert not (tmp_path / 'known_hosts').exists()


def test_python_daemon_over_stdio_runs_once_and_never_replays_an_unknown(tmp_path: Path) -> None:
    daemon = Path(__file__).parents[1] / 'src/amazme_backend/execution/remote/daemon.py'
    state = tmp_path / 'remote'
    state.mkdir()

    def start() -> RemoteClient:
        process = subprocess.Popen([sys.executable, '-I', str(daemon), str(state)],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        client = RemoteClient(process)
        client.hello = client._recv(5)
        assert client.hello['daemon_id'] == daemon_identity()
        return client

    client = start()
    call_id = 'a' * 32
    marker = tmp_path / 'mark'
    command = f"printf x >> '{marker}'; printf '你好🙂'"
    try:
        first = client.call(call_id, command)
        assert json.loads(str(first['text']))['stdout'] == '你好🙂'
        assert client.call(call_id, command) == first
        assert client.call(call_id, 'echo other')['op'] == 'conflict'
        assert marker.read_text() == 'x'
        assert client.query('b' * 32)['op'] == 'unknown'
    finally:
        client.close()
    import sqlite3
    with sqlite3.connect(state / 'receipts.sqlite3') as db:
        db.execute('INSERT INTO calls(id,command,result) VALUES(?,?,NULL)', ('c' * 32, command))
    client = start()
    try:
        assert client.query(call_id) == first
        assert client.call('c' * 32, command)['op'] == 'unknown'
        assert marker.read_text() == 'x'
        result = client.call('d' * 32, "python3 -c \"print('x'*50000)\"")
        assert len(json.loads(str(result['text']))['stdout']) == 16000
    finally:
        client.close()


def test_ssh_connect_deploys_and_verifies_the_daemon_before_start(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # A local stand-in for the SSH executable exercises its command/stdin boundary only.
    # This is deliberately not evidence of authentication to an SSH server.
    tools = tmp_path / 'bin'
    tools.mkdir()
    stub = tools / 'ssh'
    stub.write_text(f'#!{sys.executable}\nimport os,sys\nos.execv("/bin/sh",["sh","-c",sys.argv[-1]])\n')
    stub.chmod(0o700)
    remote_home = tmp_path / 'remote home'
    remote_home.mkdir()
    env = {'PATH': str(tools) + os.pathsep + os.environ.get('PATH', ''), 'HOME': str(remote_home)}
    monkeypatch.setattr('amazme_backend.execution.remote.ssh.tool_environment', lambda: env)
    rid = 'a' * 32
    key = 'amazme-remote-' + rid + ' ssh-ed25519 a2V5'
    client = RemoteClient.connect(SshTarget(host='remote-alias'), tmp_path / 'local', key, rid)
    try:
        assert client.hello['daemon_id'] == daemon_identity()
        assert json.loads(str(client.call('b' * 32, 'printf ready')['text']))['stdout'] == 'ready'
    finally:
        client.close()
    assert (tmp_path / 'local/known_hosts').read_text().strip() == key


async def test_supervisor_close_reaps_its_ssh_transport_even_with_failed_storage(tmp_path: Path) -> None:
    from amazme_backend.bootstrap.supervisor import create_supervisor
    from amazme_backend.platform.private_files import private_write
    from amazme_backend.profiles.profile import Profile
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "ssh", "workspace": str(tmp_path), "resources": "unused",
        "provider": {"provider": "faux"}}))
    private_write(tmp_path / "control.token", "test")
    owner = create_supervisor(Profile(tmp_path), "ssh-owner")
    await owner.initialize()
    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    client = RemoteClient(process)
    owner.remote.clients["a" * 32] = client
    owner.db.failed = True
    await owner.close()
    assert process.poll() is not None
    assert not owner.remote.clients
