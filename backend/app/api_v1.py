"""v1 应用工厂：异常转换 + CORS + `/api/v1` 路由挂载。

设计要点：
- 金额/编号/权限相关的业务异常一律走 `AppError` → 统一 JSON `{code, message, details}`；
- `app.main` 即 v1 入口（唯一入口）；v1 之前的实现已归档至 `archive/v0_backend/`，不再挂载。
"""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.database import describe_engine
from app.core.errors import AppError, ErrorCode
from app.core.settings import Settings, get_settings
from app.foundation.router import router as foundation_router
from app.accounts.router import router as accounts_router
from app.audit.router import router as audit_router
from app.history.router import router as history_router
from app.policy.router import router as policy_router
from app.quality.router import router as quality_router
from app.reporting.router import router as reporting_router
from app.finance.router import router as finance_router
from app.installments.router import router as installments_router
from app.orders.router import router as orders_router
from app.parties.router import router as parties_router


def install_exception_handlers(app: FastAPI) -> None:
    """业务异常 → 文档约定的错误结构；参数校验 → 422 并标记具体字段。"""

    @app.exception_handler(AppError)
    async def _handle_app_error(_request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.http_status, content=exc.to_payload())

    @app.exception_handler(RequestValidationError)
    async def _handle_validation_error(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        errors = [
            {"field": ".".join(str(item) for item in error.get("loc", ())[1:]), "msg": error.get("msg", "")}
            for error in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content={
                "code": ErrorCode.VALIDATION_ERROR,
                "message": "请求参数校验失败",
                "details": {"errors": errors},
            },
        )


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        description="黑金时代工作室 ERP v1.0（业务规则以 docs/ERP_PRD_v1.0.md 为准）",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    install_exception_handlers(app)
    app.include_router(foundation_router, prefix=settings.api_prefix)
    app.include_router(parties_router, prefix=settings.api_prefix)
    app.include_router(orders_router, prefix=settings.api_prefix)
    app.include_router(installments_router, prefix=settings.api_prefix)
    app.include_router(finance_router, prefix=settings.api_prefix)
    app.include_router(accounts_router, prefix=settings.api_prefix)
    app.include_router(reporting_router, prefix=settings.api_prefix)
    app.include_router(policy_router, prefix=settings.api_prefix)
    app.include_router(quality_router, prefix=settings.api_prefix)
    app.include_router(history_router, prefix=settings.api_prefix)
    app.include_router(audit_router, prefix=settings.api_prefix)

    @app.get("/", tags=["health"])
    def root() -> dict[str, str]:
        info = describe_engine(settings)
        info["docs"] = "/docs"
        return info

    @app.get(f"{settings.api_prefix}/health", tags=["health"])
    def health() -> dict[str, str]:
        return {"status": "ok", **describe_engine(settings)}

    return app


__all__ = ["create_app", "install_exception_handlers"]
