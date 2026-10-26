import subprocess
import tempfile
from pathlib import Path

from amazme_backend.platform.ipc import child_command
from amazme_backend.contracts import ReadFile, ToolCall, WriteFile
from amazme_backend.execution.native import LocalPermit, read_report
from amazme_backend.execution.processes import ProcessReservation


def run_file(root: Path, call: ToolCall, digest: str | None) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory(prefix="am-file-") as temporary:
        profile = Path(temporary)
        directory = profile / "scope"
        directory.mkdir()
        value = WriteFile.model_validate_json(call.arguments) if call.name == "write_file" else ReadFile.model_validate_json(call.arguments)
        permit = LocalPermit(call_id=call.id, cwd=str(root), command=call.name, timeout_seconds=5,
                             file=value, expected_digest=digest)
        with ProcessReservation(profile, "execution", "file") as reservation:
            result = subprocess.run(child_command("execute", "--profile", str(profile), "--instance", "file",
                "--lifetime-fd", str(reservation.fd), "--directory", str(directory)), pass_fds=(reservation.fd,),
                input=permit.model_dump_json()+"\n", text=True, capture_output=True, timeout=10)
        assert result.returncode == 0, result.stderr
        report = read_report(directory)
        assert report.result is not None
        return subprocess.CompletedProcess(result.args, report.result.exit_code, report.result.stdout, report.result.stderr)
