import argparse
import asyncio
import json
import os
import secrets
import sys
import time
from pathlib import Path

import httpx

from amazme_backend.contracts.profiles import ProviderConfig
from amazme_backend.execution.processes import retain_inherited
from amazme_backend.platform.private_files import lock, private_write
from amazme_backend.platform.resources import resource_root
from amazme_backend.profiles.profile import Profile


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "client-outbox":
        from amazme_backend.interfaces.client_outbox import main as outbox_main
        raise SystemExit(outbox_main())
    if len(sys.argv) > 1 and sys.argv[1] == "transient":
        from amazme_backend.bootstrap.transient import main as transient_main
        raise SystemExit(transient_main(sys.argv[2:]))
    if len(sys.argv) > 1 and sys.argv[1] == "pty-gate":
        from amazme_backend.execution.pty.gate import main as pty_main
        raise SystemExit(pty_main())
    if len(sys.argv) > 1 and sys.argv[1] == "plugin-gate":
        from amazme_backend.execution.plugins.gate import main as plugin_main
        raise SystemExit(plugin_main())
    if len(sys.argv) > 1 and sys.argv[1] == "mcp-gate":
        from pydantic import JsonValue

        from amazme_backend.accounts.store import AccountStore
        from amazme_backend.execution.mcp.gate import main as mcp_main
        from amazme_backend.execution.mcp.http import run_http_gate

        async def credential(profile: Profile, provider: str) -> str:
            return await AccountStore(profile.account_path).resolve_token(provider)

        async def http_gate(permit: dict[str, JsonValue]) -> int:
            return await run_http_gate(permit, resolve_credential=credential)

        raise SystemExit(mcp_main(http_runner=http_gate))
    if len(sys.argv) > 1 and sys.argv[1] in {"execute", "service-runner"}:
        parser = argparse.ArgumentParser()
        if sys.argv[1] == "service-runner":
            parser.add_argument("--kind", choices=["pty", "mcp", "plugin", "codemode"], required=True)
        parser.add_argument("--profile", type=Path, required=True)
        parser.add_argument("--instance", required=True)
        parser.add_argument("--lifetime-fd", type=int, required=True)
        parser.add_argument("--directory", type=Path, required=True)
        arguments = parser.parse_args(sys.argv[2:])
        if sys.argv[1] == "execute":
            from amazme_backend.execution.native import runner
            runner(arguments.profile, arguments.instance, arguments.lifetime_fd, arguments.directory)
        else:
            from amazme_backend.execution.services import runner as service_runner
            service_runner(arguments.profile, arguments.instance, arguments.lifetime_fd, arguments.directory, arguments.kind)
        return
    if len(sys.argv) > 1 and sys.argv[1] == "client":
        from amazme_backend.interfaces.cli import run_client
        raise SystemExit(run_client(sys.argv[2:]))
    if len(sys.argv) > 1 and sys.argv[1] == "tui":
        from amazme_backend.interfaces.tui import run_tui
        raise SystemExit(run_tui(sys.argv[2:]))
    parser = argparse.ArgumentParser(prog="amazme-backend")
    parser.add_argument("mode", choices=["init", "serve", "worker", "supervisor", "stop", "pair"])
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--provider-config", type=Path)
    parser.add_argument("--source-profile", type=Path)
    parser.add_argument("--session")
    parser.add_argument("--instance")
    parser.add_argument("--lifetime-fd", type=int)
    parser.add_argument("--require-existing-store", action="store_true")
    parser.add_argument("--frozen", action="store_true")
    parser.add_argument("--validation", action="store_true")
    parser.add_argument("--approval-policy", choices=["auto", "mutations", "all"], default="mutations")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    os.umask(0o077)
    if args.mode == "init":
        if args.source_profile:
            if not args.workspace or args.provider_config:
                parser.error("init --source-profile requires --workspace and excludes --provider-config")
            workspace = args.workspace.resolve(strict=True)
            if not workspace.is_dir():
                parser.error("workspace must be a directory")
            source = Profile(args.source_profile)
            from amazme_backend.profiles.configuration import stored_provider
            config = source.config.model_copy(update={
                "profile_id": secrets.token_hex(16), "workspace": str(workspace),
                "provider": stored_provider(source.config.provider), "account_profile": str(source.account_path),
            })
            args.profile.mkdir(parents=True, mode=0o700, exist_ok=False)
            private_write(args.profile / "config.json", config.model_dump_json())
            private_write(args.profile / "control.token", secrets.token_hex(32))
            private_write(args.profile / "web.token", secrets.token_hex(24))
            print(json.dumps({"profile": str(args.profile.resolve()), "workspace": str(workspace), "version": "0.1.0"}))
            return
        if not args.workspace or not args.provider_config:
            parser.error("init requires --workspace and --provider-config")
        workspace = args.workspace.resolve(strict=True)
        if not workspace.is_dir():
            parser.error("workspace must be a directory")
        provider = ProviderConfig.model_validate_json(args.provider_config.read_bytes())
        args.profile.mkdir(parents=True, mode=0o700, exist_ok=False)
        provider_data = {**provider.model_dump(), "api_key": provider.api_key.get_secret_value()}
        config = {"format": 2, "profile_id": secrets.token_hex(16), "workspace": str(workspace),
                  "approval_policy": args.approval_policy,
                  "resources": str(resource_root()), "provider": provider_data,
                  "user_resources": str(Path(os.environ.get("AMAZME_CODING_AGENT_DIR", "~/.amazme/agent")).expanduser().resolve())}
        private_write(args.profile / "config.json", json.dumps(config))
        from amazme_backend.accounts.store import AccountStore
        accounts = AccountStore(args.profile)
        accounts.write(accounts.read())
        provider_data["api_key"] = ""
        private_write(args.profile / "config.json", json.dumps(config))
        private_write(args.profile / "control.token", secrets.token_hex(32))
        private_write(args.profile / "web.token", secrets.token_hex(24))
        print(json.dumps({"profile": str(args.profile.resolve()), "workspace": str(workspace), "version": "0.1.0"}))
        return
    profile = Profile(args.profile)
    if args.mode == "serve":
        from amazme_backend.bootstrap.host import serve
        asyncio.run(serve(profile, args.port))
    elif args.mode == "supervisor":
        from amazme_backend.bootstrap.supervisor import serve
        if not args.instance or args.lifetime_fd is None:
            parser.error("supervisor requires --instance and --lifetime-fd")
        lease = retain_inherited(args.lifetime_fd, profile.path, "supervisor", args.instance)
        asyncio.run(serve(profile, args.instance, lease, require_existing=args.require_existing_store))
    elif args.mode == "worker":
        from amazme_backend.bootstrap.worker import serve
        if not args.session or not args.instance or args.lifetime_fd is None:
            parser.error("worker requires --session, --instance and --lifetime-fd")
        retain_inherited(args.lifetime_fd, profile.path, "worker", args.instance)
        asyncio.run(serve(profile, args.session, args.instance,
                          frozen=args.frozen, validation=args.validation,
                          require_existing=args.require_existing_store))
    elif args.mode == "pair":
        print((profile.path / "web.token").read_text().strip())
    elif args.mode == "stop":
        ready = json.loads((profile.path / "ready.json").read_text())
        response = httpx.post(ready["url"] + "/control/shutdown", timeout=10,
                              headers={"Authorization": "Bearer " + profile.token},
                              json={"host_epoch": ready["host_epoch"], "build_id": ready["build_id"]})
        response.raise_for_status()
        deadline = time.monotonic() + 180
        while True:
            try:
                with lock(profile.path / "host.lock"), lock(profile.path / "supervisor.lock"):
                    break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("shutdown still pending") from None
                time.sleep(0.1)
        print("services stopped")


if __name__ == "__main__":
    main()
