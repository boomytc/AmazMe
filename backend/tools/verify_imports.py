"""Check public imports in a fresh process without profile, network or database access."""

import argparse
import importlib
import json
import os
import subprocess
import sys
from pathlib import Path

PUBLIC_IMPORTS = ("amazme_backend.sdk", "amazme_backend.contracts", "amazme_backend.plugin_api")
ALLOWED_BACKEND = ("amazme_backend.shared", "amazme_backend.contracts", "amazme_backend.sdk", "amazme_backend.plugin_api")


def probe(module: str) -> dict[str, object]:
    package_root = Path(__file__).resolve().parents[1] / "src/amazme_backend"
    python_roots = (Path(sys.prefix).resolve(), Path(sys.base_prefix).resolve())
    operations: list[dict[str, object]] = []

    def audit(event: str, args: tuple[object, ...]) -> None:
        if event == "open" and args and isinstance(args[0], (str, bytes, os.PathLike)):
            path = Path(os.fsdecode(args[0])).resolve()
            mode = args[1] if len(args) > 1 else None
            flags = args[2] if len(args) > 2 else 0
            if isinstance(mode, str) and any(letter in mode for letter in "wax+") or isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC):
                operations.append({"event": event, "path": str(path), "reason": "write"})
                raise RuntimeError("import attempted a file write: " + str(path))
            if path.suffix in {".py", ".pyc", ".so", ".dylib"}:
                return
            if path == Path("/System/Library/CoreServices/SystemVersion.plist"):
                return  # sysconfig reads the OS version while initializing zoneinfo on macOS.
            if not path.is_relative_to(package_root) and any(path.is_relative_to(root) for root in python_roots):
                return  # Runtime/library metadata initialization is not profile I/O.
            operations.append({"event": event, "path": str(path), "reason": "non-code read"})
            raise RuntimeError("import attempted a business resource read: " + str(path))
        if event in {"socket.connect", "socket.bind", "subprocess.Popen", "os.system", "os.fork", "sqlite3.connect", "os.mkdir", "os.remove", "os.rename"}:
            operations.append({"event": event})
            raise RuntimeError("import attempted a side effect: " + event)

    sys.dont_write_bytecode = True
    sys.addaudithook(audit)
    importlib.import_module(module)
    if operations:
        raise RuntimeError("public import attempted forbidden business I/O: " + json.dumps(operations))
    loaded = sorted(name for name in sys.modules if name == "amazme_backend" or name.startswith("amazme_backend."))
    unexpected = [name for name in loaded if name != "amazme_backend" and not any(name == allowed or name.startswith(allowed + ".") for allowed in ALLOWED_BACKEND)]
    if unexpected:
        raise RuntimeError("public import loaded backend implementation: " + ", ".join(unexpected))
    return {"module": module, "loaded": loaded, "business_operations": operations, "passed": True}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe", choices=PUBLIC_IMPORTS)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.probe:
        print(json.dumps(probe(args.probe)))
        return
    results = []
    for module in PUBLIC_IMPORTS:
        result = subprocess.run([sys.executable, "-B", str(Path(__file__).resolve()), "--probe", module],
                                capture_output=True, text=True)
        if result.returncode:
            print(result.stderr, file=sys.stderr, end="")
            raise SystemExit(result.returncode)
        results.append(json.loads(result.stdout))
    report = json.dumps({"passed": True, "probes": results}, indent=2) + "\n"
    if args.report:
        args.report.write_text(report)
    print(report, end="")


if __name__ == "__main__":
    main()
