"""Terminal client for one explicit host, session, and workspace.

Ctrl-C releases this binding and leaves the session's accepted work running.
"""

import argparse
import asyncio
import fcntl
import json
import os
import re
import secrets
import select
import struct
import sys
import termios
import time
from dataclasses import dataclass
from typing import cast

from pydantic import JsonValue, TypeAdapter, ValidationError

from .contracts import Approval, Attachment, BackendError, McpCall, Receipt, Session, TerminalView
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


_ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")


def _visible(raw: str) -> list[str]:
    text = _ESCAPE.sub("", raw).replace("\r", "")
    rows = [line.rstrip() for line in text.split("\n")]
    return [line for line in rows if line][-8:]


def _approval_line(approval: Approval) -> str:
    detail = ""
    try:
        loaded: object = json.loads(approval.call.arguments)
    except json.JSONDecodeError:
        loaded = None
    if isinstance(loaded, dict):
        command = cast(dict[str, object], loaded).get("command")
        if isinstance(command, str):
            detail = command
    text = f"等待审批 {approval.call.name}"
    return f"{text} {detail}" if detail else text


def _receipt_line(receipt: Receipt) -> str:
    if receipt.status == "succeeded":
        return receipt.answer or "succeeded"
    if receipt.error:
        return f"{receipt.status} {receipt.error}"
    return receipt.status


def _stopped(kind: str, phase: str, clean: bool) -> str:
    if phase == "exited" and clean:
        return f"{kind}已退出"
    if phase == "unknown" or not clean:
        return f"{kind}停止未确认"
    return f"{kind}{phase}"


@dataclass
class _PtyPending:
    input_id: str = ""
    text: str = ""


@dataclass
class _Held:
    kind: str
    request_id: str = ""
    approval: Approval | None = None
    server_id: str = ""
    call_id: str = ""
    digest: str = ""
    summary: str = ""


async def _settle_request(client: Client, session_id: str, request_id: str) -> str:
    receipt = await client.wait(session_id=session_id, request_id=request_id, attempts=800)
    return _receipt_line(receipt)


async def _settle_mcp(client: Client, session_id: str, call: McpCall) -> str:
    if call.phase not in {"done", "denied", "unknown", "conflict"}:
        call = await client.await_mcp(session_id, call.call_id, attempts=800)
    if call.phase == "unknown":
        return "MCP unknown"
    if call.phase == "denied":
        return "MCP denied"
    if call.result:
        return f"MCP {call.phase} {call.result}"
    return f"MCP {call.phase}"


async def _watch_terminal(client: Client, session_id: str, attachment_id: str, terminal_id: str) -> TerminalView:
    view = await client.read_terminal(session_id=session_id, attachment_id=attachment_id, terminal_id=terminal_id)
    last = view.output_seq
    stable = 0
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline and stable < 3:
        await asyncio.sleep(0.1)
        view = await client.read_terminal(session_id=session_id, attachment_id=attachment_id, terminal_id=terminal_id)
        if view.output_seq == last and view.output_seq > 0:
            stable += 1
        else:
            last = view.output_seq
            stable = 0
    return view


async def _open(client: Client, workspace: str, session_id: str, title: str) -> Session:
    if not workspace:
        raise BackendError("workspace_required")
    if session_id:
        current = await client.session(session_id)
        if current.workspace != workspace:
            raise BackendError("workspace_mismatch")
        return current
    return await client.create_session(title=title, workspace=workspace)


async def _resume(client: Client, session_id: str) -> tuple[str, str, list[str]]:
    terminals = await client.list_terminals(session_id)
    running = [item.terminal_id for item in terminals.terminals if item.phase == "running"]
    state = await client.mcp_state(session_id)
    ready = [item.server_id for item in state.servers if item.phase == "ready"]
    notes: list[str] = []
    terminal_id = ""
    server_id = ""
    if len(running) == 1:
        terminal_id = running[0]
        notes.append("终端仍在")
    elif len(running) > 1:
        notes.append("终端不唯一")
    if len(ready) == 1:
        server_id = ready[0]
        notes.append("服务仍在")
    elif len(ready) > 1:
        notes.append("服务不唯一")
    return terminal_id, server_id, notes


