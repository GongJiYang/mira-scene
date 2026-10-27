#!/usr/bin/env python3
"""
S6b-fix2 §3：清除素材里「烧进像素」的假透明棋盘格。

生成素材时，假透明背景（灰白棋盘格，约 #FFFFFF / #CCCCCC、8–16px 方格）
被画进了像素里。本脚本在**指定区域**内识别这种交替棋盘格像素并改为完全透明；
区域外像素逐字节不变（断言）。

用法：
  python3 tools/asset-fix/checker.py <file.png> [x0 y0 x1 y1]
    不给区域 → 只统计棋盘格特征像素的分布并打印坐标范围，不修改文件。
    给区域   → 备份原图到 assets/raw/_backup/，把区域内棋盘格像素改透明，覆盖原文件。

判定：一个像素属于棋盘格，当且仅当
  - 它在指定区域内；
  - 它是灰白（R≈G≈B，容差内）且落在两种交替灰白带（亮 ≥240 / 暗 190–232）之一；
  - 它所处的 cell×cell 邻域呈现 2×2 交替（对角同明暗、邻对异明暗）——
    即它真是一个 8–16px 方格棋盘的一部分，而不是孤立的灰白噪点或白色物体。
"""
from __future__ import annotations

import os
import shutil
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BACKUP_DIR = os.path.join(ROOT, "assets", "raw", "_backup")

GRAY_TOL = 12
LIGHT_MIN = 240
DARK_LO, DARK_HI = 190, 232
ALPHA_MIN = 200
CELL = 10  # 棋盘方格边长（8–16 之间取 10，与实测 fg_table 棋盘格一致）

# S6b-fix3 §2：封闭区域填充模式参数。
# 杯柄环内被截断的半格识别不出来（检测器要求「相邻格明暗相反」），
# 需要以已识别出的棋盘格像素为种子做 flood fill，扩展到相连的灰白高亮像素。
FILL_GRAY_TOL = 14   # R≈G≈B 容差（比检测器略宽，覆盖灰白边缘）
FILL_LUMA_MIN = 180  # 亮度下限（杯柄瓷器亮度更高、且有色偏，不会被选中）


def grayish_masks(a: np.ndarray):
    r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    grayish = (
        (np.abs(r - g) <= GRAY_TOL)
        & (np.abs(g - b) <= GRAY_TOL)
        & (np.abs(r - b) <= GRAY_TOL)
        & (al >= ALPHA_MIN)
    )
    light = grayish & (r >= LIGHT_MIN)
    dark = grayish & (r >= DARK_LO) & (r <= DARK_HI)
    return light, dark


