#!/usr/bin/env python3
"""Preflight an importable BongoCat sprite model and its pet-action modules.

The application loader remains authoritative. This script intentionally checks the
portable package invariants that are easy to miss while generating a model, then
leaves animation quality and runtime behavior to the app and visual QA.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import stat
import struct
import sys
from pathlib import Path
from typing import Any

try:
    from PIL import Image
except ImportError as error:  # pragma: no cover - depends on the caller's environment.
    raise SystemExit(
        "Pillow is required. Load the Codex workspace Python dependencies or install pillow."
    ) from error


MAX_MODEL_BYTES = 1024 * 1024
MAX_MODULE_BYTES = 256 * 1024
MAX_MODULES = 64
MAX_ANIMATIONS = 96
MAX_MODULE_ANIMATIONS = 128
MAX_MODULE_ACTIONS = 128
MAX_MODULE_TRIGGERS = 256
MAX_TOTAL_ACTIONS = 512
MAX_TOTAL_TRIGGERS = 256
MAX_AUDIO_FILES = 64
MAX_AUDIO_FILE_BYTES = 8 * 1024 * 1024
MAX_AUDIO_SAMPLES = 48_000 * 30
MAX_SHEET_PIXELS = 16 * 1024 * 1024
MAX_TIMER = 2_147_483_647
MAX_STATE_DIMENSIONS = 8
MAX_STATE_VALUES = 32
MAX_STATE_PROFILES = 128
MAX_STATE_RULES = 128
MAX_STATE_ANIMATION_VARIANTS = 16
MAX_STATE_DIALOGUE_VARIANTS = 16
MAX_INPUT_ACTIONS = 128
SAFE_ID = re.compile(r"^[\da-z][\w.-]*$", re.ASCII)
STATE_ID = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
LOCAL_TIME = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
DATE = re.compile(r"^(?:\d{4}|\*)-\d{2}-\d{2}$")
SCHEME = re.compile(r"^[a-z][a-z\d+.-]*:", re.IGNORECASE)
RESERVED_IDS = {"__proto__", "prototype", "constructor"}
TRIGGER_TYPES = {
    "interval",
    "idle",
    "schedule",
    "manual",
    "pointer",
    "session",
    "visibility-return",
    "activity-burst",
    "active-session",
    "daily-window",
}


class Validation:
    """Collect all independent failures so one run gives an actionable report."""

    def __init__(self, model_dir: Path) -> None:
        self.model_dir = model_dir
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.animations: dict[str, dict[str, Any]] = {}
        self.audio_files: set[Path] = set()
        self.total_pixels = 0
        self.module_actions = 0
        self.module_triggers = 0

    def error(self, message: str) -> None:
        self.errors.append(message)

    def warning(self, message: str) -> None:
        self.warnings.append(message)

    def result(self) -> dict[str, Any]:
        return {
            "ok": not self.errors,
            "modelDirectory": str(self.model_dir),
            "animationCount": len(self.animations),
            "audioFileCount": len(self.audio_files),
            "totalSpritePixels": self.total_pixels,
            "moduleActionCount": self.module_actions,
            "moduleTriggerCount": self.module_triggers,
            "errors": self.errors,
            "warnings": self.warnings,
        }


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def is_positive(value: Any) -> bool:
    return is_number(value) and value > 0


def is_non_negative(value: Any) -> bool:
    return is_number(value) and value >= 0


def is_positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def is_timer(value: Any, allow_zero: bool = False) -> bool:
    return is_number(value) and (value >= 0 if allow_zero else value > 0) and value <= MAX_TIMER


def expect_object(validation: Validation, value: Any, label: str) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        validation.error(f"{label} must be an object")
        return None
    return value


def allowed_keys(
    validation: Validation,
    value: dict[str, Any],
    allowed: set[str],
    label: str,
) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        validation.error(f"{label} contains unsupported fields: {', '.join(unknown)}")


def validate_id(validation: Validation, value: Any, label: str) -> str | None:
    if (
        not isinstance(value, str)
        or len(value) > 80
        or not SAFE_ID.fullmatch(value)
        or value.lower() in RESERVED_IDS
    ):
        validation.error(f"{label} must be a safe id of at most 80 characters")
        return None
    return value


def validate_state_id(validation: Validation, value: Any, label: str) -> str | None:
    if not isinstance(value, str) or len(value) > 80 or not STATE_ID.fullmatch(value):
        validation.error(f"{label} must be a lowercase hyphenated state id")
        return None
    return value


def validate_localized(validation: Validation, value: Any, label: str) -> None:
    if isinstance(value, str):
        if not value.strip() or len(value.strip()) > 240:
            validation.error(f"{label} must contain 1-240 characters")
        return
    if not isinstance(value, dict) or not value or len(value) > 16:
        validation.error(f"{label} must be text or a non-empty locale map with at most 16 entries")
        return
    normalized: set[str] = set()
    for locale, text in value.items():
        locale_key = str(locale).lower()
        if locale_key in normalized or locale_key in RESERVED_IDS:
            validation.error(f"{label} contains a duplicate or reserved locale {locale!r}")
        normalized.add(locale_key)
        if not isinstance(text, str) or not text.strip() or len(text.strip()) > 240:
            validation.error(f"{label}.{locale} must contain 1-240 characters")


def load_json(validation: Validation, path: Path, limit: int, label: str) -> dict[str, Any] | None:
    if not path.is_file():
        validation.error(f"{label} is missing: {path}")
        return None
    if path.stat().st_size > limit:
        validation.error(f"{label} exceeds {limit} bytes: {path}")
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        validation.error(f"{label} is not valid UTF-8 JSON: {error}")
        return None
    return expect_object(validation, value, label)


def resolve_asset(
    validation: Validation,
    base_dir: Path,
    raw_path: Any,
    label: str,
) -> Path | None:
    if (
        not isinstance(raw_path, str)
        or not raw_path
        or len(raw_path) > 512
        or raw_path.startswith(("/", "\\"))
        or SCHEME.match(raw_path)
        or "\x00" in raw_path
    ):
        validation.error(f"{label} must be a safe relative path")
        return None
    parts = re.split(r"[\\/]", raw_path)
    if any(part in {"", ".", ".."} for part in parts):
        validation.error(f"{label} cannot contain empty, dot, or parent segments")
        return None
    candidate = base_dir.joinpath(*parts)
    try:
        candidate.resolve(strict=False).relative_to(validation.model_dir.resolve())
    except ValueError:
        validation.error(f"{label} escapes the model folder")
        return None
    if not candidate.is_file():
        validation.error(f"{label} does not reference a regular file: {raw_path}")
        return None
    if candidate.is_symlink():
        validation.error(f"{label} cannot reference a symbolic link: {raw_path}")
        return None
    return candidate


def validate_animation(
    validation: Validation,
    name: str,
    raw: Any,
    base_dir: Path,
    qualified_name: str,
) -> dict[str, Any] | None:
    animation = expect_object(validation, raw, f"animation {qualified_name!r}")
    if animation is None:
        return None
    allowed_keys(
        validation,
        animation,
        {"file", "frameWidth", "frameHeight", "frames", "columns", "fps", "loop", "frameDurations"},
        f"animation {qualified_name!r}",
    )
    if not name.strip():
        validation.error(f"animation {qualified_name!r} has an empty id")
    integer_fields = ("frameWidth", "frameHeight", "frames", "columns")
    if any(not is_positive_int(animation.get(field)) for field in integer_fields):
        validation.error(f"animation {qualified_name!r} grid fields must be positive integers")
        return None
    if not is_positive(animation.get("fps")):
        validation.error(f"animation {qualified_name!r}.fps must be positive")
    if not isinstance(animation.get("loop"), bool):
        validation.error(f"animation {qualified_name!r}.loop must be boolean")
    durations = animation.get("frameDurations")
    if durations is not None and (
        not isinstance(durations, list)
        or len(durations) != animation["frames"]
        or any(not is_positive(duration) for duration in durations)
    ):
        validation.error(
            f"animation {qualified_name!r}.frameDurations must contain one positive value per frame"
        )
    asset = resolve_asset(validation, base_dir, animation.get("file"), f"animation {qualified_name!r}.file")
    if asset is None:
        return animation
    try:
        with Image.open(asset) as image:
            image.load()
            width, height = image.size
            if image.mode != "RGBA":
                validation.error(f"animation {qualified_name!r} must decode as RGBA, got {image.mode}")
    except (OSError, ValueError) as error:
        validation.error(f"animation {qualified_name!r} cannot be decoded: {error}")
        return animation
    expected_width = animation["columns"] * animation["frameWidth"]
    expected_height = math.ceil(animation["frames"] / animation["columns"]) * animation["frameHeight"]
    if (width, height) != (expected_width, expected_height):
        validation.error(
            f"animation {qualified_name!r} is {width}x{height}; expected exact grid "
            f"{expected_width}x{expected_height}"
        )
    pixels = width * height
    if pixels > MAX_SHEET_PIXELS:
        validation.error(f"animation {qualified_name!r} exceeds the {MAX_SHEET_PIXELS} pixel limit")
    validation.total_pixels += pixels
    validation.animations[qualified_name] = animation
    return animation


def validate_hit_areas(validation: Validation, raw: Any, canvas: tuple[float, float]) -> set[str]:
    if raw is None:
        return set()
    areas = expect_object(validation, raw, "behaviors.pet.hitAreas")
    if areas is None:
        return set()
    width, height = canvas
    for name, raw_area in areas.items():
        area = expect_object(validation, raw_area, f"hit area {name!r}")
        if area is None:
            continue
        shape = area.get("shape")
        if shape == "rect":
            allowed_keys(validation, area, {"shape", "x", "y", "width", "height"}, f"hit area {name!r}")
            values = [area.get(key) for key in ("x", "y", "width", "height")]
            if not all(is_non_negative(value) for value in values[:2]) or not all(
                is_positive(value) for value in values[2:]
            ):
                validation.error(f"hit area {name!r} has invalid rect geometry")
            elif values[0] + values[2] > width or values[1] + values[3] > height:
                validation.error(f"hit area {name!r} exceeds the model canvas")
        elif shape == "ellipse":
            allowed_keys(
                validation,
                area,
                {"shape", "centerX", "centerY", "radiusX", "radiusY"},
                f"hit area {name!r}",
            )
            values = [area.get(key) for key in ("centerX", "centerY", "radiusX", "radiusY")]
            if not all(is_positive(value) for value in values):
                validation.error(f"hit area {name!r} has invalid ellipse geometry")
            elif (
                values[0] - values[2] < 0
                or values[0] + values[2] > width
                or values[1] - values[3] < 0
                or values[1] + values[3] > height
            ):
                validation.error(f"hit area {name!r} exceeds the model canvas")
        elif shape == "polygon":
            allowed_keys(validation, area, {"shape", "points"}, f"hit area {name!r}")
            points = area.get("points")
            if not isinstance(points, list) or len(points) < 3:
                validation.error(f"hit area {name!r}.points must contain at least three points")
            else:
                for index, point in enumerate(points):
                    if (
                        not isinstance(point, dict)
                        or not is_non_negative(point.get("x"))
                        or not is_non_negative(point.get("y"))
                        or point["x"] > width
                        or point["y"] > height
                    ):
                        validation.error(f"hit area {name!r}.points[{index}] is outside the canvas")
        else:
            validation.error(f"hit area {name!r}.shape must be rect, ellipse, or polygon")
    return set(areas)


def validate_dialogue(
    validation: Validation,
    raw: Any,
    label: str,
    canvas: tuple[float, float],
) -> bool:
    dialogue = expect_object(validation, raw, label)
    if dialogue is None:
        return False
    allowed_keys(validation, dialogue, {"chance", "delayMs", "durationMs", "anchor", "lines"}, label)
    chance = dialogue.get("chance", 1)
    if not is_positive(chance) or chance > 1:
        validation.error(f"{label}.chance must be in (0, 1]")
    if not is_timer(dialogue.get("delayMs", 0), allow_zero=True):
        validation.error(f"{label}.delayMs must be a non-negative timer value")
    if not is_timer(dialogue.get("durationMs", 2200)):
        validation.error(f"{label}.durationMs must be a positive timer value")
    anchor = dialogue.get("anchor")
    if anchor is not None:
        if not isinstance(anchor, dict) or set(anchor) - {"x", "y"}:
            validation.error(f"{label}.anchor must contain only x and y")
        elif (
            not is_non_negative(anchor.get("x"))
            or not is_non_negative(anchor.get("y"))
            or anchor["x"] > canvas[0]
            or anchor["y"] > canvas[1]
        ):
            validation.error(f"{label}.anchor must be inside the model canvas")
    lines = dialogue.get("lines")
    if not isinstance(lines, list) or not 1 <= len(lines) <= 32:
        validation.error(f"{label}.lines must contain 1-32 entries")
        return True
    for index, line in enumerate(lines):
        line_label = f"{label}.lines[{index}]"
        if isinstance(line, dict) and "text" in line:
            allowed_keys(validation, line, {"text", "weight"}, line_label)
            validate_localized(validation, line.get("text"), f"{line_label}.text")
            if not is_positive(line.get("weight", 1)):
                validation.error(f"{line_label}.weight must be positive")
        else:
            validate_localized(validation, line, line_label)
    return True


def validate_audio(
    validation: Validation,
    raw: Any,
    label: str,
    module_dir: Path,
) -> None:
    audio = expect_object(validation, raw, label)
    if audio is None:
        return
    allowed_keys(validation, audio, {"file", "chance", "delayMs", "volume"}, label)
    chance = audio.get("chance", 1)
    volume = audio.get("volume", 1)
    if not is_positive(chance) or chance > 1:
        validation.error(f"{label}.chance must be in (0, 1]")
    if not is_positive(volume) or volume > 1:
        validation.error(f"{label}.volume must be in (0, 1]")
    if not is_timer(audio.get("delayMs", 0), allow_zero=True):
        validation.error(f"{label}.delayMs must be a non-negative timer value")

    raw_file = audio.get("file")
    if isinstance(raw_file, str) and raw_file.startswith("@model/"):
        asset = resolve_asset(
            validation,
            validation.model_dir,
            raw_file.removeprefix("@model/"),
            f"{label}.file",
        )
    else:
        asset = resolve_asset(validation, module_dir, raw_file, f"{label}.file")
    if asset is None:
        return
    # 与运行时一致，重复引用同一个已解析文件只占一个音频名额。
    validation.audio_files.add(asset.resolve())
    if asset.stat().st_size > MAX_AUDIO_FILE_BYTES:
        validation.error(f"{label}.file exceeds {MAX_AUDIO_FILE_BYTES} bytes")
        return
    if asset.suffix.lower() != ".wem":
        return

    # 应用目前直接解码新版 Wwise Opus WEM；预检同样拒绝看似 WEM、运行时却无法播放的其他 codec。
    try:
        data = asset.read_bytes()
        if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
            raise ValueError("not a little-endian RIFF/WAVE")
        offset = 12
        format_offset = None
        while offset + 8 <= len(data):
            chunk_id = data[offset:offset + 4]
            chunk_size = struct.unpack_from("<I", data, offset + 4)[0]
            chunk_offset = offset + 8
            if chunk_offset + chunk_size > len(data):
                raise ValueError("chunk exceeds file")
            if chunk_id == b"fmt ":
                format_offset = chunk_offset
                break
            offset = chunk_offset + chunk_size + (chunk_size & 1)
        if format_offset is None or struct.unpack_from("<H", data, format_offset)[0] != 0x3041:
            raise ValueError("codec is not Wwise Opus 0x3041")
        channels = struct.unpack_from("<H", data, format_offset + 2)[0]
        samples = struct.unpack_from("<I", data, format_offset + 0x18)[0]
        mapping = data[format_offset + 0x23]
        if channels not in {1, 2} or mapping != 0 or not 0 < samples <= MAX_AUDIO_SAMPLES:
            raise ValueError("channel mapping or duration is unsupported")
    except (IndexError, OSError, struct.error, ValueError) as error:
        validation.error(f"{label}.file is not a supported Wwise Opus WEM: {error}")


def validate_timer_range(validation: Validation, value: Any, label: str) -> None:
    if (
        not isinstance(value, list)
        or len(value) != 2
        or not all(is_timer(item) for item in value)
        or value[0] > value[1]
    ):
        validation.error(f"{label} must be [positive minimum, positive maximum]")


def validate_weekdays_dates(validation: Validation, trigger: dict[str, Any], label: str) -> None:
    weekdays = trigger.get("weekdays")
    if weekdays is not None:
        valid_weekdays = (
            isinstance(weekdays, list)
            and bool(weekdays)
            and len(weekdays) <= 7
            and all(isinstance(day, int) and not isinstance(day, bool) for day in weekdays)
        )
        if (
            not valid_weekdays
            or len(set(weekdays)) != len(weekdays)
            or any(not 1 <= day <= 7 for day in weekdays)
        ):
            validation.error(f"{label}.weekdays must contain unique integers from 1 through 7")
    dates = trigger.get("dates")
    if dates is not None:
        valid_dates = (
            isinstance(dates, list)
            and bool(dates)
            and len(dates) <= 366
            and all(isinstance(date, str) for date in dates)
        )
        if (
            not valid_dates
            or len(set(dates)) != len(dates)
            or any(not DATE.fullmatch(date) for date in dates)
        ):
            validation.error(f"{label}.dates must contain unique YYYY-MM-DD or *-MM-DD values")


def validate_trigger(
    validation: Validation,
    raw: Any,
    label: str,
    actions: set[str],
    hit_areas: set[str],
) -> set[str]:
    trigger = expect_object(validation, raw, label)
    if trigger is None:
        return set()
    validate_id(validation, trigger.get("id"), f"{label}.id")
    trigger_type = trigger.get("type")
    if trigger_type not in TRIGGER_TYPES:
        validation.error(f"{label}.type is unsupported")
        return set()

    referenced: set[str] = set()

    def action(field: str = "action") -> str | None:
        value = trigger.get(field)
        if not isinstance(value, str) or value not in actions:
            validation.error(f"{label}.{field} references an unknown local action")
            return None
        referenced.add(value)
        return value

    if trigger_type == "manual":
        allowed_keys(validation, trigger, {"id", "type", "action", "label", "group", "order", "enterPet"}, label)
        action()
        validate_localized(validation, trigger.get("label"), f"{label}.label")
        if "group" in trigger:
            validate_localized(validation, trigger["group"], f"{label}.group")
    elif trigger_type == "pointer":
        allowed_keys(validation, trigger, {"id", "type", "action", "event", "area", "holdMs", "distance", "windowMs"}, label)
        action()
        event = trigger.get("event")
        if event not in {"hover", "tap", "stroke"}:
            validation.error(f"{label}.event must be hover, tap, or stroke")
        if trigger.get("area") not in hit_areas:
            validation.error(f"{label}.area references an unknown hit area")
        if event == "hover" and ("distance" in trigger or "windowMs" in trigger):
            validation.error(f"{label} hover cannot use distance or windowMs")
        if event == "stroke" and "holdMs" in trigger:
            validation.error(f"{label} stroke cannot use holdMs")
        if event == "tap" and "distance" in trigger and (
            not is_positive(trigger["distance"]) or trigger["distance"] > 6
        ):
            validation.error(f"{label}.distance must be in (0, 6]")
    elif trigger_type == "interval":
        allowed_keys(validation, trigger, {"id", "type", "delayMs", "choices"}, label)
        validate_timer_range(validation, trigger.get("delayMs"), f"{label}.delayMs")
        choices = trigger.get("choices")
        if not isinstance(choices, list) or not choices:
            validation.error(f"{label}.choices must be non-empty")
        else:
            seen: set[str] = set()
            for index, choice in enumerate(choices):
                if not isinstance(choice, dict) or set(choice) - {"action", "weight"}:
                    validation.error(f"{label}.choices[{index}] is invalid")
                    continue
                value = choice.get("action")
                if not isinstance(value, str):
                    validation.error(f"{label}.choices[{index}].action must be a string")
                    continue
                if value in seen:
                    validation.error(f"{label}.choices[{index}].action is duplicated")
                seen.add(value)
                if value not in actions:
                    validation.error(f"{label}.choices[{index}].action is unknown")
                else:
                    referenced.add(value)
                if not is_positive(choice.get("weight")):
                    validation.error(f"{label}.choices[{index}].weight must be positive")
    elif trigger_type == "idle":
        allowed_keys(validation, trigger, {"id", "type", "afterMs", "repeatMs", "action", "oncePerIdle"}, label)
        action()
        if not is_timer(trigger.get("afterMs")):
            validation.error(f"{label}.afterMs must be positive")
        once = trigger.get("oncePerIdle", "repeatMs" not in trigger)
        if not isinstance(once, bool):
            validation.error(f"{label}.oncePerIdle must be boolean")
        if "repeatMs" in trigger:
            validate_timer_range(validation, trigger["repeatMs"], f"{label}.repeatMs")
        if once and "repeatMs" in trigger:
            validation.error(f"{label} cannot combine oncePerIdle true with repeatMs")
        if once is False and "repeatMs" not in trigger:
            validation.error(f"{label} requires repeatMs when oncePerIdle is false")
    elif trigger_type == "schedule":
        allowed_keys(validation, trigger, {"id", "type", "action", "time", "dates", "weekdays", "catchUpMs", "enterPet"}, label)
        action()
        if not isinstance(trigger.get("time"), str) or not LOCAL_TIME.fullmatch(trigger["time"]):
            validation.error(f"{label}.time must use local HH:mm")
        validate_weekdays_dates(validation, trigger, label)
    elif trigger_type == "session":
        allowed_keys(validation, trigger, {"id", "type", "action", "event", "delayMs", "catchUpMs", "enterPet"}, label)
        action()
        if trigger.get("event") != "startup":
            validation.error(f"{label}.event must be startup")
        if "delayMs" in trigger:
            validate_timer_range(validation, trigger["delayMs"], f"{label}.delayMs")
    elif trigger_type == "visibility-return":
        allowed_keys(validation, trigger, {"id", "type", "action", "minAwayMs", "maxAwayMs", "settleMs", "catchUpMs", "enterPet"}, label)
        action()
        if not is_timer(trigger.get("minAwayMs")):
            validation.error(f"{label}.minAwayMs must be positive")
        if "maxAwayMs" in trigger and (
            not is_timer(trigger["maxAwayMs"]) or trigger["maxAwayMs"] <= trigger.get("minAwayMs", math.inf)
        ):
            validation.error(f"{label}.maxAwayMs must be greater than minAwayMs")
    elif trigger_type == "activity-burst":
        allowed_keys(validation, trigger, {"id", "type", "action", "sources", "windowMs", "minimumEvents", "quietMs", "catchUpMs", "enterPet"}, label)
        action()
        window = trigger.get("windowMs")
        quiet = trigger.get("quietMs")
        if not is_timer(window) or not is_timer(quiet) or quiet >= window:
            validation.error(f"{label} requires 0 < quietMs < windowMs")
        events = trigger.get("minimumEvents")
        if not isinstance(events, int) or isinstance(events, bool) or not 2 <= events <= 256:
            validation.error(f"{label}.minimumEvents must be an integer from 2 through 256")
    elif trigger_type == "active-session":
        allowed_keys(validation, trigger, {"id", "type", "action", "sources", "afterMs", "resetAfterMs", "repeatMs", "quietMs", "catchUpMs", "enterPet"}, label)
        action()
        reset = trigger.get("resetAfterMs")
        quiet = trigger.get("quietMs", 1500)
        if not is_timer(trigger.get("afterMs")) or not is_timer(reset) or not is_timer(quiet) or quiet >= reset:
            validation.error(f"{label} requires positive after/reset values and quietMs < resetAfterMs")
        if "repeatMs" in trigger and not is_timer(trigger["repeatMs"]):
            validation.error(f"{label}.repeatMs must be positive")
    elif trigger_type == "daily-window":
        allowed_keys(validation, trigger, {"id", "type", "action", "startTime", "endTime", "dates", "weekdays", "catchUpMs", "enterPet"}, label)
        action()
        start = trigger.get("startTime")
        end = trigger.get("endTime")
        if (
            not isinstance(start, str)
            or not isinstance(end, str)
            or not LOCAL_TIME.fullmatch(start)
            or not LOCAL_TIME.fullmatch(end)
            or start == end
        ):
            validation.error(f"{label} requires different local HH:mm startTime and endTime")
        validate_weekdays_dates(validation, trigger, label)

    sources = trigger.get("sources")
    if sources is not None:
        valid_sources = (
            isinstance(sources, list)
            and bool(sources)
            and all(isinstance(source, str) for source in sources)
        )
        if (
            not valid_sources
            or len(sources) != len(set(sources))
            or any(source not in {"keyboard", "mouse", "gamepad"} for source in sources)
        ):
            validation.error(f"{label}.sources must contain unique keyboard, mouse, or gamepad values")
    if "enterPet" in trigger and not isinstance(trigger["enterPet"], bool):
        validation.error(f"{label}.enterPet must be boolean")
    if "catchUpMs" in trigger and not is_timer(trigger["catchUpMs"], allow_zero=True):
        validation.error(f"{label}.catchUpMs is outside the timer range")
    return referenced


def validate_state_value_map(
    validation: Validation,
    raw: Any,
    dimensions: dict[str, set[str]],
    label: str,
    allow_empty: bool,
) -> None:
    values = expect_object(validation, raw, label)
    if values is None:
        return
    if not allow_empty and not values:
        validation.error(f"{label} cannot be empty")
    if len(values) > MAX_STATE_DIMENSIONS:
        validation.error(f"{label} exceeds {MAX_STATE_DIMENSIONS} dimensions")
    for dimension, state_value in values.items():
        if dimension not in dimensions:
            validation.error(f"{label}.{dimension} references an unknown dimension")
            continue
        if validate_state_id(validation, state_value, f"{label}.{dimension}") is not None \
                and state_value not in dimensions[dimension]:
            validation.error(f"{label}.{dimension} references an unknown state value")


def validate_daily_state_window(validation: Validation, raw: Any, label: str) -> None:
    window = expect_object(validation, raw, label)
    if window is None:
        return
    allowed_keys(validation, window, {"startTime", "endTime", "dates", "weekdays"}, label)
    start = window.get("startTime")
    end = window.get("endTime")
    if (
        not isinstance(start, str)
        or not isinstance(end, str)
        or not LOCAL_TIME.fullmatch(start)
        or not LOCAL_TIME.fullmatch(end)
        or start == end
    ):
        validation.error(f"{label} requires different local HH:mm startTime and endTime")
    dates = window.get("dates")
    if dates is not None and (
        not isinstance(dates, list)
        or not dates
        or len(dates) > 64
        or len(set(dates)) != len(dates)
        or any(not isinstance(date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date) for date in dates)
    ):
        validation.error(f"{label}.dates must contain up to 64 unique YYYY-MM-DD values")
    weekdays = window.get("weekdays")
    if weekdays is not None and (
        not isinstance(weekdays, list)
        or not weekdays
        or len(set(weekdays)) != len(weekdays)
        or any(not isinstance(day, int) or isinstance(day, bool) or not 0 <= day <= 6 for day in weekdays)
    ):
        validation.error(f"{label}.weekdays must contain unique integers from 0 through 6")


def validate_state_machine(
    validation: Validation,
    raw: Any,
    top_animations: dict[str, dict[str, Any]],
) -> dict[str, set[str]]:
    if raw is None:
        return {}
    state_machine = expect_object(validation, raw, "behaviors.pet.stateMachine")
    if state_machine is None:
        return {}
    allowed_keys(validation, state_machine, {"dimensions", "profiles", "rules"}, "behaviors.pet.stateMachine")
    raw_dimensions = expect_object(
        validation,
        state_machine.get("dimensions"),
        "behaviors.pet.stateMachine.dimensions",
    ) or {}
    if not raw_dimensions or len(raw_dimensions) > MAX_STATE_DIMENSIONS:
        validation.error(f"behaviors.pet.stateMachine.dimensions must contain 1-{MAX_STATE_DIMENSIONS} entries")
    dimensions: dict[str, set[str]] = {}
    for dimension, raw_dimension in raw_dimensions.items():
        label = f"behaviors.pet.stateMachine.dimensions.{dimension}"
        validate_state_id(validation, dimension, "behaviors.pet.stateMachine dimension id")
        config = expect_object(validation, raw_dimension, label)
        if config is None:
            continue
        allowed_keys(validation, config, {"initial", "values"}, label)
        values = config.get("values")
        if (
            not isinstance(values, list)
            or not values
            or len(values) > MAX_STATE_VALUES
            or len(set(values)) != len(values)
        ):
            validation.error(f"{label}.values must contain 1-{MAX_STATE_VALUES} unique ids")
            continue
        normalized = set()
        for index, value in enumerate(values):
            if validate_state_id(validation, value, f"{label}.values[{index}]") is not None:
                normalized.add(value)
        if config.get("initial") not in normalized:
            validation.error(f"{label}.initial must appear in values")
        dimensions[dimension] = normalized

    profiles = state_machine.get("profiles")
    if not isinstance(profiles, list) or not profiles or len(profiles) > MAX_STATE_PROFILES:
        validation.error(f"behaviors.pet.stateMachine.profiles must contain 1-{MAX_STATE_PROFILES} entries")
        profiles = []
    profile_ids: set[str] = set()
    has_pet_fallback = False
    for index, raw_profile in enumerate(profiles):
        label = f"behaviors.pet.stateMachine.profiles[{index}]"
        profile = expect_object(validation, raw_profile, label)
        if profile is None:
            continue
        allowed_keys(validation, profile, {"id", "priority", "scene", "match", "animation"}, label)
        profile_id = validate_state_id(validation, profile.get("id"), f"{label}.id")
        if profile_id in profile_ids:
            validation.error(f"{label}.id is duplicated")
        if profile_id is not None:
            profile_ids.add(profile_id)
        if not isinstance(profile.get("priority"), int) or isinstance(profile.get("priority"), bool) \
                or not 0 <= profile["priority"] <= 999:
            validation.error(f"{label}.priority must be an integer from 0 through 999")
        if profile.get("scene") not in {"work", "pet"}:
            validation.error(f"{label}.scene must be work or pet")
        validate_state_value_map(validation, profile.get("match"), dimensions, f"{label}.match", True)
        animation = top_animations.get(profile.get("animation"))
        if animation is None or animation.get("loop") is not True:
            validation.error(f"{label}.animation must reference a looping top-level animation")
        if profile.get("scene") == "pet" and profile.get("match") == {}:
            has_pet_fallback = True
    if not has_pet_fallback:
        validation.error("behaviors.pet.stateMachine.profiles requires a pet fallback profile")

    rules = state_machine.get("rules")
    if not isinstance(rules, list) or len(rules) > MAX_STATE_RULES:
        validation.error(f"behaviors.pet.stateMachine.rules must be an array of at most {MAX_STATE_RULES} entries")
        rules = []
    rule_ids: set[str] = set()
    for index, raw_rule in enumerate(rules):
        label = f"behaviors.pet.stateMachine.rules[{index}]"
        rule = expect_object(validation, raw_rule, label)
        if rule is None:
            continue
        allowed_keys(validation, rule, {"id", "priority", "when", "set"}, label)
        rule_id = validate_state_id(validation, rule.get("id"), f"{label}.id")
        if rule_id in rule_ids:
            validation.error(f"{label}.id is duplicated")
        if rule_id is not None:
            rule_ids.add(rule_id)
        if not isinstance(rule.get("priority"), int) or isinstance(rule.get("priority"), bool) \
                or not 0 <= rule["priority"] <= 999:
            validation.error(f"{label}.priority must be an integer from 0 through 999")
        condition = expect_object(validation, rule.get("when"), f"{label}.when")
        if condition is not None:
            allowed_keys(validation, condition, {"scene", "idleForMs", "dailyWindow"}, f"{label}.when")
            if not condition:
                validation.error(f"{label}.when cannot be empty")
            if "scene" in condition and condition["scene"] not in {"work", "pet"}:
                validation.error(f"{label}.when.scene must be work or pet")
            if "idleForMs" in condition and not is_timer(condition["idleForMs"], allow_zero=True):
                validation.error(f"{label}.when.idleForMs is invalid")
            if "dailyWindow" in condition:
                validate_daily_state_window(validation, condition["dailyWindow"], f"{label}.when.dailyWindow")
        validate_state_value_map(validation, rule.get("set"), dimensions, f"{label}.set", False)
    return dimensions


def validate_state_effect(
    validation: Validation,
    raw: Any,
    dimensions: dict[str, set[str]],
    label: str,
) -> None:
    effect = expect_object(validation, raw, label)
    if effect is None:
        return
    if not dimensions:
        validation.error(f"{label} requires behaviors.pet.stateMachine")
        return
    allowed_keys(validation, effect, {"when", "priority", "set", "lifetime"}, label)
    if effect.get("when", "finished") not in {"started", "finished"}:
        validation.error(f"{label}.when must be started or finished")
    priority = effect.get("priority", 0)
    if not isinstance(priority, int) or isinstance(priority, bool) or not 0 <= priority <= 99:
        validation.error(f"{label}.priority must be an integer from 0 through 99")
    validate_state_value_map(validation, effect.get("set"), dimensions, f"{label}.set", False)
    lifetime = effect.get("lifetime", {"type": "session"})
    config = expect_object(validation, lifetime, f"{label}.lifetime")
    if config is None:
        return
    lifetime_type = config.get("type")
    if lifetime_type in {"session", "until-input"}:
        allowed_keys(validation, config, {"type"}, f"{label}.lifetime")
    elif lifetime_type == "duration":
        allowed_keys(validation, config, {"type", "durationMs"}, f"{label}.lifetime")
        if not is_timer(config.get("durationMs")):
            validation.error(f"{label}.lifetime.durationMs must be positive")
    else:
        validation.error(f"{label}.lifetime.type is unsupported")


def validate_state_animations(
    validation: Validation,
    raw: Any,
    dimensions: dict[str, set[str]],
    top_animations: dict[str, dict[str, Any]],
    local_animations: dict[str, dict[str, Any]],
    label: str,
) -> None:
    """校验动作的形态选图；它只改变播放资源，不改变动作调度或状态副作用。"""

    if not dimensions:
        validation.error(f"{label} requires behaviors.pet.stateMachine")
        return
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_STATE_ANIMATION_VARIANTS:
        validation.error(
            f"{label} must contain 1-{MAX_STATE_ANIMATION_VARIANTS} variants"
        )
        return

    for index, raw_variant in enumerate(raw):
        variant_label = f"{label}[{index}]"
        variant = expect_object(validation, raw_variant, variant_label)
        if variant is None:
            continue
        allowed_keys(validation, variant, {"priority", "match", "animation"}, variant_label)
        priority = variant.get("priority", 0)
        if not isinstance(priority, int) or isinstance(priority, bool) or not 0 <= priority <= 99:
            validation.error(f"{variant_label}.priority must be an integer from 0 through 99")
        validate_state_value_map(
            validation,
            variant.get("match"),
            dimensions,
            f"{variant_label}.match",
            False,
        )

        animation_ref = variant.get("animation")
        if not isinstance(animation_ref, str):
            validation.error(f"{variant_label}.animation must be a string")
        elif animation_ref.startswith("@model/"):
            target = animation_ref.removeprefix("@model/")
            animation = top_animations.get(target)
            if not target or "/" in target or animation is None:
                validation.error(f"{variant_label}.animation has an unknown @model reference")
            elif animation.get("loop") is True:
                validation.error(f"{variant_label}.animation must be non-looping")
        elif animation_ref not in local_animations:
            validation.error(f"{variant_label}.animation references an unknown local animation")
        elif local_animations[animation_ref].get("loop") is True:
            validation.error(f"{variant_label}.animation must be non-looping")


def validate_state_dialogues(
    validation: Validation,
    raw: Any,
    dimensions: dict[str, set[str]],
    label: str,
) -> None:
    """校验按人物状态选择的对白；具体文本仍复用普通 dialogue 的完整契约。"""

    if not dimensions:
        validation.error(f"{label} requires behaviors.pet.stateMachine")
        return
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_STATE_DIALOGUE_VARIANTS:
        validation.error(f"{label} must contain 1-{MAX_STATE_DIALOGUE_VARIANTS} variants")
        return

    for index, raw_variant in enumerate(raw):
        variant_label = f"{label}[{index}]"
        variant = expect_object(validation, raw_variant, variant_label)
        if variant is None:
            continue
        allowed_keys(validation, variant, {"priority", "match", "dialogue"}, variant_label)
        priority = variant.get("priority", 0)
        if not isinstance(priority, int) or isinstance(priority, bool) or not 0 <= priority <= 99:
            validation.error(f"{variant_label}.priority must be an integer from 0 through 99")
        validate_state_value_map(
            validation,
            variant.get("match"),
            dimensions,
            f"{variant_label}.match",
            False,
        )
        validate_dialogue(
            validation,
            variant.get("dialogue"),
            f"{variant_label}.dialogue",
            getattr(validation, "canvas"),
        )


def validate_module(
    validation: Validation,
    module_path: Path,
    top_animations: dict[str, dict[str, Any]],
    hit_areas: set[str],
    state_dimensions: dict[str, set[str]],
    input_action_refs: set[str],
) -> tuple[str | None, set[str]]:
    module = load_json(validation, module_path, MAX_MODULE_BYTES, f"module {module_path}")
    if module is None:
        return None, set()
    allowed_keys(validation, module, {"version", "id", "displayName", "order", "animations", "actions", "triggers"}, f"module {module_path}")
    if module.get("version") != 1:
        validation.error(f"module {module_path}.version must be 1")
    module_id = validate_id(validation, module.get("id"), f"module {module_path}.id")
    validate_localized(validation, module.get("displayName"), f"module {module_path}.displayName")
    if module_id is None:
        module_id = f"invalid-{len(validation.errors)}"

    raw_animations = module.get("animations", {})
    if not isinstance(raw_animations, dict):
        validation.error(f"module {module_id}.animations must be an object")
        raw_animations = {}
    if len(raw_animations) > MAX_MODULE_ANIMATIONS:
        validation.error(f"module {module_id} exceeds {MAX_MODULE_ANIMATIONS} animations")
    local_animations: dict[str, dict[str, Any]] = {}
    for local_id, raw_animation in raw_animations.items():
        validate_id(validation, local_id, f"module {module_id} animation id")
        qualified = f"{module_id}/{local_id}"
        animation = validate_animation(validation, local_id, raw_animation, module_path.parent, qualified)
        if animation is not None:
            local_animations[local_id] = animation

    raw_actions = module.get("actions")
    if not isinstance(raw_actions, dict) or not raw_actions:
        validation.error(f"module {module_id}.actions must be a non-empty object")
        raw_actions = {}
    if len(raw_actions) > MAX_MODULE_ACTIONS:
        validation.error(f"module {module_id} exceeds {MAX_MODULE_ACTIONS} actions")
    actions: set[str] = set()
    for action_id, raw_action in raw_actions.items():
        validate_id(validation, action_id, f"module {module_id} action id")
        action = expect_object(validation, raw_action, f"module {module_id}.actions.{action_id}")
        if action is None:
            continue
        allowed_keys(validation, action, {"label", "animation", "priority", "cooldownMs", "interruptible", "dialogue", "audio", "stateEffect", "stateAnimations", "stateDialogues"}, f"module {module_id}.actions.{action_id}")
        actions.add(action_id)
        if "label" in action:
            validate_localized(validation, action["label"], f"module {module_id}.actions.{action_id}.label")
        animation_ref = action.get("animation")
        if animation_ref is not None:
            if not isinstance(animation_ref, str):
                validation.error(f"module {module_id}.actions.{action_id}.animation must be a string")
            elif animation_ref.startswith("@model/"):
                target = animation_ref.removeprefix("@model/")
                animation = top_animations.get(target)
                if not target or "/" in target or animation is None:
                    validation.error(f"module {module_id}.actions.{action_id}.animation has an unknown @model reference")
                elif animation.get("loop") is True:
                    validation.error(f"module {module_id}.actions.{action_id}.animation must be non-looping")
            elif animation_ref not in local_animations:
                validation.error(f"module {module_id}.actions.{action_id}.animation references an unknown local animation")
            elif local_animations[animation_ref].get("loop") is True:
                validation.error(f"module {module_id}.actions.{action_id}.animation must be non-looping")
        has_dialogue = "dialogue" in action and validate_dialogue(
            validation,
            action["dialogue"],
            f"module {module_id}.actions.{action_id}.dialogue",
            getattr(validation, "canvas"),
        )
        if "audio" in action:
            validate_audio(
                validation,
                action["audio"],
                f"module {module_id}.actions.{action_id}.audio",
                module_path.parent,
            )
        if animation_ref is None and not has_dialogue:
            validation.error(f"module {module_id}.actions.{action_id} needs animation or dialogue")
        priority = action.get("priority", 0)
        if not isinstance(priority, int) or isinstance(priority, bool) or not 0 <= priority <= 99:
            validation.error(f"module {module_id}.actions.{action_id}.priority must be an integer from 0 through 99")
        if not is_timer(action.get("cooldownMs", 0), allow_zero=True):
            validation.error(f"module {module_id}.actions.{action_id}.cooldownMs is invalid")
        if "interruptible" in action and not isinstance(action["interruptible"], bool):
            validation.error(f"module {module_id}.actions.{action_id}.interruptible must be boolean")
        if "stateEffect" in action:
            validate_state_effect(
                validation,
                action["stateEffect"],
                state_dimensions,
                f"module {module_id}.actions.{action_id}.stateEffect",
            )
        if "stateAnimations" in action:
            validate_state_animations(
                validation,
                action["stateAnimations"],
                state_dimensions,
                top_animations,
                local_animations,
                f"module {module_id}.actions.{action_id}.stateAnimations",
            )
        if "stateDialogues" in action:
            validate_state_dialogues(
                validation,
                action["stateDialogues"],
                state_dimensions,
                f"module {module_id}.actions.{action_id}.stateDialogues",
            )

    raw_triggers = module.get("triggers")
    if not isinstance(raw_triggers, list) or not raw_triggers:
        validation.error(f"module {module_id}.triggers must be a non-empty array")
        raw_triggers = []
    if len(raw_triggers) > MAX_MODULE_TRIGGERS:
        validation.error(f"module {module_id} exceeds {MAX_MODULE_TRIGGERS} triggers")
    trigger_ids: set[str] = set()
    referenced_actions: set[str] = set()
    for index, raw_trigger in enumerate(raw_triggers):
        if isinstance(raw_trigger, dict):
            trigger_id = raw_trigger.get("id")
            if isinstance(trigger_id, str):
                if trigger_id in trigger_ids:
                    validation.error(f"module {module_id}.triggers[{index}].id is duplicated")
                trigger_ids.add(trigger_id)
        referenced_actions |= validate_trigger(
            validation,
            raw_trigger,
            f"module {module_id}.triggers[{index}]",
            actions,
            hit_areas,
        )
    input_referenced_actions = {
        action_id for action_id in actions
        if f"{module_id}/{action_id}" in input_action_refs
    }
    for action_id in sorted(actions - referenced_actions - input_referenced_actions):
        # The runtime schema permits dormant actions, so keep the package valid while making
        # the menu/behavior omission explicit. New deliverables should resolve this warning.
        validation.warning(
            f"module {module_id}.actions.{action_id} has no trigger and will not appear or run"
        )
    validation.module_actions += len(actions)
    validation.module_triggers += len(raw_triggers)
    return module_id, {f"{module_id}/{action_id}" for action_id in actions}


def validate_bindings(
    validation: Validation,
    model: dict[str, Any],
    top_animations: dict[str, dict[str, Any]],
) -> None:
    bindings = model.get("bindings", {})
    if not isinstance(bindings, dict):
        validation.error("model.bindings must be an object")
        return
    for kind in ("keyboard", "mouse"):
        values = bindings.get(kind, {})
        if not isinstance(values, dict):
            validation.error(f"model.bindings.{kind} must be an object")
            continue
        for key, raw_target in values.items():
            targets = raw_target if isinstance(raw_target, list) else [raw_target]
            if (
                not key.strip()
                or not targets
                or any(
                    not isinstance(target, str) or target not in top_animations
                    for target in targets
                )
            ):
                validation.error(
                    f"model.bindings.{kind}.{key} references an unknown top-level animation"
                )


def validate_input_actions(validation: Validation, pet: dict[str, Any]) -> set[str]:
    """Validate behavior-level input bindings and return qualified module action refs."""

    raw_input_actions = pet.get("inputActions")
    if raw_input_actions is None:
        return set()
    input_actions = expect_object(validation, raw_input_actions, "behaviors.pet.inputActions")
    if input_actions is None:
        return set()
    allowed_keys(validation, input_actions, {"keyboard"}, "behaviors.pet.inputActions")
    keyboard = input_actions.get("keyboard", {})
    if not isinstance(keyboard, dict):
        validation.error("behaviors.pet.inputActions.keyboard must be an object")
        return set()
    if len(keyboard) > MAX_INPUT_ACTIONS:
        validation.error(
            f"behaviors.pet.inputActions.keyboard exceeds {MAX_INPUT_ACTIONS} bindings"
        )

    references: set[str] = set()
    for key, action_id in keyboard.items():
        if not isinstance(key, str) or not key.strip():
            validation.error("behaviors.pet.inputActions.keyboard keys must be non-empty strings")
            continue
        if not isinstance(action_id, str) or not action_id.strip():
            validation.error(
                f"behaviors.pet.inputActions.keyboard.{key} must reference a module action"
            )
            continue
        references.add(action_id)
    return references


def validate_package(model_dir: Path) -> Validation:
    validation = Validation(model_dir)
    if not model_dir.is_dir():
        validation.error(f"model directory does not exist: {model_dir}")
        return validation
    if model_dir.is_symlink():
        validation.error("model directory cannot be a symbolic link")
    for path in model_dir.rglob("*"):
        if path.is_symlink():
            validation.error(f"package contains a symbolic link: {path.relative_to(model_dir)}")
        elif path.exists() and not (path.is_file() or path.is_dir()):
            mode = stat.S_IFMT(path.stat(follow_symlinks=False).st_mode)
            validation.error(f"package contains a special file ({mode}): {path.relative_to(model_dir)}")

    model = load_json(validation, model_dir / "model.json", MAX_MODEL_BYTES, "model.json")
    if model is None:
        return validation
    if model.get("renderer") != "sprite":
        validation.error('model.renderer must equal "sprite"')
    validate_id(validation, model.get("id"), "model.id")
    if not isinstance(model.get("displayName"), str) or not model["displayName"].strip():
        validation.error("model.displayName must be a non-empty string")
    canvas = model.get("canvas")
    if not isinstance(canvas, dict) or not is_positive(canvas.get("width")) or not is_positive(canvas.get("height")):
        validation.error("model.canvas width and height must be positive")
        canvas_size = (0.0, 0.0)
    else:
        canvas_size = (float(canvas["width"]), float(canvas["height"]))
    setattr(validation, "canvas", canvas_size)

    raw_animations = model.get("animations")
    if not isinstance(raw_animations, dict) or not raw_animations:
        validation.error("model.animations must be a non-empty object")
        raw_animations = {}
    top_animations: dict[str, dict[str, Any]] = {}
    for name, raw_animation in raw_animations.items():
        animation = validate_animation(validation, name, raw_animation, model_dir, name)
        if animation is not None:
            top_animations[name] = animation
    if model.get("defaultAnimation") not in top_animations:
        validation.error("model.defaultAnimation references an unknown top-level animation")
    validate_bindings(validation, model, top_animations)

    cover = model_dir / "resources" / "cover.png"
    if not cover.is_file() or cover.is_symlink():
        validation.error("resources/cover.png is required and must be a regular file")
    else:
        try:
            with Image.open(cover) as image:
                image.verify()
        except (OSError, ValueError) as error:
            validation.error(f"resources/cover.png cannot be decoded: {error}")
    if not (model_dir / "references" / "canonical-base.png").is_file():
        validation.warning("references/canonical-base.png is missing; reproducible action repair will be harder")

    behaviors = model.get("behaviors")
    pet = behaviors.get("pet") if isinstance(behaviors, dict) else None
    if not isinstance(pet, dict):
        validation.error("model.behaviors.pet is required for action modules")
        pet = {}
    if not is_timer(pet.get("activationDelayMs")):
        validation.error("behaviors.pet.activationDelayMs must be positive")
    lifecycle = {
        "enterAnimation": False,
        "idleAnimation": True,
        "exitAnimation": False,
    }
    for field, should_loop in lifecycle.items():
        target = pet.get(field)
        animation = top_animations.get(target)
        if animation is None:
            validation.error(f"behaviors.pet.{field} references an unknown top-level animation")
        elif animation.get("loop") is not should_loop:
            validation.error(f"behaviors.pet.{field} loop must be {str(should_loop).lower()}")
    hit_areas = validate_hit_areas(validation, pet.get("hitAreas"), canvas_size)
    state_dimensions = validate_state_machine(validation, pet.get("stateMachine"), top_animations)
    input_action_refs = validate_input_actions(validation, pet)

    references = pet.get("modules")
    if not isinstance(references, list) or not references:
        validation.error("behaviors.pet.modules must be a non-empty array")
        references = []
    if len(references) > MAX_MODULES:
        validation.error(f"behaviors.pet.modules exceeds {MAX_MODULES}")
    sources: set[str] = set()
    module_ids: set[str] = set()
    module_action_ids: set[str] = set()
    for index, raw_reference in enumerate(references):
        label = f"behaviors.pet.modules[{index}]"
        reference = expect_object(validation, raw_reference, label)
        if reference is None:
            continue
        allowed_keys(validation, reference, {"source", "enabled"}, label)
        if "enabled" in reference and not isinstance(reference["enabled"], bool):
            validation.error(f"{label}.enabled must be boolean")
        if reference.get("enabled") is False:
            continue
        source = reference.get("source")
        if isinstance(source, str) and source.lower() in sources:
            validation.error(f"{label}.source is duplicated")
            continue
        if isinstance(source, str):
            sources.add(source.lower())
        module_path = resolve_asset(validation, model_dir, source, f"{label}.source")
        if module_path is None:
            continue
        if module_path.suffix.lower() != ".json":
            validation.error(f"{label}.source must reference JSON")
            continue
        module_id, action_ids = validate_module(
            validation,
            module_path,
            top_animations,
            hit_areas,
            state_dimensions,
            input_action_refs,
        )
        if module_id in module_ids:
            validation.error(f"module id {module_id!r} is duplicated")
        if module_id is not None:
            module_ids.add(module_id)
        module_action_ids.update(action_ids)

    for action_id in sorted(input_action_refs - module_action_ids):
        # Runtime bindings target normalized "module/action" ids. Failing package validation here
        # prevents an apparently clickable key from becoming a silent no-op after import.
        validation.error(
            f"behaviors.pet.inputActions references unknown module action {action_id!r}"
        )

    if len(validation.animations) > MAX_ANIMATIONS:
        validation.error(f"model has {len(validation.animations)} animations; maximum is {MAX_ANIMATIONS}")
    if len(validation.audio_files) > MAX_AUDIO_FILES:
        validation.error(f"model has {len(validation.audio_files)} audio files; maximum is {MAX_AUDIO_FILES}")
    # 总像素继续写入报告供作者评估内存，但不拒绝大型可扩展模型；单张资源上限仍在 validate_animation 中执行。
    if validation.module_actions > MAX_TOTAL_ACTIONS:
        validation.error(f"model has more than {MAX_TOTAL_ACTIONS} module actions")
    if validation.module_triggers > MAX_TOTAL_TRIGGERS:
        validation.error(f"model has more than {MAX_TOTAL_TRIGGERS} module triggers")
    return validation


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model_dir", type=Path, help="Folder whose root contains model.json")
    parser.add_argument("--report", type=Path, help="Optional JSON report output")
    args = parser.parse_args()

    validation = validate_package(args.model_dir.resolve())
    result = validation.result()
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    print(rendered)

    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(rendered + "\n", encoding="utf-8")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
