"""短信通道：可切换，默认 mock。

为什么默认 mock：手机号验证码登录与微信绑定都依赖短信，但真实短信通道需要
腾讯云/阿里云密钥。为了让「凭据未到位」时功能仍可完整演示与验收，mock 通道把
验证码直接返回给前端；**该回显在 production 下被强制关闭**（见 Settings.sms_code_deliverable），
避免上线后忘了配真实通道、验证码堂而皇之出现在响应体里。

接入真实通道时只改 `SMS_PROVIDER` 并在此补一个分支，调用方无需改动。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from app.core.errors import Validation
from app.core.settings import Settings

logger = logging.getLogger("app.sms")

# 允许的通道；新增真实通道时同步扩展（settings 里已做校验，这里再兜一层）。
_SUPPORTED = {"mock", "disabled"}


@dataclass(frozen=True)
class SmsDelivery:
    """一次下发的结果。

    `echo_code` 只会在 mock + 非生产时非空，供开发者/自动化测试直接取码；
    生产环境恒为 None，接口层也据此决定是否回显。
    """

    delivered: bool
    channel: str
    echo_code: str | None = None


def deliver_code(settings: Settings, *, phone: str, code: str, purpose: str) -> SmsDelivery:
    """把验证码交给通道。失败必须抛错——绝不能「假装发出去了」。"""
    channel = settings.sms_provider

    if channel not in _SUPPORTED:
        # 配置层已拦非法值，能走到这里说明有人绕过校验改了配置对象。
        raise Validation(f"短信通道 {channel} 未实现")

    if channel == "disabled":
        raise Validation("短信通道未配置，暂时无法使用验证码登录")

    if channel == "mock":
        if settings.app_env.lower() == "production":
            # 生产环境用 mock = 验证码根本没发出去，必须显式报错而不是静默。
            raise Validation("短信通道未配置（当前为 mock 且运行在生产环境），请联系管理员")
        # 只打手机号后四位，避免验证码与完整手机号同时进日志。
        logger.info("[mock-sms] purpose=%s phone=****%s code=%s", purpose, phone[-4:], code)
        return SmsDelivery(delivered=True, channel="mock", echo_code=code)

    raise Validation("短信通道未配置")  # pragma: no cover - 防御性兜底


__all__ = ["SmsDelivery", "deliver_code"]
