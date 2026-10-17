"""子进程任务执行入口：`python -m llm_price_monitor.webapi.task_runner --kind <kind> --params <json>`。

采集类任务体在这里独立进程里跑，主进程（API）只读它打到 stdout 的 JSON 行（日志/结果/错误）——
采集的解析、写库与网络等待不再与页面请求争 GIL 和 CPU（2026-10-16 「采集拆进程」根治）。
cwd / 环境变量 / PRICE_MONITOR_DB 由父进程原样继承，容器里无需任何额外端口或挂载。

看门狗：父进程退出（dev 热重载、崩溃）后本进程立即自杀——不然孤儿进程会继续打站，
下一轮调度又起一个，变成重复采集。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from typing import Any

from llm_price_monitor import tasklog
from llm_price_monitor.store import Store
from llm_price_monitor.webapi.job_registry import build_job

# 与 webapi/app.py 的 DB_PATH 同一语义：环境变量覆盖，缺省取工作目录下的 var/monitor.db
_DB_PATH = os.getenv("PRICE_MONITOR_DB") or "var/monitor.db"


def _emit(payload: dict[str, Any]) -> None:
    """往 stdout 写一行 JSON：父进程按行解析，非 JSON 输出会被父进程当普通日志转存。"""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _watch_parent(origin_ppid: int) -> None:
    while True:
        if os.getppid() != origin_ppid:
            # 父进程没了：日志出口已失效，直接退出（守护线程，进程退出即终止）
            os._exit(1)
        time.sleep(1.0)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="在独立进程里执行一个采集/刷新任务体")
    parser.add_argument("--kind", required=True, help="任务类型（webapi/job_registry.py 的 kind）")
    parser.add_argument("--params", default="{}", help="任务参数 JSON（persist/site_id/site_ids/force/vendor）")
    args = parser.parse_args(argv)
    try:
        params = json.loads(args.params or "{}")
    except ValueError as exc:
        _emit({"type": "error", "error": f"参数不是合法 JSON：{exc}"})
        return 1
    if not isinstance(params, dict):
        _emit({"type": "error", "error": "参数必须是 JSON 对象"})
        return 1

    threading.Thread(target=_watch_parent, args=(os.getppid(),), daemon=True, name="parent-watch").start()

    def sink(message: str, level: str = "info") -> None:
        try:
            _emit({"type": "log", "message": message, "level": level})
        except (BrokenPipeError, OSError):
            os._exit(1)  # 父进程已关闭读取端，继续跑没有意义

    tasklog.bind(sink)
    store = Store(_DB_PATH)
    try:
        job = build_job(args.kind, params, store)
        result = job()
    except Exception as exc:  # 任务体异常统一回成 error 行：父进程据此把任务置为失败
        _emit({"type": "error", "error": str(exc)})
        return 1
    _emit({"type": "result", "result": result})
    return 0


if __name__ == "__main__":  # pragma: no cover - 进程入口
    raise SystemExit(main())
