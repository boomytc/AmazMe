"""CLI receipt ownership survives other hosts and late acknowledgements."""

from pathlib import Path

import pytest

from amazme_backend.interfaces.client_outbox import OutboxCommand, PendingInput, execute
from amazme_backend.platform.private_files import lock


def test_profile_scope_reservation_and_exact_ack(tmp_path: Path) -> None:
    root = tmp_path / "outbox"

    def command(profile: str, operation: str, **extra: object) -> object:
        return execute(
            OutboxCommand.model_validate(
                dict(
                    directory=str(root), profile=profile, session="same-session", operation=operation, **extra
                )
            )
        )

    first = PendingInput(inputId="a" * 32, terminalId="terminal", prompt="你好🙂\n" * 10000)
    second = first.model_copy(update={"inputId": "b" * 32})
    assert command("host-a", "reserve", pending=first) == first
    assert command("host-b", "reserve", pending=second) == second
    assert command("host-a", "reserve", pending=second) == first
    assert command("host-a", "read") == first
    assert command("host-a", "ack", expected_id=second.inputId) is False
    assert command("host-a", "ack", expected_id=first.inputId) is True
    assert command("host-a", "reserve", pending=second) == second
    assert command("host-a", "ack", expected_id=first.inputId) is False
    assert command("host-a", "read") == second
    assert command("host-b", "read") == second
    # Contended records fail closed and the process-owned lock can be released normally.
    with lock(next(root.glob("*.lock"))):
        for host in ("host-a", "host-b"):
            try:
                command(host, "read")
            except BlockingIOError:
                break
        else:
            pytest.fail("contended outbox was not locked")
    assert command("host-a", "read") == second
