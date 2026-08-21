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
MAX_SHEET_PIXELS = 16 * 1024 * 1024
MAX_TOTAL_PIXELS = 64 * 1024 * 1024
MAX_TIMER = 2_147_483_647
SAFE_ID = re.compile(r"^[\da-z][\w.-]*$", re.ASCII)
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


def validate_module(
    validation: Validation,
    module_path: Path,
    top_animations: dict[str, dict[str, Any]],
    hit_areas: set[str],
) -> str | None:
    module = load_json(validation, module_path, MAX_MODULE_BYTES, f"module {module_path}")
    if module is None:
        return None
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
        allowed_keys(validation, action, {"label", "animation", "priority", "cooldownMs", "interruptible", "dialogue"}, f"module {module_id}.actions.{action_id}")
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
        if animation_ref is None and not has_dialogue:
            validation.error(f"module {module_id}.actions.{action_id} needs animation or dialogue")
        priority = action.get("priority", 0)
        if not isinstance(priority, int) or isinstance(priority, bool) or not 0 <= priority <= 99:
            validation.error(f"module {module_id}.actions.{action_id}.priority must be an integer from 0 through 99")
        if not is_timer(action.get("cooldownMs", 0), allow_zero=True):
            validation.error(f"module {module_id}.actions.{action_id}.cooldownMs is invalid")
        if "interruptible" in action and not isinstance(action["interruptible"], bool):
            validation.error(f"module {module_id}.actions.{action_id}.interruptible must be boolean")

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
    for action_id in sorted(actions - referenced_actions):
        # The runtime schema permits dormant actions, so keep the package valid while making
        # the menu/behavior omission explicit. New deliverables should resolve this warning.
        validation.warning(
            f"module {module_id}.actions.{action_id} has no trigger and will not appear or run"
        )
    validation.module_actions += len(actions)
    validation.module_triggers += len(raw_triggers)
    return module_id


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

    references = pet.get("modules")
    if not isinstance(references, list) or not references:
        validation.error("behaviors.pet.modules must be a non-empty array")
        references = []
    if len(references) > MAX_MODULES:
        validation.error(f"behaviors.pet.modules exceeds {MAX_MODULES}")
    sources: set[str] = set()
    module_ids: set[str] = set()
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
        module_id = validate_module(validation, module_path, top_animations, hit_areas)
        if module_id in module_ids:
            validation.error(f"module id {module_id!r} is duplicated")
        if module_id is not None:
            module_ids.add(module_id)

    if len(validation.animations) > MAX_ANIMATIONS:
        validation.error(f"model has {len(validation.animations)} animations; maximum is {MAX_ANIMATIONS}")
    if validation.total_pixels > MAX_TOTAL_PIXELS:
        validation.error(
            f"model uses {validation.total_pixels} sprite pixels; maximum is {MAX_TOTAL_PIXELS}"
        )
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
