#!/usr/bin/env python3

"""构建清宵战斗/心魔形态的完整动作表与形态过渡表。"""

import argparse
import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


FRAME_SIZE = 512
TRANSITION_PROGRESS = (0.0, 0.12, 0.32, 0.62, 0.86, 1.0, 1.0, 1.0)
# Enter 的形态展示是一次完整往返；用单条连续进度生成，避免把两个 one-shot 串起来时
# 在目标形态处重复首尾帧，造成肉眼可见的停顿或第二段动画感。
ROUND_TRIP_PROGRESS = (
    0.0, 0.08, 0.18, 0.35, 0.58, 0.78, 0.94, 1.0,
    1.0, 0.94, 0.78, 0.58, 0.35, 0.18, 0.08, 0.0,
)


@dataclass(frozen=True)
class ActionRecipe:
    """一个普通形态动作及其两个形态输出位置。"""

    animation: str
    source: str
    attack_output: str
    demon_output: str
    frames: int
    columns: int


# 这里只为真正会在宠物动作控制器中播放的 12 套 one-shot 动画生成变体。
# 多个 action 共用同一动画时继续共用同一形态 sheet，避免重复占用解码内存。
ACTION_RECIPES = (
    ActionRecipe(
        'pet-content', 'sprites/pet-content.webp',
        'sprites/pet-attack-content.webp', 'sprites/pet-demon-content.webp', 12, 4,
    ),
    ActionRecipe(
        'pet-chime', 'sprites/pet-chime.webp',
        'sprites/pet-attack-chime.webp', 'sprites/pet-demon-chime.webp', 12, 4,
    ),
    ActionRecipe(
        'pet-doze', 'sprites/pet-doze.webp',
        'sprites/pet-attack-doze.webp', 'sprites/pet-demon-doze.webp', 12, 4,
    ),
    ActionRecipe(
        'pet-dream', 'sprites/pet-dream.webp',
        'sprites/pet-attack-dream.webp', 'sprites/pet-demon-dream.webp', 12, 4,
    ),
    ActionRecipe(
        'pet-curious', 'sprites/pet-curious.webp',
        'sprites/pet-attack-curious.webp', 'sprites/pet-demon-curious.webp', 12, 4,
    ),
    ActionRecipe(
        'lively/startled', 'modules/lively/sprites/pet-startled.webp',
        'modules/lively/sprites/pet-attack-startled.webp',
        'modules/lively/sprites/pet-demon-startled.webp', 12, 4,
    ),
    ActionRecipe(
        'lively/summon-orb', 'modules/lively/sprites/pet-summon-orb.webp',
        'modules/lively/sprites/pet-attack-summon-orb.webp',
        'modules/lively/sprites/pet-demon-summon-orb.webp', 16, 4,
    ),
    # “剑气凝心”使用独立 sheet；保留 summon-orb 供手柄与节日动作继续复用云珠语义。
    ActionRecipe(
        'lively/sword-qi-focus', 'modules/lively/sprites/pet-sword-qi-focus.webp',
        'modules/lively/sprites/pet-attack-sword-qi-focus.webp',
        'modules/lively/sprites/pet-demon-sword-qi-focus.webp', 16, 4,
    ),
    ActionRecipe(
        'lively/glissando', 'modules/lively/sprites/pet-glissando.webp',
        'modules/lively/sprites/pet-attack-glissando.webp',
        'modules/lively/sprites/pet-demon-glissando.webp', 12, 4,
    ),
    ActionRecipe(
        'lively/wink-wave', 'modules/lively/sprites/pet-wink-wave.webp',
        'modules/lively/sprites/pet-attack-wink-wave.webp',
        'modules/lively/sprites/pet-demon-wink-wave.webp', 16, 4,
    ),
    ActionRecipe(
        'tsundere/remind', 'modules/tsundere/sprites/pet-remind.webp',
        'modules/tsundere/sprites/pet-attack-remind.webp',
        'modules/tsundere/sprites/pet-demon-remind.webp', 12, 4,
    ),
    ActionRecipe(
        'tsundere/hmph', 'modules/tsundere/sprites/pet-hmph.webp',
        'modules/tsundere/sprites/pet-attack-hmph.webp',
        'modules/tsundere/sprites/pet-demon-hmph.webp', 12, 4,
    ),
)


