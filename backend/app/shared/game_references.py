"""游戏、渠道编码与名称的统一读取。"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.foundation import GameTypeOption
from app.domain.options import OptionSet

GAME_REFERENCE_ARCHIVE = "GAME_REFERENCE_ARCHIVE"


def archive_game_references(session: Session, values: list[dict[str, str]], *, actor: str) -> None:
    if not values:
        return
    row = session.scalar(select(OptionSet).where(OptionSet.code == GAME_REFERENCE_ARCHIVE).with_for_update())
    if row is None:
        row = OptionSet(code=GAME_REFERENCE_ARCHIVE, label="历史游戏与渠道", group="SYSTEM",
                        editable=False, options=[], created_by=actor, updated_by=actor)
        session.add(row)
        session.flush()
    entries = {item["value"]: dict(item) for item in row.options or []}
    entries.update({item["value"]: dict(item) for item in values})
    row.options = list(entries.values())
    row.updated_by = actor


def game_reference_labels(session: Session) -> tuple[dict[str, str], dict[str, str]]:
    games: dict[str, str] = {}
    channels: dict[str, str] = {}
    archive = session.scalar(select(OptionSet).where(OptionSet.code == GAME_REFERENCE_ARCHIVE))
    for item in (archive.options or []) if archive else []:
        target = games if item["value"].startswith("game_") else channels
        target[item["value"]] = item["label"]
    for item in session.scalars(select(GameTypeOption)):
        games[item.value] = item.name
        for channel in item.channel_regions or []:
            channels[channel["value"]] = channel["label"]
    return games, channels


def matching_game_references(session: Session, keyword: str) -> tuple[list[str], list[str]]:
    games, channels = game_reference_labels(session)
    needle = keyword.strip().casefold()
    return ([value for value, label in games.items() if needle in label.casefold()],
            [value for value, label in channels.items() if needle in label.casefold()])
