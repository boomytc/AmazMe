"""Environment evidence tools must not mark a simulation as acceptance."""
import json
import subprocess
import sys
from pathlib import Path


def test_wake_prepare_stays_unaccepted(tmp_path: Path) -> None:
    output = tmp_path / "wake.json"
    script = Path(__file__).parents[1] / "tools" / "capture_wake.py"
    result = subprocess.run([sys.executable, str(script), "--prepare", "--output", str(output)],
                            check=False, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    body = json.loads(output.read_text())
    assert body["status"] == "not_accepted" and body["proves"] is None
    assert "pmset sleep" in "".join(body["scenario"])
