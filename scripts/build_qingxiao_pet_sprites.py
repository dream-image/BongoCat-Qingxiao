#!/usr/bin/env python3

import argparse
import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont


FRAME_SIZE = 512
SCALE = 4


@dataclass(frozen=True)
class AnimationSpec:
    # 同一份规格同时驱动出图和验收，避免“生成脚本已改、独立门仍按旧约定检查”的漂移。
    name: str
    frames: list[np.ndarray]
    durations: list[int]
    columns: int = 4
    loop: bool = False
    endpoint: str = 'pet'
    symmetric: bool = True
    allowed_character_mask: np.ndarray | None = None
    require_two_hands: bool = False
    # effect-free 人物层用于排除法球、水线等外部特效；手部验收不能拿最终合成帧冒充肢体运动。
    character_frames: list[np.ndarray] | None = None
    left_hand_mask: np.ndarray | None = None
    right_hand_mask: np.ndarray | None = None
    right_hand_presence_mask: np.ndarray | None = None
    minimum_left_hand_poses: int = 0
    minimum_right_hand_poses: int = 0
    enforce_single_left_hand_component: bool = False
    enforce_single_right_hand_component: bool = False
    maximum_left_hand_skin_pixels: int | None = None
    allow_non_peak_hand_holds: bool = False
    # 眼态按逐帧契约验证；允许变化的脸部 ROI 并不等于这一帧允许闭眼。
    expected_eye_frames: list[np.ndarray] | None = None
    eye_mask: np.ndarray | None = None
    # 质心约束位移、轮廓 XOR 约束袖型，两道门缺一都会漏掉视觉跳帧。
    centroid_left_hand_mask: np.ndarray | None = None
    centroid_right_hand_mask: np.ndarray | None = None
    maximum_hand_centroid_jump: float | None = None
    maximum_hand_silhouette_xor_ratio: float | None = None


