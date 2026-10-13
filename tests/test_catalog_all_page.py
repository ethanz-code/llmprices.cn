"""全量渠道价目录的浏览分页：排序/筛选/分页口径，以及 /api/catalog/all 的接口契约。

这份目录 8000+ 条、整份约 8 MB，原先整份下发给浏览器排序筛选；分页后接口只回当前页，
所以排序口径必须由后端自己保证稳定，这里把它钉住。
"""
import json
import re
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from llm_price_monitor.catalog.all_page import (
    DEFAULT_PAGE_SIZE,
    PAGE_SIZE_MAX,
    VENDOR_DISPLAY,
    filter_entries,
    found_entries,
    ordered_vendors,
    page_catalog_all,
    sort_entries,
    vendor_display,
)
from llm_price_monitor.webapi.app import create_app

FRONTEND_VENDOR_NAMES = Path(__file__).resolve().parent.parent / "web" / "lib" / "vendorNames.ts"


def _entry(model: str, vendor: str, release: str | None = None, found: bool = True) -> dict:
    return {"found": found, "model": model, "name": model, "vendor": vendor, "release_date": release}


def _doc(models: dict) -> dict:
    return {
        "generated_at": 1.0,
        "generated_at_iso": "2026-10-13T10:00:00+0800",
        "source": "models.dev",
        "source_url": "https://models.dev",
        "usd_cny_rate": 6.71,
        "rate_source": "测试",
        "providers": [{"id": "zhipuai", "name": "Zhipu AI"}],
        "models": models,
    }


def _order(entries: list[tuple[str, dict]]) -> list[str]:
    return [str(entry["model"]) for _, entry in sort_entries(entries)]


# ---------- 排序口径 ----------


def test_vendor_display_matches_frontend_map():
    """后端搜索要用厂商中文别名，映射必须与前端 web/lib/vendorNames.ts 逐条一致。"""
    source = FRONTEND_VENDOR_NAMES.read_text(encoding="utf-8")
    block = re.search(r"VENDOR_DISPLAY: Record<string, string> = \{(.*?)\n\};", source, re.S)
    assert block, "前端 vendorNames.ts 里找不到 VENDOR_DISPLAY"
    # 前端那张表里带空格的键才加引号（baichuan 这类裸键），两种写法都要认
    pairs = re.findall(r'([A-Za-z0-9.\-]+|"[^"]*")\s*:\s*"([^"]+)"', block.group(1))
    frontend = {key.strip('"').strip(): value for key, value in pairs}
    assert frontend == VENDOR_DISPLAY


def test_vendor_display_falls_back_to_raw_name():
    assert vendor_display("Tencent") == "腾讯混元"
    assert vendor_display("  tencent ") == "腾讯混元"
    assert vendor_display("OpenAI") == "OpenAI"


def test_ordered_vendors_by_latest_release_then_name():
    """厂商块按各家最新发布日期倒序；并列按厂商名；没有发布日期的厂商照样成块排在最后。"""
    models = {
        "a": _entry("old-model", "Alpha", "2025-01-01"),
        "b": _entry("new-model", "Beta", "2026-09-01"),
        "c": _entry("mid-model", "Gamma", "2026-05-01"),
        "d": _entry("no-date", "Delta", None),
        "e": _entry("no-date-2", "Echo", None),
    }
    assert ordered_vendors(found_entries(models)) == ["Beta", "Gamma", "Alpha", "Delta", "Echo"]


def test_sort_entries_vendor_block_then_release_desc_then_name():
    models = {
        "a": _entry("bbb", "Alpha", "2026-01-01"),
        "b": _entry("aaa", "Alpha", "2026-01-01"),
        "c": _entry("ccc", "Alpha", "2026-02-01"),
        "d": _entry("zzz", "Beta", "2026-03-01"),
        "e": _entry("nodate", "Alpha", None),
    }
    # Beta 家最新发布更晚，整块在前；Alpha 块内先按发布日期倒序，同日按模型名，没日期的垫底
    assert _order(found_entries(models)) == ["zzz", "ccc", "aaa", "bbb", "nodate"]


