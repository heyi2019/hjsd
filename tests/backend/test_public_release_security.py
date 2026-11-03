"""SECURITY-01 Public-release security boundaries for the API application.

The nginx assertions here are written to catch the *class* of defect rather than
the presence of a string. nginx does not merge ``add_header`` across levels: a
level that declares one stops inheriting from its parent entirely. So a single
``add_header Cache-Control`` inside a location silently removes every security
header declared on the server level for that location's responses. That was a
real, shipped defect — the application HTML (the one document CSP exists to
protect) carried no CSP at all while static assets did.

The fix is a shared snippet that every location declaring ``add_header`` must
include. The tests below fail if a future location forgets to.
"""

import re
from pathlib import Path

from fastapi.testclient import TestClient

from app.api_v1 import create_app
from app.core.settings import Settings


PRODUCTION_SECRET = "production-secret-key-0123456789-abcdef"

SNIPPET_INCLUDE = "include /etc/nginx/snippets/security-headers.conf;"

SECURITY_HEADERS = (
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "Cross-Origin-Resource-Policy",
    "Content-Security-Policy",
)


def _frontend_root() -> Path:
    return Path(__file__).resolve().parents[2] / "frontend"


def _location_blocks(nginx_conf: str) -> list[str]:
    """Split a server block into one chunk per location directive."""
    starts = [match.start() for match in re.finditer(r"(?m)^\s*location\s", nginx_conf)]
    return [
        nginx_conf[start:end]
        for start, end in zip(starts, starts[1:] + [len(nginx_conf)])
    ]


def test_production_hides_interactive_api_documentation():
    app = create_app(Settings(app_env="production", jwt_secret_key=PRODUCTION_SECRET))
    client = TestClient(app)

    assert client.get("/docs").status_code == 404
    assert client.get("/redoc").status_code == 404
    assert client.get("/openapi.json").status_code == 404


def test_development_keeps_interactive_api_documentation_available():
    app = create_app(Settings(app_env="development"))

    assert TestClient(app).get("/docs").status_code == 200


def test_public_nginx_configuration_has_brute_force_and_browser_protections():
    frontend = _frontend_root()
    nginx = (frontend / "nginx.conf").read_text(encoding="utf-8")
    global_nginx = (frontend / "nginx.global.conf").read_text(encoding="utf-8")

    assert "limit_req zone=login" in nginx
    assert 'Cache-Control "no-store"' in nginx
    assert "limit_req_zone" in global_nginx
    assert "limit_conn_zone" in global_nginx
    # 登录限流必须独立于通用 API 限流，否则爆破防护被宽松的 zone 稀释。
    assert "zone=login" in global_nginx and "zone=api" in global_nginx


def test_every_location_declaring_headers_also_includes_the_shared_snippet():
    frontend = _frontend_root()
    nginx = (frontend / "nginx.conf").read_text(encoding="utf-8")
    snippet = (frontend / "security-headers.conf").read_text(encoding="utf-8")

    # 头只在片段里定义一次；nginx.conf 只做 include，避免两处定义漂移。
    for header in SECURITY_HEADERS:
        assert header in snippet, f"{header} 未在 security-headers.conf 中定义"
        assert header not in nginx, (
            f"{header} 不应再出现在 nginx.conf，安全头统一定义在 "
            f"security-headers.conf 中，否则两处会漂移"
        )

    assert SNIPPET_INCLUDE in nginx, "server 块未 include 安全头片段，所有继承路径都会失去安全头"

    offenders = [
        block.splitlines()[0].strip()
        for block in _location_blocks(nginx)
        if "add_header" in block and SNIPPET_INCLUDE not in block
    ]
    assert not offenders, (
        "以下 location 自带 add_header 却未 include 安全头片段。"
        "nginx 的 add_header 一旦在子级出现就停止继承上级，"
        f"这些路径的响应会完全失去安全头：{offenders}"
    )


def test_frontend_image_ships_the_security_header_snippet():
    """片段必须进镜像，否则 include 失败，nginx 直接起不来。"""
    frontend = _frontend_root()
    dockerfile = (frontend / "Dockerfile").read_text(encoding="utf-8")

    assert "COPY frontend/security-headers.conf /etc/nginx/snippets/security-headers.conf" in dockerfile
    assert "/etc/nginx/snippets" in dockerfile, "运行阶段未创建 /etc/nginx/snippets 目录"
    # 片段不能放 conf.d，否则会被 include conf.d/*.conf 当作第二个 server 块加载。
    assert "conf.d/security-headers" not in dockerfile


def test_host_hardening_script_protects_public_ssh_without_blocking_http():
    project_root = Path(__file__).resolve().parents[2]
    script = (project_root / "deploy/scripts/harden_host.sh").read_text(encoding="utf-8")

    assert "authorized_keys" in script
    assert "PasswordAuthentication no" in script
    assert "PermitRootLogin no" in script
    assert "sshd -t" in script
    assert "ufw allow 22/tcp" in script
    assert "ufw allow 80/tcp" in script
    assert "fail2ban" in script
