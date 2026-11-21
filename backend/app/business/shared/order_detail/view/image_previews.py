"""Create small display images without changing the stored originals."""
from __future__ import annotations

import base64
import binascii
import hashlib
from io import BytesIO

from PIL import Image, ImageOps, UnidentifiedImageError

from app.business.inventory.schemas import AccountOut

IMAGE_FIELDS = ("secondary_images", "wallet_realname_images", "account_images")


def image_version(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def account_image_versions(account: AccountOut) -> dict[str, list[str]]:
    return {field: [image_version(image) for image in (getattr(account, field) or [])] for field in IMAGE_FIELDS}


def _preview(value: str) -> str:
    if not value.startswith("data:image/") or ";base64," not in value:
        return value
    try:
        raw = base64.b64decode(value.split(",", 1)[1], validate=True)
        with Image.open(BytesIO(raw)) as source:
            image = ImageOps.exif_transpose(source)
            image.thumbnail((320, 320))
            output = BytesIO()
            if image.mode in ("RGBA", "LA") or "transparency" in image.info:
                image.convert("RGBA").save(output, format="PNG", optimize=True)
                mime = "image/png"
            else:
                image.convert("RGB").save(output, format="JPEG", quality=75, optimize=True)
                mime = "image/jpeg"
            encoded = f"data:{mime};base64," + base64.b64encode(output.getvalue()).decode("ascii")
            return encoded if len(encoded) < len(value) else value
    except (ValueError, OSError, binascii.Error, Image.DecompressionBombError, UnidentifiedImageError):
        return value


def preview_account_images(account: AccountOut) -> AccountOut:
    return account.model_copy(update={
        field: None if (images := getattr(account, field)) is None else [_preview(image) for image in images]
        for field in IMAGE_FIELDS
    })
