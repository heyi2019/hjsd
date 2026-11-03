"""CONFIG-01 T01 / SYS-01-01：配置必须来自**根目录 .env**，且不得指向旧库。"""
from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api_v1 import create_app
from app.core.settings import (
    PROJECT_ROOT,
    Settings,
    get_settings,
    locate_env_file,
)

SECURE_TEST_SECRET = "test-production-secret-0123456789-abcdef"


def test_default_application_version_is_semver_without_release_prefix():
    """API 对外使用 SemVer；V 前缀只属于系统发布标签。

    版本号的唯一事实源是 `app/version.py`：这里断言"配置默认值 == 事实源"，
    再校验格式。发版只改 version.py，本测试无需跟着改，但能挡住手滑写坏。
    """
    from app.version import __version__ as release_version

    assert Settings().app_version == release_version
    assert re.fullmatch(r"\d+\.\d+\.\d+", release_version), "必须是 x.y.z 形式，且不带 v 前缀"


def test_frontend_version_matches_backend_release_version():
    """前后端版本必须同源，否则线上无法判断前端跑的是哪份代码。

    典型漂移：只改 `backend/app/version.py` 就发版 → 前端包版本仍是旧的，
    页面/构建产物与 `/health` 报的版本号打架。发版请走
    `scripts/ops/bump_version.sh`，它一次改齐三处（version.py / package.json /
    package-lock.json），本断言是事后兜底。
    """
    import json

    from app.version import __version__ as release_version

    pkg_path = PROJECT_ROOT / "frontend" / "package.json"
    lock_path = PROJECT_ROOT / "frontend" / "package-lock.json"
    assert pkg_path.is_file(), f"缺少前端 package.json：{pkg_path}"

    pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
    assert pkg["version"] == release_version, (
        f"frontend/package.json={pkg['version']} 与 backend/app/version.py="
        f"{release_version} 不一致，请运行 scripts/ops/bump_version.sh"
    )

    if lock_path.is_file():
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
        assert lock["version"] == release_version, "package-lock.json 顶层版本未同步"
        assert lock["packages"][""]["version"] == release_version, (
            "package-lock.json 根包版本未同步"
        )


def _release_sections(text: str) -> dict[str, str]:
    """把 RELEASE.md 切成 {版本: 章节正文}，正文不含标题行本身。

    只认 `## V1.2.3` / `## V1.2.3（说明）` 这种形态；`## 发版流程` 之类不带
    版本号的一级标题自然被跳过——它们不是发布记录。
    """
    sections: dict[str, str] = {}
    current: str | None = None
    buffer: list[str] = []

    for line in text.splitlines():
        match = re.match(r"^##\s+V?(\d+\.\d+\.\d+)", line)
        if match:
            if current is not None:
                sections[current] = "\n".join(buffer)
            current = match.group(1)
            buffer = []
            continue
        if line.startswith("## "):
            if current is not None:
                sections[current] = "\n".join(buffer)
            current = None
            buffer = []
            continue
        if current is not None:
            buffer.append(line)

    if current is not None:
        sections[current] = "\n".join(buffer)
    return sections


