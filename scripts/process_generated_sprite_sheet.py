#!/usr/bin/env python3

"""把图像模型生成的中性背景雪碧表转换成可导入的透明 WebP。"""

import argparse
import json
import math
import subprocess
import tempfile
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


FRAME_SIZE = 512


def remove_boundary_fragments(image: Image.Image) -> tuple[Image.Image, int]:
    """移除从相邻网格越界进来的小碎片，同时拒绝真正被网格裁断的主体。"""
    rgba = np.asarray(image.convert('RGBA')).copy()
    foreground = rgba[:, :, 3] >= 8
    foreground_pixels = int(foreground.sum())
    if foreground_pixels == 0:
        return image, 0

    height, width = foreground.shape
    boundary_seeds = [
        *((0, x) for x in range(width)),
        *((height - 1, x) for x in range(width)),
        *((y, 0) for y in range(1, height - 1)),
        *((y, width - 1) for y in range(1, height - 1)),
    ]
    visited = np.zeros_like(foreground, dtype=bool)
    removed = np.zeros_like(foreground, dtype=bool)
    maximum_fragment_pixels = max(600, round(foreground_pixels * 0.12))

    for seed_y, seed_x in boundary_seeds:
        if visited[seed_y, seed_x] or not foreground[seed_y, seed_x]:
            continue
        queue = deque([(seed_y, seed_x)])
        visited[seed_y, seed_x] = True
        component: list[tuple[int, int]] = []
        while queue:
            y, x = queue.popleft()
            component.append((y, x))
            for neighbor_y in range(max(0, y - 1), min(height, y + 2)):
                for neighbor_x in range(max(0, x - 1), min(width, x + 2)):
                    if (
                        not visited[neighbor_y, neighbor_x]
                        and foreground[neighbor_y, neighbor_x]
                    ):
                        visited[neighbor_y, neighbor_x] = True
                        queue.append((neighbor_y, neighbor_x))

        # 图像模型偶尔会让上一格的飘带尖端越过等分线。它会紧贴单元格边界，
        # 面积却远小于本格人物；只清理这种小组件。若触边组件较大，它通常是本格
        # 主体自己的琴尾或飘带，必须原样保留，不能为了“清边”误删完整人物。
        if len(component) > maximum_fragment_pixels:
            continue
        component_y, component_x = zip(*component)
        removed[component_y, component_x] = True

    removed_pixels = int(removed.sum())
    if removed_pixels:
        rgba[removed] = 0
    return Image.fromarray(rgba, 'RGBA'), removed_pixels


def fit_background(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """拟合图像模型产生的轻微灰底渐变，避免透明边缘残留一圈灰色。"""
    height, width, _ = rgb.shape
    y, x = np.mgrid[0:height, 0:width].astype(np.float32)
    normalized_x = x / max(1, width - 1)
    normalized_y = y / max(1, height - 1)
    features = np.stack(
        [
            np.ones_like(normalized_x),
            normalized_x,
            normalized_y,
            normalized_x * normalized_x,
            normalized_y * normalized_y,
            normalized_x * normalized_y,
        ],
        axis=-1,
    )
    background_y, background_x = np.where(alpha < 0.01)
    if len(background_x) < 100:
        raise ValueError('foreground mask leaves too few background pixels to fit')
    step = max(1, len(background_x) // 120_000)
    sampled_features = features[background_y[::step], background_x[::step]]
    coefficients = np.stack(
        [
            np.linalg.lstsq(
                sampled_features,
                rgb[background_y[::step], background_x[::step], channel],
                rcond=None,
            )[0]
            for channel in range(3)
        ],
        axis=1,
    )
    return features @ coefficients


def extract_rgba(input_path: Path, mask_script: Path) -> Image.Image:
    """用 Vision 蒙版和已知灰底恢复真实 Alpha，同时清理抗锯齿边缘。"""
    with tempfile.TemporaryDirectory(prefix='qingxiao-mask-') as temporary_directory:
        mask_path = Path(temporary_directory) / 'mask.png'
        subprocess.run(
            ['swift', str(mask_script), str(input_path), str(mask_path)],
            check=True,
        )
        rgb = np.asarray(Image.open(input_path).convert('RGB'), dtype=np.float32)
        mask = Image.open(mask_path).convert('L')

    # Vision 的实例蒙版会在物体外侧留约 1px 的灰底过渡；轻微内缩后重新羽化，
    # 能保留头发、飘带细节，同时避免深色桌面上出现灰色光边。
    mask = mask.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.55))
    alpha = np.asarray(mask, dtype=np.float32) / 255
    background = fit_background(rgb, alpha)

    # Vision 擅长识别完整人物，但高亮能量和发丝围成的孔洞偶尔会被当成实心前景。
    # 已知生成底是中性灰，因此再用“像素偏离拟合灰底的距离”约束一次 Alpha：
    # 外轮廓必须属于 Vision 前景，内部像素也必须确实不同于灰底，二者缺一不可。
    background_distance = np.linalg.norm(rgb - background, axis=2)
    # 生成器在半透明飘带孔洞和烟气附近会留下约 3~7 色阶的灰底波动；若从
    # 2.5 就开始给 Alpha，浅色桌面上会看见一团灰雾。提高起始距离并放缓
    # 羽化，只消掉接近制作底的像素，真正的蓝白高光仍有足够色差被保留。
    color_coverage = np.clip((background_distance - 12) / 30, 0, 1)
    alpha = np.minimum(alpha, color_coverage)
    alpha[alpha < 0.012] = 0
    alpha[alpha > 0.985] = 1

    safe_alpha = np.maximum(alpha[:, :, None], 0.02)
    foreground = (rgb - (1 - alpha[:, :, None]) * background) / safe_alpha
    foreground = np.clip(foreground, 0, 255)
    foreground[alpha == 0] = 0
    rgba = np.dstack([foreground, np.rint(alpha * 255)]).astype(np.uint8)
    return Image.fromarray(rgba, 'RGBA')