def split_sheet(path: Path, frames: int, columns: int) -> list[np.ndarray]:
    sheet = Image.open(path).convert('RGBA')
    expected_size = (FRAME_SIZE * columns, FRAME_SIZE * math.ceil(frames / columns))
    if sheet.size != expected_size:
        raise ValueError(f'{path} must be {expected_size[0]}x{expected_size[1]}, got {sheet.size[0]}x{sheet.size[1]}')
    return [
        np.array(
            sheet.crop(
                (
                    index % columns * FRAME_SIZE,
                    index // columns * FRAME_SIZE,
                    (index % columns + 1) * FRAME_SIZE,
                    (index // columns + 1) * FRAME_SIZE,
                )
            ),
            dtype=np.uint8,
        )
        for index in range(frames)
    ]


def compose_sheet(frames: list[np.ndarray], columns: int) -> Image.Image:
    rows = math.ceil(len(frames) / columns)
    sheet = Image.new('RGBA', (FRAME_SIZE * columns, FRAME_SIZE * rows), (0, 0, 0, 0))
    for index, frame in enumerate(frames):
        sheet.alpha_composite(
            Image.fromarray(frame, 'RGBA'),
            ((index % columns) * FRAME_SIZE, (index // columns) * FRAME_SIZE),
        )
    return sheet


def clean_transparent_rgb(image: np.ndarray) -> np.ndarray:
    # 透明像素的隐藏 RGB 会让无损解码、哈希和后续插值出现不可见但不稳定的差异，统一归零。
    output = image.copy()
    output[output[:, :, 3] == 0, :3] = 0
    return output


def changed_mask(left: np.ndarray, right: np.ndarray) -> np.ndarray:
    return np.any(left != right, axis=2)


def skin_mask(frame: np.ndarray) -> np.ndarray:
    # 这里只做清宵素材内部的手部追踪启发式，不把肤色阈值当成人物分割或通用肤色判断。
    rgb = frame[:, :, :3].astype(np.int16)
    red, green, blue = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    return (
        (frame[:, :, 3] > 0)
        & (red >= 180)
        & (green >= 120)
        & (blue >= 100)
        & (red >= green)
        & (red - blue >= 12)
        & (red - green <= 80)
        & (green - blue >= -5)
        & (green - blue <= 80)
    )


def connected_components(mask: np.ndarray, minimum_pixels: int) -> list[list[tuple[int, int]]]:
    seen = np.zeros(mask.shape, dtype=bool)
    components: list[list[tuple[int, int]]] = []
    height, width = mask.shape
    for y, x in zip(*np.where(mask)):
        if seen[y, x]:
            continue
        stack = [(int(y), int(x))]
        seen[y, x] = True
        component: list[tuple[int, int]] = []
        while stack:
            current_y, current_x = stack.pop()
            component.append((current_y, current_x))
            for delta_y, delta_x in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                next_y = current_y + delta_y
                next_x = current_x + delta_x
                if (
                    0 <= next_y < height
                    and 0 <= next_x < width
                    and mask[next_y, next_x]
                    and not seen[next_y, next_x]
                ):
                    seen[next_y, next_x] = True
                    stack.append((next_y, next_x))
        if len(component) >= minimum_pixels:
            components.append(component)
    return components


def hand_skin_component_count(frame: np.ndarray, canonical: np.ndarray, corridor: np.ndarray) -> int:
    active_skin = skin_mask(frame) & corridor & changed_mask(frame, canonical)
    cleaned = np.zeros(active_skin.shape, dtype=np.uint8)
    # 80/101/150 均按清宵 512px 素材标定：先滤掉抗锯齿碎点，再跨袖口合并同一只手，
    # 最后排除脸部、衣服等较大的非手部区域，避免把噪点或身体误判为额外肢体。
    for component in connected_components(active_skin, 80):
        ys, xs = zip(*component)
        cleaned[ys, xs] = 255
    if not np.any(cleaned):
        return 0
    merged = np.asarray(
        Image.fromarray(cleaned, 'L').filter(ImageFilter.MaxFilter(101)),
        dtype=np.uint8,
    ) > 0
    return len(connected_components(merged, 150))


def primary_hand_skin_centroid(
    frame: np.ndarray,
    corridor: np.ndarray,
) -> tuple[float, float] | None:
    # 端点 canonical 没有 changed pixels，必须直接跟踪走廊内最大的绝对肤色组件；
    # 40px 是清宵 512px 帧上可稳定保留真实手部、同时滤掉抗锯齿碎片的下限；
    # 否则 canonical→首动作会被记成 None 并跳过，48px 以上的切入突跳也能误过门。
    components = connected_components(skin_mask(frame) & corridor, 40)
    if not components:
        return None
    primary = max(components, key=len)
    ys = np.asarray([point[0] for point in primary], dtype=np.float64)
    xs = np.asarray([point[1] for point in primary], dtype=np.float64)
    return float(xs.mean()), float(ys.mean())


def ellipse_mask(boxes: list[tuple[int, int, int, int]]) -> np.ndarray:
    mask = Image.new('L', (FRAME_SIZE, FRAME_SIZE), 0)
    draw = ImageDraw.Draw(mask)
    for box in boxes:
        draw.ellipse(box, fill=255)
    return np.asarray(mask, dtype=np.uint8) > 0


def polygon_mask(points: list[tuple[int, int]], grow: int = 0) -> np.ndarray:
    mask = Image.new('L', (FRAME_SIZE, FRAME_SIZE), 0)
    ImageDraw.Draw(mask).polygon(points, fill=255)
    if grow:
        mask = mask.filter(ImageFilter.MaxFilter(grow * 2 + 1))
    return np.asarray(mask, dtype=np.uint8) > 0


def rect_mask(box: tuple[int, int, int, int]) -> np.ndarray:
    mask = Image.new('L', (FRAME_SIZE, FRAME_SIZE), 0)
    ImageDraw.Draw(mask).rectangle(box, fill=255)
    return np.asarray(mask, dtype=np.uint8) > 0


def alpha_bbox(frame: np.ndarray) -> tuple[int, int, int, int] | None:
    return Image.fromarray(frame[:, :, 3], 'L').getbbox()


def effect_canvas() -> Image.Image:
    return Image.new('RGBA', (FRAME_SIZE * SCALE, FRAME_SIZE * SCALE), (0, 0, 0, 0))


def scaled_box(box: tuple[float, float, float, float]) -> tuple[int, int, int, int]:
    return tuple(round(value * SCALE) for value in box)


def draw_cloud(
    layer: Image.Image,
    center: tuple[float, float],
    size: float,
    opacity: float,
    tint: tuple[int, int, int] = (226, 252, 255),
) -> None:
    if opacity <= 0:
        return

    cx, cy = center
    glow = effect_canvas()
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse(
        scaled_box((cx - size * 1.1, cy - size * 0.75, cx + size * 1.1, cy + size * 0.75)),
        fill=(77, 222, 255, round(95 * opacity)),
    )
    layer.alpha_composite(glow.filter(ImageFilter.GaussianBlur(round(5 * SCALE))))

    body = effect_canvas()
    draw = ImageDraw.Draw(body)
    circles = [
        (-0.48, 0.06, 0.52),
        (-0.12, -0.24, 0.62),
        (0.27, -0.15, 0.56),
        (0.52, 0.10, 0.42),
    ]
    fill = (*tint, round(225 * opacity))
    outline = (82, 207, 235, round(225 * opacity))
    width = max(1, round(1.5 * SCALE))
    for offset_x, offset_y, radius in circles:
        local_x = cx + offset_x * size
        local_y = cy + offset_y * size
        local_r = radius * size
        draw.ellipse(
            scaled_box((local_x - local_r, local_y - local_r, local_x + local_r, local_y + local_r)),
            fill=fill,
            outline=outline,
            width=width,
        )
    draw.ellipse(
        scaled_box((cx - size * 0.66, cy - size * 0.12, cx + size * 0.70, cy + size * 0.52)),
        fill=fill,
        outline=outline,
        width=width,
    )
    draw.ellipse(
        scaled_box((cx - size * 0.28, cy - size * 0.32, cx + size * 0.04, cy - size * 0.10)),
        fill=(255, 255, 255, round(185 * opacity)),
    )
    layer.alpha_composite(body)


def draw_wisp(layer: Image.Image, strength: float, phase: float = 0) -> None:
    if strength <= 0:
        return

    angle = phase * math.tau
    cx = 386 + math.sin(angle) * 3
    cy = 174 - math.sin(angle) * 4
    size = 14 + (1 - math.cos(angle)) * 1.2
    draw_cloud(layer, (cx, cy), size, strength * (0.82 + math.sin(angle) * 0.08))

    points = []
    for index in range(28):
        t = index / 27
        x = cx - size * 0.55 - t * 24 + math.sin(t * math.pi * 2) * 4
        y = cy + size * 0.20 + t * 32 - math.sin(t * math.pi) * 5
        points.append((round(x * SCALE), round(y * SCALE)))
    glow = effect_canvas()
    ImageDraw.Draw(glow).line(points, fill=(64, 222, 255, round(90 * strength)), width=round(5 * SCALE))
    layer.alpha_composite(glow.filter(ImageFilter.GaussianBlur(round(4 * SCALE))))
    ImageDraw.Draw(layer).line(
        points,
        fill=(191, 249, 255, round(205 * strength)),
        width=round(1.5 * SCALE),
        joint='curve',
    )


def draw_sparkle(layer: Image.Image, center: tuple[float, float], size: float, opacity: float) -> None:
    if opacity <= 0:
        return
    cx, cy = center
    points = [
        (cx, cy - size),
        (cx + size * 0.22, cy - size * 0.22),
        (cx + size, cy),
        (cx + size * 0.22, cy + size * 0.22),
        (cx, cy + size),
        (cx - size * 0.22, cy + size * 0.22),
        (cx - size, cy),
        (cx - size * 0.22, cy - size * 0.22),
    ]
    glow = effect_canvas()
    ImageDraw.Draw(glow).polygon(
        [(round(x * SCALE), round(y * SCALE)) for x, y in points],
        fill=(80, 228, 255, round(130 * opacity)),
    )
    layer.alpha_composite(glow.filter(ImageFilter.GaussianBlur(round(4 * SCALE))))
    ImageDraw.Draw(layer).polygon(
        [(round(x * SCALE), round(y * SCALE)) for x, y in points],
        fill=(245, 255, 255, round(235 * opacity)),
        outline=(87, 216, 242, round(230 * opacity)),
    )


def draw_heart(layer: Image.Image, center: tuple[float, float], size: float, opacity: float) -> None:
    if opacity <= 0:
        return
    cx, cy = center
    mask = Image.new('L', layer.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse(scaled_box((cx - size, cy - size * 0.62, cx, cy + size * 0.38)), fill=round(255 * opacity))
    draw.ellipse(scaled_box((cx, cy - size * 0.62, cx + size, cy + size * 0.38)), fill=round(255 * opacity))
    draw.polygon(
        [
            (round((cx - size) * SCALE), round((cy - size * 0.1) * SCALE)),
            (round((cx + size) * SCALE), round((cy - size * 0.1) * SCALE)),
            (round(cx * SCALE), round((cy + size * 1.3) * SCALE)),
        ],
        fill=round(255 * opacity),
    )
    glow = Image.new('RGBA', layer.size, (80, 220, 255, 0))
    glow.putalpha(mask.filter(ImageFilter.GaussianBlur(round(4 * SCALE))))
    layer.alpha_composite(glow)
    body = Image.new('RGBA', layer.size, (226, 252, 255, 0))
    body.putalpha(mask)
    layer.alpha_composite(body)


def draw_crescent(layer: Image.Image, center: tuple[float, float], size: float, opacity: float) -> None:
    if opacity <= 0:
        return
    cx, cy = center
    mask = Image.new('L', layer.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse(scaled_box((cx - size, cy - size, cx + size, cy + size)), fill=round(235 * opacity))
    draw.ellipse(
        scaled_box((cx - size * 0.25, cy - size * 1.05, cx + size * 1.05, cy + size * 0.55)),
        fill=0,
    )
    glow = Image.new('RGBA', layer.size, (74, 222, 255, 0))
    glow.putalpha(mask.filter(ImageFilter.GaussianBlur(round(5 * SCALE))))
    layer.alpha_composite(glow)
    body = Image.new('RGBA', layer.size, (231, 253, 255, 0))
    body.putalpha(mask)
    layer.alpha_composite(body)


def draw_note(layer: Image.Image, center: tuple[float, float], size: float, opacity: float, mirrored: bool) -> None:
    if opacity <= 0:
        return
    cx, cy = center
    direction = -1 if mirrored else 1
    draw = ImageDraw.Draw(layer)
    color = (209, 252, 255, round(230 * opacity))
    outline = (67, 210, 241, round(220 * opacity))
    width = max(1, round(2 * SCALE))
    draw.ellipse(
        scaled_box((cx - size * 0.45, cy + size * 0.25, cx + size * 0.35, cy + size * 0.78)),
        fill=color,
        outline=outline,
        width=width,
    )
    x = round((cx + size * 0.28) * SCALE)
    draw.line(
        [(x, round((cy + size * 0.45) * SCALE)), (x, round((cy - size * 0.9) * SCALE))],
        fill=outline,
        width=width,
    )
    draw.arc(
        scaled_box(
            (
                cx + direction * size * 0.2 - size * 0.05,
                cy - size * 1.08,
                cx + direction * size * 0.2 + size * 0.9,
                cy - size * 0.25,
            )
        ),
        205 if mirrored else 15,
        340 if mirrored else 150,
        fill=outline,
        width=width,
    )


def draw_orb(layer: Image.Image, center: tuple[float, float], radius: float, opacity: float) -> None:
    if opacity <= 0:
        return

    cx, cy = center
    glow = effect_canvas()
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse(
        scaled_box((cx - radius * 1.35, cy - radius * 1.35, cx + radius * 1.35, cy + radius * 1.35)),
        fill=(62, 220, 255, round(120 * opacity)),
    )
    layer.alpha_composite(glow.filter(ImageFilter.GaussianBlur(round(7 * SCALE))))

    draw = ImageDraw.Draw(layer)
    width = max(1, round(1.6 * SCALE))
    draw.ellipse(
        scaled_box((cx - radius, cy - radius, cx + radius, cy + radius)),
        fill=(183, 247, 255, round(82 * opacity)),
        outline=(219, 254, 255, round(238 * opacity)),
        width=width,
    )
    draw.arc(
        scaled_box((cx - radius * 0.72, cy - radius * 0.42, cx + radius * 0.72, cy + radius * 0.70)),
        195,
        350,
        fill=(69, 212, 244, round(230 * opacity)),
        width=max(1, round(2.2 * SCALE)),
    )
    draw.arc(
        scaled_box((cx - radius * 0.58, cy - radius * 0.84, cx + radius * 0.58, cy + radius * 0.40)),
        15,
        170,
        fill=(250, 255, 255, round(215 * opacity)),
        width=width,
    )
    draw_sparkle(layer, (cx + radius * 0.74, cy - radius * 0.62), radius * 0.24, opacity)


def draw_water_trail(
    layer: Image.Image,
    progress: float,
    hand_anchor: tuple[float, float] | None = None,
) -> None:
    if progress <= 0:
        return

    hand_x, hand_y = hand_anchor or (156, 338)
    trail_y = max(310, min(354, hand_y))
    points = []
    for index in range(34):
        t = index / 33
        x = 76 + t * 352
        # 扫弦水线跟随当前 donor 的手位上下浮动，避免手已经移动但特效仍钉在旧坐标。
        y = trail_y - math.sin(t * math.pi) * (17 + progress * 6) + math.sin(t * math.tau * 2) * 2
        points.append((round(x * SCALE), round(y * SCALE)))

    glow = effect_canvas()
    ImageDraw.Draw(glow).line(
        points,
        fill=(45, 213, 255, round(120 * progress)),
        width=round(7 * SCALE),
        joint='curve',
    )
    layer.alpha_composite(glow.filter(ImageFilter.GaussianBlur(round(5 * SCALE))))
    ImageDraw.Draw(layer).line(
        points,
        fill=(208, 252, 255, round(225 * progress)),
        width=max(1, round(1.7 * SCALE)),
        joint='curve',
    )
    for index, t in enumerate((0.12, 0.36, 0.62, 0.86)):
        x = 76 + t * 352
        y = trail_y - math.sin(t * math.pi) * (17 + progress * 6)
        draw_sparkle(layer, (x, y - 7 - index % 2 * 5), 3.5 + index % 2, progress * (0.65 + index * 0.07))
    draw_sparkle(layer, (hand_x, trail_y - 7), 5.5, progress * 0.92)


def draw_reminder_cloud(layer: Image.Image, progress: float) -> None:
    if progress <= 0:
        return

    draw_cloud(layer, (392, 143), 19 + progress * 2, progress * 0.92)
    draw = ImageDraw.Draw(layer)
    color = (42, 161, 202, round(235 * progress))
    width = max(1, round(3 * SCALE))
    x = round(392 * SCALE)
    draw.line(
        [(x, round(131 * SCALE)), (x, round(145 * SCALE))],
        fill=color,
        width=width,
    )
    draw.ellipse(scaled_box((390.5, 150, 393.5, 153)), fill=color)


def draw_wave_marks(
    layer: Image.Image,
    progress: float,
    hand_anchor: tuple[float, float] | None = None,
) -> None:
    if progress <= 0:
        return

    hand_x, hand_y = hand_anchor or (92, 205)
    draw = ImageDraw.Draw(layer)
    color = (192, 249, 255, round(225 * progress))
    width = max(1, round(1.8 * SCALE))
    for index in range(3):
        inset = index * 7
        draw.arc(
            scaled_box(
                (
                    hand_x - 46 - inset,
                    hand_y - 25 - inset,
                    hand_x - 2 + inset,
                    hand_y + 23 + inset,
                )
            ),
            210,
            310,
            fill=color,
            width=width,
        )
    draw_sparkle(layer, (hand_x - 35, hand_y - 33), 6.5, progress)


def draw_hmph_puff(
    layer: Image.Image,
    progress: float,
) -> None:
    if progress <= 0:
        return

    # 哼气从嘴左侧出现并向左上漂；它的轨迹只依赖进度，不能随抬手 donor 跳动。
    puff_x = 292 + progress * 110
    puff_y = 272 - progress * 30
    draw_cloud(
        layer,
        (puff_x, puff_y),
        15 + progress * 11,
        progress * 0.96,
        tint=(239, 251, 255),
    )
    draw_cloud(
        layer,
        (puff_x - 24, puff_y + 8),
        8 + progress * 5,
        progress * 0.56,
        tint=(239, 251, 255),
    )
    draw = ImageDraw.Draw(layer)
    emphasis = (184, 246, 255, round(225 * progress))
    width = max(1, round(1.8 * SCALE))
    for offset in (0, 7):
        draw.arc(
            scaled_box((puff_x - 35 - offset, puff_y - 17 - offset, puff_x - 5 - offset, puff_y + 12)),
            205,
            315,
            fill=emphasis,
            width=width,
        )


def draw_blush(frame: np.ndarray, strength: float) -> np.ndarray:
    if strength <= 0:
        return frame.copy()
    overlay = effect_canvas()
    draw = ImageDraw.Draw(overlay)
    for cx in (219, 292):
        draw.ellipse(
            scaled_box((cx - 11, 252 - 4.5, cx + 11, 252 + 4.5)),
            fill=(255, 145, 168, round(72 * strength)),
        )
    overlay = overlay.filter(ImageFilter.GaussianBlur(round(2.2 * SCALE)))
    small = overlay.resize((FRAME_SIZE, FRAME_SIZE), Image.Resampling.LANCZOS)
    output = Image.alpha_composite(Image.fromarray(frame, 'RGBA'), small)
    return clean_transparent_rgb(np.array(output, dtype=np.uint8))


def effect_layer(
    kind: str,
    progress: float,
    phase: float = 0,
    anchor: tuple[float, float] | None = None,
) -> np.ndarray:
    layer = effect_canvas()
    draw_wisp(layer, 1 if kind != 'enter' else progress, phase)

    if kind == 'doze':
        for index, (x, y, size) in enumerate(((358, 151, 9), (383, 126, 11), (405, 96, 13))):
            local = max(0, min(1, progress * 2.2 - index * 0.48))
            draw_cloud(layer, (x, y), size * (0.78 + local * 0.22), local * 0.85)
    elif kind == 'dream':
        draw_crescent(layer, (394, 121), 17 + progress * 2, progress)
        draw_sparkle(layer, (359, 115), 6, progress * 0.9)
        draw_sparkle(layer, (420, 158), 4.5, progress * 0.72)
    elif kind == 'chime':
        draw_note(layer, (155, 312 - progress * 14), 13, progress, False)
        draw_note(layer, (370, 309 - progress * 20), 11, progress * 0.9, True)
        draw_sparkle(layer, (407, 272), 5, progress * 0.8)
    elif kind == 'curious':
        draw_sparkle(layer, (164, 162), 7, progress)
        draw_sparkle(layer, (351, 151), 8, progress)
        draw_cloud(layer, (391, 202), 9 + progress * 2, progress * 0.72)
    elif kind == 'content':
        draw_heart(layer, (161, 178 - progress * 7), 9 + progress * 2, progress)
        draw_heart(layer, (363, 190 - progress * 11), 12 + progress * 2, progress * 0.92)
        draw_cloud(layer, (397, 139), 9 + progress * 2, progress * 0.62)
    elif kind == 'startled':
        draw_sparkle(layer, (155, 155), 8 + progress * 2, progress)
        draw_sparkle(layer, (370, 174), 5.5, progress * 0.7)
    elif kind == 'summon-orb':
        orb_center = anchor or (101, 168 - progress * 5)
        draw_orb(layer, orb_center, 18 + progress * 7, progress)
        draw_sparkle(layer, (orb_center[0] + 37, orb_center[1] - 22), 5, progress * 0.75)
    elif kind == 'glissando':
        draw_water_trail(layer, progress, anchor)
        draw_note(layer, (376, 281 - progress * 12), 10, progress * 0.8, True)
    elif kind == 'remind':
        draw_reminder_cloud(layer, progress)
        draw_sparkle(layer, (352, 181), 5, progress * 0.65)
    elif kind == 'wink-wave':
        wave_anchor = anchor or (92, 205)
        draw_wave_marks(layer, progress, wave_anchor)
        draw_heart(
            layer,
            (wave_anchor[0] + 46, wave_anchor[1] - 34 - progress * 5),
            7 + progress,
            progress * 0.72,
        )
    elif kind == 'hmph':
        draw_hmph_puff(layer, progress)

    small = layer.resize((FRAME_SIZE, FRAME_SIZE), Image.Resampling.LANCZOS)
    return clean_transparent_rgb(np.array(small, dtype=np.uint8))


def composite_external_effect(
    frame: np.ndarray,
    effect: np.ndarray,
    protected_character: np.ndarray,
) -> np.ndarray:
    clipped = effect.copy()
    clipped[protected_character] = 0
    # fail-closed：裁剪后的特效不得覆盖当前姿势任何人物像素；固定 canonical 遮罩无法保护抬起的手。
    overlap = (clipped[:, :, 3] > 0) & (frame[:, :, 3] > 0)
    if np.any(overlap):
        raise ValueError(f'external effect overlaps {int(np.count_nonzero(overlap))} current-character pixels')
    output = Image.alpha_composite(Image.fromarray(frame, 'RGBA'), Image.fromarray(clipped, 'RGBA'))
    return clean_transparent_rgb(np.array(output, dtype=np.uint8))


def transfer_pose(
    base: np.ndarray,
    canonical: np.ndarray,
    donor: np.ndarray,
    allowed_motion: np.ndarray,
) -> np.ndarray:
    # 只移植 donor 相对 canonical 的动作像素；其余人物仍来自同一 pet 基准，避免逐帧重绘色闪。
    mask = changed_mask(canonical, donor) & allowed_motion
    output = base.copy()
    output[mask] = donor[mask]
    return clean_transparent_rgb(output)


def transfer_two_hand_pose(
    base: np.ndarray,
    canonical: np.ndarray,
    left_donor: np.ndarray,
    right_donor: np.ndarray,
    left_corridor: np.ndarray,
    right_corridor: np.ndarray,
) -> np.ndarray:
    # 两侧 donor 永远从同一 canonical 独立移植，防止一侧动作覆盖或继承另一侧的合成结果。
    output = transfer_pose(base, canonical, left_donor, left_corridor)
    return transfer_pose(output, canonical, right_donor, right_corridor)


def checkerboard() -> Image.Image:
    image = Image.new('RGBA', (FRAME_SIZE, FRAME_SIZE), (33, 39, 49, 255))
    draw = ImageDraw.Draw(image)
    for y in range(0, FRAME_SIZE, 16):
        for x in range(0, FRAME_SIZE, 16):
            if (x // 16 + y // 16) % 2:
                draw.rectangle((x, y, x + 15, y + 15), fill=(52, 61, 75, 255))
    return image


def save_contact(spec: AnimationSpec, output: Path) -> None:
    label_height = 26
    rows = math.ceil(len(spec.frames) / spec.columns)
    contact = Image.new(
        'RGBA',
        (FRAME_SIZE * spec.columns, (FRAME_SIZE + label_height) * rows),
        (18, 22, 29, 255),
    )
    draw = ImageDraw.Draw(contact)
    font = ImageFont.load_default()
    for index, frame in enumerate(spec.frames):
        preview = checkerboard()
        preview.alpha_composite(Image.fromarray(frame, 'RGBA'))
        x = index % spec.columns * FRAME_SIZE
        y = index // spec.columns * (FRAME_SIZE + label_height)
        contact.alpha_composite(preview, (x, y))
        draw.text((x + 8, y + FRAME_SIZE + 7), f'{spec.name} frame {index}', fill='white', font=font)
    output.parent.mkdir(parents=True, exist_ok=True)
    contact.save(output)


def save_preview(spec: AnimationSpec, output: Path) -> None:
    previews = []
    for frame in spec.frames:
        preview = checkerboard()
        preview.alpha_composite(Image.fromarray(frame, 'RGBA'))
        previews.append(preview)
    output.parent.mkdir(parents=True, exist_ok=True)
    previews[0].save(
        output,
        save_all=True,
        append_images=previews[1:],
        duration=spec.durations,
        loop=0,
        disposal=2,
    )


def save_diff(spec: AnimationSpec, reference: np.ndarray, output: Path) -> None:
    changed = np.zeros((FRAME_SIZE, FRAME_SIZE), dtype=bool)
    maximum = np.zeros((FRAME_SIZE, FRAME_SIZE), dtype=np.uint8)
    for frame in spec.frames:
        delta = np.max(np.abs(frame.astype(np.int16) - reference.astype(np.int16)), axis=2).astype(np.uint8)
        changed |= delta > 0
        maximum = np.maximum(maximum, delta)
    rgba = np.zeros((FRAME_SIZE, FRAME_SIZE, 4), dtype=np.uint8)
    rgba[:, :, 0] = maximum
    rgba[:, :, 1] = np.where(changed, 206, 0)
    rgba[:, :, 2] = np.where(changed, 255, 0)
    rgba[:, :, 3] = np.where(changed, 230, 0)
    output.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, 'RGBA').save(output)


def frame_hash(frame: np.ndarray) -> str:
    return hashlib.sha256(frame.tobytes()).hexdigest()


def masked_frame_hash(frame: np.ndarray, mask: np.ndarray) -> str:
    return hashlib.sha256(frame[mask].tobytes()).hexdigest()


def validate_animation(
    spec: AnimationSpec,
    canonical: np.ndarray,
    pet_pose: np.ndarray,
    output_sheet: Path,
) -> dict:
    errors: list[str] = []
    # work/pet 两个 canonical 是状态机切换锚点；首尾不精确相等会在动作切换时闪一帧。
    reference = canonical if spec.endpoint == 'work-to-pet' else pet_pose
    expected_first = canonical if spec.endpoint == 'work-to-pet' else pet_pose
    expected_last = canonical if spec.endpoint == 'pet-to-work' else pet_pose
    if spec.endpoint == 'pet-to-work':
        expected_first = pet_pose
    if len(spec.frames) != len(spec.durations):
        errors.append('frameDurations count does not match frames')
    if not np.array_equal(spec.frames[0], expected_first):
        errors.append('first frame does not match its reference')
    if not np.array_equal(spec.frames[-1], expected_last):
        errors.append('last frame does not match its reference')

    hidden_rgb = 0
    edge_alpha = 0
    bboxes = []
    margins = []
    for index, frame in enumerate(spec.frames):
        if frame.shape != (FRAME_SIZE, FRAME_SIZE, 4):
            errors.append(f'frame {index} has an invalid shape')
            continue
        transparent = frame[:, :, 3] == 0
        if np.any(transparent):
            hidden_rgb = max(hidden_rgb, int(frame[:, :, :3][transparent].max(initial=0)))
        edge_alpha = max(
            edge_alpha,
            int(frame[0, :, 3].max()),
            int(frame[-1, :, 3].max()),
            int(frame[:, 0, 3].max()),
            int(frame[:, -1, 3].max()),
        )
        bbox = alpha_bbox(frame)
        if bbox is None:
            errors.append(f'frame {index} is empty')
            bboxes.append(None)
            continue
        bboxes.append(list(bbox))
        margins.append([bbox[0], bbox[1], FRAME_SIZE - bbox[2], FRAME_SIZE - bbox[3]])
    if hidden_rgb:
        errors.append('transparent pixels contain hidden RGB')
    if edge_alpha:
        # 单元格边缘存在 alpha 说明人物或特效被裁切，拼表播放时还可能串到相邻帧。
        errors.append('one or more frames touch a cell edge')

    eye_timeline_max_delta = 0
    if spec.expected_eye_frames is not None or spec.eye_mask is not None:
        if spec.expected_eye_frames is None or spec.eye_mask is None:
            errors.append('eye timeline requires both expected frames and a fixed eye mask')
        elif len(spec.expected_eye_frames) != len(spec.frames):
            errors.append('eye timeline count does not match frames')
        else:
            for frame, expected_eye_frame in zip(spec.frames, spec.expected_eye_frames):
                eye_timeline_max_delta = max(
                    eye_timeline_max_delta,
                    int(
                        np.max(
                            np.abs(
                                frame[spec.eye_mask].astype(np.int16)
                                - expected_eye_frame[spec.eye_mask].astype(np.int16)
                            ),
                            initial=0,
                        )
                    ),
                )
            # 睁眼/眨眼是显式时间线；仅靠静态区白名单会再次放过整段误用闭眼 donor。
            if eye_timeline_max_delta:
                errors.append('eye pixels do not match the declared open/blink timeline')

    symmetric_max = 0
    if spec.symmetric:
        # 镜像回程直接复用正程，要求像素级相等才能避免手工维护两段时间线后发生漂移。
        for index in range(len(spec.frames) // 2):
            symmetric_max = max(
                symmetric_max,
                int(
                    np.max(
                        np.abs(
                            spec.frames[index].astype(np.int16)
                            - spec.frames[-1 - index].astype(np.int16)
                        )
                    )
                ),
            )
        if symmetric_max:
            errors.append('symmetric frame pairs differ')

    allowed = spec.allowed_character_mask
    static_max = 0
    static_mae = 0.0
    if allowed is not None:
        # ROI 是可变白名单而不是“建议范围”；人物其余区域必须逐像素保持 canonical，防止 donor 噪点混入。
        character = canonical[:, :, 3] > 0
        static = character & ~allowed
        deltas = []
        for frame in spec.frames:
            delta = np.abs(frame.astype(np.int16) - reference.astype(np.int16))
            deltas.append(delta[static])
        if deltas and deltas[0].size:
            merged = np.concatenate(deltas, axis=0)
            static_max = int(merged.max(initial=0))
            static_mae = float(np.mean(merged))
        if static_max:
            errors.append('character pixels changed outside the allowed mask')

    left_counts: list[int] = []
    right_counts: list[int] = []
    if spec.require_two_hands:
        character_motion = spec.allowed_character_mask
        if spec.character_frames is None:
            errors.append('two-hand action must provide effect-free character frames')
            character_frames = []
        else:
            character_frames = spec.character_frames
        left_core = rect_mask((118, 300, 207, 421))
        right_core = rect_mask((268, 300, 365, 421))
        for character_frame in character_frames[1:-1]:
            # 双手门只比较无特效的人物层；腾空后的 canonical 走廊即使出现外部特效，也不能冒充手部动作。
            motion = changed_mask(character_frame, canonical)
            if character_motion is not None:
                motion &= character_motion
            left_counts.append(int(np.count_nonzero(motion & left_core)))
            right_counts.append(int(np.count_nonzero(motion & right_core)))
        if min(left_counts, default=0) < 100 or min(right_counts, default=0) < 100:
            errors.append('two-hand action does not move both hand cores')

    effect_overlap_counts: list[int] = []
    effect_overlap_max_delta = 0
    if spec.character_frames is not None:
        if len(spec.character_frames) != len(spec.frames):
            errors.append('character frame count does not match rendered frames')
        else:
            for frame, character_frame in zip(spec.frames, spec.character_frames):
                current_character = character_frame[:, :, 3] > 0
                delta = np.abs(frame.astype(np.int16) - character_frame.astype(np.int16))
                changed = np.any(delta > 0, axis=2)
                effect_overlap_counts.append(int(np.count_nonzero(changed & current_character)))
                if np.any(current_character):
                    effect_overlap_max_delta = max(
                        effect_overlap_max_delta,
                        int(delta[current_character].max(initial=0)),
                    )
            if max(effect_overlap_counts, default=0):
                # 外部特效只能出现在人物外侧，否则会把遮脸/遮手误判为动作素材的一部分。
                errors.append('external effect changes current-character pixels')

    left_pose_count = 0
    right_pose_count = 0
    left_adjacent_repeats: list[int] = []
    right_adjacent_repeats: list[int] = []
    left_skin_counts: list[int] = []
    right_alpha_counts: list[int] = []
    right_skin_counts: list[int] = []
    left_hand_component_counts: list[int] = []
    right_hand_component_counts: list[int] = []
    right_alpha_floor = 0
    right_skin_floor = 0
    if spec.character_frames is not None and spec.left_hand_mask is not None and spec.right_hand_mask is not None:
        left_hashes = [masked_frame_hash(frame, spec.left_hand_mask) for frame in spec.character_frames]
        right_hashes = [masked_frame_hash(frame, spec.right_hand_mask) for frame in spec.character_frames]
        left_pose_count = len(set(left_hashes))
        right_pose_count = len(set(right_hashes))
        left_adjacent_repeats = [
            index for index in range(1, len(left_hashes)) if left_hashes[index] == left_hashes[index - 1]
        ]
        right_adjacent_repeats = [
            index for index in range(1, len(right_hashes)) if right_hashes[index] == right_hashes[index - 1]
        ]
        expected_peak_repeat = len(spec.frames) // 2
        # effect-led 动作允许同一安全姿势停留数帧；默认仍保留旧门，防止普通动作误做成静态手。
        if (
            not spec.allow_non_peak_hand_holds
            and any(index != expected_peak_repeat for index in left_adjacent_repeats)
        ):
            errors.append('left hand repeats an adjacent active pose outside the peak hold')
        if (
            not spec.allow_non_peak_hand_holds
            and any(index != expected_peak_repeat for index in right_adjacent_repeats)
        ):
            errors.append('right hand repeats an adjacent active pose outside the peak hold')
        if left_pose_count < spec.minimum_left_hand_poses:
            errors.append(f'left hand must contain at least {spec.minimum_left_hand_poses} distinct poses')
        if right_pose_count < spec.minimum_right_hand_poses:
            errors.append(f'right hand must contain at least {spec.minimum_right_hand_poses} distinct poses')

        left_skin_counts = [
            int(np.count_nonzero(skin_mask(frame) & spec.left_hand_mask))
            for frame in spec.character_frames
        ]
        if (
            spec.maximum_left_hand_skin_pixels is not None
            and max(left_skin_counts[1:-1], default=0) > spec.maximum_left_hand_skin_pixels
        ):
            errors.append('left-hand corridor contains too much skin for a single hand')

        left_hand_component_counts = [
            hand_skin_component_count(frame, canonical, spec.left_hand_mask)
            for frame in spec.character_frames[1:-1]
        ]
        right_hand_component_counts = [
            hand_skin_component_count(frame, canonical, spec.right_hand_mask)
            for frame in spec.character_frames[1:-1]
        ]
        if spec.enforce_single_left_hand_component and any(
            count != 1 for count in left_hand_component_counts
        ):
            errors.append('left-hand corridor must contain exactly one active skin component')
        if spec.enforce_single_right_hand_component and any(
            count != 1 for count in right_hand_component_counts
        ):
            errors.append('right-hand corridor must contain exactly one active skin component')

        if spec.right_hand_presence_mask is not None:
            right_alpha_counts = [
                int(np.count_nonzero((frame[:, :, 3] > 0) & spec.right_hand_presence_mask))
                for frame in spec.character_frames
            ]
            right_skin_counts = [
                int(np.count_nonzero(skin_mask(frame) & spec.right_hand_presence_mask))
                for frame in spec.character_frames
            ]
            canonical_right_alpha = int(
                np.count_nonzero((canonical[:, :, 3] > 0) & spec.right_hand_presence_mask)
            )
            canonical_right_skin = int(
                np.count_nonzero(skin_mask(canonical) & spec.right_hand_presence_mask)
            )
            # 40% 容纳不同 donor 姿势和抗锯齿造成的面积变化，40px 绝对下限则确保
            # 小基准手也不能靠只剩零碎皮肤像素通过，从而真正拦住整只右手消失。
            right_alpha_floor = max(1, round(canonical_right_alpha * 0.4))
            right_skin_floor = max(40, round(canonical_right_skin * 0.4))
            if min(right_alpha_counts, default=0) < right_alpha_floor:
                errors.append('right-hand alpha presence fell below the canonical floor')
            if min(right_skin_counts, default=0) < right_skin_floor:
                errors.append('right-hand skin presence fell below the canonical floor')

    if spec.character_frames is not None and any(
        value is None
        for value in (
            spec.centroid_left_hand_mask,
            spec.centroid_right_hand_mask,
            spec.maximum_hand_centroid_jump,
            spec.maximum_hand_silhouette_xor_ratio,
        )
    ):
        # 一旦动作提供 effect-free 人物层，就代表人物姿势会变化；缺任一连续性门都必须失败，
        # 不能让新动作因 None 被循环跳过并用 0 值伪装成“没有跳帧”。
        errors.append('character animation must configure both hand continuity gates')

    hand_centroid_jumps: dict[str, list[dict]] = {}
    hand_silhouette_xor_ratios: dict[str, list[dict]] = {}
    maximum_hand_centroid_jump = 0.0
    maximum_hand_silhouette_xor_ratio = 0.0
    for side, motion_mask in (
        ('left', spec.centroid_left_hand_mask),
        ('right', spec.centroid_right_hand_mask),
    ):
        if motion_mask is None:
            continue
        source_frames = spec.character_frames if spec.character_frames is not None else spec.frames
        # 必须包含 canonical 首尾帧；只检查中间动作会再次漏掉切入和切回时最明显的突跳。
        centroids = [primary_hand_skin_centroid(frame, motion_mask) for frame in source_frames]
        jumps = []
        for index, (before, after) in enumerate(zip(centroids, centroids[1:])):
            if before is None or after is None:
                continue
            distance = math.dist(before, after)
            maximum_hand_centroid_jump = max(maximum_hand_centroid_jump, distance)
            jumps.append(
                {
                    'fromFrame': index,
                    'toFrame': index + 1,
                    'distance': distance,
                    'from': list(before),
                    'to': list(after),
                }
            )
        hand_centroid_jumps[side] = jumps

        silhouette_ratios = []
        # 质心可能在整条袖臂换形后仍落在附近，因此再用相邻 alpha 轮廓的归一化 XOR 捕获形态瞬换。
        for index, (before, after) in enumerate(zip(source_frames, source_frames[1:])):
            before_silhouette = (before[:, :, 3] > 0) & motion_mask
            after_silhouette = (after[:, :, 3] > 0) & motion_mask
            union = before_silhouette | after_silhouette
            ratio = (
                float(np.count_nonzero(before_silhouette ^ after_silhouette))
                / float(np.count_nonzero(union))
                if np.any(union)
                else 0.0
            )
            maximum_hand_silhouette_xor_ratio = max(
                maximum_hand_silhouette_xor_ratio,
                ratio,
            )
            silhouette_ratios.append(
                {
                    'fromFrame': index,
                    'toFrame': index + 1,
                    'ratio': ratio,
                }
            )
        hand_silhouette_xor_ratios[side] = silhouette_ratios
    if (
        spec.maximum_hand_centroid_jump is not None
        and maximum_hand_centroid_jump > spec.maximum_hand_centroid_jump
    ):
        errors.append(
            f'primary hand centroid jumps {maximum_hand_centroid_jump:.2f}px, '
            f'above the {spec.maximum_hand_centroid_jump:.2f}px limit'
        )
    if (
        spec.maximum_hand_silhouette_xor_ratio is not None
        and maximum_hand_silhouette_xor_ratio > spec.maximum_hand_silhouette_xor_ratio
    ):
        # 质心相近并不代表轮廓连续；整条袖臂瞬换会在此以 alpha silhouette XOR 比例失败。
        errors.append(
            f'hand silhouette xor ratio {maximum_hand_silhouette_xor_ratio:.4f}, '
            f'above the {spec.maximum_hand_silhouette_xor_ratio:.4f} limit'
        )

    sheet = compose_sheet(spec.frames, spec.columns)
    output_sheet.parent.mkdir(parents=True, exist_ok=True)
    # exact + lossless 只是编码请求，仍需立即解码逐像素比对，避免 Pillow/WebP 版本差异静默破坏透明边缘。
    sheet.save(output_sheet, format='WEBP', lossless=True, method=6, exact=True)
    decoded = split_sheet(output_sheet, len(spec.frames), spec.columns)
    decode_max = max(
        int(np.max(np.abs(before.astype(np.int16) - after.astype(np.int16))))
        for before, after in zip(spec.frames, decoded)
    )
    if decode_max:
        errors.append('lossless WebP decode differs from generated frames')

    alpha_centroids = []
    # 人物与特效整体重心跨度写入报告，供视觉 QA 发现“帧合法但整张画面漂移”的动作。
    for frame in spec.frames:
        alpha = frame[:, :, 3].astype(np.float64)
        total = alpha.sum()
        ys, xs = np.indices(alpha.shape)
        alpha_centroids.append([float((xs * alpha).sum() / total), float((ys * alpha).sum() / total)])
    centroid_spread = [
        max(point[axis] for point in alpha_centroids) - min(point[axis] for point in alpha_centroids)
        for axis in (0, 1)
    ]

    return {
        'ok': not errors,
        'name': spec.name,
        'file': str(output_sheet.resolve()),
        'frames': len(spec.frames),
        'columns': spec.columns,
        'rows': math.ceil(len(spec.frames) / spec.columns),
        'frameWidth': FRAME_SIZE,
        'frameHeight': FRAME_SIZE,
        'durations': spec.durations,
        'totalDurationMs': sum(spec.durations),
        'loop': spec.loop,
        'errors': errors,
        'frameBboxes': bboxes,
        'minimumMargins': [min(values[index] for values in margins) for index in range(4)],
        'edgeAlphaMax': edge_alpha,
        'hiddenRgbMax': hidden_rgb,
        'eyeTimelineMaxDelta': eye_timeline_max_delta,
        'uniqueFrames': len({frame_hash(frame) for frame in spec.frames}),
        'firstFrameHash': frame_hash(spec.frames[0]),
        'lastFrameHash': frame_hash(spec.frames[-1]),
        'symmetricMaxDelta': symmetric_max,
        'characterStaticMaxDelta': static_max,
        'characterStaticMae': static_mae,
        'twoHandLeftChangedPixels': left_counts,
        'twoHandRightChangedPixels': right_counts,
        'effectCharacterOverlapPixels': effect_overlap_counts,
        'effectCharacterOverlapMaxDelta': effect_overlap_max_delta,
        'leftHandUniquePoses': left_pose_count,
        'rightHandUniquePoses': right_pose_count,
        'leftHandAdjacentRepeatIndexes': left_adjacent_repeats,
        'rightHandAdjacentRepeatIndexes': right_adjacent_repeats,
        'leftHandSkinPixels': left_skin_counts,
        'rightHandAlphaPixels': right_alpha_counts,
        'rightHandSkinPixels': right_skin_counts,
        'rightHandAlphaFloor': right_alpha_floor,
        'rightHandSkinFloor': right_skin_floor,
        'handCentroidJumps': hand_centroid_jumps,
        'maximumHandCentroidJump': maximum_hand_centroid_jump,
        'handSilhouetteXorRatios': hand_silhouette_xor_ratios,
        'maximumHandSilhouetteXorRatio': maximum_hand_silhouette_xor_ratio,
        'leftHandSkinComponentCounts': left_hand_component_counts,
        'rightHandSkinComponentCounts': right_hand_component_counts,
        'decodedMaxDelta': decode_max,
        'alphaCentroidSpread': centroid_spread,
        'sheetSha256': hashlib.sha256(output_sheet.read_bytes()).hexdigest(),
    }


def build_animations(model_dir: Path) -> tuple[list[AnimationSpec], np.ndarray, np.ndarray]:
    idle = split_sheet(model_dir / 'sprites/idle.webp', 6, 3)
    pluck_01 = split_sheet(model_dir / 'sprites/pluck-01.webp', 6, 3)
    pluck_02 = split_sheet(model_dir / 'sprites/pluck-02.webp', 6, 3)
    pluck_03 = split_sheet(model_dir / 'sprites/pluck-03.webp', 6, 3)
    pluck_04 = split_sheet(model_dir / 'sprites/pluck-04.webp', 6, 3)
    pluck_05 = split_sheet(model_dir / 'sprites/pluck-05.webp', 6, 3)
    pluck_06 = split_sheet(model_dir / 'sprites/pluck-06.webp', 6, 3)
    pluck_07 = split_sheet(model_dir / 'sprites/pluck-07.webp', 6, 3)
    pluck_08 = split_sheet(model_dir / 'sprites/pluck-08.webp', 6, 3)
    pluck_09 = split_sheet(model_dir / 'sprites/pluck-09.webp', 6, 3)
    pluck_10 = split_sheet(model_dir / 'sprites/pluck-10.webp', 6, 3)
    # idle 第 0 帧是唯一工作态 canonical；闭眼帧只能作为局部眼态 donor，不能成为宠物常态底图。
    canonical = clean_transparent_rgb(idle[0])
    closed = clean_transparent_rgb(idle[2])

    eye_roi = ellipse_mask([(184, 198, 254, 278), (242, 198, 312, 278)])
    eye_delta = changed_mask(canonical, closed)
    if np.any(eye_delta & ~eye_roi):
        raise ValueError('idle closed-eye donor changes pixels outside the fixed eye ROI')
    # ROI 负责 fail-closed，实际差异负责保留眼线抗锯齿边缘，两者不能互相替代。
    eye = eye_delta & eye_roi
    # 脸红会覆盖下眼睑以下的同一脸部差异区；眼态门只取不与脸颊特效重叠的眼线/虹膜核心。
    eye_timeline = eye & rect_mask((180, 190, 315, 236))
    left_eye = eye & rect_mask((180, 190, 248, 282))
    wink = canonical.copy()
    wink[left_eye] = closed[left_eye]

    def add_effect(
        frame: np.ndarray,
        kind: str,
        progress: float,
        phase: float = 0,
        anchor: tuple[float, float] | None = None,
    ) -> np.ndarray:
        # 每帧都从当前 base/pose 的 alpha 膨胀保护区；移动手超出 canonical 轮廓时仍不会被特效盖住。
        character = Image.fromarray(frame[:, :, 3], 'L')
        protected = np.asarray(character.filter(ImageFilter.MaxFilter(9)), dtype=np.uint8) > 0
        return composite_external_effect(frame, effect_layer(kind, progress, phase, anchor), protected)

    # 宠物常态必须与工作态保持同一睁眼基准；闭眼 donor 只用于短眨眼和明确的睡眠语义。
    idle_faces = [canonical] * 10 + [closed, canonical]
    idle_frames = [
        add_effect(face, 'idle', 1, index / (len(idle_faces) - 1))
        for index, face in enumerate(idle_faces)
    ]
    pet_pose = idle_frames[0].copy()

    enter_progress = [0, 0.16, 0.36, 0.58, 0.78, 0.92, 1, 1]
    enter_frames = [
        add_effect(canonical, 'enter', progress)
        for progress in enter_progress
    ]
    enter_frames[-2] = pet_pose.copy()
    enter_frames[-1] = pet_pose.copy()
    exit_frames = [frame.copy() for frame in reversed(enter_frames)]

    symmetric_progress = [0, 0.12, 0.28, 0.48, 0.72, 1, 1, 0.72, 0.48, 0.28, 0.12, 0]

    def effect_action(
        kind: str,
        faces: list[np.ndarray],
        blush: bool = False,
    ) -> list[np.ndarray]:
        if len(faces) != len(symmetric_progress):
            raise ValueError(f'{kind} face timeline does not match its progress timeline')
        frames = []
        for face, progress in zip(faces, symmetric_progress):
            frame = draw_blush(face, progress) if blush else face
            frames.append(add_effect(frame, kind, progress))
        frames[0] = pet_pose.copy()
        frames[-1] = pet_pose.copy()
        return frames

    sleep_faces = [canonical, canonical, canonical, closed, closed, closed]
    sleep_faces = sleep_faces + list(reversed(sleep_faces))
    doze_frames = effect_action('doze', sleep_faces)
    dream_frames = effect_action('dream', sleep_faces)
    content_frames = effect_action('content', [canonical] * len(symmetric_progress), blush=True)

    # 动作白名单独立于 donor 像素差异，未来素材若带全身噪点也不会被自动纳入最终帧或验收区。
    chime_left = polygon_mask(
        [(110, 306), (169, 298), (213, 319), (239, 349), (239, 399), (180, 405), (145, 378), (112, 386), (102, 345)],
        4,
    )
    chime_right = polygon_mask(
        [(211, 306), (269, 303), (315, 323), (351, 347), (358, 397), (312, 419), (262, 405), (214, 397)],
        4,
    )
    chime_corridor = chime_left | chime_right
    # 轻奏只沿 pluck-08 同一袖型从 canonical→中间位→外拨位单向展开；
    # 合理 hold 用来承接特效节奏，不能为凑唯一姿势混入会让端点跳 48px 的其他 donor。
    chime_half = [canonical, pluck_08[1], pluck_08[1], pluck_08[2], pluck_08[2], pluck_08[2]]
    chime_donors = chime_half + list(reversed(chime_half))
    chime_frames = []
    chime_characters = []
    for donor, progress in zip(chime_donors, symmetric_progress):
        base = transfer_pose(canonical, canonical, donor, chime_corridor)
        chime_characters.append(base)
        chime_frames.append(add_effect(base, 'chime', progress))
    chime_characters[0] = canonical.copy()
    chime_characters[-1] = canonical.copy()
    chime_frames[0] = pet_pose.copy()
    chime_frames[-1] = pet_pose.copy()

    curious_left = polygon_mask(
        [(80, 222), (115, 209), (151, 228), (190, 269), (220, 311), (220, 351), (185, 383), (123, 385), (91, 351), (74, 283)],
        4,
    )
    curious_right = polygon_mask(
        [(273, 300), (317, 303), (350, 334), (369, 377), (360, 414), (313, 418), (282, 390), (270, 345)],
        4,
    )
    curious_corridor = curious_left | curious_right
    # 好奇动作只沿 pluck-10 同一袖型逐级伸手；首个中间位距 canonical 约 13px，
    # 不再以 changed-mask 缺失端点为由放过原先约 51.5px 的切入突跳。
    curious_half = [canonical, pluck_10[1], pluck_10[1], pluck_10[2], pluck_10[2], pluck_10[2]]
    curious_donors = curious_half + list(reversed(curious_half))
    curious_frames = []
    curious_characters = []
    for donor, progress in zip(curious_donors, symmetric_progress):
        base = transfer_pose(canonical, canonical, donor, curious_corridor)
        curious_characters.append(base)
        curious_frames.append(add_effect(base, 'curious', progress))
    curious_characters[0] = canonical.copy()
    curious_characters[-1] = canonical.copy()
    curious_frames[0] = pet_pose.copy()
    curious_frames[-1] = pet_pose.copy()

    # 脸红使用固定脸颊 ROI；不能由某个强度的输出反推白名单，否则其他强度的抗锯齿边缘会漏一像素。
    cheek = ellipse_mask([(198, 237, 241, 267), (270, 237, 313, 267)])

    # 高抬手与低位扫弦分别使用固定语义走廊；不能从 donor 差异反推白名单，否则噪点会被一起放行。
    raised_left = polygon_mask(
        [(69, 174), (121, 169), (170, 195), (211, 244), (235, 314), (232, 367), (198, 405), (130, 409), (88, 374), (69, 302)],
        6,
    )
    raised_right = polygon_mask(
        [(270, 296), (319, 301), (354, 330), (370, 377), (360, 418), (309, 425), (276, 393), (266, 340)],
        5,
    )
    raised_corridor = raised_left | raised_right
    low_left = polygon_mask(
        [(67, 279), (123, 277), (181, 294), (231, 326), (245, 369), (225, 407), (161, 415), (94, 399), (67, 355)],
        6,
    )
    low_right = raised_right
    low_corridor = low_left | low_right
    right_hand_presence = raised_right & rect_mask((286, 330, 370, 420))

    action_progress = symmetric_progress
    # 受惊动作由特效表达强度，手部只走 pluck-08 的单向外拨轨迹；
    # 同一 source family 的 hold 比跨袖型补“丰富姿势”更稳定。
    staged_04_half = [canonical, pluck_08[1], pluck_08[1], pluck_08[2], pluck_08[2], pluck_08[2]]
    staged_04 = staged_04_half + list(reversed(staged_04_half))
    staged_10 = [
        canonical,
        pluck_10[1],
        pluck_10[1],
        pluck_10[2],
        pluck_10[2],
        pluck_10[2],
        pluck_10[2],
        pluck_10[2],
        pluck_10[2],
        pluck_10[1],
        pluck_10[1],
        canonical,
    ]

    def pose_action(
        kind: str,
        donors: list[np.ndarray],
        corridor: np.ndarray,
        face: np.ndarray,
        blush: bool = False,
    ) -> tuple[list[np.ndarray], list[np.ndarray]]:
        frames = []
        character_frames = []
        for donor, progress in zip(donors, action_progress):
            base = draw_blush(face, progress) if blush else face
            character_frame = transfer_pose(base, canonical, donor, corridor)
            character_frames.append(character_frame)
            frames.append(add_effect(character_frame, kind, progress))
        character_frames[0] = canonical.copy()
        character_frames[-1] = canonical.copy()
        frames[0] = pet_pose.copy()
        frames[-1] = pet_pose.copy()
        return frames, character_frames

    def symmetric_sequence(half: list) -> list:
        return half + list(reversed(half))

    def layered_pose_action(
        kind: str,
        left_donors: list[np.ndarray],
        right_donors: list[np.ndarray],
        left_corridor: np.ndarray,
        right_corridor: np.ndarray,
        faces: np.ndarray | list[np.ndarray],
        progress_values: list[float],
        anchors: list[tuple[float, float]],
        blush: bool = False,
    ) -> tuple[list[np.ndarray], list[np.ndarray]]:
        face_frames = [faces] * len(progress_values) if isinstance(faces, np.ndarray) else faces
        if not (
            len(left_donors)
            == len(right_donors)
            == len(progress_values)
            == len(anchors)
            == len(face_frames)
        ):
            raise ValueError(f'{kind} layered timeline lengths do not match')

        frames: list[np.ndarray] = []
        character_frames: list[np.ndarray] = []
        for left_donor, right_donor, face, progress, anchor in zip(
            left_donors,
            right_donors,
            face_frames,
            progress_values,
            anchors,
        ):
            expression = draw_blush(face, progress) if blush else face
            character_frame = transfer_two_hand_pose(
                expression,
                canonical,
                left_donor,
                right_donor,
                left_corridor,
                right_corridor,
            )
            character_frames.append(character_frame)
            frames.append(add_effect(character_frame, kind, progress, anchor=anchor))

        # 所有动作回到睁眼 pet canonical；语义性闭眼只能存在于动作内部，不能污染常态。
        character_frames[0] = canonical.copy()
        character_frames[-1] = canonical.copy()
        frames[0] = pet_pose.copy()
        frames[-1] = pet_pose.copy()
        return frames, character_frames

    startled_frames, startled_characters = pose_action('startled', staged_04, curious_corridor, canonical)
    remind_frames, remind_characters = pose_action('remind', staged_10, low_corridor, canonical)

    right_common = pluck_04[1]
    right_alternate = pluck_07[1]
    # 稳定 donor 中只有这两种活动右手仍完整留在 raised_right；中央双手 donor 会让右手消失，禁止使用。
    right_half_16 = [
        canonical,
        right_common,
        right_alternate,
        right_common,
        right_alternate,
        right_common,
        right_alternate,
        right_common,
    ]
    right_half_12 = [
        canonical,
        right_common,
        right_alternate,
        right_common,
        right_alternate,
        right_common,
    ]
    progress_half_16 = [0, 0.1, 0.22, 0.36, 0.52, 0.68, 0.84, 1]
    progress_half_12 = [0, 0.16, 0.34, 0.56, 0.78, 1]

    # 法球负责向上漂浮，双手只沿 pluck-08 同一袖型单向外拨；重复姿势是有意 hold，
    # 避免原时间线在伸臂、抬掌、回琴面之间来回瞬换整条袖臂。
    summon_left_half = [
        canonical,
        pluck_08[1],
        pluck_08[1],
        pluck_08[2],
        pluck_08[2],
        pluck_08[2],
        pluck_08[2],
        pluck_08[2],
    ]
    summon_anchor_half = [
        (140, 290),
        (134, 282),
        (128, 274),
        (121, 264),
        (114, 253),
        (107, 241),
        (100, 229),
        (94, 216),
    ]
    summon_frames, summon_characters = layered_pose_action(
        'summon-orb',
        symmetric_sequence(summon_left_half),
        symmetric_sequence(summon_left_half),
        raised_left,
        raised_right,
        canonical,
        symmetric_sequence(progress_half_16),
        symmetric_sequence(summon_anchor_half),
    )

    # 扫弦沿 pluck-08 的中间位→外拨位单向展开；原先混入 pluck-01/04 会在 f1→f2 跳 55.22px。
    # 手部 hold 承接整条水线的逐帧生长，既保留扫弦语义，也不靠跨袖型姿势伪造运动量。
    glissando_left_half = [
        canonical,
        pluck_08[1],
        pluck_08[1],
        pluck_08[2],
        pluck_08[2],
        pluck_08[2],
    ]
    glissando_anchor_half = [
        (156, 338),
        (148, 339),
        (140, 340),
        (130, 340),
        (120, 339),
        (110, 338),
    ]
    glissando_frames, glissando_characters = layered_pose_action(
        'glissando',
        symmetric_sequence(glissando_left_half),
        symmetric_sequence(glissando_left_half),
        low_left,
        raised_right,
        canonical,
        symmetric_sequence(progress_half_12),
        symmetric_sequence(glissando_anchor_half),
    )

    # 挥手使用 pluck-10 同一袖型的中间位与峰值位，保持单向伸手后再镜像收回；
    # 波纹固定在手侧，仅靠强度展开，避免特效锚点反向移动放大姿势跳变。
    wink_left_half = [
        canonical,
        pluck_10[1],
        pluck_10[1],
        pluck_10[2],
        pluck_10[2],
        pluck_10[2],
        pluck_10[2],
        pluck_10[2],
    ]
    wink_anchor_half = [(105, 280)] * 8
    wink_wave_frames, wink_wave_characters = layered_pose_action(
        'wink-wave',
        symmetric_sequence(wink_left_half),
        symmetric_sequence(wink_left_half),
        raised_left,
        raised_right,
        wink,
        symmetric_sequence(progress_half_16),
        symmetric_sequence(wink_anchor_half),
        blush=True,
    )

    # 傲娇动作只沿 pluck-10 同一袖型伸手并在峰值停留；哼气和脸红负责继续推进情绪。
    # 这样保留 f5/f6 的两帧闭眼峰值，同时消除原 f3→f4→f5 的 49.95/57.47px 抬袖突跳。
    hmph_left_half = [
        canonical,
        pluck_10[1],
        pluck_10[1],
        pluck_10[2],
        pluck_10[2],
        pluck_10[2],
    ]
    hmph_anchor_half = [(120, 280)] * 6
    hmph_faces = [canonical] * 5 + [closed, closed] + [canonical] * 5
    hmph_frames, hmph_characters = layered_pose_action(
        'hmph',
        symmetric_sequence(hmph_left_half),
        symmetric_sequence(hmph_left_half),
        raised_left,
        raised_right,
        hmph_faces,
        symmetric_sequence(progress_half_12),
        symmetric_sequence(hmph_anchor_half),
        blush=True,
    )

    # 两端较快、峰值较慢，让 12/16 帧动作有可读的蓄力与停顿；idle 的闭眼只保留 80ms 短眨眼。
    enter_durations = [100, 120, 140, 160, 190, 190, 160, 140]
    idle_durations = [380] * 10 + [80, 380]
    doze_durations = [100, 120, 150, 180, 220, 300, 300, 220, 180, 150, 120, 100]
    dream_durations = [110, 140, 170, 210, 270, 360, 360, 270, 210, 170, 140, 110]
    common_durations = [90, 110, 130, 150, 180, 260, 260, 180, 150, 130, 110, 90]
    lively_durations = [75, 90, 105, 125, 160, 240, 240, 160, 125, 105, 90, 75]
    summon_durations = [70, 80, 95, 110, 130, 160, 210, 300, 300, 210, 160, 130, 110, 95, 80, 70]
    glissando_durations = [80, 110, 140, 180, 240, 300, 300, 240, 180, 140, 110, 80]
    wink_durations = [70, 80, 95, 110, 130, 160, 210, 280, 280, 210, 160, 130, 110, 95, 80, 70]
    hmph_durations = [90, 120, 150, 190, 260, 330, 330, 260, 190, 150, 120, 90]
    open_8 = [canonical] * 8
    open_12 = [canonical] * 12
    open_16 = [canonical] * 16
    wink_faces = [canonical] + [wink] * 14 + [canonical]
    # 36px 质心上限和 3.5% 轮廓变化上限共同来自最终接触表验收；统一写入所有有姿势层的动作，
    # 防止后续导入新 donor 时只满足其中一项便重新引入手部/袖型跳帧。
    specs = [
        AnimationSpec(
            'pet-enter', enter_frames, enter_durations,
            endpoint='work-to-pet', symmetric=False, allowed_character_mask=eye,
            expected_eye_frames=open_8, eye_mask=eye_timeline,
        ),
        AnimationSpec(
            'pet-idle', idle_frames, idle_durations, loop=True, symmetric=False,
            allowed_character_mask=eye, expected_eye_frames=idle_faces, eye_mask=eye_timeline,
        ),
        AnimationSpec(
            'pet-exit', exit_frames, list(reversed(enter_durations)),
            endpoint='pet-to-work', symmetric=False, allowed_character_mask=eye,
            expected_eye_frames=open_8, eye_mask=eye_timeline,
        ),
        AnimationSpec(
            'pet-doze', doze_frames, doze_durations, allowed_character_mask=eye,
            expected_eye_frames=sleep_faces, eye_mask=eye_timeline,
        ),
        AnimationSpec(
            'pet-dream', dream_frames, dream_durations, allowed_character_mask=eye,
            expected_eye_frames=sleep_faces, eye_mask=eye_timeline,
        ),
        AnimationSpec(
            'pet-chime', chime_frames, common_durations,
            allowed_character_mask=eye | chime_corridor, require_two_hands=True,
            character_frames=chime_characters, expected_eye_frames=open_12, eye_mask=eye_timeline,
            centroid_left_hand_mask=chime_left, centroid_right_hand_mask=chime_right,
            maximum_hand_centroid_jump=36, maximum_hand_silhouette_xor_ratio=0.035,
        ),
        AnimationSpec(
            'pet-curious', curious_frames, common_durations,
            allowed_character_mask=eye | curious_corridor, character_frames=curious_characters,
            expected_eye_frames=open_12, eye_mask=eye_timeline,
            centroid_left_hand_mask=curious_left, centroid_right_hand_mask=curious_right,
            maximum_hand_centroid_jump=36, maximum_hand_silhouette_xor_ratio=0.035,
        ),
        AnimationSpec(
            'pet-content', content_frames, common_durations,
            allowed_character_mask=eye | cheek, expected_eye_frames=open_12, eye_mask=eye_timeline,
        ),
        AnimationSpec(
            'pet-startled', startled_frames, lively_durations,
            allowed_character_mask=eye | curious_corridor, require_two_hands=True,
            character_frames=startled_characters, expected_eye_frames=open_12, eye_mask=eye_timeline,
            centroid_left_hand_mask=curious_left, centroid_right_hand_mask=curious_right,
            maximum_hand_centroid_jump=36, maximum_hand_silhouette_xor_ratio=0.035,
        ),
        AnimationSpec(
            'pet-summon-orb', summon_frames, summon_durations,
            allowed_character_mask=eye | raised_corridor, require_two_hands=True,
            character_frames=summon_characters,
            left_hand_mask=raised_left, right_hand_mask=raised_right,
            right_hand_presence_mask=right_hand_presence,
            minimum_left_hand_poses=3, minimum_right_hand_poses=2,
            allow_non_peak_hand_holds=True,
            enforce_single_left_hand_component=True,
            enforce_single_right_hand_component=True,
            expected_eye_frames=open_16, eye_mask=eye_timeline,
            centroid_left_hand_mask=raised_left, centroid_right_hand_mask=raised_right,
            maximum_hand_centroid_jump=36, maximum_hand_silhouette_xor_ratio=0.035,
        ),
        AnimationSpec(
            'pet-glissando', glissando_frames, glissando_durations,
            allowed_character_mask=eye | low_corridor, require_two_hands=True,
            character_frames=glissando_characters,
            left_hand_mask=low_left, right_hand_mask=raised_right,
            right_hand_presence_mask=right_hand_presence,
            minimum_left_hand_poses=3, minimum_right_hand_poses=2,
            allow_non_peak_hand_holds=True,
            enforce_single_left_hand_component=True,
            enforce_single_right_hand_component=True,
            maximum_left_hand_skin_pixels=1100,
            expected_eye_frames=open_12, eye_mask=eye_timeline,
            centroid_left_hand_mask=low_left, centroid_right_hand_mask=raised_right,
            maximum_hand_centroid_jump=36, maximum_hand_silhouette_xor_ratio=0.035,
        ),
        AnimationSpec(
            'pet-remind', remind_frames, lively_durations,
            allowed_character_mask=eye | low_corridor, require_two_hands=True,
            character_frames=remind_characters, expected_eye_frames=open_12, eye_mask=eye_timeline,
            centroid_left_hand_mask=low_left, centroid_right_hand_mask=raised_right,
            maximum_hand_centroid_jump=36, maximum_hand_silhouette_xor_ratio=0.035,
        ),
        AnimationSpec(
            'pet-wink-wave', wink_wave_frames, wink_durations,
            allowed_character_mask=eye | cheek | raised_corridor, require_two_hands=True,
            character_frames=wink_wave_characters,
            left_hand_mask=raised_left, right_hand_mask=raised_right,
            right_hand_presence_mask=right_hand_presence,
            minimum_left_hand_poses=3, minimum_right_hand_poses=2,
            allow_non_peak_hand_holds=True,
            enforce_single_left_hand_component=True,
            enforce_single_right_hand_component=True,
            expected_eye_frames=wink_faces, eye_mask=eye_timeline,
            centroid_left_hand_mask=raised_left, centroid_right_hand_mask=raised_right,
            maximum_hand_centroid_jump=36, maximum_hand_silhouette_xor_ratio=0.035,
        ),
        AnimationSpec(
            'pet-hmph', hmph_frames, hmph_durations,
            allowed_character_mask=eye | cheek | raised_corridor, require_two_hands=True,
            character_frames=hmph_characters,
            left_hand_mask=raised_left, right_hand_mask=raised_right,
            right_hand_presence_mask=right_hand_presence,
            minimum_left_hand_poses=3, minimum_right_hand_poses=2,
            allow_non_peak_hand_holds=True,
            enforce_single_left_hand_component=True,
            enforce_single_right_hand_component=True,
            expected_eye_frames=hmph_faces, eye_mask=eye_timeline,
            centroid_left_hand_mask=raised_left, centroid_right_hand_mask=raised_right,
            maximum_hand_centroid_jump=36, maximum_hand_silhouette_xor_ratio=0.035,
        ),
    ]
    return specs, canonical, pet_pose


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', required=True, type=Path)
    parser.add_argument('--output-dir', required=True, type=Path)
    parser.add_argument('--only', action='append', default=[])
    args = parser.parse_args()

    specs, canonical, pet_pose = build_animations(args.model_dir)
    if args.only:
        requested = set(args.only)
        available = {spec.name for spec in specs}
        unknown = sorted(requested - available)
        if unknown:
            raise ValueError(f'unknown animations requested by --only: {", ".join(unknown)}')
        # 修复批次只落目标动作，避免并行工作中的其他已验收 artifacts 被无关重写。
        specs = [spec for spec in specs if spec.name in requested]
    reports = []
    for spec in specs:
        sheet_path = args.output_dir / 'sheets' / f'{spec.name}.webp'
        report = validate_animation(spec, canonical, pet_pose, sheet_path)
        reports.append(report)

        for index, frame in enumerate(spec.frames):
            frame_path = args.output_dir / 'frames' / spec.name / f'{index:02d}.png'
            frame_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(frame, 'RGBA').save(frame_path)
        save_contact(spec, args.output_dir / 'previews' / f'{spec.name}-contact.png')
        save_preview(spec, args.output_dir / 'previews' / f'{spec.name}.gif')
        save_diff(spec, canonical if spec.endpoint == 'work-to-pet' else pet_pose, args.output_dir / 'diffs' / f'{spec.name}.png')
        report_path = args.output_dir / 'reports' / f'{spec.name}.json'
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')

    summary = {
        'ok': all(report['ok'] for report in reports),
        'model': str(args.model_dir.resolve()),
        'productionCanonical': 'sprites/idle.webp#frame0',
        'petCanonical': 'pet-idle#frame0',
        'animations': {report['name']: report for report in reports},
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'ok': summary['ok'], 'animations': {r['name']: r['ok'] for r in reports}}, ensure_ascii=False))
    raise SystemExit(0 if summary['ok'] else 1)


if __name__ == '__main__':
    main()