def test_release_notes_has_section_for_current_version():
    """升了版本却没写 RELEASE.md = 更新日志断档，且此前无人会发现。

    实测缺口：`bump_version.sh` 明写「不写 RELEASE.md」，CI 只打 tag 不生成
    release notes，全仓库无任何断言检查章节是否存在。于是发版脚本可以一路
    绿灯（升版本 → 打 tag → 部署成功），RELEASE.md 里却没有这一版。
    本测试就是那道兜底：版本号涨了、章节没跟上 → 直接红。
    """
    from app.version import __version__ as release_version

    release_path = PROJECT_ROOT / "RELEASE.md"
    assert release_path.is_file(), f"缺少发布记录：{release_path}"

    sections = _release_sections(release_path.read_text(encoding="utf-8"))
    assert sections, "RELEASE.md 里一个 `## Vx.y.z` 发布章节都没有，格式可能被改坏"

    assert release_version in sections, (
        f"RELEASE.md 缺少当前版本 V{release_version} 的章节"
        f"（现有：{', '.join('V' + v for v in sections)}）。\n"
        f"发版请依次执行：\n"
        f"  1) scripts/ops/bump_version.sh {release_version}   # 改齐三处版本\n"
        f"  2) scripts/ops/changelog.sh --write                # 生成章节草稿并插入\n"
        f"  3) 人工补业务口径与「发布前检查 / 回滚」两节"
    )

    body = sections[release_version]
    for required in ("发布时间", "本次内容"):
        assert required in body, (
            f"V{release_version} 章节缺少「{required}」。"
            "空章节等于没写——它挡不住「这版到底改了什么」这个问题"
        )


def test_env_file_is_project_root_dotenv():
    """本地开发与联调指南 §1：必须读根目录 .env，而不是 backend/.env。"""
    path = locate_env_file()
    assert path is not None, "根目录缺少 .env，请从 .env.example 复制后替换 JWT 密钥"
    assert path.parent == PROJECT_ROOT
    assert path.name == ".env"


def test_settings_loads_from_root_env():
    settings = get_settings()
    assert settings.env_file_path is not None
    assert settings.env_file_path.parent == PROJECT_ROOT
    assert settings.api_prefix == "/api/v1"
    assert settings.access_token_expire_minutes >= 1


def test_default_database_is_postgres():
    """SQLite 已彻底下线：缺 .env 时的兜底地址也必须是 PG。

    以前兜底是某个本地文件库地址——连不上库时会静默新建一个本地文件，
    数据写进没人知道的地方。现在宁可连不上明确报错。
    """
    settings = Settings(_env_file=None)
    assert settings.database_url.startswith("postgresql")
    assert settings.database_url.endswith("/heijin_erp_dev")


def test_alembic_url_equals_database_url():
    """PG 下不需要再拼绝对路径，engine 与 alembic 共用同一串。"""
    settings = Settings(database_url="postgresql+psycopg://u:p@127.0.0.1:5432/x")
    assert settings.alembic_url == settings.database_url


def test_sqlite_is_no_longer_supported():
    """残留的 SQLite 配置不再有专属处理路径：没有 sqlite_file / sqlalchemy_url。"""
    settings = Settings(database_url="sqlite:///./data/probe.db", _env_file=None)
    assert not hasattr(settings, "sqlite_file")
    assert not hasattr(settings, "sqlalchemy_url")


def test_describe_does_not_leak_secret():
    payload = get_settings().describe()
    assert isinstance(payload, dict)
    for key, value in payload.items():
        assert "secret" not in key.lower()
        assert isinstance(value, str)


def test_describe_redacts_database_password():
    """连接串里的口令绝不能出现在健康检查/日志里（describe 会被原样输出）。"""
    settings = Settings(
        database_url="postgresql+psycopg://erp_app:s3cr3t@db.internal:5432/heijin_erp"
    )
    payload = settings.describe()
    assert payload["database"] == "postgresql://db.internal:5432/heijin_erp"
    assert "s3cr3t" not in str(payload)


# --- CORS：dev 端口通配 ---------------------------------------------------
# 背景（实测事故）：前端换到 5199 端口后，CORS 预检返回 400，
# axios 全部 Failed to fetch，但页面**不报错**，只静默显示
# 「资金池数量 0 / 尚未配置资金池」，与「真的没有数据」无法区分。


def test_dev_allows_any_local_port():
    """development 下必须放行本机任意端口，避免换端口即静默失败。"""
    settings = Settings(app_env="development")
    assert settings.cors_origin_regex is not None
    assert "localhost" in settings.cors_origin_regex
    assert "127" in settings.cors_origin_regex


