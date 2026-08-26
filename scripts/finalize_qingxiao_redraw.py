#!/usr/bin/env python3

"""统一清宵重画雪碧图的跨动作端点，避免动作切换时闪现另一套姿势。"""

import argparse
import math
from pathlib import Path

from PIL import Image


FRAME_SIZE = 512
SHEET_SPECS = {
    'idle': (6, 3),
    **{f'pluck-{index:02d}': (6, 3) for index in range(1, 11)},
    'transform': (16, 4),
    'pet-enter': (8, 4),
    'pet-idle': (12, 4),
    'pet-exit': (8, 4),
    'pet-doze': (12, 4),
    'pet-dream': (12, 4),
    'pet-chime': (12, 4),
    'pet-curious': (12, 4),
    'pet-content': (12, 4),
    'pet-startled': (12, 4),
    'pet-summon-orb': (16, 4),
    'pet-glissando': (12, 4),
    'pet-remind': (12, 4),
    'pet-wink-wave': (16, 4),
    'pet-hmph': (12, 4),
    'pet-heart-demon': (16, 4),
}


def split_sheet(path: Path, frames: int, columns: int) -> list[Image.Image]:
    """按模型契约拆出固定 512px 帧，并在端点复用前先验证表尺寸。"""
    image = Image.open(path).convert('RGBA')
    rows = math.ceil(frames / columns)
    expected_size = (columns * FRAME_SIZE, rows * FRAME_SIZE)
    if image.size != expected_size:
        raise ValueError(f'{path}: expected {expected_size}, got {image.size}')
    return [
        image.crop(
            (
                index % columns * FRAME_SIZE,
                index // columns * FRAME_SIZE,
                (index % columns + 1) * FRAME_SIZE,
                (index // columns + 1) * FRAME_SIZE,
            )
        )
        for index in range(frames)
    ]


def save_sheet(path: Path, frames: list[Image.Image], columns: int) -> None:
    """无损重组雪碧表；透明区 RGB 也保留，避免 WebP 边缘出现黑边。"""
    rows = math.ceil(len(frames) / columns)
    image = Image.new(
        'RGBA',
        (columns * FRAME_SIZE, rows * FRAME_SIZE),
        (0, 0, 0, 0),
    )
    for index, frame in enumerate(frames):
        image.alpha_composite(
            frame,
            (index % columns * FRAME_SIZE, index // columns * FRAME_SIZE),
        )
    image.save(path, format='WEBP', lossless=True, method=6, exact=True)


def save_qa_preview(sheet_path: Path, output_path: Path, color: tuple[int, int, int, int]) -> None:
    """把透明成品铺到深/浅底上，专门检查灰边、残底和跨格碎片。"""
    image = Image.open(sheet_path).convert('RGBA')
    preview = Image.new('RGBA', image.size, color)
    preview.alpha_composite(image)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    preview.save(output_path)


def save_model_cover(frame: Image.Image, output_path: Path) -> None:
    """用正式工作态生成模型卡片，避免列表封面仍显示旧版无飘带人物。"""
    bbox = frame.getchannel('A').point(lambda value: 255 if value >= 8 else 0).getbbox()
    if bbox is None:
        raise ValueError('cannot build model cover from an empty frame')
    content = frame.crop(bbox)
    scale = min(580 / content.width, 338 / content.height)
    content = content.resize(
        (round(content.width * scale), round(content.height * scale)),
        Image.Resampling.LANCZOS,
    )
    cover = Image.new('RGBA', (612, 354), (0, 0, 0, 0))
    cover.alpha_composite(
        content,
        ((cover.width - content.width) // 2, cover.height - content.height - 8),
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cover.save(output_path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('sprites_dir', type=Path)
    parser.add_argument('--qa-dir', type=Path)
    parser.add_argument('--cover', type=Path)
    args = parser.parse_args()

    sheets = {
        name: split_sheet(args.sprites_dir / f'{name}.webp', frames, columns)
        for name, (frames, columns) in SHEET_SPECS.items()
    }
    work_pose = sheets['idle'][0].copy()
    pet_pose = sheets['pet-idle'][0].copy()
    if args.cover:
        save_model_cover(work_pose, args.cover)

    # 键盘动作必须从当前工作态出发并回到同一张工作态；直接复用整帧可以杜绝
    # 旧方案里“先出现合成飘带，再切到动作原图”的双动画闪跳。
    for index in range(1, 11):
        frames = sheets[f'pluck-{index:02d}']
        frames[0] = work_pose.copy()
        frames[-1] = work_pose.copy()
    sheets['transform'][0] = work_pose.copy()
    sheets['transform'][-1] = work_pose.copy()

    # 宠物进入/离开是工作态与宠物态之间唯一允许切换的桥；其他宠物动作都从
    # 同一张宠物端点开始并结束，所以连续点菜单或被动触发时不会突然换尺寸/姿势。
    sheets['pet-idle'][-1] = pet_pose.copy()
    sheets['pet-enter'][0] = work_pose.copy()
    sheets['pet-enter'][-1] = pet_pose.copy()
    sheets['pet-exit'][0] = pet_pose.copy()
    sheets['pet-exit'][-1] = work_pose.copy()

    # 此处只统一跨动作端点，不再按单帧可见边界放大云珠动作。单帧 fit 会让
    # 人物尺寸随特效范围变化；统一尺寸由后续 stabilize_qingxiao_redraw.py
    # 依据工作态/宠物态共同基准处理。
    for name in SHEET_SPECS:
        if not name.startswith('pet-') or name in {'pet-enter', 'pet-idle', 'pet-exit'}:
            continue
        sheets[name][0] = pet_pose.copy()
        sheets[name][-1] = pet_pose.copy()

    for name, frames in sheets.items():
        columns = SHEET_SPECS[name][1]
        path = args.sprites_dir / f'{name}.webp'
        save_sheet(path, frames, columns)
        if args.qa_dir:
            save_qa_preview(path, args.qa_dir / name / 'dark.png', (26, 28, 34, 255))
            save_qa_preview(path, args.qa_dir / name / 'light.png', (242, 245, 248, 255))

    print(f'finalized {len(sheets)} Qingxiao sprite sheets in {args.sprites_dir.resolve()}')


if __name__ == '__main__':
    main()