async def _submit_text(client: Client, session: Session, attachment: Attachment, workspace: str, text: str,
                       lines: list[str]) -> _Held | None:
    request_id = secrets.token_hex(8)
    await client.submit(
        session_id=session.session_id, workspace=workspace, attachment_id=attachment.attachment_id,
        request_id=request_id, text=text)
    receipt, approval = await client.await_user_decision(session_id=session.session_id, request_id=request_id)
    if approval is None:
        lines.append(_receipt_line(receipt))
        return None
    summary = _approval_line(approval)
    lines.append(summary)
    lines.append("输入批准或拒绝")
    return _Held(kind="request", request_id=request_id, approval=approval, summary=summary)


async def _decide_held(client: Client, session: Session, attachment: Attachment, held: _Held, approve: bool,
                       lines: list[str]) -> None:
    if held.kind == "request":
        assert held.approval is not None
        await client.decide(
            session_id=session.session_id, attachment_id=attachment.attachment_id,
            decision_id=secrets.token_hex(16), approval_id=held.approval.approval_id,
            expected_revision=held.approval.revision, proposal_digest=held.approval.proposal_digest, approve=approve)
        lines.append(await _settle_request(client, session.session_id, held.request_id))
        return
    call = await client.decide_mcp(
        session_id=session.session_id, attachment_id=attachment.attachment_id, server_id=held.server_id,
        call_id=held.call_id, decision_id=secrets.token_hex(16), digest=held.digest, approve=approve)
    lines.append(await _settle_mcp(client, session.session_id, call))


