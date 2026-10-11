"""浏览器 User-Agent：采集请求统一一份现代 Chrome UA。

UA 单值即可满足需要——认真做反爬的站点看的是 TLS 指纹而非 UA 头，
单头轮换防不住；需要临时换 UA 时用设置里的 user_agent 整体覆盖。
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from llm_price_monitor.config import MonitorConfig

DEFAULT_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
)


def choose_user_agent(config: "MonitorConfig", override: str | None = None) -> str:
    """本次运行使用的 UA：显式 override 优先，否则统一用设置里的 user_agent。"""
    return override or config.settings.user_agent
