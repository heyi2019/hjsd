"""把业务日期与已记录的时间合成详情展示时间，不改动创建时间。"""
from datetime import date, datetime


def business_timestamp(day: date, recorded: datetime) -> datetime:
    return recorded.replace(year=day.year, month=day.month, day=day.day)
