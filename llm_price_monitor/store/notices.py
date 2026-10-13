"""store/notices.py：站点公告版本时序（notice_records / notice_events）。"""
from __future__ import annotations

import json
from typing import Any

from .base import StoreBase, _dumps


class NoticeStoreMixin(StoreBase):
    # ---------- 站点公告版本与变化事件 ----------

    def append_notice_records(self, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        with self._conn() as conn:
            conn.executemany(
                "INSERT INTO notice_records (site_id, captured_at, payload) VALUES (?, ?, ?)",
                [
                    (str(row.get("site_id") or ""), float(row.get("captured_at") or 0.0), _dumps(row))
                    for row in rows
                ],
            )

    def read_notice(self, *, limit: int = 200, site_id: str | None = None) -> tuple[list[dict[str, Any]], int]:
        return self._read_rows(
            "notice_records", limit=limit, site_id=site_id, kind=None, kind_column="kind", payload_column="payload"
        )

    def latest_notice(self, site_id: str) -> dict[str, Any] | None:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT payload FROM notice_records WHERE site_id = ? ORDER BY id DESC LIMIT 1", (site_id,)
            ).fetchone()
        return json.loads(row["payload"]) if row else None

    def append_notice_events(self, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        with self._conn() as conn:
            conn.executemany(
                "INSERT INTO notice_events (site_id, kind, detected_at, payload) VALUES (?, ?, ?, ?)",
                [
                    (
                        str(row.get("site_id") or ""),
                        str(row.get("kind") or ""),
                        float(row.get("detected_at") or 0.0),
                        _dumps(row),
                    )
                    for row in rows
                ],
            )

    def read_notice_events(
        self, *, limit: int = 200, site_id: str | None = None, kind: str | None = None, since: float | None = None
    ) -> tuple[list[dict[str, Any]], int]:
        return self._read_rows(
            "notice_events",
            limit=limit,
            site_id=site_id,
            kind=kind,
            kind_column="kind",
            payload_column="payload",
            since=since,
            since_column="detected_at",
        )

    def notice_event_content(self, *, site_id: str, detected_at: float) -> str | None:
        """单条公告事件的正文：事件流不再下发正文，详情弹窗按需来这里取。

        事件流条目只带 site_id/detected_at/kind，没有表主键，所以按站点 + 检出时间定位。
        时间戳是同一份浮点值经 JSON 往返（Python json.dumps ↔ JS Number）传回来的，
        留 1 毫秒容差防序列化末位误差；同站点不同事件的间隔远大于此。
        """
        with self._conn() as conn:
            row = conn.execute(
                "SELECT payload FROM notice_events WHERE site_id = ? AND ABS(detected_at - ?) < 0.001 ORDER BY id DESC LIMIT 1",
                (site_id, detected_at),
            ).fetchone()
        if row is None:
            return None
        content = json.loads(row["payload"]).get("content")
        return str(content) if content is not None else None
