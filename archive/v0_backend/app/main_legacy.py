"""FastAPI 入口：CORS + 路由挂载 + 启动时建表。"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.db import init_db
from app.routers import (
    accounts, cashflow, installments, leads, linkage, orders, reports,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="黑金时代简易ERP", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(accounts.router)
app.include_router(orders.router)
app.include_router(cashflow.router)
app.include_router(reports.router)
app.include_router(installments.router)
app.include_router(leads.router)
app.include_router(linkage.router)


@app.get("/")
def root():
    return {"name": "黑金时代简易ERP", "docs": "/docs"}
