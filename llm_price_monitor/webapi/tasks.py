"""进程内后台任务注册表：采集与官方价抓取耗时较长，提交到线程执行并轮询状态。

任务记录连同过程日志经 attach_store 持久化到 SQLite 文档表，服务重启后历史仍可查看；
重启加载时把中断的 running 任务统一标记为失败。概览页“采集异常”卡片另有一份
warn/error 抄送流水（task_errors 文档），独立于任务日志的滚动窗口，持久保存供排查。
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Callable
from typing import Any

from llm_price_monitor import tasklog
from llm_price_monitor.report import is_origin_fault, is_transport_error

_log = logging.getLogger("llm_price_monitor.webapi.tasks")

# 持久化的任务条数与单任务日志行数上限：MAX_TASK_RUNS 是清理界限，超出即淘汰最旧任务
MAX_TASK_RUNS = 100
MAX_TASK_LOG_LINES = 500

# 写盘时保留完整日志的最近任务数：快照最多留 100 条任务、每条日志可到 500 行，
# 全量写盘会让 tasks 文档膨胀到十几 MB；更早的任务只留一条归档说明（内存里日志不裁）
KEEP_LOGGED_RUNS = 10

# 保留完整 result 的最近任务数：单条 collect-status 的 result 有 1.7 MB（85 站的原始快照），
# 留 10 条会把 tasks 文档撑到 14 MB——任务进行中这份文档每几秒整份重写一次、管理台还每 4 秒
# 整份读一次，写锁会把页面读库挡在外面（2026-10-16 页面变慢定位）。前端列表只读
# *_total / models_found 计数，所以除最新一条外一律改用 _slim_result 摘要。
KEEP_FULL_RESULT_RUNS = 1

# 落盘合并窗口（秒）：任务进行中每行日志都会调 _persist()，不合并就是每 1–3 秒整份重写
# 十几 MB 的文档；窗口内的后续变更由尾随定时器补写，任务创建/终态走 force 立即落盘。
_PERSIST_MIN_INTERVAL = 3.0

_lock = threading.Lock()
# 写盘串行锁：只护住 store.set_document，避免合并窗口外的两次写盘交错互相覆盖
_write_lock = threading.Lock()
_tasks: dict[str, dict[str, Any]] = {}
_RUNNING_KINDS: dict[str, str] = {}
_store: Any = None
_last_persist_at = 0.0
_persist_timer: threading.Timer | None = None

# 异常卡片的持久化流水：warn/error 日志写入任务日志时同步抄送一份（上限条数滚动淘汰）。
# 任务日志只给最近 KEEP_LOGGED_RUNS 个任务保留、更早的归档省略，异常历史靠这份流水留存；
# 单条消息截断到固定长度，异常原文任务日志里仍完整，流水文档体积有硬上界不撑大数据库
_JOURNAL_DOC = "task_errors"
_JOURNAL_KEEP = 1000
_JOURNAL_MSG_MAX = 500
_journal: list[dict[str, Any]] = []



# 全量采集与三类拆分采集写同一份价格快照/状态时序，彼此互斥（读-改-写不能并发）。
# 站点截图（collect-screenshot）不进组：只写自己的图片与元数据文档，与采集并行互不影响；
# 单站测试采集（collect-test）不进组：只写本站数据行，允许与全局采集并行（共享文档
# 的读-改-写竞态由 report 的合并锁兜住），同类测试之间仍靠同 kind 去重一次只跑一个
COLLECT_KINDS = frozenset({"collect", "collect-price", "collect-status", "collect-notice"})
# 目录刷新与单厂商源刷新都读-改-写同一份 catalog 文档，二者同样互斥（但不与价格/状态采集互斥）
CATALOG_KINDS = frozenset({"catalog-refresh", "vendor-source-refresh"})


def _conflict_of(kind: str) -> str | None:
    """返回与 kind 冲突的运行中任务 id；同组任务彼此互斥。"""
    if kind in _RUNNING_KINDS:
        return _RUNNING_KINDS[kind]
    for group in (COLLECT_KINDS, CATALOG_KINDS):
        if kind in group:
            return next((_RUNNING_KINDS[k] for k in group if k in _RUNNING_KINDS), None)
    return None


def attach_store(store: Any) -> None:
    """接入持久化并加载历史任务；create_app 组装时调用一次。"""
    global _store
    _store = store
    runs = (store.get_document("tasks") or {}).get("runs", [])
    journal = (store.get_document(_JOURNAL_DOC) or {}).get("entries", [])
    marked_failed = False
    with _lock:
        for entry in runs:
            if entry["status"] == "running":
                entry.update(status="failed", error="服务重启，任务中断", finished_at=time.time())
                marked_failed = True
            entry.setdefault("logs", [])
            _tasks[entry["id"]] = entry
        _journal[:] = _merge_journal([item for item in journal if isinstance(item, dict)])
    if marked_failed:
        _persist(force=True)


def _slim_result(result: Any) -> Any:
    """老任务归档用的结果摘要：列表换成 *_total 计数、嵌套字典丢弃，标量原样保留。

    完整 result 里嵌着采集快照（状态采集一轮几十 KB），留 100 条能把 tasks 文档
    撑到 10MB；前端列表只读 records 长度与 models_found，摘要足够。
    """
    if not isinstance(result, dict):
        return result
    slim: dict[str, Any] = {}
    for key, value in result.items():
        if isinstance(value, list):
            slim[f"{key}_total"] = len(value)
        elif not isinstance(value, dict):
            slim[key] = value
    return slim


def _persist(*, force: bool = False) -> None:
    """把最近的任务记录（含日志）写入存储；未接入存储时跳过。

    写盘按 _PERSIST_MIN_INTERVAL 合并：非 force 调用落在窗口内时只安排一次尾随补写，
    保证「最后一次变更」不丢；force 用于任务创建、终态与重启标记，状态转换即时落盘。"""
    store = _store
    if store is None:
        return
    global _last_persist_at, _persist_timer
    with _lock:
        now = time.time()
        if not force and now - _last_persist_at < _PERSIST_MIN_INTERVAL:
            _schedule_trailing_persist(_PERSIST_MIN_INTERVAL - (now - _last_persist_at))
            return
        _last_persist_at = now
        if _persist_timer is not None:
            _persist_timer.cancel()
            _persist_timer = None
        max_runs = MAX_TASK_RUNS
        items = sorted(_tasks.values(), key=lambda item: str(item["started_at"]), reverse=True)
        snapshot = [dict(item, logs=list(item["logs"])) for item in items[:max_runs]]
        for index, entry in enumerate(snapshot):
            if index >= KEEP_LOGGED_RUNS and entry["logs"]:
                entry["logs"] = [
                    {
                        "time": entry.get("finished_at") or entry["started_at"],
                        "message": "历史任务日志已归档省略",
                        "level": "info",
                    }
                ]
            if index >= KEEP_FULL_RESULT_RUNS and entry.get("result") is not None:
                entry["result"] = _slim_result(entry["result"])
    with _write_lock:
        try:
            store.set_document("tasks", {"runs": snapshot})
        except Exception as exc:  # 写盘失败不阻断采集：日志属辅助信息，任务状态仍在内存可用
            _log.warning("任务记录写盘失败：%s", exc)


def _schedule_trailing_persist(delay: float) -> None:
    """合并窗口的尾随落盘：窗口内没有新写入时补一次 force 写盘（调用方须持有 _lock）。"""
    global _persist_timer
    if _persist_timer is not None:
        return
    timer = threading.Timer(max(delay, 0.0), lambda: _persist(force=True))
    timer.daemon = True
    _persist_timer = timer
    timer.start()


def _append_log(task_id: str, message: str, level: str) -> None:
    journaled = False
    with _lock:
        entry = _tasks.get(task_id)
        if entry is None:
            return
        max_lines = MAX_TASK_LOG_LINES
        logs = entry["logs"]
        if len(logs) >= max_lines and not entry.get("rolled"):
            # 滚动窗口前先插一条提示，避免长任务后半段日志静默丢失却无迹可查
            logs.append({"time": time.time(), "message": f"日志超过 {max_lines} 条，最早的记录将被滚动覆盖", "level": "warn"})
            entry["rolled"] = True
        log = {"time": time.time(), "message": message, "level": level}
        logs.append(log)
        while len(logs) > max_lines:
            logs.pop(0)
        # 异常卡片抄送：warn/error 在写任务日志时同步记入持久化流水；三类不收——
        # 容忍窗口内的 warn（链路抖动、站方源站故障未达容忍轮数）、自愈动作 warn
        # （已改走代理/已换节点重试）都是环境噪声，与健康档案同一套规则；达标后的 error 照进。
        # 同站同类问题按归一键合并计数，不逐轮追加（666ai 这类持续故障只占一行）
        if level in ("warn", "error") and not (
            level == "warn"
            and (is_transport_error(message) or is_origin_fault(message) or _is_self_healed_warn(message))
        ):
            _journal_store_entry(task_id, str(entry["kind"]), log)
            journaled = True
    if journaled:
        _persist_journal()
    _persist()


def _persist_journal() -> None:
    """把异常流水写入存储；未接入存储时跳过。"""
    store = _store
    if store is None:
        return
    with _lock:
        entries = list(_journal)
    try:
        store.set_document(_JOURNAL_DOC, {"entries": entries})
    except Exception as exc:  # 流水写盘失败不阻断采集：卡片属辅助信息，任务日志仍照常记录
        _log.warning("异常流水写盘失败：%s", exc)


def _register(kind: str) -> str:
    """冲突检查 + 建任务条目 + 立即落盘：线程版与子进程版共用同一套注册表语义。"""
    with _lock:
        conflict = _conflict_of(kind)
        if conflict:
            # 占用方与请求方是两个任务：报错要报占用方的 kind 与开始时间，
            # 否则用户会误以为是上一次同类操作没结束
            entry = _tasks.get(conflict)
            if entry is not None:
                started = time.strftime("%m-%d %H:%M", time.localtime(entry["started_at"]))
                raise RuntimeError(f"已有运行中的 {entry['kind']} 任务（{started} 开始，id {conflict[:8]}），等它结束再试")
            raise RuntimeError(f"已有运行中的 {kind} 任务: {conflict}")
        task_id = uuid.uuid4().hex
        _tasks[task_id] = {
            "id": task_id,
            "kind": kind,
            "status": "running",
            "started_at": time.time(),
            "finished_at": None,
            "result": None,
            "error": None,
            "logs": [],
        }
        _RUNNING_KINDS[kind] = task_id
    _persist(force=True)
    return task_id


def _finish(task_id: str, *, status: str, result: Any = None, error: str | None = None) -> None:
    """任务收尾（线程版与子进程版共用）：写终态、释放 kind 占用、立即落盘。

    reset() 可能已把任务清出注册表（测试清场）；条目不存在时静默退出。"""
    with _lock:
        entry = _tasks.get(task_id)
        if entry is not None:
            entry.update(status=status, result=result, error=error, finished_at=time.time())
            _RUNNING_KINDS.pop(str(entry["kind"]), None)
    _persist(force=True)


def submit(kind: str, fn: Callable[[], Any]) -> str:
    """提交后台任务并立即返回 task_id；同一 kind 同时只允许一个运行中的任务。

    任务体在本进程线程里跑：测试与显式传任务的调用走这条路径；生产走 submit_remote。"""
    task_id = _register(kind)

    def _write_log(message: str, level: str) -> None:
        _append_log(task_id, message, level)

    def _run() -> None:
        tasklog.bind(_write_log)
        try:
            result = fn()
        except Exception as exc:  # 后台线程后备：任何异常都落到任务状态里供前端展示
            _append_log(task_id, f"任务失败：{exc}", "error")
            _finish(task_id, status="failed", error=str(exc))
        else:
            _finish(task_id, status="done", result=result)
        finally:
            tasklog.unbind()

    threading.Thread(target=_run, daemon=True, name=f"webapi-{kind}-{task_id[:8]}").start()
    return task_id


# 任务执行方式：process = 采集类任务体跑在独立子进程（默认，采集期不再与页面请求争 CPU）；
# inline = 在本进程线程里跑（测试用：路由级用例要 monkeypatch 任务体、也不真打外站）。
# 两种模式的注册表语义完全一致（同冲突判定、同落盘、同日志）。
_TASK_MODE_ENV = "PRICE_MONITOR_TASK_MODE"

# 子进程入口：sys.executable 保证用同一个虚拟环境（容器里同样成立，部署无需改动）
_REMOTE_COMMAND: list[str] = [sys.executable, "-m", "llm_price_monitor.webapi.task_runner"]


def submit_remote(kind: str, params: dict[str, Any] | None = None, *, store: Any = None) -> str:
    """提交采集/刷新任务：默认起独立子进程执行，主进程只收日志与结果。

    拆进程的动机（2026-10-16 根治采集期页面变慢）：此前任务体与 API 同进程，一轮采集的
    解析与写库会把接口从毫秒级拖到秒级（GIL 与 CPU 争用）；拆开后两者互不干扰。
    子进程继承 cwd 与环境变量，DB 走 PRICE_MONITOR_DB 或工作目录下的 var/monitor.db。

    store 只在 inline 模式（测试）用得上：直接调调度器的用例没经过 create_app，
    注册表里没有接入存储，由调用方把自己的 store 传进来构建任务体。"""
    if os.environ.get(_TASK_MODE_ENV) == "inline":
        target = store or _store
        if target is None:
            raise RuntimeError("任务执行器未接入存储，无法在进程内构建任务体")
        from llm_price_monitor.webapi.job_registry import build_job

        return submit(kind, build_job(kind, params or {}, target))
    task_id = _register(kind)
    command = [*_REMOTE_COMMAND, "--kind", kind, "--params", json.dumps(params or {}, ensure_ascii=False)]
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            # stderr 合并进 stdout：一边读一边转日志，避免两条管道写满后互相等成死锁
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            cwd=os.getcwd(),
            env=os.environ.copy(),
        )
    except OSError as exc:
        # 起不来就地把任务置为失败：前端在任务列表里能看到原因，不用猜
        _finish(task_id, status="failed", error=f"子进程启动失败：{exc}")
        return task_id
    threading.Thread(
        target=_pump_remote,
        args=(task_id, process),
        daemon=True,
        name=f"webapi-remote-{task_id[:8]}",
    ).start()
    return task_id


def _pump_remote(task_id: str, process: subprocess.Popen[str]) -> None:
    """读子进程输出：JSON 行收成日志/结果/错误，其余原样按日志转存；退出后写终态。"""
    result: Any = None
    error: str | None = None
    saw_result = False
    for raw in process.stdout or []:
        line = raw.strip()
        if not line:
            continue
        payload: Any = None
        if line.startswith("{"):
            try:
                payload = json.loads(line)
            except ValueError:
                payload = None
        if not isinstance(payload, dict):
            _append_log(task_id, line[:500], "info")
            continue
        line_kind = payload.get("type")
        if line_kind == "log":
            _append_log(task_id, str(payload.get("message") or ""), str(payload.get("level") or "info"))
        elif line_kind == "result":
            result = payload.get("result")
            saw_result = True
        elif line_kind == "error":
            error = str(payload.get("error") or "任务失败")
    code = process.wait()
    if error is None and code != 0:
        error = f"任务进程异常退出（退出码 {code}）"
    elif error is None and not saw_result:
        # runner 一定以 result 或 error 收场：两头都没有说明子进程没跑完就没了
        error = "任务进程没有返回结果"
    if error is not None:
        _append_log(task_id, f"任务失败：{error}", "error")
        _finish(task_id, status="failed", error=error)
    else:
        _finish(task_id, status="done", result=result)


def is_running(kind: str) -> bool:
    """该 kind（或与其互斥的采集类任务）是否有运行中实例；调度器据此顺延一轮。"""
    with _lock:
        return _conflict_of(kind) is not None


def get(task_id: str) -> dict[str, Any] | None:
    with _lock:
        task = _tasks.get(task_id)
        if not task:
            return None
        # logs 是后台线程滚动维护的列表，浅拷贝外层后需再拷一层，避免轮询序列化时与写线程竞态
        snapshot = dict(task)
        snapshot["logs"] = list(task.get("logs") or [])
        return snapshot


def reset() -> None:
    """清空任务注册表并解除持久化（仅测试使用）：注册表进程内共享，测试间需要显式清场。"""
    global _store, _last_persist_at, _persist_timer
    with _lock:
        _tasks.clear()
        _RUNNING_KINDS.clear()
        _journal.clear()
        # 合并窗口状态一并清场：残留的窗口时间戳会让下一个测试的首写被节流，
        # 悬着的尾随定时器也会在别的用例里补一次落盘
        _last_persist_at = 0.0
        if _persist_timer is not None:
            _persist_timer.cancel()
            _persist_timer = None
    _store = None


def recent(limit: int = 100) -> list[dict[str, Any]]:
    """最近的任务列表（新任务在前）；日志不随列表下发，只附带错误摘要供列表行提示。"""
    with _lock:
        items = sorted(_tasks.values(), key=lambda item: str(item["started_at"]), reverse=True)
        rows = []
        for item in items[:limit]:
            errors = [log for log in item["logs"] if log.get("level") == "error"]
            rows.append(
                {key: value for key, value in item.items() if key != "logs"}
                | {"log_count": len(item["logs"]), "error_count": len(errors), "error_summary": errors[-1]["message"] if errors else None}
            )
        return rows


# 概览页“采集异常”卡片的清除标记：被移除的单条日志键与“清空”时间点，
# 只影响该卡片的展示，不改动流水与任务本体日志
_DISMISS_DOC = "task_error_stream"
_DISMISS_KEEP = 1000


def _dismiss_state() -> dict[str, Any]:
    store = _store
    if store is None:
        return {}
    try:
        return store.get_document(_DISMISS_DOC) or {}
    except Exception as exc:
        _log.warning("读取异常卡片清除标记失败，按未清除处理：%s", exc)
        return {}


# 持续故障的报错文本每轮只变「连续 N 轮」这个数字：归一后做归一键，同一站点的同类
# 问题在卡片里只占一行、计数累计，而不是每轮追加一条（2026-10-14 实证：666ai 一家
# 把卡片刷到 1000 条上限，把真正的新问题挤了出去）。只归一这一处动态量，
# 其余原文参与哈希——宁可少合并，不误合并。
_STREAK_ROUNDS_RE = re.compile(r"连续第?\s*\d+\s*(?:/\s*\d+)?\s*轮")

# 自愈动作的 warn（直连被拒收已改走备用代理、代理被拦已换节点重试）当轮即恢复，
# 结果由后续采集的成/败日志后备；进卡片只是每轮重复的噪声。
_SELF_HEALED_WARN_RE = re.compile(r"改走备用代理重试|已切换节点")


def _journal_fingerprint(message: str) -> str:
    """异常条目的归一键：同站点同类持续故障得到同一个键。"""
    normalized = _STREAK_ROUNDS_RE.sub("连续 N 轮", message)
    return hashlib.sha1(normalized.encode("utf-8")).hexdigest()[:16]


def _is_self_healed_warn(message: str) -> bool:
    """是否为「已自动处理」的警告（改走代理/换节点重试）。"""
    return bool(_SELF_HEALED_WARN_RE.search(message))


def _journal_store_entry(task_id: str, kind: str, log: dict[str, Any]) -> None:
    """把一条 warn/error 日志并入异常流水：同归一键更新计数与时间，否则追加新条目。

    调用方需持有 _lock（_append_log 的临界区）。
    """
    message = str(log.get("message") or "")
    # 指纹用截断后的存储文本算：与 _merge_journal 加载历史时规则一致（文档里只有截断版），
    # 否则超长消息重启后归并键漂移、会再重复出现一条
    stored = message if len(message) <= _JOURNAL_MSG_MAX else message[:_JOURNAL_MSG_MAX] + "…"
    key = _journal_fingerprint(stored)
    for item in _journal:
        if item.get("key") == key:
            item.update(task_id=task_id, kind=kind, time=log["time"], level=log["level"], message=stored)
            item["count"] = int(item.get("count") or 1) + 1
            return
    _journal.append({
        "key": key,
        "task_id": task_id,
        "kind": kind,
        "time": log["time"],
        "level": log["level"],
        "message": stored,
        "count": 1,
        "first_time": log["time"],
    })
    del _journal[:-_JOURNAL_KEEP]


def _merge_journal(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """加载持久化流水时归并：同归一键合并成一条（计数累计、首见取最早、其余取最新）。

    老式逐条 key 一并重算，历史堆积（每轮一条）缩回「每类问题一条」；与抄送规则一致，
    自愈类/容忍窗口内的 warn 历史条目顺带清掉。
    """
    merged: dict[str, dict[str, Any]] = {}
    for item in entries:
        message = str(item.get("message") or "")
        level = str(item.get("level") or "")
        if level == "warn" and (
            is_transport_error(message) or is_origin_fault(message) or _is_self_healed_warn(message)
        ):
            continue
        key = _journal_fingerprint(message)
        time_value = float(item.get("time") or 0)
        first_value = float(item.get("first_time") or time_value)
        count = int(item.get("count") or 1)
        current = merged.get(key)
        if current is None:
            merged[key] = {**item, "key": key, "count": count, "first_time": first_value}
            continue
        current["count"] = int(current.get("count") or 1) + count
        current["first_time"] = min(float(current.get("first_time") or first_value), first_value)
        if time_value >= float(current.get("time") or 0):
            current.update(
                task_id=item.get("task_id"),
                kind=item.get("kind"),
                time=item.get("time"),
                level=item.get("level"),
                message=item.get("message"),
            )
    return list(merged.values())[-_JOURNAL_KEEP:]


def error_stream(limit: int = 200) -> list[dict[str, Any]]:
    """跨任务汇总 warn/error 日志（新在前），滤掉已移除/清空时间点之前的条目，供概览页异常卡片展示。

    条目来自写日志时同步抄送的持久化流水，不随任务日志的滚动窗口归档、也不因重启丢失；
    传输层抖动的 warn 在抄送时已按健康档案标准拦下，重试耗尽升级成 error 的站点失败仍可见。
    """
    state = _dismiss_state()
    cleared_at = state.get("cleared_at")
    dismissed = set(state.get("dismissed", []))
    with _lock:
        entries = [dict(entry) for entry in _journal]
    entries.sort(key=lambda entry: float(entry.get("time") or 0), reverse=True)
    visible = []
    for entry in entries:
        if dismissed and entry["key"] in dismissed:
            continue
        if cleared_at is not None and float(entry.get("time") or 0) <= float(cleared_at):
            continue
        visible.append(entry)
    return visible[:limit]


def dismiss_error(key: str) -> bool:
    """移除异常卡片里的单条日志：只记入清除标记，任务本体日志保持不动。"""
    store = _store
    if store is None:
        return False
    state = _dismiss_state()
    dismissed = list(state.get("dismissed", []))
    if key not in dismissed:
        dismissed.append(key)
    state["dismissed"] = dismissed[-_DISMISS_KEEP:]
    store.set_document(_DISMISS_DOC, state)
    return True


def clear_errors() -> int:
    """清空异常卡片：以当前时间为界隐藏此前的日志，返回剩余可见条数。"""
    store = _store
    if store is None:
        return 0
    store.set_document(_DISMISS_DOC, {"cleared_at": time.time(), "dismissed": []})
    return len(error_stream())
