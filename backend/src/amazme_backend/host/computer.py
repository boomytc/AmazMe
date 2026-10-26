from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import json
import time
from pathlib import Path
from typing import Literal

from pydantic import JsonValue, TypeAdapter

from amazme_backend.accounts.store import ApiKeyCredential
from amazme_backend.ai.classification.client import classify
from amazme_backend.ai.classification.types import BoolAnswer, ClassifierContext, ClassifierResult
from amazme_backend.ai.types import Auth, RequestTransport
from amazme_backend.contracts.computer import (
    ComputerActionRequest,
    ComputerActionView,
    ComputerCaptureView,
    ComputerCleanup,
    ComputerClick,
    ComputerDrag,
    ComputerElement,
    ComputerGroundRequest,
    ComputerInspect,
    ComputerLocateRequest,
    ComputerMutation,
    ComputerObserve,
    ComputerPixel,
    ComputerPolicy,
    ComputerScroll,
    ComputerText,
    ComputerWindow,
)
from amazme_backend.contracts.execution import SupervisorHealth
from amazme_backend.contracts.ipc.host import ComputerToolRequest, ComputerToolResult
from amazme_backend.contracts.models import ImagePart
from amazme_backend.execution.computer.candidates import (
    blocked_risks,
    extract_candidates,
    rect,
    visual_fallback_reason,
)
from amazme_backend.execution.computer.driver import ComputerDriver, start_driver
from amazme_backend.execution.computer.geometry import driver_point, upright_size
from amazme_backend.execution.computer.grounding import (
    Classify,
    choose_candidate,
    image_context,
    locate,
    noul,
    risk_questions,
    risks_accepted,
)
from amazme_backend.execution.processes import exited
from amazme_backend.host.accounts import AccountOperations
from amazme_backend.host.lifecycle import HostLifecycle
from amazme_backend.host.session_access import WorkerSessions
from amazme_backend.profiles.layout import session_database
from amazme_backend.shared.errors import BackendError