def test_sort_entries_tie_break_matches_browser_collation():
    """同日并列的次序：小写在前（浏览器 localeCompare 口径）、标点排在字母数字之前。"""
    models = {
        "a": _entry("NanoGPT", "Alpha", "2026-01-01"),
        "b": _entry("nanogpt", "Alpha", "2026-01-01"),
        "c": _entry("~openai/gpt-sol-latest", "Alpha", "2026-01-01"),
        "d": _entry("sakana/fugu-max", "Alpha", "2026-01-01"),
    }
    assert _order(found_entries(models)) == [
        "~openai/gpt-sol-latest",
        "nanogpt",
        "NanoGPT",
        "sakana/fugu-max",
    ]


def test_found_entries_skips_unpriced_and_broken_rows():
    models = {
        "a": _entry("priced", "Alpha"),
        "b": _entry("unpriced", "Alpha", found=False),
        "c": "不是字典",
    }
    assert [key for key, _ in found_entries(models)] == ["a"]


# ---------- 筛选 ----------


def test_filter_entries_vendor_exact_and_keyword_loose():
    models = {
        "a": _entry("glm-5.3", "Zhipu AI"),
        "b": _entry("GLM-5.3-Flash", "Zhipu AI"),
        "c": _entry("gpt-5.6-sol", "OpenAI"),
    }
    entries = found_entries(models)
    # 厂商下拉给的是原始厂商名，精确匹配
    assert [key for key, _ in filter_entries(entries, vendor="Zhipu AI")] == ["a", "b"]
    # 关键词去分隔符后比较：GLM5.3 能命中 GLM-5.3
    assert [key for key, _ in filter_entries(entries, q="GLM5.3")] == ["a", "b"]
    assert [key for key, _ in filter_entries(entries, q="gpt56sol")] == ["c"]
    assert filter_entries(entries, q="查不到的东西") == []


def test_filter_entries_keyword_hits_vendor_display_name():
    """搜索在服务端做，中文别名（"腾讯"）也得命中，否则中文用户搜不到。"""
    models = {"a": _entry("hunyuan-t1", "Tencent"), "b": _entry("gpt-5.6-sol", "OpenAI")}
    assert [key for key, _ in filter_entries(found_entries(models), q="腾讯")] == ["a"]


# ---------- 分页 ----------


def test_page_catalog_all_counts_and_slicing():
    models = {str(i): _entry(f"m{i}", "Alpha", "2026-01-01") for i in range(5)}
    models.update({"x": _entry("unpriced", "Alpha", found=False)})
    page = page_catalog_all(_doc(models), limit=2, offset=2)
    # 不带价的条目不进总数
    assert page["total"] == 5 and page["filtered_total"] == 5
    assert len(page["models"]) == 2
    assert page["models"]["2"]["model"] == "m2"
    # 元信息带上，providers 这类浏览用不到的大字段不下发
    assert page["usd_cny_rate"] == 6.71 and page["source"] == "models.dev"
    assert "providers" not in page


def test_page_catalog_all_limit_zero_returns_counts_only():
    models = {str(i): _entry(f"m{i}", "Alpha", "2026-01-01") for i in range(3)}
    page = page_catalog_all(_doc(models), limit=0)
    assert page["models"] == {} and page["filtered_total"] == 3
    assert page["vendors"] == ["Alpha"]


def test_page_catalog_all_clamps_limit_and_offset():
    models = {str(i): _entry(f"m{i}", "Alpha", "2026-01-01") for i in range(5)}
    assert len(page_catalog_all(_doc(models), limit=9999)["models"]) == 5
    assert page_catalog_all(_doc(models), limit=PAGE_SIZE_MAX + 100)["filtered_total"] == 5
    assert page_catalog_all(_doc(models), limit=100, offset=-3)["models"]["0"]["model"] == "m0"