def checker_blocks(light: np.ndarray, dark: np.ndarray, cell: int = CELL):
    """返回布尔掩码：哪些像素属于 8–16px 交替棋盘格。

    判定（对亮/暗灰白像素）：把它归入 cell×cell 网格，若它在水平或垂直方向的
    相邻 cell 里存在相反明暗（亮格挨暗格、暗格挨亮格），即认为它是棋盘格的一部分。
    相比「必须有完整 2×2」，这样能覆盖棋盘格的边缘格子（杯子边缘截断处）。
    孤立的灰白噪点（四邻同明暗或无灰白邻居）不会被误判。
    """
    h, w = light.shape
    # 每个 cell 的主明暗：2=亮格，1=暗格，0=非灰白/不足。
    gh, gw = h // cell + 1, w // cell + 1
    grid = np.zeros((gh, gw), dtype=np.uint8)
    light_cell = np.zeros((gh, gw), dtype=np.uint32)
    dark_cell = np.zeros((gh, gw), dtype=np.uint32)
    # 聚合每个 cell 的亮/暗像素数。
    ys, xs = np.nonzero(light)
    np.add.at(light_cell, (ys // cell, xs // cell), 1)
    ys, xs = np.nonzero(dark)
    np.add.at(dark_cell, (ys // cell, xs // cell), 1)
    thresh = (cell * cell) // 4  # 至少 1/4 像素同明暗才认定该格的明暗
    grid[light_cell >= thresh] = 2
    grid[dark_cell >= thresh] = 1

    # 与相邻格明暗相反的格 → 棋盘格。
    checker_cell = np.zeros((gh, gw), dtype=bool)
    nonzero = grid > 0
    right = np.zeros_like(nonzero)
    right[:, :-1] = (grid[:, :-1] > 0) & (grid[:, 1:] > 0) & (grid[:, :-1] != grid[:, 1:])
    down = np.zeros_like(nonzero)
    down[:-1, :] = (grid[:-1, :] > 0) & (grid[1:, :] > 0) & (grid[:-1, :] != grid[1:, :])
    checker_cell |= right
    checker_cell[:, 1:] |= right[:, :-1]
    checker_cell |= down
    checker_cell[1:, :] |= down[:-1, :]
    checker_cell &= nonzero

    # 放大回像素级掩码。
    block = np.zeros((h, w), dtype=bool)
    gy, gx = np.nonzero(checker_cell)
    for cy, cx in zip(gy, gx):
        block[cy * cell : (cy + 1) * cell, cx * cell : (cx + 1) * cell] = True
    return block


def grayish_high_luma(a: np.ndarray) -> np.ndarray:
    """灰白且高亮的像素掩码（封闭区域填充的扩展条件）。

    杯柄瓷器亮度更高、且带暖白色偏（R≠G≠B），不会被选中。
    """
    r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    grayish = (
        (np.abs(r - g) <= FILL_GRAY_TOL)
        & (np.abs(g - b) <= FILL_GRAY_TOL)
        & (np.abs(r - b) <= FILL_GRAY_TOL)
        & (al >= ALPHA_MIN)
    )
    luma = (r + g + b) // 3
    return grayish & (luma >= FILL_LUMA_MIN)


def enclosed_fill(a: np.ndarray, region: tuple[int, int, int, int]) -> tuple[np.ndarray, int, list[tuple[int, int]]]:
    """S6b-fix3 §2：封闭区域填充模式。

    以已识别出的棋盘格像素为种子，在指定区域内做 flood fill，
    扩展到相连的灰白（R≈G≈B 容差 FILL_GRAY_TOL）且亮度 ≥ FILL_LUMA_MIN 的像素，
    全部置为完全透明；杯柄本身（亮度更高的暖白瓷器、有明显色偏）不会被选中。
    返回 (处理后的数组, 改动像素数, 剩余灰白像素坐标列表)。
    """
    x0, y0, x1, y1 = region
    h, w = a.shape[:2]
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(w, x1), min(h, y1)

    light, dark = grayish_masks(a)
    blocks = checker_blocks(light, dark)
    region_mask = np.zeros((h, w), dtype=bool)
    region_mask[y0:y1, x0:x1] = True

    # 种子：区域内已识别出的棋盘格像素。
    seed = blocks & region_mask & (light | dark)
    # 目标可扩展域：区域内灰白高亮像素（含已识别的棋盘格像素）。
    domain = grayish_high_luma(a) & region_mask

    # flood fill：从种子出发，在 domain 内 4-连通扩展。
    # 用 scipy.ndimage.label 求连通域，保留含种子的域。
    from scipy import ndimage

    labeled, _ = ndimage.label(domain, structure=np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]]))
    seed_labels = np.unique(labeled[seed])
    seed_labels = seed_labels[seed_labels > 0]

    # S6b-fix3 §2：若检测器已识别不出棋盘格（fix2 已清除完整交替块），
    # 残留的截断半格仍以「灰白高亮」形式存在——用最大连通块作为种子继续扩展。
    if seed_labels.size == 0:
        sizes = ndimage.sum(domain, labeled, index=np.arange(1, labeled.max() + 1))
        if sizes.size > 0:
            largest = int(np.argmax(sizes)) + 1
            seed_labels = np.array([largest], dtype=labeled.dtype)

    target = np.isin(labeled, seed_labels) & domain

    out = a.copy()
    out[..., 3] = np.where(target, 0, out[..., 3])
    out[..., 0] = np.where(target, 0, out[..., 0])
    out[..., 1] = np.where(target, 0, out[..., 1])
    out[..., 2] = np.where(target, 0, out[..., 2])
    changed = int(target.sum())

    # 区域内剩余灰白像素（未被清除的）。
    remaining = domain & ~target
    rem_ys, rem_xs = np.nonzero(remaining)
    remaining_coords = list(zip(rem_xs.tolist(), rem_ys.tolist()))
    return out, changed, remaining_coords


def region_stats(path: str) -> None:
    """只统计：打印棋盘格块的坐标范围与数量（不改文件）。"""
    a = np.asarray(Image.open(path).convert("RGBA")).astype(np.int32)
    light, dark = grayish_masks(a)
    blocks = checker_blocks(light, dark)
    ys, xs = np.nonzero(blocks)
    n_blocks = int(blocks.sum()) // (CELL * CELL)
    if not ys.size:
        print(f"{path}: 未发现交替棋盘格")
        return
    print(f"{path}: 棋盘格块 {n_blocks} 个；x {int(xs.min())}..{int(xs.max())}, y {int(ys.min())}..{int(ys.max())}")


def fix(path: str, region: tuple[int, int, int, int]) -> None:
    x0, y0, x1, y1 = region
    original = Image.open(path).convert("RGBA")
    before = original.tobytes()
    a = np.asarray(original).astype(np.int32)
    h, w = a.shape[:2]
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(w, x1), min(h, y1)

    light, dark = grayish_masks(a)
    blocks = checker_blocks(light, dark)

    mask = np.zeros((h, w), dtype=bool)
    mask[y0:y1, x0:x1] = True
    target = blocks & mask & (light | dark)

    out = a.copy()
    out[..., 3] = np.where(target, 0, out[..., 3])
    out[..., 0] = np.where(target, 0, out[..., 0])
    out[..., 1] = np.where(target, 0, out[..., 1])
    out[..., 2] = np.where(target, 0, out[..., 2])

    changed = int(target.sum())

    # 区域外像素逐字节不变（断言）。
    result = Image.fromarray(out.astype(np.uint8))
    res_a = np.asarray(result).astype(np.int32)
    outside = np.ones((h, w), dtype=bool)
    outside[y0:y1, x0:x1] = False
    assert np.array_equal(res_a[outside], a[outside]), "区域外像素被改动"
    # 区域内只动 alpha（被清除的像素 RGBA 全 0）；其余像素逐字节不变。
    inner_changed = ~np.all(res_a == a, axis=-1)
    assert np.array_equal(inner_changed, target), "区域内改动与目标棋盘格掩码不一致"
    assert before != result.tobytes() or changed == 0

    os.makedirs(BACKUP_DIR, exist_ok=True)
    backup = os.path.join(BACKUP_DIR, os.path.basename(path))
    if not os.path.exists(backup):
        shutil.copy2(path, backup)
    result.save(path)
    print(f"{path}: 清除棋盘格像素 {changed} 个（区域 {x0},{y0}..{x1},{y1}），备份 -> {os.path.relpath(backup, ROOT)}")


def fix_enclosed(path: str, region: tuple[int, int, int, int]) -> None:
    """S6b-fix3 §2：封闭区域填充模式修图入口。"""
    x0, y0, x1, y1 = region
    original = Image.open(path).convert("RGBA")
    before = original.tobytes()
    a = np.asarray(original).astype(np.int32)

    out, changed, remaining_coords = enclosed_fill(a, region)

    result = Image.fromarray(out.astype(np.uint8))
    res_a = np.asarray(result).astype(np.int32)
    h, w = a.shape[:2]
    x0c, y0c = max(0, x0), max(0, y0)
    x1c, y1c = min(w, x1), min(h, y1)
    outside = np.ones((h, w), dtype=bool)
    outside[y0c:y1c, x0c:x1c] = False
    assert np.array_equal(res_a[outside], a[outside]), "区域外像素被改动"
    assert before != result.tobytes() or changed == 0

    os.makedirs(BACKUP_DIR, exist_ok=True)
    backup = os.path.join(BACKUP_DIR, os.path.basename(path))
    if not os.path.exists(backup):
        shutil.copy2(path, backup)
    result.save(path)

    # 自验：打印处理前后区域内的灰白像素数、透明像素数。
    domain_before = grayish_high_luma(a)
    domain_after = grayish_high_luma(res_a)
    region_mask = np.zeros((h, w), dtype=bool)
    region_mask[y0c:y1c, x0c:x1c] = True
    gray_before = int((domain_before & region_mask).sum())
    gray_after = int((domain_after & region_mask).sum())
    alpha_before = int(((a[..., 3] == 0) & region_mask).sum())
    alpha_after = int(((res_a[..., 3] == 0) & region_mask).sum())
    print(f"{path}: 封闭区域填充清除像素 {changed} 个（区域 {x0c},{y0c}..{x1c},{y1c}）")
    print(f"  处理前：灰白像素 {gray_before}，透明像素 {alpha_before}")
    print(f"  处理后：灰白像素 {gray_after}，透明像素 {alpha_after}")
    print(f"  备份 -> {os.path.relpath(backup, ROOT)}")

    # 若剩余灰白像素仍连成 ≥ 20 像素的块，列出坐标。
    from scipy import ndimage
    remaining_mask = domain_after & region_mask
    labeled, n = ndimage.label(remaining_mask, structure=np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]]))
    for label_id in range(1, n + 1):
        ys, xs = np.nonzero(labeled == label_id)
        if len(ys) >= 20:
            print(f"  剩余灰白块（{len(ys)} 像素）：x {int(xs.min())}..{int(xs.max())}, y {int(ys.min())}..{int(ys.max())}")


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    enclosed = "--enclosed" in argv
    argv = [a for a in argv if a != "--enclosed"]
    path = argv[1]
    if len(argv) == 2:
        region_stats(path)
        return 0
    if len(argv) != 6:
        print("用法：checker.py <file.png> [--enclosed] [x0 y0 x1 y1]")
        return 2
    x0, y0, x1, y1 = (int(v) for v in argv[2:6])
    if enclosed:
        fix_enclosed(path, (x0, y0, x1, y1))
    else:
        fix(path, (x0, y0, x1, y1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
