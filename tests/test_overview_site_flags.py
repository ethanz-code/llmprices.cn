"""站点配置标志：站点综合分「配置完整」一项的输入，逐项应如实反映站点配置。

只测纯函数（不建 app）：create_app 会顺带起调度线程，测试里拉起会按默认项跑真实采集，
污染同批用例（discovery 文档被后台任务覆盖）。
"""
from llm_price_monitor.config import SiteSpec
from llm_price_monitor.webapi.routes.data import site_config_flags


def test_site_config_flags_reflect_config():
    flags = site_config_flags([
        SiteSpec(
            id="full",
            network={"url": "https://full.test/pricing"},
            status={"url": "https://full.test/api/status"},
            notice={"url": "https://full.test/api/notice"},
            networks=({"url": "https://full.test/extra"},),
            token_refresh={"url": "https://full.test/api/refresh"},
            homepage="https://full.test",
        ),
        SiteSpec(id="bare", network={"url": "https://bare.test/pricing"}),
        SiteSpec(id="off", network={"url": "https://off.test/pricing"}, enabled=False),
    ])

    assert flags["full"] == {
        "network": True,
        "status": True,
        "notice": True,
        "networks": True,
        "token_refresh": True,
        "homepage": True,
        "enabled": True,
    }
    assert flags["bare"]["network"] is True
    assert flags["bare"]["status"] is False
    assert flags["bare"]["notice"] is False
    assert flags["bare"]["networks"] is False
    assert flags["bare"]["token_refresh"] is False
    assert flags["bare"]["homepage"] is False
    assert flags["off"]["enabled"] is False
