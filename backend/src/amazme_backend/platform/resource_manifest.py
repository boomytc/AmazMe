from __future__ import annotations

IDENTITY_SUFFIXES = {".py", ".html", ".js", ".css", ".json", ".mjs"}

# Package-relative source resources.
RESOURCE_PATHS = {
    "models": "assets/model_catalog.json",
    "command_code_models": "assets/command_code_models.json",
    "classifiers": "assets/classifier_catalog.json",
    "web": "assets/web",
    "pty_gate": "execution/pty/gate.py",
    "mcp_gate": "execution/mcp/gate.py",
    "plugin_gate": "execution/plugins/gate.py",
    "remote_daemon": "execution/remote/daemon.py",
    "codemode_helper": "execution/codemode/helper.mjs",
}