def test_dev_cors_middleware_accepts_frontend_port():
    settings = Settings(
        app_env="development",
        database_url="postgresql+psycopg://erp_app@127.0.0.1:5432/heijin_erp_test",
    )
    response = TestClient(create_app(settings)).options(
        "/api/v1/orders",
        headers={
            "Origin": "http://127.0.0.1:5188",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5188"


def test_production_never_widens_cors():
    """生产环境必须收紧：端口通配一律失效，且不得回落成 *。"""
    for env in ("production", "staging", "prod"):
        settings = Settings(app_env=env, jwt_secret_key=SECURE_TEST_SECRET)
        assert settings.cors_origin_regex is None, f"{env} 不应放宽 CORS"
        assert "*" not in settings.cors_origin_list


def test_production_rejects_default_jwt_secret():
    with pytest.raises(ValidationError) as exc:
        Settings(
            app_env="production",
            jwt_secret_key="dev-insecure-secret-not-for-production-use!!",
        )
    assert "JWT" in str(exc.value)


def test_production_rejects_wildcard_cors():
    with pytest.raises(ValidationError) as exc:
        Settings(
            app_env="production",
            jwt_secret_key=SECURE_TEST_SECRET,
            cors_origins="*",
        )
    assert "CORS" in str(exc.value)


def test_cors_origin_list_still_parses_env():
    """显式白名单仍走环境变量，不因通配而失效。"""
    settings = Settings(cors_origins="http://a.test, http://b.test ,")
    assert settings.cors_origin_list == ["http://a.test", "http://b.test"]


def test_dev_wildcard_can_be_disabled():
    """显式关闭开关后立即收紧，便于生产或收紧策略。"""
    settings = Settings(app_env="development", cors_dev_allow_any_local_port=False)
    assert settings.cors_origin_regex is None


class TestLoginRateLimitKnob:
    """登录限流次数：负值必须炸，否则窗口计数永远打不满、限流形同关闭。"""

    def test_default_is_positive(self):
        assert Settings().login_rate_limit_per_minute >= 1

    def test_negative_is_rejected(self):
        with pytest.raises(ValidationError):
            Settings(login_rate_limit_per_minute=-1)



class TestTestDatabaseSeparation:
    """测试库必须与开发库分开配置：曾因回落 DATABASE_URL 把开发库 118 单清空。"""

    def test_test_database_url_defaults_to_empty(self):
        """缺省为空表示「未单独配置」，夹具据此拒绝运行，不猜一个库去清空。"""
        # 必须显式屏蔽 .env：本机 .env 已配了 TEST_DATABASE_URL，否则测的是环境而非缺省值
        assert Settings(_env_file=None).test_database_url == ""

    def test_test_database_url_is_independent_of_database_url(self):
        settings = Settings(
            database_url="postgresql+psycopg://u:p@127.0.0.1:5432/heijin_erp_dev",
            test_database_url="postgresql+psycopg://u:p@127.0.0.1:5432/heijin_erp_test",
        )
        assert settings.test_database_url.endswith("/heijin_erp_test")
        assert settings.database_url.endswith("/heijin_erp_dev")

    def test_env_file_value_is_loaded(self, monkeypatch, tmp_path):
        """`.env` 里的 TEST_DATABASE_URL 必须真的被读进来，而不是只认环境变量。"""
        env_file = tmp_path / ".env"
        env_file.write_text(
            "DATABASE_URL=postgresql+psycopg://u:p@127.0.0.1:5432/heijin_erp_dev\n"
            "TEST_DATABASE_URL=postgresql+psycopg://u:p@127.0.0.1:5432/heijin_erp_test\n",
            encoding="utf-8",
        )
        monkeypatch.delenv("TEST_DATABASE_URL", raising=False)
        settings = Settings(_env_file=env_file)
        assert settings.test_database_url.endswith("/heijin_erp_test")
        assert settings.database_url.endswith("/heijin_erp_dev")
