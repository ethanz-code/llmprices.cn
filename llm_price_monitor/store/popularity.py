"""store/popularity.py：站点人气时序点（popularity_points）——趋势图的数据源。

每个站点每天最多一个点：同一天再采到新值就覆盖当天那个点（一次采集里先拿到旧值、
补采又拿到新值是很常见的，覆盖保证图上留下的是当天最终值）。点里带月访问量与
全网排名两个信号，各自记来源（访问量 SimilarWeb/hypestat、排名 Tranco/SimilarWeb
月度历史），画图时按来源分线，不混源。
"""
from __future__ import annotations

import time
from typing import Any

from .base import StoreBase

# 单站保留的点数上限：一天一点，两年多足够看趋势；超出按时间裁掉最老的
MAX_POINTS_PER_SITE = 800


def popularity_day(captured_at: float) -> str:
    """点的日期键（本地时区 YYYY-MM-DD）：同一天只留一个点，图表刻度也按天对齐。"""
    return time.strftime("%Y-%m-%d", time.localtime(captured_at))


class PopularityStoreMixin(StoreBase):
    # ---------- 人气时序点 ----------

    def append_popularity_points(self, site_id: str, rows: list[dict[str, Any]]) -> int:
        """按天写入人气点（同天覆盖），并裁掉超出保留上限的最老点；返回写入行数。

        rows 每项：{captured_at, visits, visits_source, rank, rank_source}；
        visits/rank 都为空的点直接跳过（没数据可画）。
        """
        prepared: dict[str, tuple[str, float, float | None, str, int | None, str]] = {}
        for row in rows:
            visits = row.get("visits")
            rank = row.get("rank")
            if visits is None and rank is None:
                continue
            at = float(row.get("captured_at") or 0.0)
            if at <= 0:
                continue
            day = popularity_day(at)
            prepared[day] = (
                site_id,
                day,
                at,
                float(visits) if visits is not None else None,
                str(row.get("visits_source") or ""),
                int(rank) if rank is not None else None,
                str(row.get("rank_source") or ""),
            )
        if not prepared:
            return 0
        with self._conn() as conn:
            conn.executemany(
                "INSERT INTO popularity_points (site_id, day, captured_at, visits, visits_source, rank, rank_source)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(site_id, day) DO UPDATE SET"
                " captured_at = excluded.captured_at,"
                # 同天覆盖按字段来：这次没采到的信号保留当天已有的值（别把上午的排名擦掉）
                " visits = COALESCE(excluded.visits, popularity_points.visits),"
                " visits_source = CASE WHEN excluded.visits IS NULL"
                "   THEN popularity_points.visits_source ELSE excluded.visits_source END,"
                " rank = COALESCE(excluded.rank, popularity_points.rank),"
                " rank_source = CASE WHEN excluded.rank IS NULL"
                "   THEN popularity_points.rank_source ELSE excluded.rank_source END",
                list(prepared.values()),
            )
            conn.execute(
                "DELETE FROM popularity_points WHERE site_id = ? AND id NOT IN ("
                " SELECT id FROM popularity_points WHERE site_id = ? ORDER BY captured_at DESC LIMIT ?)",
                (site_id, site_id, MAX_POINTS_PER_SITE),
            )
        return len(prepared)

    def popularity_points(self, site_id: str, *, limit: int = MAX_POINTS_PER_SITE) -> list[dict[str, Any]]:
        """该站点最近的点（时间正序，图表直接用）。"""
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT day, captured_at, visits, visits_source, rank, rank_source FROM popularity_points"
                " WHERE site_id = ? ORDER BY captured_at DESC LIMIT ?",
                (site_id, max(1, int(limit))),
            ).fetchall()
        return [
            {
                "day": row["day"],
                "at": row["captured_at"],
                "visits": row["visits"],
                "visits_source": row["visits_source"],
                "rank": row["rank"],
                "rank_source": row["rank_source"],
            }
            for row in reversed(rows)
        ]

    def prune_popularity_points(self, before_ts: float) -> int:
        """过期人气点清理（按保留天数淘汰），返回删除行数。"""
        with self._conn() as conn:
            cursor = conn.execute("DELETE FROM popularity_points WHERE captured_at < ?", (before_ts,))
        return int(cursor.rowcount)
