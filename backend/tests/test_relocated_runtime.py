"""The relocated-bundle profile must refuse host Python, Node, Colima, and Docker."""

import importlib.util
import shutil
import subprocess
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1] / "tools" / "verify_relocated_bundle.py"


def load_tool() -> object:
    spec = importlib.util.spec_from_file_location("verify_relocated_bundle", TOOL)
    if spec is None or spec.loader is None:
        raise RuntimeError("verify_relocated_bundle could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_runtime_profile_blocks_system_names_and_allows_the_bundle_copy(tmp_path: Path) -> None:
    module = load_tool()
    write_sandbox = getattr(module, "write_sandbox")
    is_forbidden_runtime = getattr(module, "is_forbidden_runtime")
    prove_seatbelt = getattr(module, "prove_seatbelt")
    root = tmp_path / "with space"
    bundle = root / "AmazMe Python 0.1.0"
    bundled = bundle / "resources" / "docker"
    bundled.parent.mkdir(parents=True)
    source = root / "hello.c"
    source.write_text("#include <stdio.h>\nint main(int argc, char **argv){if(argc>1) puts(argv[1]); return 0;}\n")
    compiled = subprocess.run(["cc", "-O2", "-o", str(bundled), str(source)], check=False, capture_output=True, text=True)
    assert compiled.returncode == 0, compiled.stderr
    outside = root / "node"
    named = root / "python3.12"
    shutil.copy(bundled, outside)
    shutil.copy(bundled, named)
    outside.chmod(0o755)
    named.chmod(0o755)
    profile = root / "runtime.sb"
    write_sandbox(profile, [root], bundle)
    network = root / "offline.sb"
    write_sandbox(network, [root])
    seatbelt = prove_seatbelt(network)
    assert seatbelt == {"public_ip_443": "operation not permitted", "localhost_9": "connection refused"}

    def run(executable: Path | str, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["/usr/bin/sandbox-exec", "-f", str(profile), str(executable), *args],
            check=False, capture_output=True, text=True)

    denied_python = run("/usr/bin/python3", "-c", "print(1)")
    denied_node = run("/opt/homebrew/bin/node", "-e", "console.log(1)")
    denied_docker = run("/opt/homebrew/bin/docker", "--version")
    denied_colima = run("/opt/homebrew/bin/colima", "version")
    allowed = run(bundled, "ok")
    outside_run = run(outside, "no")
    assert denied_python.returncode != 0
    assert "Operation not permitted" in denied_python.stderr
    assert denied_node.returncode != 0 and "Operation not permitted" in denied_node.stderr
    assert denied_docker.returncode != 0 and "Operation not permitted" in denied_docker.stderr
    assert denied_colima.returncode != 0 and "Operation not permitted" in denied_colima.stderr
    assert allowed.returncode == 0, allowed.stderr
    assert allowed.stdout.strip() == "ok"
    assert outside_run.returncode == 0
    assert is_forbidden_runtime("/usr/bin/python3", bundle)
    assert is_forbidden_runtime("/opt/homebrew/bin/colima", bundle)
    assert is_forbidden_runtime("/opt/homebrew/bin/docker", bundle)
    assert is_forbidden_runtime(str(outside), bundle)
    assert is_forbidden_runtime(str(named), bundle)
    assert not is_forbidden_runtime(str(bundled), bundle)
    assert not is_forbidden_runtime("/usr/bin/sandbox-exec", bundle)
    assert not is_forbidden_runtime(str(bundle / "resources" / "lima" / "bin" / "limactl"), bundle)
