"""store/sites.py：站点配置与 AI 助手配额计数。"""
from __future__ import annotations

import json
from typing import Any

from .base import StoreBase, _dumps
from .schema import latest_site_prefix


class SiteStoreMixin(StoreBase):
    # ---------- 站点配置 ----------

    def count_sites(self) -> int:
        with self._conn() as conn:
            return int(conn.execute("SELECT COUNT(*) FROM sites").fetchone()[0])

    def list_site_configs(self) -> list[dict[str, Any]]:
        with self._conn() as conn:
            rows = conn.execute("SELECT config FROM sites ORDER BY seq, id").fetchall()
        return [json.loads(row["config"]) for row in rows]

    def get_site_config(self, site_id: str) -> dict[str, Any] | None:
        with self._conn() as conn:
            row = conn.execute("SELECT config FROM sites WHERE id = ?", (site_id,)).fetchone()
        return json.loads(row["config"]) if row else None

    def upsert_site(self, site_id: str, config: dict[str, Any]) -> None:
        with self._conn() as conn:
            exists = conn.execute("SELECT 1 FROM sites WHERE id = ?", (site_id,)).fetchone()
            if exists:
                conn.execute("UPDATE sites SET config = ? WHERE id = ?", (_dumps(config), site_id))
            else:
                seq = int(conn.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM sites").fetchone()[0])
                conn.execute(
                    "INSERT INTO sites (id, seq, config) VALUES (?, ?, ?)", (site_id, seq, _dumps(config))
                )

    def delete_site(self, site_id: str, *, purge: bool = False) -> bool:
        """删除站点配置；purge 为真时一并清理该站点的历史价格、事件、状态、公告时序与最新快照。"""
        with self._conn() as conn:
            cursor = conn.execute("DELETE FROM sites WHERE id = ?", (site_id,))
            deleted = cursor.rowcount > 0
            if purge and deleted:
                for table in ("price_trend", "price_events", "status_records", "status_events", "notice_records", "notice_events"):
                    conn.execute(f"DELETE FROM {table} WHERE site_id = ?", (site_id,))
                # 用站点前缀精确匹配避免 LIKE 通配符歧义（key 格式见 latest_key）
                prefix = latest_site_prefix(site_id)
                conn.execute("DELETE FROM latest WHERE substr(key, 1, ?) = ?", (len(prefix), prefix))
                conn.execute("DELETE FROM documents WHERE name = ?", (f"status_ref:{site_id}",))
                # collect_status 与 site_collect_health 都是 site_id → 状态 的文档，删站点时同步移除
                for doc_name in ("collect_status", "site_collect_health", "site_popularity"):
                    row = conn.execute("SELECT content FROM documents WHERE name = ?", (doc_name,)).fetchone()
                    if row:
                        merged = {k: v for k, v in (json.loads(row[0]) or {}).items() if k != site_id}
                        conn.execute(
                            "UPDATE documents SET content = ? WHERE name = ?",
                            (json.dumps(merged, ensure_ascii=False), doc_name),
                        )
        return deleted

    def rename_site(self, old_id: str, new_id: str) -> bool:
        """站点 id 变更时，把旧 id 名下的全部数据迁移到新 id，保持历史完整。"""
        with self._conn() as conn:
            cursor = conn.execute("UPDATE sites SET id = ? WHERE id = ?", (new_id, old_id))
            renamed = cursor.rowcount > 0
            if renamed:
                for table in ("price_trend", "price_events", "status_records", "status_events", "notice_records", "notice_events"):
                    conn.execute(f"UPDATE {table} SET site_id = ? WHERE site_id = ?", (new_id, old_id))
                old_prefix = latest_site_prefix(old_id)
                conn.execute(
                    "UPDATE latest SET key = ? || substr(key, ?) WHERE substr(key, 1, ?) = ?",
                    (new_id, len(old_prefix) + 1, len(old_prefix), old_prefix),
                )
                conn.execute("UPDATE documents SET name = ? WHERE name = ?", (f"status_ref:{new_id}", f"status_ref:{old_id}"))
                # collect_status 与 site_collect_health 都是 site_id → 状态 的文档，改名同步搬迁（与 delete_site 对齐）
                for doc_name in ("collect_status", "site_collect_health", "site_screenshots", "site_popularity"):
                    row = conn.execute("SELECT content FROM documents WHERE name = ?", (doc_name,)).fetchone()
                    if row:
                        merged = json.loads(row[0]) or {}
                        if old_id in merged:
                            merged[new_id] = merged.pop(old_id)
                            conn.execute(
                                "UPDATE documents SET content = ? WHERE name = ?",
                                (json.dumps(merged, ensure_ascii=False), doc_name),
                            )
        if renamed:
            # 截图文件按站点 id 命名，改名后图片跟着走，否则详情页按新 id 找不到图
            from llm_price_monitor.screenshot import screenshot_path

            try:
                old_path, new_path = screenshot_path(old_id), screenshot_path(new_id)
            except Exception:
                return renamed  # id 不合法时本来就没有对应文件
            if old_path.is_file():
                new_path.parent.mkdir(parents=True, exist_ok=True)
                old_path.replace(new_path)
        return renamed

    def replace_sites(self, configs: list[dict[str, Any]]) -> None:
        """种子导入：整体替换站点表，seq 按数组顺序。"""
        with self._conn() as conn:
            conn.execute("DELETE FROM sites")
            for seq, config in enumerate(configs, start=1):
                site_id = str(config.get("id") or f"site-{seq}")
                conn.execute(
                    "INSERT OR REPLACE INTO sites (id, seq, config) VALUES (?, ?, ?)",
                    (site_id, seq, _dumps(config)),
                )

    # ---------- AI 助手配额（SQLite 计数：重启不丢、并发不互相覆盖） ----------

    def quota_used(self, ip: str, day: str) -> int:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT count FROM assistant_usage WHERE ip = ? AND day = ?", (ip, day)
            ).fetchone()
        return int(row["count"]) if row else 0

    def record_quota(self, ip: str, day: str) -> None:
        """计数 +1；顺带清理历史日期的行，避免表随天数无限增长。"""
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO assistant_usage (ip, day, count) VALUES (?, ?, 1)"
                " ON CONFLICT(ip, day) DO UPDATE SET count = count + 1",
                (ip, day),
            )
            conn.execute("DELETE FROM assistant_usage WHERE day < ?", (day,))
