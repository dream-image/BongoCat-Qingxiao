#!/usr/bin/env python3

"""从清宵 canonical 和已确认 donor 构建“剑气凝心”一次性动画。"""

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


FRAME_SIZE = 512
FRAME_COUNT = 16
COLUMNS = 4
FRAME_DURATIONS = (70, 80, 95, 110, 130, 160, 210, 320, 320, 210, 160, 130, 110, 95, 80, 70)
MAGENTA = np.array([255.0, 0.0, 255.0], dtype=np.float32)


def clean_transparent_rgb(frame: np.ndarray) -> np.ndarray:
    """透明像素隐藏色统一清零，避免 WebP 边缘携带洋红底色。"""

    output = frame.copy()
    output[output[:, :, 3] == 0, :3] = 0
    return output


def split_sheet(path: Path, frames: int, columns: int) -> list[np.ndarray]:
    image = Image.open(path).convert('RGBA')
    rows = math.ceil(frames / columns)
    expected = (columns * FRAME_SIZE, rows * FRAME_SIZE)
    if image.size != expected:
        raise ValueError(f'{path} must be {expected}, got {image.size}')
    return [
        clean_transparent_rgb(np.asarray(image.crop((
            index % columns * FRAME_SIZE,
            index // columns * FRAME_SIZE,
            (index % columns + 1) * FRAME_SIZE,
            (index // columns + 1) * FRAME_SIZE,
        )), dtype=np.uint8))
        for index in range(frames)
    ]


def chroma_key_donor(path: Path) -> np.ndarray:
    """在原始分辨率去除纯洋红分割底，再缩到模型的固定 512px 坐标系。"""

    rgb = np.asarray(Image.open(path).convert('RGB'), dtype=np.float32)
    distance = np.linalg.norm(rgb - MAGENTA, axis=2)
    alpha = np.clip((distance - 28.0) / 72.0, 0.0, 1.0)

    # 图像生成器会在物体边缘把前景与洋红底做抗锯齿混合；先反解前景色再缩放，
    # 否则手指、袖口和剑气会留下难以在透明背景上察觉的紫边。
    safe_alpha = np.maximum(alpha, 1 / 255)
    foreground = (rgb - MAGENTA[None, None, :] * (1.0 - alpha[:, :, None])) / safe_alpha[:, :, None]
    foreground = np.clip(np.rint(foreground), 0, 255).astype(np.uint8)
    rgba = np.dstack((foreground, np.rint(alpha * 255).astype(np.uint8)))
    rgba[alpha <= 0, :3] = 0
    keyed = Image.fromarray(rgba, 'RGBA').resize(
        (FRAME_SIZE, FRAME_SIZE), Image.Resampling.LANCZOS
    )
    return clean_transparent_rgb(np.asarray(keyed, dtype=np.uint8))


def polygon_mask(points: tuple[tuple[int, int], ...], blur: float = 0.7) -> np.ndarray:
    """建立局部动作走廊；轻微羽化只处理拼接边，不参与肢体姿势过渡。"""

    mask = Image.new('L', (FRAME_SIZE, FRAME_SIZE), 0)
    ImageDraw.Draw(mask).polygon(points, fill=255)
    if blur:
        mask = mask.filter(ImageFilter.GaussianBlur(blur))
    return np.asarray(mask, dtype=np.uint8)


LOW_ARM_MASK = polygon_mask((
    (120, 390), (120, 350), (135, 315), (155, 288),
    (191, 286), (197, 325), (188, 390),
))
HIGH_ARM_MASK = polygon_mask((
    (116, 390), (119, 338), (129, 292), (132, 238),
    (168, 218), (184, 268), (191, 330), (184, 390),
))


def composite_pose(canonical: np.ndarray, donor: np.ndarray, corridor: np.ndarray) -> np.ndarray:
    """只把 donor 的单侧手臂写入 canonical，脸、琴、另一只手和常驻飘带保持不变。"""

    base = Image.fromarray(canonical, 'RGBA')
    source = Image.fromarray(donor, 'RGBA')
    source_alpha = np.asarray(source.getchannel('A'), dtype=np.float32)
    effective = np.rint(source_alpha * (corridor.astype(np.float32) / 255.0)).astype(np.uint8)
    source.putalpha(Image.fromarray(effective, 'L'))
    base.alpha_composite(source)
    return clean_transparent_rgb(np.asarray(base, dtype=np.uint8))


def effect_corridor() -> np.ndarray:
    """剑身、指尖法环和少量飞散光点使用独立走廊，避免误采 donor 的人物与飘带。"""

    mask = Image.new('L', (FRAME_SIZE, FRAME_SIZE), 0)
    draw = ImageDraw.Draw(mask)
    draw.polygon(((54, 63), (78, 70), (169, 246), (137, 258)), fill=255)
    draw.ellipse((92, 207, 194, 275), fill=255)
    draw.ellipse((72, 88, 195, 225), fill=255)
    return np.asarray(mask.filter(ImageFilter.GaussianBlur(0.6)), dtype=np.uint8)


EFFECT_MASK = effect_corridor()
EFFECT_ORIGIN = np.array([151.0, 247.0], dtype=np.float32)
EFFECT_TIP = np.array([65.0, 70.0], dtype=np.float32)


def recolor_embedded_energy(donor: np.ndarray) -> np.ndarray:
    """修正手指附近被写进姿势 donor 的紫色能量边，不触碰蓝发或肤色。"""

    output = donor.copy()
    rgb = output[:, :, :3].astype(np.float32)
    red, green, blue = np.moveaxis(rgb, 2, 0)
    energy = (
        (EFFECT_MASK > 0)
        & (output[:, :, 3] > 0)
        & (blue - green > 34)
        & (red - green > 22)
    )
    luma = red * 0.2126 + green * 0.7152 + blue * 0.0722
    target = np.stack((
        np.clip(luma * 0.75 + 40, 0, 255),
        np.clip(luma * 0.70 + 100, 0, 255),
        np.clip(luma * 0.30 + 180, 0, 255),
    ), axis=2)
    output[energy, :3] = np.rint(target[energy]).astype(np.uint8)
    return clean_transparent_rgb(output)


def extract_effect(peak: np.ndarray) -> np.ndarray:
    """从已确认峰值 donor 只取剑气，不把峰值人物当成第二层常驻角色。"""

    output = peak.copy()
    alpha = output[:, :, 3].astype(np.float32)
    alpha *= EFFECT_MASK.astype(np.float32) / 255.0
    # 抬手本体与剑气法环相交，先扣除手臂中心区，最终由 canonical 手臂层负责遮挡关系。
    alpha *= 1.0 - (HIGH_ARM_MASK.astype(np.float32) / 255.0) * 0.92
    output[:, :, 3] = np.rint(alpha).astype(np.uint8)
    # donor 的高亮边缘带有少量生成器紫色描边；动作语义是清宵本体的水蓝剑气，
    # 因此只在已经隔离出的能量层内统一为冰青色，人物材质不做全局滤镜。
    rgb = output[:, :, :3].astype(np.float32)
    luma = rgb[:, :, 0] * 0.2126 + rgb[:, :, 1] * 0.7152 + rgb[:, :, 2] * 0.0722
    cyan = np.stack((
        np.clip(luma * 0.75 + 40, 0, 255),
        np.clip(luma * 0.70 + 100, 0, 255),
        np.clip(luma * 0.30 + 180, 0, 255),
    ), axis=2)
    visible = output[:, :, 3] > 0
    output[visible, :3] = np.rint(cyan[visible]).astype(np.uint8)
    return clean_transparent_rgb(output)


def reveal_effect(effect: np.ndarray, progress: float) -> np.ndarray:
    """让剑气从指尖沿剑身方向生长；淡入只用于能量，不用于两套肢体姿势。"""

    y, x = np.indices((FRAME_SIZE, FRAME_SIZE), dtype=np.float32)
    direction = EFFECT_TIP - EFFECT_ORIGIN
    length_squared = float(np.dot(direction, direction))
    projection = ((x - EFFECT_ORIGIN[0]) * direction[0] + (y - EFFECT_ORIGIN[1]) * direction[1]) / length_squared
    reveal = np.clip((progress - projection + 0.035) / 0.07, 0.0, 1.0)
    # 指尖法环在起势时先亮起，剑身随后向外延伸；负投影的环形像素不会被提前裁掉。
    ring_distance = ((x - EFFECT_ORIGIN[0]) / 57.0) ** 2 + ((y - EFFECT_ORIGIN[1]) / 34.0) ** 2
    ring = np.clip((1.35 - ring_distance) * 2.2, 0.0, 1.0) * min(1.0, progress * 4.0)
    visibility = np.maximum(reveal * min(1.0, progress * 2.8), ring)
    output = effect.copy()
    output[:, :, 3] = np.rint(output[:, :, 3].astype(np.float32) * visibility).astype(np.uint8)
    return clean_transparent_rgb(output)


def add_effect(frame: np.ndarray, effect: np.ndarray, progress: float) -> np.ndarray:
    base = Image.fromarray(frame, 'RGBA')
    base.alpha_composite(Image.fromarray(reveal_effect(effect, progress), 'RGBA'))
    return clean_transparent_rgb(np.asarray(base, dtype=np.uint8))


def compose_sheet(frames: list[np.ndarray]) -> Image.Image:
    sheet = Image.new('RGBA', (COLUMNS * FRAME_SIZE, 4 * FRAME_SIZE), (0, 0, 0, 0))
    for index, frame in enumerate(frames):
        sheet.alpha_composite(Image.fromarray(frame, 'RGBA'), (
            index % COLUMNS * FRAME_SIZE,
            index // COLUMNS * FRAME_SIZE,
        ))
    return sheet


def checkerboard() -> Image.Image:
    background = Image.new('RGBA', (FRAME_SIZE, FRAME_SIZE), (34, 39, 49, 255))
    draw = ImageDraw.Draw(background)
    for y in range(0, FRAME_SIZE, 16):
        for x in range(0, FRAME_SIZE, 16):
            if (x // 16 + y // 16) % 2:
                draw.rectangle((x, y, x + 15, y + 15), fill=(53, 60, 74, 255))
    return background


def write_qa(frames: list[np.ndarray], work_dir: Path, report: dict[str, object]) -> None:
    qa_dir = work_dir / 'qa'
    qa_dir.mkdir(parents=True, exist_ok=True)
    contact = Image.new('RGBA', (COLUMNS * FRAME_SIZE, 4 * (FRAME_SIZE + 28)), (20, 24, 31, 255))
    draw = ImageDraw.Draw(contact)
    previews: list[Image.Image] = []
    for index, frame in enumerate(frames):
        preview = checkerboard()
        preview.alpha_composite(Image.fromarray(frame, 'RGBA'))
        previews.append(preview)
        x = index % COLUMNS * FRAME_SIZE
        y = index // COLUMNS * (FRAME_SIZE + 28)
        contact.alpha_composite(preview, (x, y))
        draw.text((x + 8, y + FRAME_SIZE + 7), f'frame {index}', fill=(255, 255, 255, 255))
    contact.save(qa_dir / 'sword-qi-focus-contact.png')
    previews[0].save(
        qa_dir / 'sword-qi-focus.gif', save_all=True, append_images=previews[1:],
        duration=FRAME_DURATIONS, loop=0, disposal=2,
    )
    (qa_dir / 'sword-qi-focus-report.json').write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
    )


def build(model_dir: Path, work_dir: Path) -> None:
    canonical = split_sheet(model_dir / 'sprites/pet-idle.webp', 12, 4)[0]
    low = chroma_key_donor(model_dir / 'references/sword-qi-focus-low-donor.png')
    high = recolor_embedded_energy(
        chroma_key_donor(model_dir / 'references/sword-qi-focus-high-donor.png')
    )
    peak = recolor_embedded_energy(
        chroma_key_donor(model_dir / 'references/sword-qi-focus-peak-donor.png')
    )

    low_pose = composite_pose(canonical, low, LOW_ARM_MASK)
    high_pose = composite_pose(canonical, high, HIGH_ARM_MASK)
    peak_pose = composite_pose(canonical, peak, HIGH_ARM_MASK)
    effect = extract_effect(peak)

    # 16 帧严格镜像返回 canonical；人物姿势使用三个真实关键姿势，只有能量层做渐进显隐。
    poses = (
        canonical, low_pose, high_pose, peak_pose,
        peak_pose, peak_pose, peak_pose, peak_pose,
        peak_pose, peak_pose, peak_pose, peak_pose,
        peak_pose, high_pose, low_pose, canonical,
    )
    progress = (0, 0, 0, 0, 0.12, 0.35, 0.65, 1.0, 1.0, 0.65, 0.35, 0.12, 0, 0, 0, 0)
    frames = [add_effect(pose, effect, amount) if amount else pose.copy() for pose, amount in zip(poses, progress)]
    frames[0] = canonical.copy()
    frames[-1] = canonical.copy()

    output = model_dir / 'modules/lively/sprites/pet-sword-qi-focus.webp'
    output.parent.mkdir(parents=True, exist_ok=True)
    compose_sheet(frames).save(output, format='WEBP', lossless=True, method=6, exact=True)
    decoded = split_sheet(output, FRAME_COUNT, COLUMNS)
    if not all(np.array_equal(source, target) for source, target in zip(frames, decoded)):
        raise ValueError('lossless WebP decode differs from generated sword-qi frames')
    if not np.array_equal(decoded[0], canonical) or not np.array_equal(decoded[-1], canonical):
        raise ValueError('manual action must begin and end on the pet canonical')

    edge_alpha = [
        int(np.count_nonzero(np.concatenate((frame[0, :, 3], frame[-1, :, 3], frame[:, 0, 3], frame[:, -1, 3]))))
        for frame in decoded
    ]
    hidden_rgb = max(int(frame[frame[:, :, 3] == 0, :3].max(initial=0)) for frame in decoded)
    if any(edge_alpha) or hidden_rgb:
        raise ValueError('sword-qi sheet failed transparent-edge hygiene')

    report = {
        'output': str(output),
        'frames': FRAME_COUNT,
        'columns': COLUMNS,
        'decodedSize': [COLUMNS * FRAME_SIZE, 4 * FRAME_SIZE],
        'firstFrameMatchesCanonical': True,
        'lastFrameMatchesCanonical': True,
        'edgeAlphaPixels': edge_alpha,
        'hiddenRgbMaximum': hidden_rgb,
        'uniqueFrames': len({hashlib.sha256(frame.tobytes()).hexdigest() for frame in decoded}),
        'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
        'donors': [
            'references/sword-qi-focus-low-donor.png',
            'references/sword-qi-focus-high-donor.png',
            'references/sword-qi-focus-peak-donor.png',
        ],
    }
    write_qa(decoded, work_dir, report)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('model_dir', type=Path)
    parser.add_argument('--work-dir', type=Path, required=True)
    args = parser.parse_args()
    build(args.model_dir.resolve(), args.work_dir.resolve())


if __name__ == '__main__':
    main()
