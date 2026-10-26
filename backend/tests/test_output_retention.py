"""Execution log failure and UTF-8 contracts at real file and process boundaries."""
import errno
import time

import pytest

from amazme_backend.contracts.execution import OutputRead
from amazme_backend.execution.output import OutputCapture, read_output
from amazme_backend.shared.errors import BackendError


def test_streams_and_byte_cursors_preserve_chinese_and_partial_characters(tmp_path):
    capture = OutputCapture(tmp_path, "call", int(time.time()) + 60)
    capture.append("stdout", "甲乙\n丙".encode())
    capture.append("stderr", "错误\n".encode())
    capture.publish(settled=True)
    first = read_output(tmp_path, OutputRead(locator="call", limit=4))
    second = read_output(tmp_path, OutputRead(locator="call", offset=first.next_offset, limit=4))
    third = read_output(tmp_path, OutputRead(locator="call", offset=second.next_offset, limit=4))
    assert first.content + second.content + third.content == "甲乙\n丙"
    assert first.next_offset == 3 and second.next_offset == 7 and third.next_offset == 10
    assert read_output(tmp_path, OutputRead(locator="call", stream="stderr")).content == "错误\n"
    for offset in (1, 11):
        with pytest.raises(BackendError, match="output_cursor"):
            read_output(tmp_path, OutputRead(locator="call", offset=offset))


def test_live_incomplete_character_waits_for_remaining_bytes(tmp_path):
    capture = OutputCapture(tmp_path, "call", int(time.time()) + 60)
    capture.append("stdout", "甲".encode()[:2])
    capture.publish()
    first = read_output(tmp_path, OutputRead(locator="call"))
    assert first.content == "" and first.next_offset == 0 and first.has_more
    capture.append("stdout", "甲".encode()[2:])
    capture.publish(settled=True)
    assert read_output(tmp_path, OutputRead(locator="call")).content == "甲"


def test_quota_reports_exact_retained_prefix_and_continues_counting(tmp_path, monkeypatch):
    monkeypatch.setattr("amazme_backend.execution.output.STREAM_LIMIT", 5)
    capture = OutputCapture(tmp_path, "call", int(time.time()) + 60)
    capture.append("stdout", b"abcdef")
    capture.append("stdout", b"ghi")
    capture.publish(settled=True)
    page = read_output(tmp_path, OutputRead(locator="call"))
    assert page.content == "abcde"
    assert page.archive.stdout.retained_bytes == 5 and page.archive.stdout.observed_bytes == 9
    assert page.archive.stdout.error == "output_quota"


def test_disk_failure_is_not_claimed_as_a_complete_log(tmp_path, monkeypatch):
    capture = OutputCapture(tmp_path, "call", int(time.time()) + 60)
    capture.append("stdout", b"before")
    def no_space(*_):
        raise OSError(errno.ENOSPC, "full")
    with monkeypatch.context() as failure:
        failure.setattr("amazme_backend.execution.output.os.write", no_space)
        capture.append("stdout", b"lost")
    capture.publish(settled=True)
    page = read_output(tmp_path, OutputRead(locator="call"))
    assert page.content == "before" and page.archive.stdout.error == "output_save_failed"
    assert page.archive.stdout.observed_bytes == 10 and page.archive.stdout.retained_bytes == 6


def test_expiry_missing_locator_and_symlink_are_refused(tmp_path):
    with pytest.raises(BackendError, match="output_unavailable"):
        read_output(tmp_path, OutputRead(locator="missing"))
    capture = OutputCapture(tmp_path, "call", int(time.time()) - 1)
    capture.publish(settled=True)
    with pytest.raises(BackendError, match="output_expired"):
        read_output(tmp_path, OutputRead(locator="call"))
    capture.archive.expires_at = int(time.time()) + 60
    capture.publish(settled=True)
    (tmp_path / "stdout.log").symlink_to(tmp_path / "output.json")
    with pytest.raises(BackendError, match="output_unavailable"):
        read_output(tmp_path, OutputRead(locator="call"))


def test_metadata_failure_is_explicit_and_does_not_retry_unbounded_writes(tmp_path, monkeypatch):
    attempts = []
    def fail(*_):
        attempts.append(1)
        raise OSError(errno.ENOSPC, "full")
    monkeypatch.setattr("amazme_backend.execution.output.private_write", fail)
    capture = OutputCapture(tmp_path, "call", int(time.time()) + 60)
    capture.publish()
    capture.append("stdout", b"lost")
    capture.publish(settled=True)
    assert attempts == [1]
    assert capture.archive.stdout.error == "output_metadata_failed"
    assert capture.archive.stdout.observed_bytes == 4 and capture.archive.stdout.retained_bytes == 0