class ComputerOperations:
    def __init__(self, access: WorkerSessions, accounts: AccountOperations, lifecycle: HostLifecycle):
        self.access = access
        self.accounts = accounts
        self.lifecycle = lifecycle
        self.computer_drivers: dict[str, ComputerDriver] = {}
        self.computer_observations: dict[str, ComputerObserve] = {}
        self.computer_held: set[str] = set()
        self.computer_mu = asyncio.Lock()

    async def _computer_enter(self, session: str) -> bool:
        async with self.computer_mu:
            if self.computer_held:
                return False
            self.computer_held.add(session)
            return True

    async def _computer_leave(self, session: str) -> None:
        async with self.computer_mu:
            self.computer_held.discard(session)

    @staticmethod
    def _driver_int(hello: dict[str, object], key: str) -> int:
        value = hello.get(key)
        if not isinstance(value, int):
            raise BackendError("computer_driver_lost")
        return value

    async def save_computer_policy(self, session: str, value: ComputerPolicy) -> ComputerPolicy:
        if not value.enabled and session in self.computer_drivers:
            if not await self._computer_enter(session):
                raise BackendError("computer_busy")
            try:
                driver = self.computer_drivers[session]
                code = await self.park_driver(session, driver)
                if code is None:
                    await self.access.operate(session, lambda store: store.note_computer_exit(code))
                    raise BackendError("computer_exit_unproven")
            finally:
                await self._computer_leave(session)
        return await self.access.operate(session, lambda store: store.save_computer_policy(value))

    async def computer_policy(self, session: str) -> ComputerPolicy:
        return await self.access.operate(
            session, lambda store: store.computer_policy(), require_active=False, write=False
        )

    async def computer_model_tool(self, value: ComputerToolRequest) -> ComputerToolResult:
        self.lifecycle.admit()
        if value.build_id != self.lifecycle.build or value.host_epoch != self.lifecycle.fence.host_epoch:
            raise BackendError("stale_host_epoch")
        if await self.lifecycle.store.active_update():
            raise BackendError("update_frozen", status=503)
        service = await self.lifecycle.store.service()
        if service is None or service.state != "running" or exited(service.process_lease):
            raise BackendError("supervisor_unavailable", status=503)
        health = await self.lifecycle.supervisor.call("GET", "/health", SupervisorHealth)
        self.lifecycle.check_supervisor(health.identity, service, fenced=True)
        worker = next((item for item in health.workers if item.worker_id == value.worker_id), None)
        if (
            health.identity.state != "ready"
            or health.freeze_id
            or health.blocked
            or health.session_errors.get(value.session_id)
            or (worker is None)
            or (worker.session_id != value.session_id)
            or (worker.state != "ready")
            or (worker.host_epoch != value.host_epoch)
            or (worker.build_id != self.lifecycle.build)
            or (worker.fingerprint != self.lifecycle.build)
            or (worker.purpose != "business")
            or (worker.process_lease is None)
            or exited(worker.process_lease)
        ):
            raise BackendError("worker_identity_mismatch", status=503)
        await self.access.read(value.session_id, lambda store: store.check_computer_intent(value))
        try:
            if value.call.name == "computer_observe":
                observed = await self.computer_observe(
                    value.session_id, ComputerInspect.model_validate_json(value.call.arguments)
                )
                result = observed.model_dump_json(exclude={"image_base64"})
                images = (
                    [ImagePart(media_type="image/png", data_base64=observed.image_base64)]
                    if observed.image_base64
                    else []
                )
                return ComputerToolResult(
                    phase="done" if observed.permitted else "failed", result=result, images=images
                )
            if value.call.name == "computer_locate":
                acted = await self.computer_locate(
                    value.session_id,
                    ComputerLocateRequest(action_id=value.step_id, **json.loads(value.call.arguments)),
                )
            elif value.call.name == "computer_ground":
                acted = await self.computer_ground(
                    value.session_id,
                    ComputerGroundRequest(action_id=value.step_id, **json.loads(value.call.arguments)),
                )
            elif value.call.name == "computer_act":
                point = ComputerMutation.model_validate_json(value.call.arguments)
                acted = await self.computer_action(
                    value.session_id, ComputerActionRequest(action_id=value.step_id, **point.model_dump())
                )
            else:
                raise BackendError("computer_tool_missing")
            return ComputerToolResult(
                phase=acted.phase, result=acted.model_dump_json(exclude={"images"}), images=acted.images
            )
        except BackendError as exc:
            if value.call.name == "computer_act":
                point = ComputerMutation.model_validate_json(value.call.arguments)
                body = json.dumps(point.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
                prior = await self.access.operate(
                    value.session_id,
                    lambda store: store.find_computer_action(value.step_id, body),
                    write=False,
                )
                if prior is not None:
                    return ComputerToolResult(phase=prior.phase, result=prior.model_dump_json())
            return ComputerToolResult(phase="failed", result=exc.code)

    async def park_driver(self, session: str, driver: ComputerDriver) -> int | None:
        code = await self._computer_completion(asyncio.create_task(asyncio.to_thread(driver.stop)))
        if code is not None:
            self.computer_drivers.pop(session, None)
            self.computer_observations.pop(session, None)
        return code

    @staticmethod
    async def _computer_completion[T](pending: asyncio.Task[T]) -> T:
        while True:
            try:
                return await asyncio.shield(pending)
            except asyncio.CancelledError:
                if pending.cancelled():
                    raise

    async def _computer_request(
        self, driver: ComputerDriver, payload: dict[str, object]
    ) -> dict[str, object]:
        pending = asyncio.create_task(asyncio.to_thread(driver.request, payload))
        try:
            return await asyncio.shield(pending)
        except asyncio.CancelledError:
            with contextlib.suppress(Exception):
                await self._computer_completion(pending)
            raise

    async def _computer_start(self, directory: Path) -> ComputerDriver:
        pending = asyncio.create_task(asyncio.to_thread(start_driver, directory))
        try:
            return await asyncio.shield(pending)
        except asyncio.CancelledError:
            with contextlib.suppress(Exception):
                driver = await self._computer_completion(pending)
                await self._computer_completion(asyncio.create_task(asyncio.to_thread(driver.stop)))
            raise

    async def computer_observe(self, session: str, value: ComputerInspect | None = None) -> ComputerObserve:
        if not await self._computer_enter(session):
            raise BackendError("computer_busy")
        try:
            return await self._computer_observe(session, value)
        finally:
            await self._computer_leave(session)

    async def _computer_observe(self, session: str, value: ComputerInspect | None = None) -> ComputerObserve:
        value = value or ComputerInspect()
        if (
            value.action == "window"
            and value.target is None
            or (value.action != "window" and value.target is not None)
        ):
            raise BackendError("computer_target_required")
        self.lifecycle.admit()
        if await self.lifecycle.store.active_update():
            raise BackendError("update_frozen", status=503)
        policy = await self.computer_policy(session)
        if not policy.enabled:
            raise BackendError("computer_disabled")
        if await self.access.operate(session, lambda store: store.computer_blocked(), write=False):
            raise BackendError("computer_blocked")
        driver = self.computer_drivers.get(session)
        if driver is None or not driver.alive:
            if driver is not None:
                code = await self.park_driver(session, driver)
                await self.access.operate(session, lambda store: store.note_computer_exit(code))
                raise BackendError("computer_blocked")
            directory = session_database(self.lifecycle.profile.path, session).parent
            driver = await self._computer_start(directory)
            self.computer_drivers[session] = driver
        hello = driver.hello
        accessibility = hello.get("accessibility") is True
        screen = hello.get("screen") is True
        identity = str(hello.get("identity") or "")
        if value.action == "permissions":
            report = await self._computer_request(driver, {"op": "permissions"})
            accessibility, screen = (report.get("accessibility") is True, report.get("screen") is True)
            return ComputerObserve(
                permitted=accessibility and screen,
                accessibility=accessibility,
                screen=screen,
                identity=identity,
            )
        if not accessibility or not screen:
            await self.park_driver(session, driver)
            return ComputerObserve(
                permitted=False,
                accessibility=accessibility,
                screen=screen,
                identity=identity,
                error="permission_required",
            )
        if value.action in {"apps", "windows"}:
            reply = await self._computer_request(
                driver, {"op": "inspect", "action": value.action, "pid": value.pid}
            )
            return ComputerObserve(
                permitted=True,
                accessibility=True,
                screen=True,
                identity=identity,
                data=TypeAdapter(dict[str, JsonValue]).validate_python(reply.get("data", {})),
            )
        capture_id = hashlib.sha256(f"{session}:{identity}:{time.time_ns()}".encode()).hexdigest()[:32]
        reply = await self._computer_request(
            driver,
            {
                "op": "observe",
                "capture_id": capture_id,
                "target": value.target.model_dump() if value.target else None,
            },
        )
        if reply.get("capture_id") != capture_id:
            raise BackendError("computer_driver_lost")
        raw_width = self._driver_int(hello, "raw_width")
        raw_height = self._driver_int(hello, "raw_height")
        orientation = self._driver_int(hello, "orientation")
        scale = self._driver_int(hello, "scale")
        width, height = upright_size(raw_width, raw_height, orientation)
        capture = ComputerCaptureView(
            capture_id=capture_id,
            width=width,
            height=height,
            raw_width=raw_width,
            raw_height=raw_height,
            orientation=orientation,
            scale=scale,
            observed_ms=time.time_ns() // 1000000,
            target=value.target,
            snapshot_id=str(reply.get("snapshot_id", "")),
            tree=str(reply.get("tree", ""))[:20000],
            elements=TypeAdapter(list[dict[str, JsonValue]]).validate_python(reply.get("elements", [])),
            window_bounds=rect(TypeAdapter(JsonValue).validate_python(reply.get("window_bounds"))),
            degraded_reason=str(reply.get("degraded_reason", "")),
        )
        capture.candidates = extract_candidates(capture, policy)
        await self.access.operate(session, lambda store: store.save_computer_capture(capture))
        observed = ComputerObserve(
            permitted=True,
            accessibility=True,
            screen=True,
            identity=identity,
            capture=capture,
            image_base64=str(reply.get("image_base64", "")),
        )
        self.computer_observations[session] = observed
        return observed

    async def computer_action(self, session: str, value: ComputerActionRequest) -> ComputerActionView:
        body = json.dumps(
            value.model_dump(mode="json", exclude={"action_id"}), sort_keys=True, separators=(",", ":")
        )
        prior = await self.access.operate(
            session,
            lambda store: store.find_computer_action(value.action_id, body),
            require_active=False,
            write=False,
        )
        if prior is not None:
            return prior
        if not await self._computer_enter(session):
            raise BackendError("computer_busy")
        try:
            async with asyncio.timeout((await self.computer_policy(session)).timeout_ms / 1000):
                return await self._computer_action(session, value)
        except (asyncio.CancelledError, TimeoutError) as interrupted:
            driver = self.computer_drivers.get(session)
            if driver is not None:
                code = await self.park_driver(session, driver)
                await self.access.operate(session, lambda store: store.note_computer_exit(code))
            if isinstance(interrupted, TimeoutError):
                found = await self.access.operate(
                    session,
                    lambda store: store.find_computer_action(value.action_id, body),
                    require_active=False,
                    write=False,
                )
                if found is not None:
                    return await self.access.operate(
                        session,
                        lambda store: store.settle_computer_action(
                            value.action_id, "unknown", "computer_timeout", None, None
                        ),
                    )
                raise BackendError("computer_timeout", status=503) from None
            raise
        finally:
            await self._computer_leave(session)

    async def _computer_action(self, session: str, value: ComputerActionRequest) -> ComputerActionView:
        policy = await self.computer_policy(session)
        body = json.dumps(
            value.model_dump(mode="json", exclude={"action_id"}), sort_keys=True, separators=(",", ":")
        )
        found = await self.access.operate(
            session,
            lambda store: store.find_computer_action(value.action_id, body),
            require_active=False,
            write=False,
        )
        if found is not None:
            return found
        if not policy.enabled:
            raise BackendError("computer_disabled")
        if (
            value.delivery_mode == "foreground"
            and (not policy.allow_foreground)
            or (value.target is None and value.delivery_mode != "foreground")
        ):
            raise BackendError("computer_foreground_disabled")
        if await self.access.operate(session, lambda store: store.computer_blocked(), write=False):
            raise BackendError("computer_blocked")
        capture = await self.access.operate(
            session, lambda store: store.latest_computer_capture(), write=False
        )
        if (
            capture is None
            or capture.capture_id != value.capture_id
            or capture.target != value.target
            or (time.time_ns() // 1000000 - capture.observed_ms > policy.max_age_ms)
        ):
            raise BackendError("computer_stale")
        action = value.action
        point: tuple[int, int] | None = None
        mutation = action.model_dump(mode="json")
        if isinstance(action, ComputerClick) and isinstance(action.point, ComputerPixel):
            point = driver_point(
                action.point.x,
                action.point.y,
                capture.raw_width,
                capture.raw_height,
                capture.orientation,
                capture.scale,
            )
            mutation["point"] = {"x": point[0], "y": point[1]}
        elif isinstance(action, (ComputerScroll, ComputerDrag)):
            point = driver_point(
                action.x, action.y, capture.raw_width, capture.raw_height, capture.orientation, capture.scale
            )
            mutation.update(x=point[0], y=point[1])
            if isinstance(action, ComputerDrag):
                dest = driver_point(
                    action.to_x,
                    action.to_y,
                    capture.raw_width,
                    capture.raw_height,
                    capture.orientation,
                    capture.scale,
                )
                mutation.update(to_x=dest[0], to_y=dest[1])
        view, send = await self.access.operate(
            session, lambda store: store.begin_computer_action(value.action_id, body)
        )
        if not send:
            return view
        driver = self.computer_drivers.get(session)
        if driver is None or not driver.alive:
            code = await self.park_driver(session, driver) if driver is not None else None
            await self.access.operate(session, lambda store: store.note_computer_exit(code))
            return await self.access.operate(
                session,
                lambda store: store.settle_computer_action(
                    value.action_id, "unknown", "computer_driver_lost", None, None
                ),
            )
        reviewed: dict[str, JsonValue]
        try:
            reviewed = await self._computer_risk(session, value, capture, policy)
        except (BackendError, ValueError, OSError):
            reviewed = {"status": "review", "reason": "Action risk could not be assessed", "applied": 0}
        if reviewed.get("status") != "allowed":
            return await self.access.operate(
                session,
                lambda store: store.settle_computer_action(value.action_id, "done", "", None, None, reviewed),
            )
        latest = await self.access.operate(
            session, lambda store: store.latest_computer_capture(), write=False
        )
        if (
            latest is None
            or latest.capture_id != capture.capture_id
            or time.time_ns() // 1000000 - capture.observed_ms > policy.max_age_ms
        ):
            return await self.access.operate(
                session,
                lambda store: store.settle_computer_action(
                    value.action_id, "failed", "computer_stale", None, None
                ),
            )
        try:
            reply = await self._computer_request(
                driver,
                {
                    "op": "act",
                    "capture_id": value.capture_id,
                    "action": mutation,
                    "target": value.target.model_dump() if value.target else None,
                    "delivery_mode": value.delivery_mode,
                },
            )
        except BackendError:
            code = await self.park_driver(session, driver)
            await self.access.operate(session, lambda store: store.note_computer_exit(code))
            return await self.access.operate(
                session,
                lambda store: store.settle_computer_action(
                    value.action_id, "unknown", "computer_driver_lost", None, None
                ),
            )
        if reply.get("op") != "acted":
            return await self.access.operate(
                session,
                lambda store: store.settle_computer_action(
                    value.action_id, "failed", str(reply.get("error") or "computer_rejected"), None, None
                ),
            )
        return await self.access.operate(
            session,
            lambda store: store.settle_computer_action(
                value.action_id,
                "done",
                "",
                point[0] if point else None,
                point[1] if point else None,
                {"status": "acted", "applied": 1, "calls": reviewed.get("calls", [])},
            ),
        )

    def _computer_classifier(self, policy: ComputerPolicy) -> Classify:

        async def run(context: ClassifierContext) -> ClassifierResult:
            document = self.accounts.accounts.read()
            configured = document.transports.get(policy.jev_provider)

            async def auth() -> Auth:
                credential = await self.accounts.accounts.resolve(
                    policy.jev_provider, proxy=configured.proxy if configured else ""
                )
                if credential is None:
                    raise BackendError("provider_not_configured")
                key = credential.key if isinstance(credential, ApiKeyCredential) else credential.access
                return Auth(api_key=key, auth_type=credential.type)

            return await classify(
                policy.jev_provider,
                policy.jev_model,
                context,
                auth=auth,
                transport=RequestTransport(
                    proxy=configured.proxy if configured else "",
                    headers=configured.headers if configured else {},
                ),
                timeout_ms=policy.timeout_ms,
            )

        return run

    async def _current_computer_observation(
        self, session: str, capture_id: str, target: ComputerWindow | None, policy: ComputerPolicy
    ) -> ComputerObserve:
        observed = self.computer_observations.get(session)
        latest = await self.access.operate(
            session, lambda store: store.latest_computer_capture(), write=False
        )
        driver = self.computer_drivers.get(session)
        if (
            observed is None
            or observed.capture is None
            or latest is None
            or (latest.capture_id != capture_id)
            or (observed.capture.capture_id != capture_id)
            or (latest.target != target)
            or (driver is None)
            or (not driver.alive)
            or (time.time_ns() // 1000000 - latest.observed_ms > policy.max_age_ms)
        ):
            raise BackendError("computer_stale")
        return observed

    async def _computer_risk(
        self, session: str, value: ComputerActionRequest, capture: ComputerCaptureView, policy: ComputerPolicy
    ) -> dict[str, JsonValue]:
        report: dict[str, JsonValue] = {"status": "allowed", "calls": []}
        if blocked_risks(value.intent, policy):
            return {
                "status": "review",
                "reason": "Intent contains a risk category not allowed by user policy",
                "applied": 0,
            }
        action = value.action
        token = (
            action.element_token
            if isinstance(action, ComputerText)
            else action.point.element_token
            if isinstance(action, ComputerClick) and isinstance(action.point, ComputerElement)
            else ""
        )
        candidate = next(
            (item for item in extract_candidates(capture, policy) if item.element_token == token), None
        )
        if token and (
            candidate is None or not capture.snapshot_id or (not token.startswith(capture.snapshot_id + ":"))
        ):
            return {
                "status": "review",
                "reason": "Element token is stale, excluded or not in this window's candidate table",
                "applied": 0,
            }
        if isinstance(action, ComputerText) and (
            candidate is None
            or (
                candidate.role != "text_input"
                and (not (action.action == "set_value" and candidate.role == "popup"))
            )
        ):
            return {
                "status": "review",
                "reason": "Text actions require a text input or an explicitly valued popup",
                "applied": 0,
            }
        if not policy.jev_enabled:
            if not token or not isinstance(action, (ComputerClick, ComputerText)):
                return {
                    "status": "review",
                    "reason": "Jev is required to assess coordinate and keyboard actions",
                    "applied": 0,
                }
            return report
        if not risk_questions(policy):
            return report
        observed = await self._current_computer_observation(session, capture.capture_id, value.target, policy)
        picture, assets = image_context(base64.b64decode(observed.image_base64), 640)
        result = await self._computer_classifier(policy)(
            ClassifierContext(
                state={
                    "target": value.intent,
                    "action": {
                        "tool": action.action,
                        "parameters": action.model_dump(mode="json"),
                        "candidate": candidate.model_dump(mode="json", exclude={"element_token"})
                        if candidate
                        else None,
                    },
                    "observation": picture,
                },
                assets=assets,
                questions=risk_questions(policy),
            )
        )
        report["calls"] = [result.model_dump(mode="json")]
        if not risks_accepted(result, policy):
            report.update(
                status="review", reason="Action risk is not confidently within user policy", applied=0
            )
        return report

    async def computer_locate(self, session: str, value: ComputerLocateRequest) -> ComputerActionView:
        return await self._computer_operation(session, value)

    async def computer_ground(self, session: str, value: ComputerGroundRequest) -> ComputerActionView:
        return await self._computer_operation(session, value)

    async def _computer_operation(
        self, session: str, value: ComputerLocateRequest | ComputerGroundRequest
    ) -> ComputerActionView:
        body = json.dumps(
            {
                "kind": "locate" if isinstance(value, ComputerLocateRequest) else "ground",
                "arguments": value.model_dump(mode="json", exclude={"action_id"}),
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        prior = await self.access.operate(
            session,
            lambda store: store.find_computer_action(value.action_id, body),
            require_active=False,
            write=False,
        )
        if prior is not None:
            return prior
        policy = await self.computer_policy(session)
        if not policy.enabled or not policy.jev_enabled:
            raise BackendError("computer_disabled" if not policy.enabled else "computer_jev_disabled")
        if not await self._computer_enter(session):
            raise BackendError("computer_busy")
        reserved = False
        try:
            view, send = await self.access.operate(
                session, lambda store: store.begin_computer_action(value.action_id, body)
            )
            if not send:
                return view
            reserved = True
            async with asyncio.timeout(policy.timeout_ms / 1000):
                if isinstance(value, ComputerLocateRequest):
                    observed = await self._current_computer_observation(
                        session, value.capture_id, value.target, policy
                    )
                    found = await locate(
                        base64.b64decode(observed.image_base64),
                        value.description,
                        value.mode,
                        self._computer_classifier(policy),
                        policy,
                    )
                    await self._current_computer_observation(session, value.capture_id, value.target, policy)
                    report = found.model_dump(mode="json", exclude={"crop"})
                    report.update(
                        capture_id=value.capture_id,
                        target=value.target.model_dump(mode="json") if value.target else None,
                    )
                    images = [found.crop] if found.crop else []
                else:
                    report = await self._ground_computer(session, value, policy)
                    images = []
                phase: Literal["unknown", "done"] = (
                    "unknown" if report.get("outcome_unknown") is True else "done"
                )
                return await self.access.operate(
                    session,
                    lambda store: store.settle_computer_action(
                        value.action_id, phase, "", None, None, report, images
                    ),
                )
        except (asyncio.CancelledError, TimeoutError) as interrupted:
            driver = self.computer_drivers.get(session)
            if driver is not None:
                code = await self.park_driver(session, driver)
                await self.access.operate(session, lambda store: store.note_computer_exit(code))
            if isinstance(interrupted, TimeoutError):
                found = await self.access.operate(
                    session,
                    lambda store: store.find_computer_action(value.action_id, body),
                    require_active=False,
                    write=False,
                )
                if found is not None:
                    return await self.access.operate(
                        session,
                        lambda store: store.settle_computer_action(
                            value.action_id, "unknown", "computer_timeout", None, None
                        ),
                    )
                raise BackendError("computer_timeout", status=503) from None
            raise
        except (BackendError, ValueError, OSError) as error:
            if not reserved:
                raise
            error_code = error.code if isinstance(error, BackendError) else "computer_classification_failed"
            return await self.access.operate(
                session,
                lambda store: store.settle_computer_action(value.action_id, "failed", error_code, None, None),
            )
        finally:
            await self._computer_leave(session)

    async def _ground_computer(
        self, session: str, value: ComputerGroundRequest, policy: ComputerPolicy
    ) -> dict[str, JsonValue]:
        if blocked_risks(value.goal, policy):
            return {"status": "review", "reason": "Goal contains a blocked risk category", "acted": False}
        before = await self._computer_observe(session, ComputerInspect(action="window", target=value.target))
        if not before.permitted or before.capture is None:
            raise BackendError(before.error or "permission_required")
        capture = before.capture
        classify = self._computer_classifier(policy)
        calls: list[ClassifierResult] = []
        action: ComputerClick | ComputerText | None = None
        if not visual_fallback_reason(capture):
            chosen = await choose_candidate(
                value.goal,
                capture.model_dump_json(exclude={"elements"}),
                capture.candidates,
                classify,
                policy,
            )
            calls.append(chosen.call)
            if chosen.goal_satisfied:
                return {
                    "status": "already_satisfied",
                    "acted": False,
                    "calls": [call.model_dump(mode="json") for call in calls],
                }
            if chosen.choice == "reobserve":
                return {
                    "status": "review",
                    "reason": "Jev requested reobservation",
                    "acted": False,
                    "calls": [call.model_dump(mode="json") for call in calls],
                }
            candidate = next((item for item in capture.candidates if item.id == chosen.choice), None)
            if candidate:
                action = (
                    ComputerClick(
                        action="click", point=ComputerElement(element_token=candidate.element_token)
                    )
                    if value.action == "click"
                    else ComputerText(
                        action=value.action, element_token=candidate.element_token, text=value.text or ""
                    )
                )
            elif not chosen.can_locate_visually:
                return {
                    "status": "review",
                    "reason": "No confident safe AX selection",
                    "acted": False,
                    "calls": [call.model_dump(mode="json") for call in calls],
                }
        if action is None:
            if value.action != "click":
                return {
                    "status": "review",
                    "reason": "Text action requires a matching AX field",
                    "acted": False,
                    "calls": [call.model_dump(mode="json") for call in calls],
                }
            found = await locate(
                base64.b64decode(before.image_base64), value.goal, "look_closer", classify, policy
            )
            calls.extend(found.calls)
            if found.status != "located" or found.x is None or found.y is None:
                return {
                    "status": "review",
                    "reason": found.reason,
                    "acted": False,
                    "calls": [call.model_dump(mode="json") for call in calls],
                }
            action = ComputerClick(action="click", point=ComputerPixel(x=found.x, y=found.y))
        request = ComputerActionRequest(
            action_id=hashlib.sha256((value.action_id + ":act").encode()).hexdigest(),
            capture_id=capture.capture_id,
            target=value.target,
            intent=value.goal,
            action=action,
        )
        acted = await self._computer_action(session, request)
        if acted.phase != "done" or acted.result.get("status") == "review":
            return {
                "status": "review",
                "acted": False,
                "outcome_unknown": acted.phase == "unknown",
                "reason": acted.error,
                "action": acted.model_dump(mode="json", exclude={"images"}),
                "calls": [call.model_dump(mode="json") for call in calls],
            }
        risk_calls = acted.result.get("calls")
        if isinstance(risk_calls, list):
            calls.extend((ClassifierResult.model_validate(call) for call in risk_calls))
        try:
            after = await self._computer_observe(
                session, ComputerInspect(action="window", target=value.target)
            )
            picture, assets = image_context(base64.b64decode(after.image_base64))
            checked = await classify(
                ClassifierContext(
                    state={
                        "goal": value.goal,
                        "verification": value.verification,
                        "observation": {**picture, "tree": after.capture.tree if after.capture else ""},
                    },
                    assets=assets,
                    questions={
                        "verified": noul(
                            "Does the new observation independently prove verification is satisfied? Evaluate the visible resulting state, not whether an action was attempted."
                        )
                    },
                )
            )
            calls.append(checked)
            answer = checked.answers.get("verified")
            verified = (
                checked.stop_reason == "stop"
                and isinstance(answer, BoolAnswer)
                and (answer.probability >= policy.min_presence)
            )
            return {
                "status": "verified" if verified else "review",
                "acted": True,
                "verified": verified,
                "verification_probability": answer.probability if isinstance(answer, BoolAnswer) else None,
                "capture_id": after.capture.capture_id if after.capture else None,
                "calls": [call.model_dump(mode="json") for call in calls],
            }
        except (BackendError, ValueError, OSError):
            return {
                "status": "review",
                "acted": True,
                "verified": False,
                "reason": "Action was dispatched but verification failed",
                "calls": [call.model_dump(mode="json") for call in calls],
            }

    async def computer_cleanup(self, session: str) -> ComputerCleanup:
        if not await self._computer_enter(session):
            raise BackendError("computer_busy")
        try:
            return await self._computer_cleanup_owned(session)
        finally:
            await self._computer_leave(session)

    async def _computer_cleanup_owned(self, session: str) -> ComputerCleanup:
        driver = self.computer_drivers.get(session)
        if driver is not None:
            code = await self.park_driver(session, driver)
            await self.access.operate(session, lambda store: store.note_computer_exit(code))
        blocked, exit_code, proof = await self.access.operate(
            session, lambda store: store.computer_runtime(), write=False
        )
        if not blocked:
            return ComputerCleanup(cleared=True, proof=proof)
        if exit_code is None:
            raise BackendError("computer_exit_unproven")
        digest = hashlib.sha256(f"computer-cleanup:{exit_code}".encode()).hexdigest()
        stored = await self.access.operate(session, lambda store: store.finish_computer_cleanup(digest))
        return ComputerCleanup(cleared=True, proof=stored)
