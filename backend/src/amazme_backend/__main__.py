import argparse
import asyncio
import json
import os
import secrets
import sys
import time
from contextlib import ExitStack
from pathlib import Path

import httpx

from .common import Profile, lock, private_write, resource_root
from .contracts import ProviderConfig
from .processes import retain_inherited


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "client":
        from .client_cmd import run_client
        raise SystemExit(run_client(sys.argv[2:]))
    if len(sys.argv) > 1 and sys.argv[1] == "tui":
        from .tui import run_tui
        raise SystemExit(run_tui(sys.argv[2:]))
    parser = argparse.ArgumentParser(prog="amazme-backend")
    parser.add_argument("mode", choices=["init", "serve", "worker", "supervisor", "stop", "pair", "destroy-vm"])
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--provider-config", type=Path)
    parser.add_argument("--session")
    parser.add_argument("--instance")
    parser.add_argument("--lifetime-fd", type=int)
    parser.add_argument("--require-existing-store", action="store_true")
    parser.add_argument("--frozen", action="store_true")
    parser.add_argument("--validation", action="store_true")
    parser.add_argument("--approval-policy", choices=["auto", "mutations", "all"], default="mutations")
    parser.add_argument("--test-mode", action="store_true")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    os.umask(0o077)
    if args.mode == "init":
        if not args.workspace or not args.provider_config:
            parser.error("init requires --workspace and --provider-config")
        workspace = args.workspace.resolve(strict=True)
        if not workspace.is_dir():
            parser.error("workspace must be a directory")
        provider = ProviderConfig.model_validate_json(args.provider_config.read_bytes())
        args.profile.mkdir(parents=True, mode=0o700, exist_ok=False)
        config = {"format": 2, "profile_id": secrets.token_hex(16), "workspace": str(workspace),
                  "approval_policy": args.approval_policy, "testing": args.test_mode,
                  "resources": str(resource_root()), "provider": {**provider.model_dump(), "api_key": provider.api_key.get_secret_value()}}
        private_write(args.profile / "config.json", json.dumps(config))
        private_write(args.profile / "control.token", secrets.token_hex(32))
        private_write(args.profile / "web.token", secrets.token_hex(24))
        print(json.dumps({"profile": str(args.profile.resolve()), "workspace": str(workspace), "version": "0.1.0"}))
        return
    profile = Profile(args.profile)
    if args.mode == "serve":
        from .host import serve
        asyncio.run(serve(profile, args.port))
    elif args.mode == "supervisor":
        from .supervisor import serve
        if not args.instance or args.lifetime_fd is None:
            parser.error("supervisor requires --instance and --lifetime-fd")
        lease = retain_inherited(args.lifetime_fd, profile.path, "supervisor", args.instance)
        asyncio.run(serve(profile, args.instance, lease, require_existing=args.require_existing_store))
    elif args.mode == "worker":
        from .worker import serve
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
    else:
        from .vm import VM
        async def destroy() -> None:
            vm = VM(profile)
            try:
                await vm.delete()
            finally:
                await vm.close()
        with ExitStack() as locks:
            for path in [profile.path / "host.lock", profile.path / "supervisor.lock",
                         *sorted((profile.path / "sessions").glob("*/writer.lock"))]:
                locks.enter_context(lock(path))
            asyncio.run(destroy())


if __name__ == "__main__":
    main()
