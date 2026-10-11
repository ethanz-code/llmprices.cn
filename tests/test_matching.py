"""模型名匹配：版本号省略关系的边界与歧义取舍。"""
from llm_price_monitor.matching import canonical_target, resolve_site_names, version_omitted_match


def test_version_omitted_match_accepts_name_without_version():
    """models.dev 的目录 id 是 deepseek-flash，站点接口里叫 deepseek-v4.1-flash。"""
    assert version_omitted_match("deepseek-v4.1-flash", "deepseek-flash")
    assert version_omitted_match("deepseek-flash", "deepseek-v4.1-flash")
    assert version_omitted_match("deepseek-v4-flash-0731", "deepseek-flash")


def test_version_omitted_match_keeps_two_versions_apart():
    """两侧都带版本号就是两个模型，不能互相匹配。"""
    assert not version_omitted_match("deepseek-v4-flash", "deepseek-v4.1-flash")
    assert not version_omitted_match("gpt-5.6-sol", "gpt-5.6-terra")
    assert not version_omitted_match("glm-5.3-flash", "glm-4.7-flash")


def test_version_omitted_match_requires_same_family():
    assert not version_omitted_match("glm-5.3-flash", "deepseek-v4.1-flash")
    assert not version_omitted_match("deepseek-v4-flash-vision-exp", "deepseek-flash")
    assert not version_omitted_match("", "deepseek-flash")


def test_resolve_site_names_prefers_exact_then_claims_once():
    resolved = resolve_site_names(
        ["deepseek-v4-flash"],
        {"deepseek-flash": ("deepseek-flash",), "deepseek-v4-flash": ("deepseek-v4-flash",)},
    )

    assert resolved == {"deepseek-v4-flash": "deepseek-v4-flash"}


def test_resolve_site_names_gives_up_when_two_versions_are_present():
    resolved = resolve_site_names(
        ["deepseek-v4-flash", "deepseek-v4.1-flash"],
        {"deepseek-flash": ("deepseek-flash",)},
    )

    assert resolved == {}


def test_resolve_site_names_uses_ai_alias_before_version_rule():
    """AI 解析出的别名（此处是展示名）优先于版本号省略关系。"""
    resolved = resolve_site_names(
        ["DeepSeek V4.1 Flash"],
        {"deepseek-flash": ("deepseek-flash", "DeepSeek V4.1 Flash")},
    )

    assert resolved == {"deepseek-flash": "DeepSeek V4.1 Flash"}


def test_resolve_site_names_abstains_when_alias_hits_two_site_models():
    """AIHub365 实锤：目标 deepseek-flash 的别名同时命中站上 v4-flash 与 v4.1-flash
    两个模型时，按 payload 顺序挑一个就是把两份价格张冠李戴，必须宁缺勿猜。"""
    resolved = resolve_site_names(
        ["mimo-v2.5", "gpt-image-2", "deepseek-v4-flash", "deepseek-v4.1-flash"],
        {"deepseek-flash": ("deepseek-flash", "deepseek-v4-flash", "deepseek-v4.1-flash")},
    )

    assert resolved == {}


def test_resolve_site_names_alias_single_hit_still_matches():
    """站点只挂一个候选版本时，别名命中照旧采信。"""
    resolved = resolve_site_names(
        ["deepseek-v4.1-flash"],
        {"deepseek-flash": ("deepseek-flash", "deepseek-v4-flash", "deepseek-v4.1-flash")},
    )

    assert resolved == {"deepseek-flash": "deepseek-v4.1-flash"}


def test_resolve_site_names_alias_hits_keep_ambiguous_even_after_exact_claim():
    """专属名被另一目标认领后，多别名目标的剩余唯一命中仍是猜测，不采信。"""
    resolved = resolve_site_names(
        ["deepseek-v4-flash", "deepseek-v4.1-flash"],
        {
            "deepseek-v4-flash": ("deepseek-v4-flash",),
            "deepseek-flash": ("deepseek-flash", "deepseek-v4-flash", "deepseek-v4.1-flash"),
        },
    )

    assert resolved == {"deepseek-v4-flash": "deepseek-v4-flash"}


def test_resolve_site_names_ignores_duplicate_records():
    """同一模型名在响应里重复出现不算多个候选。"""
    resolved = resolve_site_names(
        ["deepseek-v4.1-flash", "DeepSeek-V4.1-Flash"],
        {"deepseek-flash": ("deepseek-flash",)},
    )

    assert resolved == {"deepseek-flash": "deepseek-v4.1-flash"}


def test_canonical_target_maps_separator_free_variants_to_standard_names():
    """站点把分隔符整个去掉的写法（glm5.3 / claudefable51）要归到标准名入库，
    且同名不同型号（flash 后缀）不得被误并。"""
    expected = ["glm-5.3", "glm-5.3-flash", "claude-fable-5", "claude-fable-5-1", "qwen3.8-max"]

    assert canonical_target("glm5.3", expected) == "glm-5.3"
    assert canonical_target("claudefable51", expected) == "claude-fable-5-1"
    assert canonical_target("qwen3.8max", expected) == "qwen3.8-max"
    assert canonical_target("glm53flash", expected) == "glm-5.3-flash"
    # 标准名自身必须原样返回，不能被相似名吞掉
    assert canonical_target("glm-5.3-flash", expected) == "glm-5.3-flash"
    # 完全对不上的名字不硬猜
    assert canonical_target("glm-9.9", expected) is None
