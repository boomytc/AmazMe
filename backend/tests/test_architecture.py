"""Exercise architecture rules against small source trees, never the live backend."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
CHECKER = BACKEND / "tools/check_architecture.py"
MANIFEST = BACKEND / "architecture.json"


def check_tree(tmp_path: Path, sources: dict[str, str], *, report_only: bool = False):
    root = tmp_path / "amazme_backend"
    root.mkdir()
    (root / "__init__.py").write_text("")
    for name, content in sources.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        for parent in path.parents:
            if not parent.is_relative_to(root):
                break
            (parent / "__init__.py").touch(exist_ok=True)
        path.write_text(content)
    command = [sys.executable, str(CHECKER), "--manifest", str(MANIFEST), "--source-root", str(root), "--format", "json"]
    if report_only:
        command.append("--report-only")
    result = subprocess.run(command, capture_output=True, text=True, timeout=20)
    assert result.returncode in {0, 1}, result.stderr
    return result.returncode, json.loads(result.stdout)


def finding(report: dict, rule: str, target: str):
    return next(item for item in report["diagnostics"] if item["rule"] == rule and item["target"] == target)


def test_sdk_cannot_reach_session_store_via_artifacts(tmp_path):
    code, report = check_tree(tmp_path, {
        "sdk/client.py": "from ..features.artifacts.service import ArtifactView\n",
        "features/artifacts/service.py": "from ...sessions.store import SessionStore\n",
        "sessions/store.py": "class SessionStore: pass\n",
    })
    assert code == 1
    problem = finding(report, "pure-closure", "amazme_backend.sessions.store")
    assert problem["chain"] == ["amazme_backend.sdk.client", "amazme_backend.features.artifacts.service", "amazme_backend.sessions.store"]


@pytest.mark.parametrize("module", ["agent.prompting", "host.service", "accounts.store"])
def test_ai_cannot_import_product_or_credential_owners(tmp_path, module):
    code, report = check_tree(tmp_path, {
        "ai/client.py": f"def call():\n    from amazme_backend.{module} import secret\n",
        module.replace(".", "/") + ".py": "secret = None\n",
    })
    assert code == 1
    problem = next(item for item in report["diagnostics"] if item["rule"] in {"dependency", "private-entry"})
    assert problem["target"] == "amazme_backend." + module
    assert "function" in problem["message"]
    assert problem["file"].endswith("ai/client.py") and problem["line"] == 2
    assert problem["allowed"]


def test_cross_domain_private_persistence_is_not_a_type_entry(tmp_path):
    code, report = check_tree(tmp_path, {
        "host/service.py": "from ..sessions.persistence.rows import Row\n",
        "sessions/persistence/rows.py": "class Row: pass\n",
    })
    assert code == 1
    problem = finding(report, "private-entry", "amazme_backend.sessions.persistence.rows")
    assert "amazme_backend.sessions.service" in problem["allowed"]


@pytest.mark.parametrize("source,target", [
    ("import subprocess as sp\ndef run(): sp.Popen(['true'])\n", "subprocess.Popen"),
    ("from subprocess import Popen as launch\nlaunch(['true'])\n", "subprocess.Popen"),
    ("import asyncio as loop\nasync def run(): await loop.create_subprocess_exec('true')\n", "asyncio.create_subprocess_exec"),
    ("from asyncio import create_subprocess_shell as launch\nasync def run(): await launch('true')\n", "asyncio.create_subprocess_shell"),
    ("import subprocess\nstart = subprocess.run\nstart(['true'])\n", "subprocess.run"),
    ("import subprocess as sp\ngetattr(sp, 'Popen')(['true'])\n", "subprocess.Popen"),
    ("import subprocess as sp\nlaunch, number = sp.Popen, 1\nlaunch(['true'])\n", "subprocess.Popen"),
    ("import subprocess as sp\nattribute = 'Popen'\nlaunch = getattr(sp, attribute)\nlaunch(['true'])\n", "subprocess.Popen"),
    ("from importlib import import_module\nsp = import_module('subprocess')\nsp.Popen(['true'])\n", "subprocess.Popen"),
])
def test_nested_modules_cannot_hide_process_apis_with_aliases(tmp_path, source, target):
    code, report = check_tree(tmp_path, {"features/resources/nested/deeper.py": source})
    assert code == 1
    problem = finding(report, "process-spawn", target)
    assert problem["file"].endswith("nested/deeper.py")


def test_initializer_reexport_and_delayed_import_do_not_hide_domain_cycle(tmp_path):
    code, report = check_tree(tmp_path, {
        "ai/__init__.py": "from ..host.service import Host\n",
        "ai/client.py": "class Client: pass\n",
        "host/service.py": "class Host:\n    def run(self):\n        from ..ai.client import Client\n",
    })
    assert code == 1
    cycle = [item for item in report["diagnostics"] if item["rule"] == "cross-domain-cycle"]
    assert cycle and any("phase=function" in item["message"] for item in cycle)
    assert any("amazme_backend.ai" in item["chain"] for item in cycle)


def test_contract_return_type_cannot_come_from_implementation_even_in_type_checking(tmp_path):
    code, report = check_tree(tmp_path, {
        "contracts/models.py": "from typing import TYPE_CHECKING as TC\nif TC:\n    from ..sessions.service import Result\n",
        "sessions/service.py": "class Result: pass\n",
    })
    assert code == 1
    problem = finding(report, "pure-closure", "amazme_backend.sessions.service")
    assert "type-checking" in problem["message"]
    assert any(edge["phase"] == "type-checking" for edge in report["edges"])


@pytest.mark.parametrize("source", [
    "from importlib import import_module as load\nload('amazme_backend.' + 'host.service')\n",
    "import importlib as loader\nmodule_name = 'amazme_backend.host.service'\nloader.import_module(module_name)\n",
    "import importlib\nimportlib.import_module('..host.service', package='amazme_backend.ai')\n",
    "__import__('amazme_backend.host.service')\n",
    "import runpy\nrunpy.run_module('amazme_backend.host.service')\n",
    "import importlib\nimportlib.import_module(name='amazme_backend.host.service')\n",
    "__import__('host.service', globals(), locals(), ['Host'], 2)\n",
])
def test_statically_known_dynamic_imports_obey_same_boundaries(tmp_path, source):
    code, report = check_tree(tmp_path, {"ai/client.py": source, "host/service.py": ""})
    assert code == 1
    finding(report, "dependency", "amazme_backend.host.service")
    assert any(edge["target"] == "amazme_backend.host.service" and edge["dynamic"] for edge in report["edges"])


def test_unresolvable_dynamic_import_is_a_failure(tmp_path):
    code, report = check_tree(tmp_path, {"ai/client.py": "import importlib\ndef load(name): return importlib.import_module(name)\n"})
    assert code == 1
    finding(report, "dynamic-import-unresolved", "importlib.import_module")


def test_file_loader_to_internal_module_is_not_an_external_extension(tmp_path):
    code, report = check_tree(tmp_path, {
        "ai/client.py": "from pathlib import Path\nfrom importlib.util import spec_from_file_location as load\nload('private', Path(__file__).parent.parent / 'host/service.py')\n",
        "host/service.py": "",
    })
    assert code == 1
    finding(report, "dependency", "amazme_backend.host.service")


def test_parent_package_initialization_is_included_in_sdk_closure(tmp_path):
    code, report = check_tree(tmp_path, {
        "__init__.py": "from .accounts.store import AccountStore\n",
        "sdk/client.py": "class Client: pass\n",
        "accounts/store.py": "class AccountStore: pass\n",
    })
    assert code == 1
    problem = finding(report, "pure-closure", "amazme_backend.accounts.store")
    assert problem["chain"][0] in {"amazme_backend.sdk", "amazme_backend.sdk.client"}
    assert "amazme_backend" in problem["chain"]


def test_process_reexport_does_not_launder_sensitive_alias(tmp_path):
    code, report = check_tree(tmp_path, {
        "execution/mcp/__init__.py": "from subprocess import Popen as launch\n",
        "features/resources/service.py": "from ...execution.mcp import launch\nlaunch(['true'])\n",
    })
    assert code == 1
    problem = finding(report, "process-spawn", "subprocess.Popen")
    assert problem["source"] == "amazme_backend.features.resources.service"


@pytest.mark.parametrize("source,rule,target", [
    ("from os import execve as replace\nreplace('/bin/sh', [], {})\n", "process-reexec", "os.execve"),
    ("from os import fork as split\nsplit()\n", "process-reexec", "os.fork"),
    ("import fcntl as locks\nlocks.flock(3, locks.LOCK_UN)\n", "lifetime-unlock", "fcntl.LOCK_UN"),
    ("from fcntl import LOCK_UN as unlock\nvalue = unlock\n", "lifetime-unlock", "fcntl.LOCK_UN"),
    ("import os\nstop = os.killpg\nstop(1, 9)\n", "process-lifecycle", "os.killpg"),
    ("import fcntl\nvalue = getattr(fcntl, 'LOCK_' + 'UN')\n", "lifetime-unlock", "fcntl.LOCK_UN"),
])
def test_exec_unlock_and_lifecycle_aliases_remain_restricted(tmp_path, source, rule, target):
    code, report = check_tree(tmp_path, {"features/resources/service.py": source})
    assert code == 1
    finding(report, rule, target)


def test_inherited_descriptor_cannot_be_closed_through_alias(tmp_path):
    code, report = check_tree(tmp_path, {"execution/processes.py":
        "from os import close as release\ndef retain_inherited(fd, profile, role, instance):\n    release(fd)\n"})
    assert code == 1
    finding(report, "lifetime-close", "os.close")


def test_pty_permission_is_scoped_not_a_blanket_reexec_exemption(tmp_path):
    code, report = check_tree(tmp_path, {"execution/pty/gate.py":
        "import os\ndef _child(): os.execve('/bin/sh', [], {})\ndef unrelated(): os.execve('/bin/sh', [], {})\n"})
    assert code == 1
    problems = [item for item in report["diagnostics"] if item["rule"] == "process-reexec"]
    assert [item["line"] for item in problems] == [3]


def test_registered_plugin_loader_is_allowed_but_other_scope_is_not(tmp_path):
    code, report = check_tree(tmp_path, {"execution/plugins/gate.py":
        "import importlib.util\ndef run():\n    spec = importlib.util.spec_from_file_location('user', entry)\n    exec(compile(source, entry, 'exec'), {})\ndef other():\n    exec(source)\n"})
    assert code == 1
    assert [item["line"] for item in report["diagnostics"] if item["rule"] == "dynamic-code"] == [6]
    assert not [item for item in report["diagnostics"] if item["rule"] == "dynamic-loader"]


def test_remote_daemon_must_not_require_installed_product_or_third_party(tmp_path):
    code, report = check_tree(tmp_path, {
        "execution/remote/daemon.py": "from ...contracts.models import Message\nimport httpx\n",
        "contracts/models.py": "class Message: pass\n",
    })
    assert code == 1
    finding(report, "standalone-import", "amazme_backend.contracts.models")
    finding(report, "standalone-import", "httpx")


def test_embedded_remote_deployment_source_is_also_scanned(tmp_path):
    code, report = check_tree(tmp_path, {"execution/remote/client.py": "_DEPLOY = 'import amazme_backend.host.service\\n'\n"})
    assert code == 1
    finding(report, "embedded-import", "amazme_backend.host.service")


def test_pure_contract_cannot_read_a_snapshot(tmp_path):
    code, report = check_tree(tmp_path, {"contracts/models.py": "from pathlib import Path\nvalue = Path('catalog.json').read_text()\n"})
    assert code == 1
    assert any(item["rule"] == "pure-io" for item in report["diagnostics"])


def test_legal_public_imports_and_service_process_owner_pass_without_execution(tmp_path):
    marker = tmp_path / "must-not-exist"
    code, report = check_tree(tmp_path, {
        "shared/model.py": "class Model: pass\n",
        "contracts/models.py": "from ..shared.model import Model\nclass Message(Model): pass\n",
        "sdk/__init__.py": "from .client import Client\n",
        "sdk/client.py": "from ..contracts.models import Message\nclass Client: pass\n",
        "execution/services.py": f"import subprocess as sp\nsp.Popen(['touch', {str(marker)!r}])\n",
        "execution/remote/daemon.py": "import json\nimport subprocess\ndef execute(): subprocess.Popen('true', shell=True)\n",
    })
    assert code == 0, report["diagnostics"]
    assert report["diagnostics"] == []
    assert not marker.exists()


def test_feature_siblings_need_a_specific_declared_edge(tmp_path):
    code, report = check_tree(tmp_path, {
        "features/resources/service.py": "from ..skills.service import catalog\n",
        "features/skills/service.py": "catalog = None\n",
    })
    assert code == 1
    finding(report, "dependency", "amazme_backend.features.skills.service")
    assert report["domains"]["amazme_backend.features.resources.service"] != report["domains"]["amazme_backend.features.skills.service"]


def test_report_only_keeps_every_diagnostic_but_changes_exit_status(tmp_path):
    code, report = check_tree(tmp_path, {"ai/client.py": "import subprocess as sp\nsp.run(['true'])\n"}, report_only=True)
    assert code == 0
    finding(report, "process-spawn", "subprocess.run")


def test_unowned_nested_domain_is_not_implicitly_permitted(tmp_path):
    code, report = check_tree(tmp_path, {"features/new_feature/worker.py": ""})
    assert code == 1
    finding(report, "unowned-module", "amazme_backend.features.new_feature.worker")


def test_invalid_manifest_does_not_pass_in_report_only_mode(tmp_path):
    manifest = json.loads(MANIFEST.read_text())
    manifest["domains"]["sdk"]["imports"].append("amazme_backend.host.*")
    path = tmp_path / "invalid.json"
    path.write_text(json.dumps(manifest))
    result = subprocess.run([sys.executable, str(CHECKER), "--manifest", str(path), "--report-only"],
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 2
    assert "without globs" in result.stderr


def test_runtime_and_type_checking_branches_are_distinguished(tmp_path):
    _, report = check_tree(tmp_path, {
        "ai/client.py": "import typing as t\nif not t.TYPE_CHECKING:\n    from ..host.service import Host\nelse:\n    from ..accounts.store import AccountStore\n",
        "host/service.py": "class Host: pass\n",
        "accounts/store.py": "class AccountStore: pass\n",
    })
    edges = {edge["target"]: edge["phase"] for edge in report["edges"] if not edge["implicit"]}
    assert edges["amazme_backend.host.service"] == "module"
    assert edges["amazme_backend.accounts.store"] == "type-checking"


def test_same_domain_cycle_is_permitted(tmp_path):
    code, report = check_tree(tmp_path, {
        "execution/remote/first.py": "from .second import second\ndef first(): pass\n",
        "execution/remote/second.py": "from .first import first\ndef second(): pass\n",
    })
    assert code == 0, report["diagnostics"]


def test_computed_sensitive_reflection_has_no_silent_bypass(tmp_path):
    code, report = check_tree(tmp_path, {"features/resources/service.py":
        "import subprocess as sp\ndef call(attribute):\n    getattr(sp, attribute)(['true'])\n"})
    assert code == 1
    finding(report, "sensitive-api-unresolved", "subprocess")