def clean_transparent_rgb(frame: np.ndarray) -> np.ndarray:
    """透明像素隐藏色统一清零，保证无损编码和哈希可重复。"""

    output = frame.copy()
    output[output[:, :, 3] == 0, :3] = 0
    return output


def split_sheet(path: Path, frames: int, columns: int) -> list[np.ndarray]:
    image = Image.open(path).convert('RGBA')
    expected = (columns * FRAME_SIZE, math.ceil(frames / columns) * FRAME_SIZE)

    if image.size != expected:
        raise ValueError(
            f'{path} must be {expected[0]}x{expected[1]}, got {image.width}x{image.height}'
        )

    return [
        clean_transparent_rgb(np.asarray(image.crop((
            index % columns * FRAME_SIZE,
            index // columns * FRAME_SIZE,
            (index % columns + 1) * FRAME_SIZE,
            (index // columns + 1) * FRAME_SIZE,
        )), dtype=np.uint8))
        for index in range(frames)
    ]


def compose_sheet(frames: list[np.ndarray], columns: int) -> Image.Image:
    sheet = Image.new(
        'RGBA',
        (columns * FRAME_SIZE, math.ceil(len(frames) / columns) * FRAME_SIZE),
        (0, 0, 0, 0),
    )
    for index, frame in enumerate(frames):
        sheet.alpha_composite(
            Image.fromarray(clean_transparent_rgb(frame), 'RGBA'),
            (index % columns * FRAME_SIZE, index // columns * FRAME_SIZE),
        )
    return sheet


def smoothstep(low: float, high: float, values: np.ndarray) -> np.ndarray:
    scaled = np.clip((values - low) / (high - low), 0, 1)
    return scaled * scaled * (3 - 2 * scaled)


def attack_tint(frame: np.ndarray) -> np.ndarray:
    """把蓝青材质提升为攻击形态的月白/冰蓝，同时保护肤色和金色纹样。"""

    output = frame.copy()
    rgb = frame[:, :, :3].astype(np.float32)
    red, green, blue = np.moveaxis(rgb, 2, 0)
    luma = red * 0.2126 + green * 0.7152 + blue * 0.0722
    chroma = np.max(rgb, axis=2) - np.min(rgb, axis=2)
    y, x = np.indices(luma.shape)
    blue_family = smoothstep(5, 70, blue - (red + green) / 2)
    cool = smoothstep(0, 55, np.maximum(blue - red, green - red))
    dark = smoothstep(35, 135, luma)
    head = np.exp(-1.2 * (((x - 255) / 150) ** 2 + ((y - 205) / 135) ** 2))
    skin = smoothstep(8, 40, red - blue) * smoothstep(0, 25, red - green)
    gold = smoothstep(8, 40, red - blue) * smoothstep(3, 30, green - blue)
    neutral = (1 - smoothstep(20, 75, chroma)) * smoothstep(95, 205, luma)
    strength = (
        blue_family * (0.1 + 0.8 * head) * (0.18 + 0.82 * dark)
        + 0.05 * cool * dark
        + 0.035 * neutral
    ) * (1 - 0.8 * np.maximum(skin, gold))
    strength = np.clip(strength, 0, 0.82)
    target = np.array([238, 248, 255], dtype=np.float32)
    output[:, :, :3] = np.clip(
        np.rint(rgb + (target - rgb) * strength[:, :, None]), 0, 255
    ).astype(np.uint8)
    return clean_transparent_rgb(output)


def demon_tint(frame: np.ndarray) -> np.ndarray:
    """按心魔原型分区换色，保留皮肤、白衣和金纹，不做整帧紫色滤镜。"""

    output = frame.copy()
    rgb = frame[:, :, :3].astype(np.float32)
    red, green, blue = np.moveaxis(rgb, 2, 0)
    visible = frame[:, :, 3] > 0
    chroma = np.maximum.reduce((red, green, blue)) - np.minimum.reduce((red, green, blue))
    blue_family = visible & (blue >= 70) & (blue - red >= 18) & (chroma >= 25)
    cyan_accent = blue_family & (green - red >= 35) & (blue - green <= 65) & (green >= 100)
    blue_material = blue_family & ~cyan_accent

    material = rgb.copy()
    material[:, :, 0] = np.clip(red * 0.45 + green * 0.28 + blue * 0.15 + 5, 0, 255)
    material[:, :, 1] = np.clip(red * 0.12 + green * 0.48 + blue * 0.14 + 3, 0, 255)
    material[:, :, 2] = np.clip(red * 0.06 + green * 0.16 + blue * 0.72 + 2, 0, 255)
    accent = rgb.copy()
    accent[:, :, 0] = np.clip(red * 0.25 + green * 0.20 + blue * 0.38 + 5, 0, 255)
    accent[:, :, 1] = np.clip(red * 0.08 + green * 0.32 + blue * 0.16 + 5, 0, 255)
    accent[:, :, 2] = np.clip(red * 0.08 + green * 0.18 + blue * 0.76, 0, 255)
    output[blue_material, :3] = np.rint(material[blue_material]).astype(np.uint8)
    output[cyan_accent, :3] = np.rint(accent[cyan_accent]).astype(np.uint8)
    return clean_transparent_rgb(output)


def ellipse_mask(boxes: tuple[tuple[int, int, int, int], ...]) -> np.ndarray:
    mask = Image.new('L', (FRAME_SIZE, FRAME_SIZE), 0)
    draw = ImageDraw.Draw(mask)
    for box in boxes:
        draw.ellipse(box, fill=255)
    return np.asarray(mask, dtype=np.uint8) > 0


def prepare_references(model_dir: Path, work_dir: Path) -> None:
    """提取三种完整 canonical，供图像编辑生成同材质闭眼 donor。"""

    references = work_dir / 'references'
    references.mkdir(parents=True, exist_ok=True)
    normal = split_sheet(model_dir / 'sprites/pet-idle.webp', 12, 4)[0]
    attack = split_sheet(model_dir / 'sprites/transform.webp', 16, 4)[7]
    demon = split_sheet(model_dir / 'sprites/pet-heart-demon.webp', 16, 4)[7]
    for name, frame in (('normal-open', normal), ('attack-open', attack), ('demon-open', demon)):
        Image.fromarray(frame, 'RGBA').save(references / f'{name}.png')


def normalize_closed_donor(path: Path, canonical: np.ndarray) -> np.ndarray:
    """把图像编辑结果统一到 512px；最终只会消费固定眼部 ROI。"""

    image = Image.open(path).convert('RGBA')
    if image.size != (FRAME_SIZE, FRAME_SIZE):
        image = image.resize((FRAME_SIZE, FRAME_SIZE), Image.Resampling.LANCZOS)
    donor = clean_transparent_rgb(np.asarray(image, dtype=np.uint8))
    # 眼部以外永远回填 canonical，防止图像模型的全身细微重绘进入正式雪碧图。
    eye_roi = ellipse_mask(((184, 198, 254, 248), (242, 198, 312, 248)))
    output = canonical.copy()
    output[eye_roi] = donor[eye_roi]
    return clean_transparent_rgb(output)


def build_form_action_frames(
    normal_canonical: np.ndarray,
    form_canonical: np.ndarray,
    closed_donor: np.ndarray,
    source_frames: list[np.ndarray],
    tint,
) -> list[np.ndarray]:
    """从完整形态 canonical 出发，只移植普通动作的姿势/表情/特效差分。"""

    normal_closed = split_eye_reference(source_frames, normal_canonical)
    left_eye, right_eye = eye_masks(normal_canonical, normal_closed)
    frames: list[np.ndarray] = []
    for source in source_frames:
        motion = np.any(source != normal_canonical, axis=2)
        # 扩一像素覆盖抗锯齿边缘；输出仍是一张完整 RGBA 帧，不在运行时叠人物图层。
        motion = np.asarray(
            Image.fromarray((motion * 255).astype(np.uint8), 'L').filter(ImageFilter.MaxFilter(3)),
            dtype=np.uint8,
        ) > 0
        transformed = tint(source)
        frame = form_canonical.copy()
        frame[motion] = transformed[motion]

        # 普通动作中哪只眼实际闭合，就只换对应形态的闭眼 donor；解决普通眼色混入化形帧。
        for mask in (left_eye, right_eye):
            if np.count_nonzero(np.any(source[mask] != normal_canonical[mask], axis=1)) > 12:
                frame[mask] = closed_donor[mask]
        frames.append(clean_transparent_rgb(frame))

    frames[0] = form_canonical.copy()
    frames[-1] = form_canonical.copy()
    return frames


def split_eye_reference(frames: list[np.ndarray], canonical: np.ndarray) -> np.ndarray:
    """选取眼部变化最大的源帧，只用于识别普通动作中的闭眼语义。"""

    roi = ellipse_mask(((184, 198, 254, 248), (242, 198, 312, 248)))
    return max(
        frames,
        key=lambda frame: int(np.count_nonzero(np.any(frame[roi] != canonical[roi], axis=1))),
    )


def eye_masks(canonical: np.ndarray, closed: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    changed = np.any(canonical != closed, axis=2)
    left = changed & ellipse_mask(((184, 198, 254, 248),))
    right = changed & ellipse_mask(((242, 198, 312, 248),))
    return left, right


def blend_frame(start: np.ndarray, end: np.ndarray, progress: float) -> np.ndarray:
    blended = np.rint(
        start.astype(np.float32) * (1 - progress) + end.astype(np.float32) * progress
    ).astype(np.uint8)
    return clean_transparent_rgb(blended)


def transition_frames(start: np.ndarray, end: np.ndarray) -> list[np.ndarray]:
    frames = [blend_frame(start, end, progress) for progress in TRANSITION_PROGRESS]
    frames[0] = start.copy()
    frames[-1] = end.copy()
    return frames


def round_trip_frames(start: np.ndarray, target: np.ndarray) -> list[np.ndarray]:
    """从来源形态连续展示目标形态后回到来源形态，语义状态不发生改变。"""

    frames = [blend_frame(start, target, progress) for progress in ROUND_TRIP_PROGRESS]
    frames[0] = start.copy()
    frames[-1] = start.copy()
    return frames


def flourish_frames(canonical: np.ndarray, form: str) -> list[np.ndarray]:
    progress_values = (0.0, 0.25, 0.55, 0.8, 0.8, 0.55, 0.25, 0.0)
    frames = []
    for progress in progress_values:
        target = canonical.copy().astype(np.float32)
        visible = canonical[:, :, 3] > 0
        if form == 'attack':
            target[visible, :3] = np.clip(target[visible, :3] + 10, 0, 255)
        else:
            target[visible, 0] = np.clip(target[visible, 0] + 8, 0, 255)
            target[visible, 2] = np.clip(target[visible, 2] + 12, 0, 255)
        frames.append(blend_frame(canonical, target.astype(np.uint8), progress))
    frames[0] = canonical.copy()
    frames[-1] = canonical.copy()
    return frames


def save_verified_sheet(
    model_dir: Path,
    relative_path: str,
    frames: list[np.ndarray],
    columns: int,
    expected_first: np.ndarray,
    expected_last: np.ndarray,
) -> dict[str, object]:
    output = model_dir / relative_path
    output.parent.mkdir(parents=True, exist_ok=True)
    compose_sheet(frames, columns).save(
        output, format='WEBP', lossless=True, method=6, exact=True
    )
    decoded = split_sheet(output, len(frames), columns)
    if not all(np.array_equal(left, right) for left, right in zip(frames, decoded)):
        raise ValueError(f'{output} changed during lossless WebP encoding')
    if not np.array_equal(decoded[0], expected_first):
        raise ValueError(f'{output} first frame does not match its source form')
    if not np.array_equal(decoded[-1], expected_last):
        raise ValueError(f'{output} last frame does not match its target form')

    edge_alpha = [
        int(np.count_nonzero(np.concatenate((
            frame[0, :, 3], frame[-1, :, 3], frame[:, 0, 3], frame[:, -1, 3],
        ))))
        for frame in decoded
    ]
    hidden_rgb = max(
        int(frame[frame[:, :, 3] == 0, :3].max(initial=0)) for frame in decoded
    )
    if any(edge_alpha) or hidden_rgb:
        raise ValueError(f'{output} failed transparent-edge hygiene')

    return {
        'output': relative_path,
        'frames': len(frames),
        'columns': columns,
        'decodedSize': [columns * FRAME_SIZE, math.ceil(len(frames) / columns) * FRAME_SIZE],
        'edgeAlphaPixels': edge_alpha,
        'hiddenRgbMaximum': hidden_rgb,
        'uniqueFrames': len({hashlib.sha256(frame.tobytes()).hexdigest() for frame in decoded}),
        'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
    }


def save_contact_sheet(
    model_dir: Path,
    entries: list[tuple[str, str]],
    output: Path,
) -> None:
    """每个动作抽首帧、中间帧、末帧，组成可快速人工检查的形态总览。"""

    cell_width = FRAME_SIZE
    cell_height = FRAME_SIZE + 32
    preview = Image.new('RGBA', (3 * cell_width, len(entries) * cell_height), (32, 38, 48, 255))
    draw = ImageDraw.Draw(preview)
    for row, (label, relative_path) in enumerate(entries):
        image = Image.open(model_dir / relative_path).convert('RGBA')
        columns = image.width // FRAME_SIZE
        rows = image.height // FRAME_SIZE
        frame_count = columns * rows
        indices = (0, max(0, frame_count // 2), max(0, frame_count - 1))
        for column, index in enumerate(indices):
            frame = image.crop((
                index % columns * FRAME_SIZE,
                index // columns * FRAME_SIZE,
                (index % columns + 1) * FRAME_SIZE,
                (index // columns + 1) * FRAME_SIZE,
            ))
            preview.alpha_composite(frame, (column * cell_width, row * cell_height + 32))
        draw.text((8, row * cell_height + 8), label, fill=(235, 241, 250, 255))
    output.parent.mkdir(parents=True, exist_ok=True)
    preview.save(output)


def build(model_dir: Path, work_dir: Path, report_path: Path) -> None:
    # 开眼 canonical 直接从正式模型提取；闭眼 donor 则随模型 references 一并保存。
    # 因此任何开发者只需仓库内容即可复建，不依赖当前机器的临时 artifacts 目录。
    normal = split_sheet(model_dir / 'sprites/pet-idle.webp', 12, 4)[0]
    attack = split_sheet(model_dir / 'sprites/transform.webp', 16, 4)[7]
    demon = split_sheet(model_dir / 'sprites/pet-heart-demon.webp', 16, 4)[7]
    attack_closed = normalize_closed_donor(
        model_dir / 'references/attack-form-closed-eye-donor.png', attack
    )
    demon_closed = normalize_closed_donor(
        model_dir / 'references/demon-form-closed-eye-donor.png', demon
    )
    report: dict[str, object] = {'model': str(model_dir), 'animations': {}}
    attack_contacts: list[tuple[str, str]] = []
    demon_contacts: list[tuple[str, str]] = []

    # 形态常态也从各自完整 canonical 构建，闭眼帧不再引用普通形态眼部像素。
    for form, canonical, closed, relative_path in (
        ('attack', attack, attack_closed, 'sprites/pet-attack-idle.webp'),
        ('demon', demon, demon_closed, 'sprites/pet-demon-idle.webp'),
    ):
        idle_frames = [canonical.copy()] * 4 + [closed.copy(), canonical.copy()]
        result = save_verified_sheet(
            model_dir, relative_path, idle_frames, 3, canonical, canonical
        )
        report['animations'][f'pet-{form}-idle'] = result

    for recipe in ACTION_RECIPES:
        source = split_sheet(model_dir / recipe.source, recipe.frames, recipe.columns)
        attack_frames = build_form_action_frames(
            normal, attack, attack_closed, source, attack_tint
        )
        demon_frames = build_form_action_frames(
            normal, demon, demon_closed, source, demon_tint
        )
        attack_result = save_verified_sheet(
            model_dir, recipe.attack_output, attack_frames, recipe.columns, attack, attack
        )
        demon_result = save_verified_sheet(
            model_dir, recipe.demon_output, demon_frames, recipe.columns, demon, demon
        )
        report['animations'][f'attack/{recipe.animation}'] = attack_result
        report['animations'][f'demon/{recipe.animation}'] = demon_result
        attack_contacts.append((recipe.animation, recipe.attack_output))
        demon_contacts.append((recipe.animation, recipe.demon_output))

    transition_specs = (
        ('pet-normal-to-attack', 'sprites/pet-normal-to-attack.webp', transition_frames(normal, attack), normal, attack),
        ('pet-demon-to-attack', 'sprites/pet-demon-to-attack.webp', transition_frames(demon, attack), demon, attack),
        ('pet-attack-flourish', 'sprites/pet-attack-flourish.webp', flourish_frames(attack, 'attack'), attack, attack),
        ('pet-normal-to-demon', 'sprites/pet-normal-to-demon.webp', transition_frames(normal, demon), normal, demon),
        ('pet-attack-to-demon', 'sprites/pet-attack-to-demon.webp', transition_frames(attack, demon), attack, demon),
        ('pet-demon-flourish', 'sprites/pet-demon-flourish.webp', flourish_frames(demon, 'demon'), demon, demon),
        ('pet-attack-to-normal', 'sprites/pet-attack-to-normal.webp', transition_frames(attack, normal), attack, normal),
        ('pet-demon-to-normal', 'sprites/pet-demon-to-normal.webp', transition_frames(demon, normal), demon, normal),
        # 三条往返动画只负责可见展示；最终形态由状态机 action 的来源快照决定，
        # 因此首尾必须严格等于同一个 canonical，且 action 配置不能附带 stateEffect。
        ('pet-normal-attack-return', 'sprites/pet-normal-attack-return.webp', round_trip_frames(normal, attack), normal, normal),
        ('pet-attack-demon-return', 'sprites/pet-attack-demon-return.webp', round_trip_frames(attack, demon), attack, attack),
        ('pet-demon-normal-return', 'sprites/pet-demon-normal-return.webp', round_trip_frames(demon, normal), demon, demon),
    )
    for name, relative_path, frames, first, last in transition_specs:
        result = save_verified_sheet(model_dir, relative_path, frames, 4, first, last)
        report['animations'][name] = result

    save_contact_sheet(model_dir, attack_contacts, work_dir / 'qa/attack-actions-contact.png')
    save_contact_sheet(model_dir, demon_contacts, work_dir / 'qa/demon-actions-contact.png')
    save_contact_sheet(
        model_dir,
        [
            ('normal -> attack -> normal', 'sprites/pet-normal-attack-return.webp'),
            ('attack -> demon -> attack', 'sprites/pet-attack-demon-return.webp'),
            ('demon -> normal -> demon', 'sprites/pet-demon-normal-return.webp'),
        ],
        work_dir / 'qa/form-round-trips-contact.png',
    )
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('model_dir', type=Path)
    parser.add_argument('--work-dir', type=Path, required=True)
    parser.add_argument('--qa-report', type=Path)
    parser.add_argument('--prepare-references', action='store_true')
    args = parser.parse_args()
    model_dir = args.model_dir.resolve()
    work_dir = args.work_dir.resolve()
    if args.prepare_references:
        prepare_references(model_dir, work_dir)
        return
    if args.qa_report is None:
        raise ValueError('--qa-report is required unless --prepare-references is used')
    build(model_dir, work_dir, args.qa_report.resolve())


if __name__ == '__main__':
    main()
