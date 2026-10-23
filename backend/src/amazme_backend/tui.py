"""Terminal client for one explicit host, session, and workspace.

Ctrl-C releases this binding and leaves the session's accepted work running.
"""

import argparse
import asyncio
import fcntl
import os
import secrets
import select
import struct
import sys
import termios

from .contracts import Attachment, BackendError, Session
from .sdk import Client


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="amazme-backend tui")
    parser.add_argument("--url", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--session", default="")
    parser.add_argument("--title", default="终端")
    return parser


def _width() -> int:
    buf = bytearray(struct.pack("HHHH", 0, 0, 0, 0))
    try:
        fcntl.ioctl(sys.stdout.fileno(), termios.TIOCGWINSZ, buf)
    except OSError:
        return 100
    _rows, cols, _x, _y = struct.unpack("HHHH", buf)
    return cols if cols >= 40 else 100


def _clip(text: str) -> str:
    return text.replace("\n", " ")[:_width()]


def _write(text: str) -> None:
    view = memoryview(text.encode("utf-8"))
    fd = sys.stdout.fileno()
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise BackendError("tty_closed")
        view = view[written:]


def _paint(session_id: str, attachment_id: str, workspace: str, lines: list[str], draft: str, notice: str) -> None:
    body = [
        f"会话:{session_id} 绑定:{attachment_id} 工作区:{workspace}",
        notice,
        *lines[-20:],
        "",
        "Ctrl-C 松开绑定并离开",
        "> " + draft,
    ]
    _write("\x1b[H\x1b[2J" + "\r\n".join(_clip(item) for item in body))


def _raw(fd: int) -> None:
    attrs = termios.tcgetattr(fd)
    flag = attrs[3]
    cc = attrs[6]
    incoming = attrs[0]
    if not isinstance(flag, int) or not isinstance(cc, list) or not isinstance(incoming, int):
        raise BackendError("tty_unsupported")
    attrs[0] = incoming & ~(termios.ICRNL | termios.IXON)
    attrs[3] = flag & ~(termios.ECHO | termios.ICANON | termios.ISIG)
    cc[termios.VMIN] = 1
    cc[termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSADRAIN, attrs)


async def _read_key() -> str:
    def read() -> str:
        buf = b""
        while True:
            part = os.read(sys.stdin.fileno(), 1)
            if not part:
                return ""
            buf += part
            try:
                return buf.decode("utf-8")
            except UnicodeDecodeError:
                if len(buf) >= 4:
                    return "\ufffd"
    return await asyncio.to_thread(read)


async def _drain_escape() -> None:
    fd = sys.stdin.fileno()

    def drain() -> None:
        while True:
            ready, _, _ = select.select([fd], [], [], 0.02)
            if not ready:
                return
            if not os.read(fd, 16):
                return
    await asyncio.to_thread(drain)


async def _open(client: Client, workspace: str, session_id: str, title: str) -> Session:
    if not workspace:
        raise BackendError("workspace_required")
    if session_id:
        current = await client.session(session_id)
        if current.workspace != workspace:
            raise BackendError("workspace_mismatch")
        return current
    return await client.create_session(title=title, workspace=workspace)


async def _loop(client: Client, session: Session, attachment: Attachment, workspace: str) -> None:
    lines: list[str] = []
    draft = ""
    notice = ""
    while True:
        _paint(session.session_id, attachment.attachment_id, workspace, lines, draft, notice)
        key = await _read_key()
        if key in {"", "\x03", "\x04"}:
            return
        if key == "\x1b":
            await _drain_escape()
            continue
        if key in {"\x7f", "\b"}:
            draft = draft[:-1]
            continue
        if key in {"\r", "\n"}:
            text = draft.strip()
            draft = ""
            if not text:
                continue
            notice = "正在等待"
            _paint(session.session_id, attachment.attachment_id, workspace, lines, draft, notice)
            request_id = secrets.token_hex(8)
            receipt = await client.submit(
                session_id=session.session_id, workspace=workspace, attachment_id=attachment.attachment_id,
                request_id=request_id, text=text)
            receipt = await client.wait(session_id=session.session_id, request_id=receipt.request_id)
            lines.append(text)
            lines.append(receipt.answer if receipt.status == "succeeded" else receipt.status)
            notice = ""
            continue
        if key.isprintable():
            draft += key


async def _run(url: str, token: str, workspace: str, session_id: str, title: str) -> int:
    fd = sys.stdin.fileno()
    previous = termios.tcgetattr(fd)
    _raw(fd)
    try:
        _write("\x1b[?1049h\x1b[?25l")
        async with Client(url, token) as client:
            session = await _open(client, workspace, session_id, title)
            attachment = await client.attach(session.session_id)
            try:
                await _loop(client, session, attachment, workspace)
            finally:
                await client.release(session_id=session.session_id, attachment_id=attachment.attachment_id)
                _paint(session.session_id, attachment.attachment_id, workspace, [], "", "已松开绑定")
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, previous)
        _write("\x1b[?25h\x1b[?1049l")
    return 0


def run_tui(argv: list[str]) -> int:
    args = _parser().parse_args(argv)
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        print("tui_requires_tty", file=sys.stderr)
        return 1
    try:
        return asyncio.run(_run(args.url, args.token, args.workspace, args.session, args.title))
    except BackendError as exc:
        print(exc.code, file=sys.stderr)
        return 1
    except Exception:
        print("tui_failed", file=sys.stderr)
        return 1