def normalize_frames(
    image: Image.Image,
    frames: int,
    columns: int,
    target_center_x: int,
    target_bottom: int,
) -> tuple[Image.Image, list[dict[str, object]]]:
    """把每个已重画帧作为整体平移到相同中心和底线，消除网格生成漂移。"""
    rows = math.ceil(frames / columns)
    expected_size = (FRAME_SIZE * columns, FRAME_SIZE * rows)
    if image.size != expected_size:
        raise ValueError(f'expected generated sheet {expected_size}, got {image.size}')

    output = Image.new('RGBA', expected_size, (0, 0, 0, 0))
    reports: list[dict[str, object]] = []
    for index in range(frames):
        source_x = index % columns * FRAME_SIZE
        source_y = index // columns * FRAME_SIZE
        frame = image.crop(
            (source_x, source_y, source_x + FRAME_SIZE, source_y + FRAME_SIZE)
        )
        frame, removed_boundary_pixels = remove_boundary_fragments(frame)
        bbox = frame.getchannel('A').point(lambda value: 255 if value >= 8 else 0).getbbox()
        if bbox is None:
            raise ValueError(f'frame {index} has no foreground')

        center_x = (bbox[0] + bbox[2]) / 2
        shift_x = round(target_center_x - center_x)
        shift_y = target_bottom - bbox[3]
        normalized = Image.new('RGBA', (FRAME_SIZE, FRAME_SIZE), (0, 0, 0, 0))
        normalized.alpha_composite(frame, (shift_x, shift_y))
        normalized_bbox = normalized.getchannel('A').point(
            lambda value: 255 if value >= 8 else 0
        ).getbbox()
        if normalized_bbox is None or normalized_bbox[0] == 0 or normalized_bbox[2] == FRAME_SIZE:
            raise ValueError(f'frame {index} is clipped after normalization: {normalized_bbox}')

        output.alpha_composite(
            normalized,
            (index % columns * FRAME_SIZE, index // columns * FRAME_SIZE),
        )
        reports.append(
            {
                'frame': index,
                'sourceBbox': bbox,
                'removedBoundaryPixels': removed_boundary_pixels,
                'shift': [shift_x, shift_y],
                'normalizedBbox': normalized_bbox,
            }
        )
    return output, reports


def normalize_arbitrary_grid(
    image: Image.Image,
    frames: int,
    columns: int,
    target_center_x: int,
    target_bottom: int,
    maximum_width: int,
    maximum_height: int,
) -> tuple[Image.Image, list[dict[str, object]]]:
    """从任意分辨率等分网格中取帧，并用整表统一比例适配 512px 画布。"""
    rows = math.ceil(frames / columns)
    cells: list[Image.Image] = []
    boxes: list[tuple[int, int, int, int]] = []
    cell_reports: list[dict[str, int]] = []
    for index in range(frames):
        column = index % columns
        row = index // columns
        left = round(column * image.width / columns)
        right = round((column + 1) * image.width / columns)
        top = round(row * image.height / rows)
        bottom = round((row + 1) * image.height / rows)
        cell = image.crop((left, top, right, bottom))
        cell, removed_boundary_pixels = remove_boundary_fragments(cell)
        bbox = cell.getchannel('A').point(lambda value: 255 if value >= 8 else 0).getbbox()
        if bbox is None:
            raise ValueError(f'frame {index} has no foreground')
        cells.append(cell)
        boxes.append(bbox)
        reports_for_cell = {
            'removedBoundaryPixels': removed_boundary_pixels,
        }
        # 与 cells/boxes 保持相同下标，稍后写入逐帧报告；这里只记录透明化后
        # 被确认是相邻网格越界碎片的像素数，便于 QA 发现生成器排版异常。
        cell_reports.append(reports_for_cell)

    # 同一动作表只计算一个缩放比例；最大姿势/特效也必须完整留在画布内，
    # 这样不会因逐帧 fit 导致角色在播放时忽大忽小。
    maximum_source_width = max(box[2] - box[0] for box in boxes)
    maximum_source_height = max(box[3] - box[1] for box in boxes)
    scale = min(
        maximum_width / maximum_source_width,
        maximum_height / maximum_source_height,
    )

    output = Image.new(
        'RGBA',
        (FRAME_SIZE * columns, FRAME_SIZE * rows),
        (0, 0, 0, 0),
    )
    reports: list[dict[str, object]] = []
    for index, (cell, bbox) in enumerate(zip(cells, boxes)):
        content = cell.crop(bbox)
        resized_size = (
            max(1, round(content.width * scale)),
            max(1, round(content.height * scale)),
        )
        content = content.resize(resized_size, Image.Resampling.LANCZOS)
        position = (
            round(target_center_x - content.width / 2),
            target_bottom - content.height,
        )
        frame = Image.new('RGBA', (FRAME_SIZE, FRAME_SIZE), (0, 0, 0, 0))
        frame.alpha_composite(content, position)
        normalized_bbox = frame.getchannel('A').point(
            lambda value: 255 if value >= 8 else 0
        ).getbbox()
        if (
            normalized_bbox is None
            or normalized_bbox[0] == 0
            or normalized_bbox[1] == 0
            or normalized_bbox[2] == FRAME_SIZE
            or normalized_bbox[3] == FRAME_SIZE
        ):
            raise ValueError(f'frame {index} is clipped after grid normalization: {normalized_bbox}')
        output.alpha_composite(
            frame,
            (index % columns * FRAME_SIZE, index // columns * FRAME_SIZE),
        )
        reports.append(
            {
                'frame': index,
                'sourceBbox': bbox,
                **cell_reports[index],
                'scale': scale,
                'normalizedBbox': normalized_bbox,
            }
        )
    return output, reports


def save_qa_preview(image: Image.Image, output_path: Path, color: tuple[int, int, int, int]) -> None:
    preview = Image.new('RGBA', image.size, color)
    preview.alpha_composite(image)
    preview.save(output_path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--frames', type=int, required=True)
    parser.add_argument('--columns', type=int, required=True)
    parser.add_argument('--target-center-x', type=int, default=256)
    parser.add_argument('--target-bottom', type=int, default=474)
    parser.add_argument('--arbitrary-grid', action='store_true')
    parser.add_argument('--maximum-width', type=int, default=450)
    parser.add_argument('--maximum-height', type=int, default=450)
    parser.add_argument(
        '--mask-script',
        type=Path,
        default=Path(__file__).with_name('extract_foreground_mask.swift'),
    )
    parser.add_argument('--qa-dir', type=Path)
    args = parser.parse_args()

    rgba = extract_rgba(args.input, args.mask_script)
    if args.arbitrary_grid:
        normalized, reports = normalize_arbitrary_grid(
            rgba,
            args.frames,
            args.columns,
            args.target_center_x,
            args.target_bottom,
            args.maximum_width,
            args.maximum_height,
        )
    else:
        normalized, reports = normalize_frames(
            rgba,
            args.frames,
            args.columns,
            args.target_center_x,
            args.target_bottom,
        )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    normalized.save(args.output, format='WEBP', lossless=True, method=6, exact=True)

    if args.qa_dir:
        args.qa_dir.mkdir(parents=True, exist_ok=True)
        save_qa_preview(normalized, args.qa_dir / 'dark.png', (26, 28, 34, 255))
        save_qa_preview(normalized, args.qa_dir / 'light.png', (242, 245, 248, 255))

    print(
        json.dumps(
            {
                'ok': True,
                'input': str(args.input.resolve()),
                'output': str(args.output.resolve()),
                'frames': reports,
            },
            ensure_ascii=False,
        )
    )


if __name__ == '__main__':
    main()
