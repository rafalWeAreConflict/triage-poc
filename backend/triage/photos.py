"""Defect photos sent in the copilot chat (multimodal AG-UI input).

CopilotKit's chat attachments arrive in the AG-UI ``RunAgentInput`` as image content parts of a
user message (base64 ``data`` source). Pydantic AI's AG-UI adapter turns those into
``BinaryContent`` so the (vision) model sees the image directly — no extra tool needed. What the
model cannot do is reference the picture later, so before the run the copilot view calls
``annotate_run_input_photos``: every inline image is stored once in default storage (MinIO / S3)
as a ``TicketPhoto`` and a short text part carrying its ``photo_guid`` is placed right after it.
The agent passes that guid to ``propose_triage`` / ``create_ticket``, which links the stored file
to ``Ticket.photo``.

Deduplicated by content hash per uploader: AG-UI replays the whole conversation on every run, so
the same image maps to the same guid each time.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import io
import logging
from typing import Any, Optional

from config.roles_gen import P
from django.core.files.base import ContentFile
from django.db import IntegrityError, transaction

from .models import TicketPhoto

logger = logging.getLogger(__name__)

ALLOWED_PHOTO_TYPES = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
}
MAX_PHOTO_BYTES = 10 * 1024 * 1024
PHOTO_NOTE_PREFIX = '[photo_guid:'


def photo_note(guid) -> str:
    return (f'{PHOTO_NOTE_PREFIX} {guid}] The image above was saved as a defect photo. '
            'Pass this photo_guid to propose_triage and create_ticket.')


def _decode_image_part(part) -> Optional[tuple[bytes, str]]:
    """Return ``(raw bytes, mime type)`` for an inline image content part, else ``None``."""
    part_type = getattr(part, 'type', None)
    if part_type == 'image':
        source = getattr(part, 'source', None)
        if getattr(source, 'type', None) != 'data':
            return None
        data, mime = source.value, source.mime_type
    elif part_type == 'binary':
        data, mime = getattr(part, 'data', None), getattr(part, 'mime_type', '')
        if not data or not (mime or '').startswith('image/'):
            return None
    else:
        return None
    mime = (mime or '').lower()
    if mime not in ALLOWED_PHOTO_TYPES:
        return None
    try:
        raw = base64.b64decode(data, validate=False)
    except (binascii.Error, ValueError):
        return None
    if not raw or len(raw) > MAX_PHOTO_BYTES:
        return None
    return raw, mime


def _is_image(raw: bytes) -> bool:
    from PIL import Image, UnidentifiedImageError
    try:
        with Image.open(io.BytesIO(raw)) as img:
            img.verify()
        return True
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError):
        return False


def store_photo(user, raw: bytes, mime: str) -> Optional[TicketPhoto]:
    """Store (or reuse) a photo for ``user``. Returns ``None`` when the bytes are not a valid image."""
    digest = hashlib.sha256(raw).hexdigest()
    existing = TicketPhoto.objects.filter(sha256=digest, created_by=user, deleted_at__isnull=True).first()
    if existing:
        return existing
    if not _is_image(raw):
        return None
    photo = TicketPhoto(sha256=digest, content_type=mime, created_by=user, updated_by=user)
    photo.image.save(f'{photo.guid}.{ALLOWED_PHOTO_TYPES[mime]}', ContentFile(raw), save=False)
    try:
        with transaction.atomic():
            photo.save()
    except IntegrityError:  # concurrent run stored the same image first
        return TicketPhoto.objects.filter(sha256=digest, created_by=user).first()
    return photo


def annotate_run_input_photos(run_input: Any, user) -> int:
    """Persist inline chat images and add a ``photo_guid`` note after each one (mutates ``run_input``).

    Only for users who may create tickets (``P.TICKET_ADD``); others still get the image in the model
    input, just without a stored copy. Storage failures are logged and never break the chat run.
    Returns the number of images annotated.
    """
    if not P.TICKET_ADD.check(user, raised_error=False):
        return 0
    from ag_ui.core import TextInputContent

    annotated = 0
    for message in getattr(run_input, 'messages', None) or []:
        if getattr(message, 'role', None) != 'user' or not isinstance(message.content, list):
            continue
        parts = list(message.content)
        if any(getattr(p, 'type', None) == 'text' and p.text.startswith(PHOTO_NOTE_PREFIX) for p in parts):
            continue  # already annotated
        new_parts = []
        for part in parts:
            new_parts.append(part)
            decoded = _decode_image_part(part)
            if decoded is None:
                continue
            try:
                photo = store_photo(user, *decoded)
            except Exception:  # a storage outage must not kill the chat run
                logger.exception('Could not store copilot chat photo')
                photo = None
            if photo is not None:
                new_parts.append(TextInputContent(type='text', text=photo_note(photo.guid)))
                annotated += 1
        message.content = new_parts
    return annotated
