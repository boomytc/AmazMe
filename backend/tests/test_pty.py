"""Native PTY gate, protocol and bounded client buffers."""

import os
import socket
import subprocess
import sys
from pathlib import Path

import pytest

from amazme_backend.contracts import BackendError
from amazme_backend.pty_gate import EXIT, OUTPUT, WINDOW
from amazme_backend.pty_session import SCROLLBACK, PtyClient, utf16_tail, utf16_units

GATE = Path(__file__).parents[1] / "src/amazme_backend/pty_gate.py"
SOURCE = GATE.read_text()


def start(command: str, cols: int = 80, rows: int = 24) -> tuple[subprocess.Popen[bytes], PtyClient]:
    gate, client = socket.socketpair()
    process = subprocess.Popen(
        [sys.executable, "-m", "amazme_backend", "pty-gate"],
        stdin=gate.fileno(), stdout=gate.fileno(), stderr=subprocess.PIPE, pass_fds=(gate.fileno(),),
    )
    gate.close()
    pty = PtyClient(client)
    try:
        pty.permit(command, os.getuid(), os.getgid(), cols, rows)
    except BaseException:
        client.close()
        process.wait(timeout=5)
        raise
    return process, pty


def stop(process: subprocess.Popen[bytes], pty: PtyClient) -> None:
    pty.sock.close()
    process.wait(timeout=5)


def test_input_resize_and_waitpid_exit() -> None:
    command = (
        "python3 -c 'import fcntl,struct,sys,termios; sys.stdin.readline(); "
        "size=struct.unpack(\"HHHH\", fcntl.ioctl(1, termios.TIOCGWINSZ, bytes(8))); "
        "sys.stdout.write(\"%d %d\\n\" % (size[0], size[1])); sys.stdout.flush()'"
    )
    process, pty = start(command)
    try:
        pty.resize(100, 40)
        pty.send_input(b"\n")
        pty.pump(3, lambda: pty.exit_code is not None)
        text = pty.output.decode(errors="replace")
        assert "40 100" in text
        assert pty.exit_code == 0
    finally:
        stop(process, pty)


def test_output_stops_at_the_window_until_the_client_grants_credit() -> None:
    command = "python3 -c 'import sys; sys.stdout.write(\"x\"*200000); sys.stdout.flush()'"
    process, pty = start(command)
    try:
        pty.pump(1)
        assert 0 < len(pty.output) <= WINDOW
        held = len(pty.output)
        pty.pump(0.3)
        assert len(pty.output) == held
        for _ in range(40):
            pty.grant(WINDOW)
            pty.pump(0.3)
            if pty.received >= 200000:
                break
        assert pty.received == 200000
        assert len(pty.output) <= WINDOW
        assert set(pty.output) == {ord("x")}
        pty.pump(1, lambda: pty.exit_code is not None)
        assert pty.exit_code == 0
    finally:
        stop(process, pty)


def test_replenish_keeps_scrollback_past_the_protocol_window() -> None:
    command = "python3 -c 'import sys; sys.stdout.write(\"ab\"*100000); sys.stdout.flush()'"
    process, pty = start(command)
    try:
        for _ in range(40):
            pty.replenish()
            pty.pump(0.2)
            if pty.received >= 200000:
                break
        assert pty.received == 200000
        assert len(pty.output) <= WINDOW
        assert pty.text_seq == 200000
        assert "ab" * 10 in pty.text
        assert len(pty.text) <= SCROLLBACK
        pty.pump(1, lambda: pty.exit_code is not None)
        assert pty.exit_code == 0
    finally:
        stop(process, pty)


def test_split_utf8_and_output_after_exit_stay_in_scrollback() -> None:
    left, right = socket.socketpair()
    pty = PtyClient(left)
    try:
        encoded = "你".encode()
        pty._apply(OUTPUT, encoded[:2])
        pty._apply(OUTPUT, encoded[2:])
        pty._apply(EXIT, (0).to_bytes(4, "big", signed=True) + b"\x01")
        pty._apply(OUTPUT, b"OK")
        assert pty.text == "你OK"
        assert pty.text_seq == 3
        emoji = "🙂".encode()
        other = PtyClient(right)
        other._apply(OUTPUT, emoji[:1])
        assert other.text == "" and other.text_seq == 0
        other._apply(OUTPUT, emoji[1:])
        assert other.text == "🙂" and other.text_seq == utf16_units("🙂") == 2
        assert utf16_tail("A🙂", 2) == "🙂"
        assert utf16_tail("A🙂", 1) == ""
        assert utf16_units("你") == 1 and utf16_units("e\u0301") == 2
        assert pty.exit_code == 0
        assert pty.pending_output is True
    finally:
        left.close()
        right.close()


def test_input_is_accounted_as_written_or_queued() -> None:
    process, pty = start("sleep 30")
    try:
        payload = b"y" * 8192
        pty.send_input(payload)
        pty.pump(1, lambda: pty.written + pty.queued >= len(payload))
        assert pty.written + pty.queued == len(payload)
        assert pty.queued <= WINDOW
        assert pty.exit_code is None
    finally:
        stop(process, pty)


def test_socket_loss_is_not_an_exit_proof() -> None:
    process, pty = start("sleep 30")
    try:
        pty.sock.close()
        process.wait(timeout=3)
        assert pty.exit_code is None
    finally:
        stop(process, pty)


def test_window_full_is_refused_before_another_frame() -> None:
    process, pty = start("sleep 30")
    try:
        pty.credit = 0
        with pytest.raises(BackendError, match="pty_window_full"):
            pty.send_input(b"more")
    finally:
        stop(process, pty)
