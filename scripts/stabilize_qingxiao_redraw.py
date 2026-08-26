#!/usr/bin/env python3

"""稳定清宵一体化重画帧的位置和播放顺序，并生成真实时长 QA 预览。"""

import argparse
import itertools
import json
import math
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


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
    """严格按 512px 单元格拆表，避免把配置错误误判成美术抖动。"""
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
    """无损保存稳定后的 RGBA 表，并确保未使用单元格保持完全透明。"""
    rows = math.ceil(len(frames) / columns)
    sheet = Image.new(
        'RGBA',
        (columns * FRAME_SIZE, rows * FRAME_SIZE),
        (0, 0, 0, 0),
    )
    for index, frame in enumerate(frames):
        sheet.alpha_composite(
            frame,
            (index % columns * FRAME_SIZE, index // columns * FRAME_SIZE),
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path, format='WEBP', lossless=True, method=6, exact=True)


def largest_component_bbox(frame: Image.Image) -> tuple[int, int, int, int]:
    """返回人物主连通体，而不是被零散法术像素撑大的整帧外接框。"""
    foreground = np.asarray(frame.getchannel('A')) >= 8
    height, width = foreground.shape
    visited = np.zeros_like(foreground, dtype=bool)
    largest: list[tuple[int, int]] = []

    for seed_y, seed_x in zip(*np.where(foreground)):
        if visited[seed_y, seed_x]:
            continue
        queue = deque([(int(seed_y), int(seed_x))])
        visited[seed_y, seed_x] = True
        component: list[tuple[int, int]] = []
        while queue:
            y, x = queue.popleft()
            component.append((y, x))
            for neighbor_y in range(max(0, y - 1), min(height, y + 2)):
                for neighbor_x in range(max(0, x - 1), min(width, x + 2)):
                    if (
                        foreground[neighbor_y, neighbor_x]
                        and not visited[neighbor_y, neighbor_x]
                    ):
                        visited[neighbor_y, neighbor_x] = True
                        queue.append((neighbor_y, neighbor_x))
        if len(component) > len(largest):
            largest = component

    if not largest:
        raise ValueError('cannot stabilize an empty frame')
    points = np.asarray(largest)
    return (
        int(points[:, 1].min()),
        int(points[:, 0].min()),
        int(points[:, 1].max()) + 1,
        int(points[:, 0].max()) + 1,
    )


def face_anchor(frame: Image.Image) -> tuple[float, float]:
    """从脸部暖色皮肤的最大连通区提取锚点，避开手、飘带和外部特效。"""
    rgba = np.asarray(frame)
    rgb = rgba[:, :, :3].astype(np.int16)
    alpha = rgba[:, :, 3]
    y, x = np.mgrid[:FRAME_SIZE, :FRAME_SIZE]
    skin = (
        (alpha > 100)
        & (rgb[:, :, 0] > 160)
        & (rgb[:, :, 1] > 105)
        & (rgb[:, :, 2] > 80)
        & (rgb[:, :, 0] > rgb[:, :, 2] + 10)
        & (rgb[:, :, 0] > rgb[:, :, 1] + 4)
        & (x >= 110)
        & (x < 410)
        & (y >= 50)
        & (y < 310)
    )
    visited = np.zeros_like(skin, dtype=bool)
    largest: list[tuple[int, int]] = []
    for seed_y, seed_x in zip(*np.where(skin)):
        if visited[seed_y, seed_x]:
            continue
        queue = deque([(int(seed_y), int(seed_x))])
        visited[seed_y, seed_x] = True
        component: list[tuple[int, int]] = []
        while queue:
            current_y, current_x = queue.popleft()
            component.append((current_y, current_x))
            for neighbor_y, neighbor_x in (
                (current_y - 1, current_x),
                (current_y + 1, current_x),
                (current_y, current_x - 1),
                (current_y, current_x + 1),
            ):
                if (
                    0 <= neighbor_y < FRAME_SIZE
                    and 0 <= neighbor_x < FRAME_SIZE
                    and skin[neighbor_y, neighbor_x]
                    and not visited[neighbor_y, neighbor_x]
                ):
                    visited[neighbor_y, neighbor_x] = True
                    queue.append((neighbor_y, neighbor_x))
        if len(component) > len(largest):
            largest = component

    # 正常清宵脸部区域远大于手指。如果低于这个面积，说明颜色或人物身份已经
    # 漂移到不能可靠自动定位，宁可中止也不能静默把一只手当成人脸来平移整帧。
    if len(largest) < 800:
        raise ValueError(f'face anchor component is too small: {len(largest)} pixels')
    points = np.asarray(largest)
    return float(points[:, 1].mean()), float(points[:, 0].mean())


def translate_frame(
    frame: Image.Image,
    shift_x: int,
    shift_y: int,
) -> tuple[Image.Image, int]:
    """平移完整重画帧；人物、飘带、表情和特效始终作为一个整体移动。"""
    rgba = np.asarray(frame).copy()
    alpha = rgba[:, :, 3]
    source_left = max(0, -shift_x)
    source_top = max(0, -shift_y)
    source_right = min(FRAME_SIZE, FRAME_SIZE - shift_x)
    source_bottom = min(FRAME_SIZE, FRAME_SIZE - shift_y)
    kept = np.zeros_like(alpha, dtype=bool)
    if source_left < source_right and source_top < source_bottom:
        kept[source_top:source_bottom, source_left:source_right] = True
    clipped_pixels = int(((alpha >= 8) & ~kept).sum())

    translated = Image.new('RGBA', (FRAME_SIZE, FRAME_SIZE), (0, 0, 0, 0))
    translated.alpha_composite(frame, (shift_x, shift_y))
    translated_rgba = np.asarray(translated).copy()
    # WebP 的透明 RGB 若残留旧颜色，缩放时会在人物外轮廓形成黑边或彩边。
    translated_rgba[translated_rgba[:, :, 3] == 0] = 0
    return Image.fromarray(translated_rgba, 'RGBA'), clipped_pixels


def align_main_component(
    frame: Image.Image,
    target_bbox: tuple[int, int, int, int],
) -> tuple[Image.Image, dict[str, object]]:
    """按同一形态的统一宽度缩放完整帧，再锁定人物主连通体的位置。"""
    source_bbox = largest_component_bbox(frame)
    source_width = source_bbox[2] - source_bbox[0]
    target_width = target_bbox[2] - target_bbox[0]
    # 这里不是把每一帧分别 fit 到画布，而是让同一形态共同服从 idle/pet-idle
    # 的人物宽度。缩放对象是完整 RGBA 帧，因此人物、古琴、飘带和动作特效
    # 仍然保持生成时的一体材质；修复的是独立生成造成的人物比例漂移。
    scale = target_width / source_width
    source_center_x = (source_bbox[0] + source_bbox[2]) / 2
    target_center_x = (target_bbox[0] + target_bbox[2]) / 2
    if abs(scale - 1) < 0.001:
        scaled = frame.copy()
        scaled_size = FRAME_SIZE
    else:
        scaled_size = round(FRAME_SIZE * scale)
        scaled = frame.resize(
            (scaled_size, scaled_size),
            Image.Resampling.LANCZOS,
        )

    # 以人物主连通体的水平中心和下沿为共同基线。先算缩放后的理论锚点，
    # 再把整张缩放帧一次性放回 512px 画布，避免“先缩放人物、再单独移动特效”。
    shift_x = round(target_center_x - source_center_x * scale)
    shift_y = round(target_bbox[3] - source_bbox[3] * scale)
    scaled_alpha = np.asarray(scaled.getchannel('A'))
    full_bbox = scaled.getchannel('A').point(
        lambda value: 255 if value >= 8 else 0
    ).getbbox()
    if full_bbox is None:
        raise ValueError('cannot align an empty scaled frame')
    # 人物基线优先，但不能为了对齐主体裁掉云珠或飘带末端。若完整前景能放入
    # 画布，就把理论位移限制在至少保留 1px 透明安全边的范围内；通常只需
    # 修正 1～2px，后续人脸轨迹仍会吸收这点位置差。
    minimum_shift_x = 1 - full_bbox[0]
    maximum_shift_x = FRAME_SIZE - 1 - full_bbox[2]
    minimum_shift_y = 1 - full_bbox[1]
    maximum_shift_y = FRAME_SIZE - 1 - full_bbox[3]
    if minimum_shift_x <= maximum_shift_x:
        shift_x = min(max(shift_x, minimum_shift_x), maximum_shift_x)
    if minimum_shift_y <= maximum_shift_y:
        shift_y = min(max(shift_y, minimum_shift_y), maximum_shift_y)
    source_left = max(0, -shift_x)
    source_top = max(0, -shift_y)
    source_right = min(scaled_size, FRAME_SIZE - shift_x)
    source_bottom = min(scaled_size, FRAME_SIZE - shift_y)
    kept = np.zeros_like(scaled_alpha, dtype=bool)
    if source_left < source_right and source_top < source_bottom:
        kept[source_top:source_bottom, source_left:source_right] = True
    clipped_pixels = int(((scaled_alpha >= 8) & ~kept).sum())

    aligned = Image.new('RGBA', (FRAME_SIZE, FRAME_SIZE), (0, 0, 0, 0))
    aligned.alpha_composite(scaled, (shift_x, shift_y))
    aligned_rgba = np.asarray(aligned).copy()
    aligned_rgba[aligned_rgba[:, :, 3] == 0] = 0
    aligned = Image.fromarray(aligned_rgba, 'RGBA')
    aligned_bbox = largest_component_bbox(aligned)
    if aligned_bbox[0] == 0 or aligned_bbox[1] == 0 or aligned_bbox[2] == FRAME_SIZE or aligned_bbox[3] == FRAME_SIZE:
        raise ValueError(f'main character touches canvas edge after alignment: {aligned_bbox}')
    visible_pixels = int((np.asarray(frame.getchannel('A')) >= 8).sum())
    if clipped_pixels > max(80, round(visible_pixels * 0.005 * scale * scale)):
        raise ValueError(
            f'main character normalization clips {clipped_pixels} visible pixels'
        )
    return aligned, {
        'sourceMainBbox': source_bbox,
        'mainScale': round(scale, 6),
        'mainShift': [shift_x, shift_y],
        'alignedMainBbox': aligned_bbox,
        'mainAlignmentClippedPixels': clipped_pixels,
    }


def target_main_bbox(
    name: str,
    frame_index: int,
    frame_count: int,
    work_bbox: tuple[int, int, int, int],
    pet_bbox: tuple[int, int, int, int],
) -> tuple[int, int, int, int]:
    """给每帧提供共享尺寸基准；进出场只做平滑的形态间过渡。"""
    if name == 'pet-enter':
        progress = frame_index / (frame_count - 1)
        start_bbox, end_bbox = work_bbox, pet_bbox
    elif name == 'pet-exit':
        progress = frame_index / (frame_count - 1)
        start_bbox, end_bbox = pet_bbox, work_bbox
    else:
        return pet_bbox if name.startswith('pet-') else work_bbox

    eased = 0.5 - math.cos(math.pi * progress) / 2
    return tuple(
        round(start + (end - start) * eased)
        for start, end in zip(start_bbox, end_bbox)
    )


def visual_feature(frame: Image.Image) -> np.ndarray:
    """用低分辨率色彩与 Alpha 联合特征衡量真实播放中的相邻帧跳变。"""
    rgba = np.asarray(frame, dtype=np.float32) / 255
    alpha = rgba[:, :, 3:4]
    # 先铺中灰再缩小；透明区不会以隐藏 RGB 参与距离，人物轮廓仍由额外 Alpha
    # 通道提高权重，因此路径选择同时关注材质突变和位置突变。
    composite = rgba[:, :, :3] * alpha + 0.5 * (1 - alpha)
    color = np.asarray(
        Image.fromarray(np.uint8(np.clip(composite * 255, 0, 255)), 'RGB').resize(
            (64, 64),
            Image.Resampling.BILINEAR,
        ),
        dtype=np.float32,
    ).reshape(-1) / 255
    small_alpha = np.asarray(
        frame.getchannel('A').resize((64, 64), Image.Resampling.BILINEAR),
        dtype=np.float32,
    ).reshape(-1) / 255
    return np.concatenate([color, small_alpha * 1.5])


def distance_matrix(frames: list[Image.Image]) -> np.ndarray:
    """一次计算完整距离矩阵，后续选帧和 QA 使用同一评价尺度。"""
    features = np.stack([visual_feature(frame) for frame in frames])
    return np.mean(np.abs(features[:, None, :] - features[None, :, :]), axis=2)


def symmetric_order(name: str, frames: list[Image.Image]) -> tuple[int, ...]:
    """选择最小化画面与位置最大跳变的出程，再用同一完整帧原路返回。"""
    frame_count = len(frames)
    active_count = (frame_count - 2) // 2
    visual_distances = distance_matrix(frames)
    anchors = np.asarray([face_anchor(frame) for frame in frames])
    face_distances = np.linalg.norm(
        anchors[:, None, :] - anchors[None, :, :],
        axis=2,
    )

    if name == 'pet-hmph':
        # 原生成表混入两组相反方向的侧脸。任意五个唯一 donor 都会被迫从左侧
        # 突然跳到右侧；这里保留同一方向的 2→7→8 三步侧身，并在峰值停留，
        # 比平移整个人物去掩盖身份/发型变化更自然。
        return 0, 2, 7, 8, 8, 8, 8, 8, 8, 7, 2, frame_count - 1
    if name == 'pet-summon-orb':
        # 云珠原表同时包含聚气、完整云珠和消散残影。纯视觉最短路径可能把
        # 残影误当峰值；固定为“准备→小云珠→聚气→大云珠→原路收回”，既保留
        # 明确语义，也让往返使用同一批完整重画帧，不会在回程换人物大小。
        return 0, 4, 3, 1, 2, 5, 6, 7, 7, 6, 5, 2, 1, 3, 4, frame_count - 1

    # 画面距离反映材质、轮廓和姿势变化；人脸距离直接反映用户看到的主体偏移。
    # 两者联合后做 minimax（最小化最大边）而不是只最小化平均值，避免九帧很顺、
    # 其中一帧突然跳走仍被低平均值掩盖。
    edge_scores = visual_distances + 0.75 * face_distances / FRAME_SIZE
    candidates = list(range(1, frame_count - 1))
    candidate_bits = {
        candidate: 1 << bit_index
        for bit_index, candidate in enumerate(candidates)
    }
    states: dict[
        tuple[int, int],
        tuple[float, float, tuple[int, ...]],
    ] = {(0, 0): (0, 0, ())}

    for _ in range(active_count):
        next_states: dict[
            tuple[int, int],
            tuple[float, float, tuple[int, ...]],
        ] = {}
        for (mask, previous), (maximum, total, path) in states.items():
            for candidate in candidates:
                candidate_bit = candidate_bits[candidate]
                if mask & candidate_bit:
                    continue
                edge = float(edge_scores[previous, candidate])
                key = mask | candidate_bit, candidate
                value = max(maximum, edge), total + edge, (*path, candidate)
                if key not in next_states or value[:2] < next_states[key][:2]:
                    next_states[key] = value
        states = next_states

    maximum_action_level = max(
        float(visual_distances[0, candidate])
        for candidate in candidates
    )
    # 峰值至少保留原表 82% 的动作强度；否则算法可能选择五张都接近待机的帧，
    # 数值非常平滑却把动作本身消掉。
    eligible = [
        state
        for (_, final_candidate), state in states.items()
        if float(visual_distances[0, final_candidate])
        >= maximum_action_level * 0.82
    ]
    if not eligible:
        raise ValueError(f'{name}: cannot choose a meaningful smooth timeline')
    _, _, best_path = min(eligible)
    return (0, *best_path, *reversed(best_path), frame_count - 1)


def lifecycle_order(frames: list[Image.Image]) -> tuple[int, ...]:
    """进入/退出端点不同，枚举六个中间帧得到从起点到终点的最短连续路径。"""
    distances = distance_matrix(frames)
    interior = range(1, len(frames) - 1)
    return min(
        ((0, *permutation, len(frames) - 1) for permutation in itertools.permutations(interior)),
        key=lambda order: sum(
            distances[left, right]
            for left, right in zip(order, order[1:])
        ),
    )


def timeline_order(name: str, frames: list[Image.Image]) -> tuple[int, ...]:
    """保留待机的语义帧，其余往返动作使用统一的连续路径规则。"""
    if name == 'idle':
        # 0/1 为睁眼，2/3 为短眨眼，4 为重新睁眼；末帧直接复用 0，保证
        # 4200ms 常态睁眼之后只发生一次短暂眨眼，循环衔接也不换人物位置。
        return 0, 1, 2, 3, 4, 0
    if name == 'pet-idle':
        # 宠物待机绝大多数时间保持睁眼，只把现有闭眼 donor 放到配置中唯一的
        # 80ms 短帧（索引 10），避免旧顺序连续闭眼一秒以上。
        return 0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 4, 11
    if name in {'pet-enter', 'pet-exit'}:
        return lifecycle_order(frames)
    return symmetric_order(name, frames)


def clamp_motion(
    start: tuple[float, float],
    peak: tuple[float, float],
    maximum_distance: float = 18,
) -> tuple[float, float]:
    """保留有意的点头或侧身方向，但限制独立生成帧造成的夸张整体漂移。"""
    delta_x = peak[0] - start[0]
    delta_y = peak[1] - start[1]
    distance = math.hypot(delta_x, delta_y)
    if distance <= maximum_distance or distance == 0:
        return delta_x, delta_y
    scale = maximum_distance / distance
    return delta_x * scale, delta_y * scale


def smooth_face_positions(
    name: str,
    frames: list[Image.Image],
    strength: float,
) -> tuple[list[Image.Image], list[dict[str, object]]]:
    """把人脸锚点投到平滑轨迹上，完整人物随轨迹移动而不拆分飘带图层。"""
    anchors = [face_anchor(frame) for frame in frames]
    reports: list[dict[str, object]] = []

    if name in {'idle', 'pet-idle'}:
        targets = [anchors[0]] * len(frames)
    elif name in {'pet-enter', 'pet-exit'}:
        targets = []
        for index in range(len(frames)):
            progress = index / (len(frames) - 1)
            eased = 0.5 - math.cos(math.pi * progress) / 2
            targets.append(
                (
                    anchors[0][0] + (anchors[-1][0] - anchors[0][0]) * eased,
                    anchors[0][1] + (anchors[-1][1] - anchors[0][1]) * eased,
                )
            )
    else:
        active_count = (len(frames) - 2) // 2
        delta_x, delta_y = clamp_motion(anchors[0], anchors[active_count])
        targets = []
        for index in range(len(frames)):
            if index <= active_count:
                progress = index / active_count
            else:
                progress = (len(frames) - 1 - index) / active_count
            eased = 0.5 - math.cos(math.pi * progress) / 2
            targets.append(
                (anchors[0][0] + delta_x * eased, anchors[0][1] + delta_y * eased)
            )

    stabilized: list[Image.Image] = []
    for index, (frame, source_anchor, target_anchor) in enumerate(
        zip(frames, anchors, targets)
    ):
        # 不总是强制 100% 对齐。独立重画帧的头部、古琴和飘带并非刚体，过度
        # 平移会让脸稳定却让琴身跳动；上层会在几个强度中选择联合指标最优值。
        shift_x = round((target_anchor[0] - source_anchor[0]) * strength)
        shift_y = round((target_anchor[1] - source_anchor[1]) * strength)
        translated, clipped_pixels = translate_frame(frame, shift_x, shift_y)
        main_bbox = largest_component_bbox(translated)
        if main_bbox[0] == 0 or main_bbox[1] == 0 or main_bbox[2] == FRAME_SIZE or main_bbox[3] == FRAME_SIZE:
            raise ValueError(f'{name} frame {index}: character touches edge after face alignment')
        visible_pixels = int((np.asarray(frame.getchannel('A')) >= 8).sum())
        # 少量被裁的是原图中散落到安全区外的生成碎片；若超过主体的 0.5%，
        # 说明平移正在伤到人物或正式特效，必须停下人工检查。
        if clipped_pixels > max(80, round(visible_pixels * 0.005)):
            raise ValueError(
                f'{name} frame {index}: alignment clips {clipped_pixels} visible pixels'
            )
        stabilized.append(translated)
        reports.append(
            {
                'frame': index,
                'sourceFaceAnchor': [round(value, 3) for value in source_anchor],
                'targetFaceAnchor': [round(value, 3) for value in target_anchor],
                'faceShift': [shift_x, shift_y],
                'clippedPixels': clipped_pixels,
            }
        )
    return stabilized, reports


def face_distance_summary(frames: list[Image.Image]) -> dict[str, float]:
    """记录相邻帧人脸锚点步长，直接量化用户感知到的人物位置抖动。"""
    anchors = [np.asarray(face_anchor(frame)) for frame in frames]
    distances = [
        float(np.linalg.norm(right - left))
        for left, right in zip(anchors, anchors[1:])
    ]
    return {
        'mean': round(float(np.mean(distances)), 6),
        'maximum': round(float(max(distances)), 6),
    }


def main_width_summary(frames: list[Image.Image]) -> dict[str, float]:
    """量化人物主连通体宽度，防止位置稳定后仍出现角色忽大忽小。"""
    widths = [
        bbox[2] - bbox[0]
        for bbox in (largest_component_bbox(frame) for frame in frames)
    ]
    adjacent_changes = [
        abs(right - left) / max(left, 1)
        for left, right in zip(widths, widths[1:])
    ]
    return {
        'minimum': min(widths),
        'maximum': max(widths),
        'maximumAdjacentRatio': round(max(adjacent_changes, default=0), 6),
    }


def choose_face_stabilization(
    name: str,
    frames: list[Image.Image],
    source_maximum_visual_distance: float,
) -> tuple[list[Image.Image], list[dict[str, object]], float]:
    """在位置稳定与整帧连续之间自动选择最低够用的平移强度。"""
    best: tuple[
        float,
        list[Image.Image],
        list[dict[str, object]],
        float,
    ] | None = None
    for strength in (0, 0.25, 0.5, 0.75, 1):
        candidate_frames, reports = smooth_face_positions(name, frames, strength)
        visual = frame_distance_summary(candidate_frames)
        face = face_distance_summary(candidate_frames)
        # 修复不能用更剧烈的全画面闪跳换取坐标漂亮；允许 10% 测量波动，超过
        # 就淘汰该强度。剩余候选按“最大画面差异 + 位置步长”联合选择。
        if visual['maximum'] > source_maximum_visual_distance * 1.1:
            continue
        score = visual['maximum'] + 0.75 * face['maximum'] / FRAME_SIZE
        if best is None or score < best[0]:
            best = score, candidate_frames, reports, strength
    if best is None:
        raise ValueError(f'{name}: no safe face stabilization strength')
    return best[1], best[2], best[3]


def frame_distance_summary(frames: list[Image.Image]) -> dict[str, float]:
    """记录相邻帧的平均和最大视觉差异，便于比较修复是否真实降低跳变。"""
    distances = distance_matrix(frames)
    adjacent = [distances[index, index + 1] for index in range(len(frames) - 1)]
    return {
        'mean': round(float(np.mean(adjacent)), 6),
        'maximum': round(float(max(adjacent)), 6),
    }


def checkerboard(size: tuple[int, int], block: int = 16) -> Image.Image:
    """QA 预览使用真实棋盘底；棋盘只存在于报告，绝不写进正式 WebP。"""
    image = Image.new('RGBA', size, (235, 239, 244, 255))
    draw = ImageDraw.Draw(image)
    for y in range(0, size[1], block):
        for x in range(0, size[0], block):
            if (x // block + y // block) % 2:
                draw.rectangle(
                    (x, y, x + block - 1, y + block - 1),
                    fill=(215, 221, 229, 255),
                )
    return image


def save_contact_sheet(
    frames: list[Image.Image],
    columns: int,
    output_path: Path,
) -> None:
    """生成带帧序号的接触表，人工检查动作方向、表情和人物中心。"""
    thumbnail_size = 256
    label_height = 24
    rows = math.ceil(len(frames) / columns)
    output = Image.new(
        'RGBA',
        (columns * thumbnail_size, rows * (thumbnail_size + label_height)),
        (28, 31, 38, 255),
    )
    draw = ImageDraw.Draw(output)
    font = ImageFont.load_default()
    for index, frame in enumerate(frames):
        preview = checkerboard(frame.size)
        preview.alpha_composite(frame)
        preview = preview.resize(
            (thumbnail_size, thumbnail_size),
            Image.Resampling.LANCZOS,
        )
        x = index % columns * thumbnail_size
        y = index // columns * (thumbnail_size + label_height)
        output.alpha_composite(preview, (x, y))
        draw.text(
            (x + 8, y + thumbnail_size + 6),
            f'frame {index}',
            fill=(255, 255, 255, 255),
            font=font,
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output.save(output_path)


def load_durations(model_dir: Path) -> dict[str, list[int]]:
    """从顶层与外部模组读取真实帧时长，避免用固定速度掩盖运行时抖动。"""
    model = json.loads((model_dir / 'model.json').read_text())
    animation_configs = list(model.get('animations', {}).values())
    for module_reference in model.get('behaviors', {}).get('pet', {}).get('modules', []):
        module = json.loads((model_dir / module_reference['source']).read_text())
        animation_configs.extend(module.get('animations', {}).values())

    durations: dict[str, list[int]] = {}
    for config in animation_configs:
        name = Path(config['file']).stem
        if 'frameDurations' in config:
            values = [int(value) for value in config['frameDurations']]
        else:
            values = [round(1000 / float(config['fps']))] * int(config['frames'])
        durations[name] = values
    return durations


def save_real_duration_gif(
    frames: list[Image.Image],
    durations: list[int],
    output_path: Path,
) -> None:
    """按应用配置播放棋盘 GIF，验证不是接触表静态看似整齐、实际仍然跳。"""
    if len(frames) != len(durations):
        raise ValueError('preview duration count does not match frame count')
    previews = []
    for frame in frames:
        preview = checkerboard(frame.size)
        preview.alpha_composite(frame)
        previews.append(preview.resize((384, 384), Image.Resampling.LANCZOS))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    previews[0].save(
        output_path,
        save_all=True,
        append_images=previews[1:],
        duration=durations,
        loop=0,
        disposal=2,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('input_dir', type=Path)
    parser.add_argument('output_dir', type=Path)
    parser.add_argument('--model-dir', required=True, type=Path)
    parser.add_argument('--qa-dir', type=Path)
    args = parser.parse_args()
    if args.input_dir.resolve() == args.output_dir.resolve():
        parser.error('input_dir and output_dir must differ; validate before promotion')

    sheets = {
        name: split_sheet(args.input_dir / f'{name}.webp', frames, columns)
        for name, (frames, columns) in SHEET_SPECS.items()
    }
    work_bbox = largest_component_bbox(sheets['idle'][0])
    pet_bbox = largest_component_bbox(sheets['pet-idle'][0])
    durations = load_durations(args.model_dir)
    reports: dict[str, object] = {}

    for name, source_frames in sheets.items():
        main_aligned: list[Image.Image] = []
        alignment_reports: list[dict[str, object]] = []
        for frame_index, frame in enumerate(source_frames):
            target_bbox = target_main_bbox(
                name,
                frame_index,
                len(source_frames),
                work_bbox,
                pet_bbox,
            )
            aligned, report = align_main_component(frame, target_bbox)
            main_aligned.append(aligned)
            alignment_reports.append(report)

        order = timeline_order(name, main_aligned)
        ordered_frames = [main_aligned[index].copy() for index in order]
        source_visual = frame_distance_summary(source_frames)
        normalized_visual = frame_distance_summary(ordered_frames)
        stabilized_frames, face_reports, face_strength = choose_face_stabilization(
            name,
            ordered_frames,
            # 人物统一尺寸本身会改变轮廓差异；人脸平移只允许相对已经完成的
            # 尺寸归一结果波动 10%，不能拿尚未修复的原表作为错误阈值。
            normalized_visual['maximum'],
        )

        # 所有循环和往返动作都必须回到同一张完整人物帧；这里比较 RGBA 全帧，
        # 因此飘带、透明区和表情任一处不一致都会被拒绝。
        if name not in {'pet-enter', 'pet-exit'}:
            if np.any(
                np.asarray(stabilized_frames[0]) != np.asarray(stabilized_frames[-1])
            ):
                raise ValueError(f'{name}: first and final full frames differ')
        for frame_index, frame in enumerate(stabilized_frames):
            alpha = np.asarray(frame.getchannel('A'))
            if (
                np.any(alpha[0] >= 8)
                or np.any(alpha[-1] >= 8)
                or np.any(alpha[:, 0] >= 8)
                or np.any(alpha[:, -1] >= 8)
            ):
                raise ValueError(f'{name} frame {frame_index}: visible alpha touches edge')

        output_path = args.output_dir / f'{name}.webp'
        save_sheet(output_path, stabilized_frames, SHEET_SPECS[name][1])
        if args.qa_dir:
            save_contact_sheet(
                stabilized_frames,
                SHEET_SPECS[name][1],
                args.qa_dir / name / 'contact.png',
            )
            save_real_duration_gif(
                stabilized_frames,
                durations[name],
                args.qa_dir / name / 'preview.gif',
            )
        reports[name] = {
            'sourceOrder': list(order),
            'faceStabilizationStrength': face_strength,
            'beforeMainWidth': main_width_summary(source_frames),
            'afterMainWidth': main_width_summary(stabilized_frames),
            'beforeDistance': source_visual,
            'normalizedDistanceBeforeFaceAlignment': normalized_visual,
            'afterDistance': frame_distance_summary(stabilized_frames),
            'beforeFaceDistance': face_distance_summary(source_frames),
            'afterFaceDistance': face_distance_summary(stabilized_frames),
            'mainAlignment': alignment_reports,
            'faceAlignment': face_reports,
        }

    report = {
        'ok': True,
        'inputDirectory': str(args.input_dir.resolve()),
        'outputDirectory': str(args.output_dir.resolve()),
        'animationCount': len(reports),
        'animations': reports,
    }
    if args.qa_dir:
        args.qa_dir.mkdir(parents=True, exist_ok=True)
        (args.qa_dir / 'report.json').write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + '\n'
        )
    print(
        json.dumps(
            {
                'ok': True,
                'animationCount': len(reports),
                'outputDirectory': str(args.output_dir.resolve()),
            },
            ensure_ascii=False,
        )
    )


if __name__ == '__main__':
    main()
