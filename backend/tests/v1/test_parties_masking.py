"""客户联系方式脱敏契约测试（阶段5 高风险）。

覆盖 mask_phone / mask_id / to_customer_out 的脱敏与按需显隐：
- 手机号按「前3后4」遮罩；
- 微信 / QQ 按「前2 + 星」遮罩；
- to_customer_out(reveal_contact=False) 必须脱敏且 contact_masked=True；
  reveal_contact=True 原样返回。
纯函数、无 DB、无 HTTP。
"""
from __future__ import annotations

from app.domain.parties import Customer
from app.parties._common import mask_id, mask_phone, to_customer_out


def test_mask_phone_keeps_head_and_tail():
    assert mask_phone("13800001111") == "138****1111"


def test_mask_phone_short_is_partially_masked():
    # 长度 <=7：保留前 3 位，其余打星。
    assert mask_phone("1234567") == "123****"


def test_mask_phone_empty_passthrough():
    assert mask_phone(None) is None
    assert mask_phone("") == ""


def test_mask_id_keeps_head_and_preserves_length():
    masked = mask_id("wxid_abc123")
    assert masked.startswith("wx")
    assert len(masked) == len("wxid_abc123")
    assert masked != "wxid_abc123"
    # 非头部字符全部为星号。
    assert set(masked[2:]) == {"*"}


def test_mask_id_short_keeps_first_char():
    assert mask_id("ab") == "a*"


def test_to_customer_out_masks_when_not_revealed():
    cust = Customer(
        id=1, customer_no="CUS0001", display_name="张三",
        contact_name="张三", phone="13800001111", wechat="wxid_abc", qq="123456",
        owner_id=1, status="ACTIVE",
    )
    out = to_customer_out(cust, reveal_contact=False)
    assert out["contact_masked"] is True
    assert out["phone"] == "138****1111"
    assert out["wechat"] == mask_id("wxid_abc")
    assert out["qq"] == mask_id("123456")


def test_to_customer_out_reveals_when_requested():
    cust = Customer(
        id=1, customer_no="CUS0001", display_name="张三",
        contact_name="张三", phone="13800001111", wechat="wxid_abc", qq="123456",
        owner_id=1, status="ACTIVE",
    )
    out = to_customer_out(cust, reveal_contact=True)
    assert out["contact_masked"] is False
    assert out["phone"] == "13800001111"
    assert out["wechat"] == "wxid_abc"
    assert out["qq"] == "123456"
