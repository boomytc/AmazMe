import importlib.util
import os
import time
from pathlib import Path

import pytest

SOURCE = Path(__file__).parents[1] / "tools/resource_budget.py"
spec = importlib.util.spec_from_file_location("native_resource_budget", SOURCE)
budget = importlib.util.module_from_spec(spec)
spec.loader.exec_module(budget)


def test_sparse_allocation_and_hardlinks_count_actual_blocks_once(tmp_path):
    file = tmp_path / "sparse"
    with file.open("wb") as stream:
        stream.truncate(1024**3)
    os.link(file, tmp_path / "duplicate")
    actual = budget.allocated_bytes([tmp_path, file])
    assert actual == tmp_path.stat().st_blocks*512 + file.stat().st_blocks*512
    assert actual < 1024**2
    (tmp_path / "link").symlink_to(file)
    with pytest.raises(budget.ResourceBudgetError, match="symlink"):
        budget.require_budget([tmp_path / "link"], min_free_bytes=0)


def test_allocation_watchdog_aborts_work_and_allows_owner_cleanup(tmp_path):
    monitor = budget.ResourceBudget([tmp_path], limit_bytes=16384, min_free_bytes=0,
                                    deadline_seconds=2, interval_seconds=.01)
    cleaned = False
    with pytest.raises(budget.BudgetAbort):
        try:
            with monitor:
                (tmp_path / "new").write_bytes(b"x"*32768)
                time.sleep(.2)
        finally:
            (tmp_path / "new").unlink(missing_ok=True)
            cleaned = True
    assert cleaned and monitor.snapshot()["failure"]
    assert monitor.highwater_bytes > monitor.limit_bytes


def test_preflight_reserves_room_before_work(tmp_path):
    with pytest.raises(budget.ResourceBudgetError, match="reserve"):
        budget.require_budget([tmp_path], limit_bytes=8192, reserve_bytes=8193, min_free_bytes=0)
