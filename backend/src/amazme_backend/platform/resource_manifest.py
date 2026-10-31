from __future__ import annotations

IDENTITY_SUFFIXES = {".py", ".html", ".js", ".css", ".json", ".mjs"}

# Package-relative resources shared by lookup, freezing and bundle identity checks.
RESOURCE_PATHS = {
    "models": "assets/model_catalog.json",
    "classifiers": "assets/classifier_catalog.json",
    "web": "assets/web",
    "pty_gate": "execution/pty/gate.py",
    "mcp_gate": "execution/mcp/gate.py",
    "plugin_gate": "execution/plugins/gate.py",
    "remote_daemon": "execution/remote/daemon.py",
    "codemode_helper": "execution/codemode/helper.mjs",
}
CLIENT_DIRECTORY = "assets/web/client"
CLIENT_REQUIRED_FILES = (
    "index.html",
    "index.en.html",
    "index.zh.html",
    "page.js",
    "page.css",
    "tokens.css",
    "app-icon.png",
    "app-icon.svg",
    "favicon.png",
)
NODE_MODULES_DIRECTORY = "execution/codemode/node_modules"
REQUIRED_IDENTITY = (
    "runtime/node/bin/node",
    *(path for name, path in RESOURCE_PATHS.items() if name != "web"),
    RESOURCE_PATHS["web"] + "/events.schema.json",
    RESOURCE_PATHS["web"] + "/xterm-terminal.js",
    RESOURCE_PATHS["web"] + "/xterm.css",
    *(CLIENT_DIRECTORY + "/" + name for name in CLIENT_REQUIRED_FILES),
    NODE_MODULES_DIRECTORY + "/quickjs-wasi/quickjs.wasm",
    NODE_MODULES_DIRECTORY + "/@amazme/codemode/dist/index.js",
)
