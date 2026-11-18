"""v1 应用工厂：异常转换 + CORS + `/api/v1` 路由挂载。

设计要点：
- 金额/编号/权限相关的业务异常一律走 `AppError` → 统一 JSON `{code, message, details}`；
- `app.main` 即 v1 入口（唯一入口）。
"""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from starlette.exceptions import HTTPException as StarletteHTTPException
from uuid import uuid4

from app.core.database import describe_engine, get_engine
from app.core.errors import AppError, ErrorCode
from app.core.settings import Settings, get_settings
from app.core.request_context import reset_request_id, set_request_id
from app.core.schemas import EngineInfoOut, HealthOut
from app.field_definitions.router import router as foundation_router
from app.stocks.router import router as stocks_router
from app.audit.router import router as audit_router
from app.profit_allocation.router import router as profit_allocation_router
from app.notifications.router import router as notifications_router
from app.reporting.router import router as reporting_router
from app.finance.router import router as finance_router
from app.installments.router import router as installments_router
from app.orders.router import router as orders_router
from app.orders.export_router import export_router as order_exports_router
from app.orders.form_fields_router import router as order_form_fields_router
from app.customer_center.router import router as parties_router
from app.auth.router import router as auth_router, admin_router as users_router, teams_router
from app.attachments.router import router as attachments_router
from app.options.router import router as options_router
from app.workbench.router import router as workbench_router
from app.lists.router import router as lists_router


def install_exception_handlers(app: FastAPI) -> None:
    """业务异常 → 文档约定的错误结构；参数校验 → 422 并标记具体字段。"""

    @app.exception_handler(StarletteHTTPException)
    async def _handle_framework_http_error(
        _request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        code_by_status = {
            401: ErrorCode.AUTH_REQUIRED,
            403: ErrorCode.PERMISSION_DENIED,
            404: ErrorCode.RESOURCE_NOT_FOUND,
            405: ErrorCode.METHOD_NOT_ALLOWED,
        }
        detail = exc.detail
        if isinstance(detail, dict):
            message = str(detail.get("message") or detail.get("detail") or "请求失败")
            code = str(detail.get("code") or code_by_status.get(exc.status_code, ErrorCode.VALIDATION_ERROR))
            details = detail.get("details") or {}
        else:
            message = str(detail or "请求失败")
            code = code_by_status.get(exc.status_code, ErrorCode.VALIDATION_ERROR)
            details = {}
        return JSONResponse(
            status_code=exc.status_code,
            content={"code": code, "message": message, "details": details},
        )

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

    @app.exception_handler(ValueError)
    async def _handle_value_error(_request: Request, exc: ValueError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={
                "code": ErrorCode.VALIDATION_ERROR,
                "message": str(exc),
                "details": {},
            },
        )


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    docs_url = "/docs" if settings.is_development else None
    redoc_url = "/redoc" if settings.is_development else None
    openapi_url = "/openapi.json" if settings.is_development else None
    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        description="宜游轩 ERP v1 当前实现。",
        docs_url=docs_url,
        redoc_url=redoc_url,
        openapi_url=openapi_url,
    )

    origin_regex = settings.cors_origin_regex
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_origin_regex=origin_regex,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Inventory-Detail-Failures"],
    )

    # 响应压缩：列表类端点返回高冗余 JSON（实测 /orders 约 489KB → gzip 约 16KB，压比 ~30x）。
    # 在真实网络（非本机回环）上显著降低大列表传输耗时，直接缓解「换页 / 列表加载慢」。
    # minimum_size=1024：<1KB 的响应不压缩（压缩收益不抵开销）；同时保留已登录态与错误体不动。
    app.add_middleware(GZipMiddleware, minimum_size=1024)

    install_exception_handlers(app)

    @app.middleware("http")
    async def request_context_middleware(request: Request, call_next):
        incoming = request.headers.get("X-Request-ID", "").strip()
        request_id = (
            incoming
            if incoming and len(incoming) <= 64 and all(ord(char) >= 32 for char in incoming)
            else uuid4().hex
        )
        token = set_request_id(request_id)
        try:
            response = await call_next(request)
            response.headers["X-Request-ID"] = request_id
            return response
        finally:
            reset_request_id(token)

    app.include_router(foundation_router, prefix=settings.api_prefix)
    app.include_router(parties_router, prefix=settings.api_prefix)
    app.include_router(order_exports_router, prefix=settings.api_prefix)
    app.include_router(orders_router, prefix=settings.api_prefix)
    app.include_router(order_form_fields_router, prefix=settings.api_prefix)
    app.include_router(installments_router, prefix=settings.api_prefix)
    app.include_router(finance_router, prefix=settings.api_prefix)
    app.include_router(stocks_router, prefix=settings.api_prefix)
    app.include_router(reporting_router, prefix=settings.api_prefix)
    app.include_router(profit_allocation_router, prefix=settings.api_prefix)
    app.include_router(notifications_router, prefix=settings.api_prefix)
    app.include_router(audit_router, prefix=settings.api_prefix)
    app.include_router(auth_router, prefix=settings.api_prefix)
    app.include_router(users_router, prefix=settings.api_prefix)
    app.include_router(teams_router, prefix=settings.api_prefix)
    app.include_router(attachments_router, prefix=settings.api_prefix)
    app.include_router(options_router, prefix=settings.api_prefix)
    app.include_router(workbench_router, prefix=settings.api_prefix)
    app.include_router(lists_router, prefix=settings.api_prefix)

    @app.get("/", response_model=EngineInfoOut, tags=["health"])
    def root() -> EngineInfoOut:
        info = describe_engine()
        info["docs"] = "/docs"
        return EngineInfoOut.model_validate(info)

    @app.get(
        f"{settings.api_prefix}/health",
        response_model=HealthOut,
        tags=["health"],
    )
    def health() -> HealthOut | JSONResponse:
        try:
            with get_engine().connect() as connection:
                connection.execute(text("SELECT 1"))
        except Exception:
            return JSONResponse(
                status_code=503,
                content={"status": "error", "database_status": "unavailable"},
            )
        return HealthOut.model_validate(
            {
                "status": "ok",
                "database_status": "ok",
                **describe_engine(),
            }
        )

    return app


__all__ = ["create_app", "install_exception_handlers"]