def test_page_catalog_all_filter_narrows_but_keeps_vendor_list():
    models = {
        "a": _entry("glm-5.3", "Zhipu AI", "2026-01-01"),
        "b": _entry("gpt-5.6-sol", "OpenAI", "2026-02-01"),
    }
    page = page_catalog_all(_doc(models), q="glm", limit=10)
    assert page["total"] == 2 and page["filtered_total"] == 1
    assert list(page["models"]) == ["a"]
    # 厂商下拉不能被筛选带着走，否则切不回别的厂商
    assert page["vendors"] == ["OpenAI", "Zhipu AI"]


# ---------- 列排序 ----------


def _priced(model: str, vendor: str, input_price: float | None, context: int | None) -> dict:
    entry = _entry(model, vendor, "2026-01-01")
    entry["list"] = {} if input_price is None else {"input": input_price}
    entry["limit"] = {} if context is None else {"context": context}
    return entry


def _sorted_models(sort: str, direction: str = "ascend") -> list[str]:
    models = {
        "a": _priced("m-a", "Alpha", 5.0, 200),
        "b": _priced("m-b", "Alpha", 1.0, 100),
        "c": _priced("m-c", "Alpha", None, None),
        "d": _priced("m-d", "Beta", 3.0, 300),
    }
    page = page_catalog_all(_doc(models), limit=10, sort=sort, direction=direction)
    return [entry["model"] for entry in page["models"].values()]


def test_sort_by_column_ascending_and_descending():
    # 价格升序：缺价的按 0 排最前（与前端列 sorter 的 `?? 0` 同口径）
    assert _sorted_models("list") == ["m-c", "m-b", "m-d", "m-a"]
    assert _sorted_models("list", "descend") == ["m-a", "m-d", "m-b", "m-c"]
    assert _sorted_models("limit") == ["m-c", "m-b", "m-a", "m-d"]
    assert _sorted_models("limit", "descend") == ["m-d", "m-a", "m-b", "m-c"]


def test_sort_by_release_date_and_unknown_key_keeps_directory_order():
    models = {
        "a": _entry("old", "Alpha", "2025-01-01"),
        "b": _entry("new", "Beta", "2026-05-01"),
        "c": _entry("nodate", "Alpha", None),
    }
    page = page_catalog_all(_doc(models), limit=10, sort="release_date")
    assert [e["model"] for e in page["models"].values()] == ["nodate", "old", "new"]
    # 白名单外的键当没传：仍是目录口径（厂商块 + 发布日期倒序）
    page = page_catalog_all(_doc(models), limit=10, sort="description_zh")
    assert [e["model"] for e in page["models"].values()] == ["new", "old", "nodate"]


def test_sort_keeps_directory_order_for_ties():
    """价格并列时保持目录口径的行序（厂商块 + 发布日期倒序），不被排序键搅乱。"""
    models = {
        "a": _priced("m-a", "Alpha", 2.0, 100),
        "b": _priced("m-b", "Beta", 2.0, 100),
        "c": _priced("m-c", "Alpha", 2.0, 100),
    }
    page = page_catalog_all(_doc(models), limit=10, sort="list")
    assert [e["model"] for e in page["models"].values()] == ["m-a", "m-c", "m-b"]


# ---------- 接口契约 ----------


@pytest.fixture
def client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "var").mkdir()
    (tmp_path / "var" / "latest.json").write_text("{}", encoding="utf-8")
    (tmp_path / "var" / "history.jsonl").write_text("", encoding="utf-8")
    (tmp_path / "var" / "catalog.json").write_text(
        json.dumps({"generated_at": time.time(), "models": {}}), encoding="utf-8"
    )
    config = tmp_path / "config.json"
    config.write_text(
        json.dumps(
            {
                "settings": {
                    "history_file": str(tmp_path / "var" / "history.jsonl"),
                    "latest_file": str(tmp_path / "var" / "latest.json"),
                    "event_file": str(tmp_path / "var" / "events.jsonl"),
                    "schedule": {"price": 0, "status": 0, "notice": 0, "catalog": 0, "rankings": 0, "discovery": 0},
                    "monitor_models": [],
                },
                "ai": {},
                "sites": [],
            }
        ),
        encoding="utf-8",
    )
    return TestClient(create_app(config))