async def _handle(client: Client, session: Session, attachment: Attachment, workspace: str, text: str,
                  lines: list[str], held: _Held | None, terminal_id: str, server_id: str,
                  pending: _PtyPending) -> tuple[_Held | None, str, str]:
    if held is not None:
        if text not in {"批准", "拒绝"}:
            lines.append("先输入批准或拒绝")
            return held, terminal_id, server_id
        await _decide_held(client, session, attachment, held, text == "批准", lines)
        return None, terminal_id, server_id
    if text == "/pty-close":
        if not terminal_id:
            lines.append("尚无终端")
            return None, terminal_id, server_id
        view = await client.close_terminal(
            session_id=session.session_id, attachment_id=attachment.attachment_id, terminal_id=terminal_id)
        lines.append(_stopped("终端", view.phase, view.clean))
        return None, "" if view.phase == "exited" else terminal_id, server_id
    if text.startswith("/pty-size "):
        if not terminal_id:
            lines.append("尚无终端")
            return None, terminal_id, server_id
        cols_text, _, rows_text = text.removeprefix("/pty-size ").strip().partition(" ")
        cols, rows = int(cols_text), int(rows_text)
        view = await client.resize_terminal(
            session_id=session.session_id, attachment_id=attachment.attachment_id,
            terminal_id=terminal_id, cols=cols, rows=rows)
        lines.append(f"终端 {view.cols} {view.rows}")
        return None, terminal_id, server_id
    if text == "/pty-ack":
        if not pending.input_id:
            lines.append("没有未确认的输入")
            return None, terminal_id, server_id
        pending.input_id = ""
        pending.text = ""
        lines.append("已由用户核对；原输入不会重放")
        return None, terminal_id, server_id
    if text.startswith("/pty "):
        if pending.input_id and pending.text != text:
            lines.append("上次输入结果未确认；先重试同一输入，或输入 /pty-ack 核对后继续。")
            return None, terminal_id, server_id
        if not terminal_id:
            terminal_id = secrets.token_hex(16)
            opened = await client.open_terminal(
                session_id=session.session_id, attachment_id=attachment.attachment_id, terminal_id=terminal_id,
                command="sh", cols=80, rows=24, workspace=workspace)
            if opened.phase != "running" or opened.terminal_id != terminal_id:
                lines.append("终端打开未确认")
                return None, "", server_id
            lines.append("终端已打开")
        if not pending.input_id:
            pending.input_id = secrets.token_hex(16)
            pending.text = text
        written = await client.write_terminal(
            session_id=session.session_id, attachment_id=attachment.attachment_id, terminal_id=terminal_id,
            input_id=pending.input_id, data=text.removeprefix("/pty ") + "\n")
        if written.input_status != "accepted":
            lines.append("输入未确认")
            return None, terminal_id, server_id
        pending.input_id = ""
        pending.text = ""
        lines.append("输入已接收")
        view = await _watch_terminal(client, session.session_id, attachment.attachment_id, terminal_id)
        lines.extend(_visible(view.output))
        return None, terminal_id, server_id
    if text == "/mcp-close":
        if not server_id:
            lines.append("尚无服务")
            return None, terminal_id, server_id
        view = await client.close_mcp(
            session_id=session.session_id, attachment_id=attachment.attachment_id, server_id=server_id)
        lines.append(_stopped("服务", view.phase, view.clean))
        return None, terminal_id, "" if view.phase == "exited" else server_id
    if text.startswith("/mcp-call "):
        if not server_id:
            lines.append("尚无服务")
            return None, terminal_id, server_id
        name, _, raw = text.removeprefix("/mcp-call ").strip().partition(" ")
        arguments = TypeAdapter(dict[str, JsonValue]).validate_json(raw)
        call = await client.request_mcp(
            session_id=session.session_id, attachment_id=attachment.attachment_id, server_id=server_id,
            call_id=secrets.token_hex(16), name=name, arguments=arguments)
        if call.phase != "waiting_approval":
            lines.append(await _settle_mcp(client, session.session_id, call))
            return None, terminal_id, server_id
        summary = f"等待审批 MCP {call.name}"
        lines.append(summary)
        lines.append("输入批准或拒绝")
        return _Held(kind="mcp", server_id=server_id, call_id=call.call_id, digest=call.digest, summary=summary), terminal_id, server_id
    if text.startswith("/mcp "):
        if server_id:
            lines.append("服务已连接")
            return None, terminal_id, server_id
        server_id = secrets.token_hex(16)
        opened = await client.open_mcp(
            session_id=session.session_id, attachment_id=attachment.attachment_id, server_id=server_id,
            command=text.removeprefix("/mcp ").strip(), workspace=workspace)
        if opened.phase != "ready" or opened.server_id != server_id:
            lines.append("服务打开未确认")
            return None, terminal_id, ""
        lines.append("MCP 已连接")
        return None, terminal_id, server_id
    if text.startswith("/file "):
        content = await client.read_file(text.removeprefix("/file ").strip())
        lines.append(content.content.replace("\n", " "))
        return None, terminal_id, server_id
    if text.startswith("/checkpoint "):
        saved = await client.save_checkpoint(
            checkpoint_id=secrets.token_hex(16), workspace=workspace, path=text.removeprefix("/checkpoint ").strip())
        lines.append(f"已保存 {saved.digest[:12]}")
        return None, terminal_id, server_id
    parked = await _submit_text(client, session, attachment, workspace, text, lines)
    return parked, terminal_id, server_id


async def _loop(client: Client, session: Session, attachment: Attachment, workspace: str,
                terminal_id: str, server_id: str, notes: list[str]) -> None:
    lines = list(notes)
    draft = ""
    notice = ""
    held: _Held | None = None
    pending = _PtyPending()
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
            lines.append(text)
            notice = "正在等待"
            _paint(session.session_id, attachment.attachment_id, workspace, lines, draft, notice)
            try:
                held, terminal_id, server_id = await _handle(
                    client, session, attachment, workspace, text, lines, held, terminal_id, server_id, pending)
            except (BackendError, ValidationError, json.JSONDecodeError, ValueError) as exc:
                code = exc.code if isinstance(exc, BackendError) else "invalid_command"
                lines.append(code)
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
            terminal_id, server_id, notes = await _resume(client, session.session_id)
            try:
                await _loop(client, session, attachment, workspace, terminal_id, server_id, notes)
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
