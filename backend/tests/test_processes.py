import json
import subprocess
import sys

import pytest

from amazme_backend.contracts import BackendError
from amazme_backend.processes import ProcessReservation, exited


def test_child_keeps_lease_until_kernel_exit_and_replaced_inode_never_proves_exit(tmp_path):
    reservation = ProcessReservation(tmp_path, "worker", "instance")
    lease = reservation.lease
    code = """import json,os,sys
from pathlib import Path
from amazme_backend.processes import retain_inherited
retain_inherited(int(sys.argv[1]),Path(sys.argv[2]),'worker','instance')
print(json.dumps({'ready':True}),flush=True)
sys.stdin.readline()
"""
    child = subprocess.Popen([sys.executable, "-c", code, str(reservation.fd), str(tmp_path)],
                             pass_fds=(reservation.fd,), stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    reservation.close()
    try:
        assert json.loads(child.stdout.readline())["ready"]
        assert not exited(lease)
        child.stdin.write("exit\n")
        child.stdin.flush()
        child.wait(timeout=5)
        assert exited(lease)
        path = tmp_path / "processes/worker-instance.lock"
        original = path.read_bytes()
        path.rename(path.with_suffix(".old"))
        path.write_bytes(original)
        with pytest.raises(BackendError, match="process_lease_identity_mismatch"):
            exited(lease)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)


def test_parent_sigkill_before_child_registration_does_not_release_birth_lease(tmp_path):
    import time

    from amazme_backend.contracts import ProcessLease

    parent_code = '''import subprocess,sys,time
from pathlib import Path
from amazme_backend.processes import ProcessReservation
root=Path(sys.argv[1])
r=ProcessReservation(root,"worker","birth")
child_code="import sys,time; from pathlib import Path; from amazme_backend.processes import retain_inherited; retain_inherited(int(sys.argv[1]),Path(sys.argv[2]),'worker','birth'); print('ready',flush=True); time.sleep(2)"
p=subprocess.Popen([sys.executable,"-c",child_code,str(r.fd),str(root)],pass_fds=(r.fd,),stdout=subprocess.PIPE,text=True)
assert p.stdout.readline().strip()=="ready"
print(r.lease.model_dump_json(),flush=True)
time.sleep(30)
'''
    parent = subprocess.Popen([sys.executable, "-c", parent_code, str(tmp_path)], stdout=subprocess.PIPE, text=True)
    try:
        lease = ProcessLease.model_validate_json(parent.stdout.readline())
        parent.kill()
        parent.wait(timeout=5)
        assert not exited(lease)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not exited(lease):
            time.sleep(0.05)
        assert exited(lease)
    finally:
        if parent.poll() is None:
            parent.kill()
            parent.wait(timeout=5)
