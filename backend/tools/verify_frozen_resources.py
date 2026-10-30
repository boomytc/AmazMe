"""Read-only integrity check for one existing frozen backend bundle."""

import argparse
import json
import os
from pathlib import Path

from amazme_backend.platform.identity import FrozenManifest, frozen_identity
from amazme_backend.platform.resource_manifest import REQUIRED_IDENTITY
from amazme_backend.shared.errors import BackendError


def bundle_resources(executable: Path, report: dict) -> dict[str, Path]:
    bundle = executable.parent
    manifest = FrozenManifest.model_validate_json((bundle / "build.json").read_bytes())
    build = frozen_identity(bundle)
    if build != manifest.build_id:
        raise BackendError("build_manifest_mismatch")
    if executable.name not in manifest.files:
        raise BackendError("build_resource_missing", executable.name)
    resources: dict[str, Path] = {}
    for name in REQUIRED_IDENTITY:
        matches = [path for path in manifest.files if path == name or path.endswith("/" + name)]
        if len(matches) != 1:
            raise BackendError("build_resource_missing_or_ambiguous", name)
        resources[name] = bundle / matches[0]
    report.update(build_id=build, bundle_files=len(manifest.files), required_identity={
        name: path.relative_to(bundle).as_posix() for name, path in resources.items()
    })
    report["checks"].append("frozen_identity verified all manifest bytes and every REQUIRED_IDENTITY resource")
    return resources


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    executable, report_path = args.executable.resolve(strict=True), args.report.resolve()
    if not executable.is_file() or not os.access(executable, os.X_OK):
        parser.error("--executable must be an existing frozen executable")
    if report_path.is_relative_to(executable.parent):
        parser.error("--report must be outside the immutable bundle")
    report = {"status": "checking", "executable": str(executable), "checks": [],
              "scope": "manifest bytes and required resource presence; no runtime behavior"}
    try:
        bundle_resources(executable, report)
        report["status"] = "passed"
    except (OSError, ValueError, BackendError) as error:
        report.update(status="failed", error=f"{type(error).__name__}: {error}")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"status": report["status"], "build_id": report.get("build_id"), "report": str(report_path)}))
    if report["status"] != "passed":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
