#!/usr/bin/env python3

"""从清宵已验收动作的稳定帧构造普通形态状态循环。"""

import argparse
import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image


FRAME_SIZE = 512


@dataclass(frozen=True)
class LoopRecipe:
    output: str
    source: str
    source_frames: int
    source_columns: int
    selection: tuple[int, ...]
    columns: int = 4


# 这里只选择同一条既有时间线的相邻/对称帧，不对人物做逐帧 fit、缩放或颜色匹配。
# 因此人物、古琴和常驻飘带仍使用原动作里已经验收过的同一像素与遮挡关系。
RECIPES = (
    LoopRecipe('pet-drowsy', 'sprites/pet-doze.webp', 12, 4, (0, 1, 2, 3, 4, 3, 2, 1)),
    LoopRecipe('pet-nap', 'sprites/pet-doze.webp', 12, 4, (4, 5, 6, 7, 8, 7, 6, 5)),
    LoopRecipe('pet-sleep', 'sprites/pet-dream.webp', 12, 4, (4, 5, 6, 7, 8, 7, 6, 5)),
    LoopRecipe('pet-happy', 'sprites/pet-content.webp', 12, 4, (2, 3, 4, 5, 6, 7, 8, 7, 6, 5, 4, 3)),
    LoopRecipe(
        'pet-annoyed',
        'modules/tsundere/sprites/pet-hmph.webp',
        12,
        4,
        (3, 4, 5, 6, 7, 8, 7, 6, 5, 4),
    ),
    LoopRecipe(
        'pet-concerned',
        'modules/tsundere/sprites/pet-remind.webp',
        12,
        4,
        (3, 4, 5, 6, 7, 8, 7, 6, 5, 4),
    ),
)


def split_sheet(path: Path, frames: int, columns: int) -> list[np.ndarray]:
    image = Image.open(path).convert('RGBA')
    expected = (columns * FRAME_SIZE, math.ceil(frames / columns) * FRAME_SIZE)

    if image.size != expected:
        raise ValueError(f'{path} must be {expected[0]}x{expected[1]}, got {image.width}x{image.height}')

    return [
        np.asarray(image.crop((
            index % columns * FRAME_SIZE,
            index // columns * FRAME_SIZE,
            (index % columns + 1) * FRAME_SIZE,
            (index // columns + 1) * FRAME_SIZE,
        )), dtype=np.uint8).copy()
        for index in range(frames)
    ]


def clean_transparent_rgb(frame: np.ndarray) -> np.ndarray:
    output = frame.copy()
    output[output[:, :, 3] == 0, :3] = 0
    return output


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


def alpha_bbox(frame: np.ndarray) -> tuple[int, int, int, int] | None:
    return Image.fromarray(frame[:, :, 3], 'L').getbbox()


def save_and_verify(
    model_dir: Path,
    output_name: str,
    frames: list[np.ndarray],
    columns: int,
) -> dict[str, object]:
    output = model_dir / 'sprites' / f'{output_name}.webp'
    sheet = compose_sheet(frames, columns)

    sheet.save(output, format='WEBP', lossless=True, method=6, exact=True)
    decoded = Image.open(output).convert('RGBA')
    expected_size = (columns * FRAME_SIZE, math.ceil(len(frames) / columns) * FRAME_SIZE)

    if decoded.size != expected_size:
        raise ValueError(f'{output} decoded to the wrong size')

    decoded_frames = split_sheet(output, len(frames), columns)
    for index, (expected, actual) in enumerate(zip(frames, decoded_frames)):
        if not np.array_equal(clean_transparent_rgb(expected), actual):
            raise ValueError(f'{output} frame {index} changed during lossless encode')

    bboxes = [alpha_bbox(frame) for frame in decoded_frames]
    visible_edges = [
        int(np.count_nonzero(np.concatenate((
            frame[0, :, 3],
            frame[-1, :, 3],
            frame[:, 0, 3],
            frame[:, -1, 3],
        ))))
        for frame in decoded_frames
    ]
    hidden_rgb = max(
        int(frame[frame[:, :, 3] == 0, :3].max(initial=0))
        for frame in decoded_frames
    )

    if any(visible_edges) or hidden_rgb != 0:
        raise ValueError(f'{output} failed transparent edge hygiene')

    return {
        'output': str(output.relative_to(model_dir)),
        'frames': len(frames),
        'columns': columns,
        'decodedSize': list(decoded.size),
        'alphaBboxes': bboxes,
        'edgeAlphaPixels': visible_edges,
        'hiddenRgbMaximum': hidden_rgb,
        'uniqueFrames': len({hashlib.sha256(frame.tobytes()).hexdigest() for frame in decoded_frames}),
        'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('model_dir', type=Path)
    parser.add_argument('--qa-report', type=Path)
    args = parser.parse_args()
    report: dict[str, object] = {'model': str(args.model_dir), 'animations': {}}
    model_dir = args.model_dir.resolve()

    for recipe in RECIPES:
        source_frames = split_sheet(
            model_dir / recipe.source,
            recipe.source_frames,
            recipe.source_columns,
        )
        frames = [source_frames[index].copy() for index in recipe.selection]
        result = save_and_verify(model_dir, recipe.output, frames, recipe.columns)
        result['source'] = recipe.source
        result['sourceFrames'] = list(recipe.selection)
        report['animations'][recipe.output] = result

    # 战斗/心魔常态需要各自材质的闭眼 donor，由 form-action 脚本统一生成。
    # 这里刻意不再写它们，防止普通形态眼睛重新覆盖化形常态。

    if args.qa_report:
        args.qa_report.parent.mkdir(parents=True, exist_ok=True)
        args.qa_report.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + '\n',
            encoding='utf-8',
        )


if __name__ == '__main__':
    main()