def _seed(client: TestClient, models: dict) -> None:
    client.app.state.store.set_document("catalog_all", _doc(models))


def test_catalog_all_404_when_missing(client: TestClient):
    assert client.get("/api/catalog/all").status_code == 404
    assert client.get("/api/catalog/all", params={"limit": 20}).status_code == 404


def test_catalog_all_without_params_keeps_full_document(client: TestClient):
    """不带参数的老调用方拿到的仍是整份文档（含 providers），行为不变。"""
    _seed(client, {"a": _entry("glm-5.3", "Zhipu AI", "2026-01-01")})
    body = client.get("/api/catalog/all").json()
    assert body["providers"] == [{"id": "zhipuai", "name": "Zhipu AI"}]
    assert list(body["models"]) == ["a"]
    assert "total" not in body


def test_catalog_all_paged_response(client: TestClient):
    models = {str(i): _entry(f"m{i}", "Alpha", f"2026-01-0{i + 1}") for i in range(5)}
    models["z"] = _entry("glm-5.3", "Zhipu AI", "2026-02-01")
    _seed(client, models)

    page = client.get("/api/catalog/all", params={"limit": 2}).json()
    assert page["total"] == 6 and page["filtered_total"] == 6 and len(page["models"]) == 2
    assert page["vendors"] == ["Zhipu AI", "Alpha"]
    assert "providers" not in page
    # 第二页接着第一页，不重不漏
    second = client.get("/api/catalog/all", params={"limit": 2, "offset": 2}).json()
    assert list(page["models"]) == ["z", "4"]
    assert list(second["models"]) == ["3", "2"]

    # 计数模式：只要数字不要行
    counts = client.get("/api/catalog/all", params={"limit": 0}).json()
    assert counts["models"] == {} and counts["filtered_total"] == 6

    # 厂商筛选走原始名；关键词走归一（含中文别名）
    by_vendor = client.get("/api/catalog/all", params={"limit": 10, "vendor": "Zhipu AI"}).json()
    assert list(by_vendor["models"]) == ["z"] and by_vendor["filtered_total"] == 1
    assert list(client.get("/api/catalog/all", params={"limit": 10, "q": "智谱"}).json()["models"]) == ["z"]
    assert client.get("/api/catalog/all", params={"limit": 10}).json()["filtered_total"] == 6


def test_catalog_all_default_page_size(client: TestClient):
    """只给关键词不给 limit 时按默认页大小截断，不会又整份下发。"""
    models = {str(i): _entry(f"m{i}", "Alpha", f"2026-01-01") for i in range(DEFAULT_PAGE_SIZE + 5)}
    _seed(client, models)
    page = client.get("/api/catalog/all", params={"q": "m"}).json()
    assert len(page["models"]) == DEFAULT_PAGE_SIZE and page["filtered_total"] == DEFAULT_PAGE_SIZE + 5


def test_catalog_all_sort_param(client: TestClient):
    """列排序在服务端做：分页后前端只能排当页，排序键必须下推。"""
    models = {
        "a": {**_entry("cheap", "Alpha", "2026-01-01"), "list": {"input": 1.0}},
        "b": {**_entry("pricey", "Alpha", "2026-01-02"), "list": {"input": 9.0}},
    }
    _seed(client, models)
    rows = client.get("/api/catalog/all", params={"limit": 10, "sort": "list", "dir": "descend"}).json()["models"]
    assert [entry["model"] for entry in rows.values()] == ["pricey", "cheap"]
