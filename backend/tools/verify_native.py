"""Bounded native shell/file/approval/checkpoint acceptance in one fresh profile."""
import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from resource_budget import ResourceBudget
from resource_census import apply_cleanup, raise_pending, release_named_slot
from verify_runtime import ROOT, Runtime, until


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", type=Path)
    args = parser.parse_args()
    parent = ROOT / ".artifacts/native"
    parent.mkdir(parents=True, exist_ok=True)
    release_named_slot(parent, "run-", 2)
    root = Path(tempfile.mkdtemp(prefix="run-", dir=parent))
    provider = root / "faux.json"
    provider.write_text('{"provider":"faux"}')
    runtime = None
    report = {"status": "running", "provider": "faux", "checks": [], "started": time.time(),
              "source_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
              "source_dirty": bool(subprocess.check_output(["git", "diff", "--name-only"], cwd=ROOT)),
              "root": str(root), "execution": "native", "vm_created": False}
    budget = ResourceBudget([ROOT / ".artifacts"], limit_bytes=512 * 1024**2, deadline_seconds=180)
    try:
        with budget:
            command = [str(args.executable.resolve())] if args.executable else [sys.executable, "-m", "amazme_backend"]
            runtime = Runtime(command, root, provider, approval_policy="mutations")
            runtime.start()
            report["identity"] = runtime.ready
            session = runtime.session()
            headers = runtime.attach(session)
            api = runtime.client

            def post(path, value=None, expected=200):
                response = api.post(path, json=value, headers=headers)
                assert response.status_code == expected, response.text
                return response.json()

            def submit(request, text):
                return post(f"/api/v1/sessions/{session}/submissions", {"request_id": request, "text": text}, 202)

            def approve(request):
                def pending():
                    response = api.get(f"/api/v1/sessions/{session}/snapshot")
                    response.raise_for_status()
                    return [v for v in response.json()["approvals"] if v["request_id"] == request and v["state"] == "pending"]
                approval = until(pending, bool)[0]
                payload = {"decision_id": request + "-yes", "approval_id": approval["approval_id"],
                           "expected_revision": approval["revision"], "proposal_digest": approval["proposal_digest"], "approve": True}
                stale = api.post(f"/api/v1/sessions/{session}/approvals", json={**payload, "decision_id": request + "-stale", "expected_revision": "0"}, headers=headers)
                assert stale.status_code == 409, stale.text
                post(f"/api/v1/sessions/{session}/approvals", payload, 202)

            marker = runtime.workspace / "once.txt"
            text = "/shell printf x >> once.txt; pwd; command -v git"
            submit("shell", text)
            until(lambda: runtime.receipt(session, "shell"), lambda v: v["status"] == "waiting_approval")
            assert not marker.exists()
            approve("shell")
            assert runtime.complete(session, "shell")["status"] == "succeeded"
            submit("shell", text)
            assert marker.read_text() == "x"
            report["checks"].append("native shell: approval before effect, stale approval rejected, retry did not repeat effect")

            branch_id = "b" * 32
            branch = post(f"/api/v1/sessions/{session}/branches",
                          {"branch_id": branch_id, "request_id": "shell", "title": "Branch verification"}, 201)
            assert branch["session_id"] == branch_id and branch["prepared"]
            assert post(f"/api/v1/sessions/{session}/branches",
                        {"branch_id": branch_id, "request_id": "shell", "title": "Branch verification"}, 201) == branch
            accepted = api.post(f"/api/v1/sessions/{branch_id}/submissions", headers=runtime.attach(branch_id),
                                json={"request_id": "after-branch", "text": "branch remains writable"})
            assert accepted.status_code == 202, accepted.text
            assert runtime.complete(branch_id, "after-branch")["status"] == "succeeded"
            assert marker.read_text() == "x"
            report["checks"].append("metadata branch: same ID reuses copy; retired validation owner leaves business session writable")

            file = runtime.workspace / "note.txt"
            file.write_text("before\n")
            submit("file", '/write {"path":"note.txt","content":"after\\n"}')
            until(lambda: runtime.receipt(session, "file"), lambda v: v["status"] == "waiting_approval")
            assert file.read_text() == "before\n"
            approve("file")
            assert runtime.complete(session, "file")["status"] == "succeeded"
            assert file.read_text() == "after\n"
            rows = api.get("/api/v1/checkpoints", params={"workspace": "primary", "path": "note.txt"}).json()["checkpoints"]
            checkpoint = rows[-1]["checkpoint_id"]
            preview = api.get("/api/v1/checkpoints/"+checkpoint).json()
            assert preview["content"] == "before\n" and file.read_text() == "after\n"
            assert preview["absolute_path"] == str(file)
            file.write_text("external edit\n")
            post("/api/v1/checkpoints/"+checkpoint+"/restore", {"expected_digest": preview["current_digest"]}, 409)
            assert file.read_text() == "external edit\n"
            digest = hashlib.sha256(file.read_bytes()).hexdigest()
            post("/api/v1/checkpoints/"+checkpoint+"/restore", {"expected_digest": digest})
            assert file.read_text() == "before\n"
            report["checks"].append("model write: durable checkpoint, preview without writes, conflict refusal, selective restore")

            submit("cancel", "/shell echo started > cancel.txt; sleep 60; echo bad >> cancel.txt")
            approve("cancel")
            until(lambda: (runtime.workspace / "cancel.txt").exists(), bool)
            post(f"/api/v1/sessions/{session}/requests/cancel/cancel", expected=202)
            result = runtime.complete(session, "cancel")
            assert result["cancel_requested"] and result["status"] in {"cancelled", "unknown"}, result
            until(lambda: runtime.cleanup_receipt(session), bool)
            assert (runtime.workspace / "cancel.txt").read_text() == "started\n"
            report["checks"].append("cancel accepted separately; registered native processes stopped before cleanup receipt")
            assert not (runtime.profile / "vm.json").exists()
            report["status"] = "passed"
    except BaseException as error:
        report.update(status="failed", error=f"{type(error).__name__}: {error}")
        raise
    finally:
        report["budget"] = budget.snapshot()
        report["ended"] = time.time()
        pending = apply_cleanup(runtime, report)
        (root / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
        print(root / "report.json", flush=True)
        raise_pending(pending)


if __name__ == "__main__":
    main()
