"""Public-release security boundaries for the API application."""

from fastapi.testclient import TestClient
from pathlib import Path

from app.api_v1 import create_app
from app.core.settings import Settings


PRODUCTION_SECRET = "production-secret-key-0123456789-abcdef"


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
    project_root = Path(__file__).resolve().parents[3]
    nginx = (project_root / "frontend/nginx.conf").read_text(encoding="utf-8")
    global_nginx = (project_root / "frontend/nginx.global.conf").read_text(encoding="utf-8")

    assert "limit_req zone=login" in nginx
    assert "X-Content-Type-Options" in nginx
    assert "X-Frame-Options" in nginx
    assert "Content-Security-Policy" in nginx
    assert 'Cache-Control "no-store"' in nginx
    assert "limit_req_zone" in global_nginx
    assert "limit_conn_zone" in global_nginx


def test_host_hardening_script_protects_public_ssh_without_blocking_http():
    project_root = Path(__file__).resolve().parents[3]
    script = (project_root / "deploy/scripts/harden_host.sh").read_text(encoding="utf-8")

    assert "authorized_keys" in script
    assert "PasswordAuthentication no" in script
    assert "PermitRootLogin no" in script
    assert "sshd -t" in script
    assert "ufw allow 22/tcp" in script
    assert "ufw allow 80/tcp" in script
    assert "fail2ban" in script
