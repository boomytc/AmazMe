"""Model file observations cross the real Host / worker / Supervisor boundary."""
import json

import pytest
from test_client import _serve, _stop

from amazme_backend.sdk import Client


@pytest.fixture
async def files(tmp_path):
    process, url, profile = _serve(tmp_path)
    token = (profile / "web.token").read_text().strip()
    try:
        async with Client(url, token) as client:
            session = await client.create_session(workspace="primary", title="edit")
            attachment = await client.attach(session.session_id)
            sequence = 0
            async def invoke(name, **arguments):
                nonlocal sequence
                sequence += 1
                rid = f"file-{sequence}"
                await client.rpc("request.submit", session_id=session.session_id, workspace="primary",
                    attachment_id=attachment.attachment_id, request_id=rid, text="file operation",
                    approval_policy="auto", tool_call={"id":"file", "name":name, "arguments":json.dumps(arguments)})
                receipt = await client.wait(session_id=session.session_id, request_id=rid)
                assert receipt.status == "succeeded", receipt
                return json.loads(receipt.answer)
            yield tmp_path / "workspace", invoke
    finally:
        _stop(process, profile)


async def test_unread_existing_file_is_never_overwritten(files):
    root, invoke = files
    path = root / "note.txt"
    path.write_text("keep")
    result = await invoke("write_file", path="note.txt", content="overwrite")
    assert path.read_text() == "keep"
    assert result["exit_code"] != 0 and result["stderr"] == "file_not_observed"
    edit = await invoke("edit_file", path="note.txt", old_string="keep", new_string="overwrite")
    assert edit["stderr"] == "file_not_observed" and path.read_text() == "keep"


async def test_observed_versions_edit_literal_lines_and_reject_external_changes(files):
    root, invoke = files
    path = root / "note.txt"
    path.write_bytes("甲\r\n乙\r\n甲\r\n".encode())
    await invoke("read_file", path="note.txt")
    for old, error in (("无", "file_edit_not_found"), ("甲", "file_edit_ambiguous")):
        result = await invoke("edit_file", path="note.txt", old_string=old, new_string="改")
        assert result["stderr"] == error and path.read_bytes() == "甲\r\n乙\r\n甲\r\n".encode()
    first = await invoke("edit_file", path="note.txt", old_string="乙\r\n", new_string="改\r\n")
    assert first["exit_code"] == 0 and path.read_bytes() == "甲\r\n改\r\n甲\r\n".encode()
    second = await invoke("edit_file", path="note.txt", old_string="甲", new_string="丙", replace_all=True)
    assert second["exit_code"] == 0 and path.read_bytes() == "丙\r\n改\r\n丙\r\n".encode()
    path.write_text("someone else changed it")
    for name, arguments in (("edit_file", {"old_string":"丙", "new_string":"坏"}),
                            ("write_file", {"content":"overwrite"})):
        conflict = await invoke(name, path="note.txt", **arguments)
        assert conflict["exit_code"] != 0 and conflict["stderr"] == "file_conflict"
        assert path.read_text() == "someone else changed it"


async def test_absence_and_unseen_creation_do_not_clobber(files):
    root, invoke = files
    missing = await invoke("read_file", path="new.txt")
    assert missing["file_observation"]["kind"] == "absent"
    (root / "new.txt").write_text("created meanwhile")
    refused = await invoke("write_file", path="new.txt", content="overwrite")
    assert refused["stderr"] == "file_conflict" and (root / "new.txt").read_text() == "created meanwhile"
    created = await invoke("write_file", path="fresh.txt", content="new")
    assert created["exit_code"] == 0 and (root / "fresh.txt").read_text() == "new"
    absent = await invoke("read_file", path="missing.txt")
    assert absent["exit_code"] != 0
    edit = await invoke("edit_file", path="missing.txt", old_string="x", new_string="y")
    assert edit["stderr"] == "workspace_missing" and not (root / "missing.txt").exists()


async def test_model_pages_a_large_file_and_can_edit_a_small_region(files):
    import hashlib
    root, invoke = files
    path = root / "large.txt"
    text = "中文行\n" * 5000 + "one target\n" + "后续\n" * 5000
    path.write_text(text)
    observed, offset = "", 0
    while True:
        result = await invoke("read_file", path="large.txt", offset=offset, limit=32000)
        assert result["exit_code"] == 0
        page = json.loads(result["stdout"])
        assert page["digest"] == hashlib.sha256(text.encode()).hexdigest()
        observed += page["content"]
        offset = page["next_offset"]
        if not page["has_more"]:
            break
    assert observed == text and offset == len(text.encode())
    changed = await invoke("edit_file", path="large.txt", old_string="one target", new_string="new target")
    assert changed["exit_code"] == 0 and path.read_text() == text.replace("one target", "new target")
    (root / "binary").write_bytes(b"\xff")
    binary = await invoke("read_file", path="binary")
    assert binary["stderr"] == "file_not_text" and binary["file_observation"] is None
    with (root / "huge").open("wb") as stream:
        stream.truncate(16 * 1024 * 1024 + 1)
    oversized = await invoke("read_file", path="huge")
    assert oversized["stderr"] == "file_too_large" and oversized["file_observation"] is None
