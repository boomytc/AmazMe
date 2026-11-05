import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

import httpx

from amazme_backend.contracts.execution import ProcessLease
from amazme_backend.contracts.identity import HostReady, Identity
from amazme_backend.contracts.profiles import ProviderConfig
from amazme_backend.execution.processes import exited, retain_inherited
from amazme_backend.platform.private_files import lock
from amazme_backend.profiles.profile import Profile, live_host_ready


def _stopped(profile: Profile) -> bool:
    try:
        with lock(profile.path / "host.lock"), lock(profile.path / "supervisor.lock"):
            return all(exited(ProcessLease.model_validate_json(path.read_bytes()))
                       for path in (profile.path / "processes").glob("*.lock"))
    except BlockingIOError:
        return False


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] in {"connect", "web", "doctor"}:
        from amazme_backend.bootstrap.local import main as connect_main
        mode = "web" if sys.argv[1] == "web" else "doctor" if sys.argv[1] == "doctor" else "connect"
        connect_main(sys.argv[2:], mode)
        return
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
            return await AccountStore(profile.path).resolve_token(provider)

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
    parser = argparse.ArgumentParser(prog="amazme-backend")
    parser.add_argument("mode", choices=["init", "serve", "worker", "supervisor", "stop", "pair"])
    parser.add_argument("--profile", type=Path)
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--provider-config", type=Path)
    parser.add_argument("--session")
    parser.add_argument("--instance")
    parser.add_argument("--lifetime-fd", type=int)
    parser.add_argument("--require-existing-store", action="store_true")
    parser.add_argument("--validation", action="store_true")
    parser.add_argument("--approval-policy", choices=["auto", "mutations", "all"], default="mutations")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--expected-epoch", type=int)
    args = parser.parse_args()
    from amazme_backend.profiles.locations import local_profile
    if args.mode in {"worker", "supervisor"} and args.profile is None:
        parser.error("internal services require --profile")
    args.profile = local_profile(args.profile)
    os.umask(0o077)
    if args.mode == "init":
        from amazme_backend.bootstrap.initialization import initialize
        if not args.workspace or not args.provider_config:
            parser.error("init requires --workspace and --provider-config")
        provider = ProviderConfig.model_validate_json(args.provider_config.read_bytes())
        initialize(args.profile, args.workspace, provider, approval=args.approval_policy)
        print(json.dumps({"profile": str(args.profile), "workspace": str(args.workspace.resolve()), "version": "0.1.0"}))
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
        asyncio.run(serve(profile, args.session, args.instance, validation=args.validation, require_existing=args.require_existing_store))
    elif args.mode == "pair":
        print((profile.path / "web.token").read_text().strip())
    elif args.mode == "stop":
        if _stopped(profile):
            print("services stopped")
            return
        deadline = time.monotonic() + 90
        while not (profile.path / "ready.json").exists():
            if _stopped(profile):
                print("services stopped")
                return
            if time.monotonic() >= deadline:
                raise TimeoutError("host readiness still pending")
            time.sleep(0.1)
        ready = HostReady.model_validate_json((profile.path / "ready.json").read_bytes())
        with httpx.Client(timeout=180, trust_env=False) as client:
            bootstrap = client.get(ready.url + "/api/v1/bootstrap",
                                   headers={"Authorization": "Bearer " + (profile.path / "web.token").read_text().strip()})
            bootstrap.raise_for_status()
            ready = live_host_ready(profile.config.profile_id, ready, Identity.model_validate_json(bootstrap.content))
            if args.expected_epoch is not None and args.expected_epoch != ready.host_epoch:
                parser.error("stale_host_epoch")
            response = client.post(ready.url + "/control/shutdown",
                                   headers={"Authorization": "Bearer " + profile.token},
                                   json={"host_epoch": ready.host_epoch})
            response.raise_for_status()
        deadline = time.monotonic() + 180
        while not _stopped(profile):
            if time.monotonic() >= deadline:
                raise TimeoutError("shutdown still pending")
            time.sleep(0.1)
        print("services stopped")


if __name__ == "__main__":
    main()
