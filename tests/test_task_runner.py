"""拆进程采集（2026-10-16）：任务体注册表的完整性 + 子进程管道协议。

生产上采集类任务体跑在独立子进程里（webapi/task_runner.py），主进程只读 stdout 的 JSON 行；
测试默认退回进程内执行（conftest 设 PRICE_MONITOR_TASK_MODE=inline），这里单独覆盖两条路径。
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

from llm_price_monitor.store import Store

# 路由与调度器会用到的全部 kind（新增 kind 必须同时进 job_registry.build_job，否则这里红）
ALL_KINDS = [
    "collect",
    "collect-test",
    "collect-price",
    "collect-status",
    "collect-notice",
    "collect-screenshot",
    "collect-popularity",
    "catalog-refresh",
    "rankings-refresh",
    "discovery-refresh",
    "vendor-source-refresh",
]


def _store(tmp_path: Path) -> Store:
    return Store(tmp_path / "monitor.db")


def test_build_job_covers_every_kind(tmp_path: Path):
    """每个 kind 都能构建出可调用的任务体（不执行）：kind 表与注册表不分叉。"""
    from llm_price_monitor.webapi.job_registry import build_job

    store = _store(tmp_path)
    for kind in ALL_KINDS:
        params = {"vendor": "models.dev"} if kind == "vendor-source-refresh" else {}
        job = build_job(kind, params, store)
        assert callable(job), f"{kind} 没有构建出可调用的任务体"


def test_build_job_rejects_unknown_kind_and_missing_vendor(tmp_path: Path):
    from llm_price_monitor.webapi.job_registry import build_job

    store = _store(tmp_path)
    with pytest.raises(ValueError, match="未知任务类型"):
        build_job("does-not-exist", {}, store)
    with pytest.raises(ValueError, match="vendor"):
        build_job("vendor-source-refresh", {}, store)


def test_build_job_validates_site_params(tmp_path: Path):
    """站点参数校验抛 UnknownSite：路由据此回 400，子进程据此把任务置失败。"""
    from llm_price_monitor.webapi.deps import load_config
    from llm_price_monitor.webapi.job_registry import UnknownSite, build_job, resolve_sites

    store = _store(tmp_path)
    with pytest.raises(UnknownSite):
        build_job("collect-status", {"site_id": "不存在的站"}, store)
    # 空配置库：批量站点参数同样报 UnknownSite（路由把它转成 400）
    with pytest.raises(UnknownSite):
        resolve_sites(load_config(store), {"site_ids": ["a"]})


def _wait_done(task_id: str, timeout: float = 5.0) -> dict:
    from llm_price_monitor.webapi import tasks

    deadline = time.time() + timeout
    while time.time() < deadline:
        entry = tasks.get(task_id)
        if entry and entry["status"] != "running":
            return entry
        time.sleep(0.02)
    raise AssertionError("任务没有在超时内收尾")


def test_submit_remote_pipes_logs_and_result(tmp_path: Path, monkeypatch):
    """子进程协议：JSON 行收成日志/结果，非 JSON 行按日志转存，收尾写 done。"""
    from llm_price_monitor.webapi import tasks

    script = (
        "import json;"
        "print(json.dumps({'type':'log','message':'开始采集','level':'info'}, ensure_ascii=False));"
        "print('裸输出一行');"
        "print(json.dumps({'type':'result','result':{'records_total':3}}, ensure_ascii=False))"
    )
    monkeypatch.setenv("PRICE_MONITOR_TASK_MODE", "process")
    monkeypatch.setattr(tasks, "_REMOTE_COMMAND", [sys.executable, "-c", script])
    tasks.reset()
    tasks.attach_store(Store(tmp_path / "monitor.db"))
    task_id = tasks.submit_remote("catalog-refresh", {"vendor": "models.dev"})
    entry = _wait_done(task_id)
    assert entry["status"] == "done" and entry["result"] == {"records_total": 3}
    messages = [log["message"] for log in entry["logs"]]
    assert "开始采集" in messages and "裸输出一行" in messages


def test_submit_remote_marks_failed_on_child_error(tmp_path: Path, monkeypatch):
    """子进程报错行或异常退出码都要落成 failed，并把原因写进任务与日志。"""
    from llm_price_monitor.webapi import tasks

    for script, expect in (
        ("print('{bad json')", "没有返回结果"),
        ("import json,sys;print(json.dumps({'type':'error','error':'站点不可达'}));sys.exit(1)", "站点不可达"),
    ):
        monkeypatch.setenv("PRICE_MONITOR_TASK_MODE", "process")
        monkeypatch.setattr(tasks, "_REMOTE_COMMAND", [sys.executable, "-c", script])
        tasks.reset()
        tasks.attach_store(Store(tmp_path / "monitor.db"))
        task_id = tasks.submit_remote("catalog-refresh")
        entry = _wait_done(task_id)
        assert entry["status"] == "failed", entry
        assert expect in (entry["error"] or "")
        assert any("任务失败" in log["message"] for log in entry["logs"])


def test_task_runner_reports_unknown_kind(tmp_path: Path):
    """runner 对未知 kind 以错误行 + 非零退出码收场（父进程据此置失败）。"""
    env = {"PRICE_MONITOR_DB": str(tmp_path / "monitor.db"), "PATH": "/usr/bin:/bin"}
    result = subprocess.run(
        [sys.executable, "-m", "llm_price_monitor.webapi.task_runner", "--kind", "does-not-exist"],
        capture_output=True, text=True, env=env, timeout=60,
    )
    assert result.returncode == 1
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["type"] == "error" and "未知任务类型" in payload["error"]
