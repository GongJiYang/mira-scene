#!/usr/bin/env python3
"""探针 P4 修复轮: 两阶段配准 + 肤色匹配 + 整块手势替换 + 头发去色边 (实验代码)

相对上一轮的改动:
  1. 面部贴片两阶段配准: 全局相似变换 -> 脸框 (300,320)-(720,600) 内再用 SIFT+RANSAC
     估一次局部相似变换, 贴片用 "全局 ∘ 局部"。局部修正量 > 20px 视为失败, 退回全局。
     掩码 = 差分变化区域 ∪ master 五官框 (眉/眼/嘴), 保证旧线稿被盖住。
  2. 肤色匹配: 掩码外圈 8~16px 环内算 Lab 平均差, 在掩码内把它减掉。
  3. 手势贴片整块替换: y 740~820 自动找梯度最小的一行当接缝, 缝下 48px 竖向羽化,
     差分图缺数据的底部输出为透明, 约束写进 tools/spike-align/composition.json。
  4. master 半透明边缘去色边: 用往内 3px 的不透明像素颜色替换 RGB, alpha 不变,
     输出 assets/parts/master_clean.png (后续贴片与预览都以它为底)。
  5. 指标里新增局部修正量、线稿覆盖率、环形 ΔE。

依赖只允许 opencv-python-headless / numpy。
产物: assets/parts/*.png (含 master_clean.png), tools/spike-align/{metrics.json,metrics.js,composition.json}
"""

import json
import os
import sys

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RAW = os.path.join(ROOT, "assets", "raw")
PARTS = os.path.join(ROOT, "assets", "parts")
OUT = os.path.join(ROOT, "tools", "spike-align")

MASTER_RAW = os.path.join(RAW, "master.png")
MASTER_CLEAN = os.path.join(PARTS, "master_clean.png")
TABLE_SRC = "b4_fg_table_v_checker.png"

# ---------------------------------------------------------------- 区域定义
# 值取探针说明里的参考区域, 四周各放宽 8~20px (说明允许在此基础上自动扩展)。
REGIONS = {
    "eyelid": ("eyes", (312, 332, 710, 475)),
    "brow": ("brow", (310, 300, 712, 432)),
    "mouth": ("mouth", (408, 446, 614, 604)),
    "blush": ("cheek", (312, 396, 710, 548)),
}
# master 坐标下的五官框: 表情贴片掩码必须并上这些框, 否则旧五官线稿会透出来。
FACE_FEAT_BOXES = (REGIONS["brow"][1], REGIONS["eyelid"][1], REGIONS["mouth"][1])
# 第二阶段局部配准用的脸框 (修复说明给定)
FACE_BOX = (300, 320, 720, 600)
# 配准特征必须排除的区域 (master 坐标)。表情差分排除脸, 手势差分排除下半身。
EXCLUDE = {
    "expr": ("face", (296, 286, 726, 622)),
    "gest": ("body_lower", (0, 700, 1024, 1536)),
}
# 表情贴片区域自动扩边的上限, 防止扩边把整颗头吃进来
EXPR_LIMITS = (290, 280, 742, 640)
REGION_RING = 24         # 探测环宽度
REGION_STEP = 16         # 每次扩边量
REGION_RING_MIN = 220    # 环内强差异像素超过此值就扩这一边 (≈环面积 5%, 压掉重绘噪声驱动的误扩)
REGION_GROW_MAX = 8      # 最多扩 8 次 (128px)

# 差分图清单: (文件名, 类型, 贴片输出名)
DIFFS = [
    ("x_eyelid_half", "expr", "eyelid_half"),
    ("x_eyelid_closed", "expr", "eyelid_closed"),
    ("x_brow_sad", "expr", "brow_sad"),
    ("x_brow_raised", "expr", "brow_raised"),
    ("x_mouth_small", "expr", "mouth_small"),
    ("x_mouth_open", "expr", "mouth_open"),
    ("x_mouth_o", "expr", "mouth_o"),
    ("x_mouth_smile", "expr", "mouth_smile"),
    ("x_mouth_sad", "expr", "mouth_sad"),
    ("x_blush", "expr", "blush"),
    ("a1_arm_cup", "gest", "arm_cup"),
    ("a2_arm_polaroid", "gest", "arm_polaroid"),
    ("a3_arm_camera", "gest", "arm_camera"),
    ("a4_arm_phone", "gest", "arm_phone"),
]

# 全局常量 (整批共用, 不做单图调参)
ALPHA_OPAQUE = 64        # 参与特征/贴片的 alpha 下限
SIFT_FEATURES = 4000
SIFT_CONTRAST = 0.008
RATIO = 0.75             # Lowe ratio test
RANSAC_PX = 3.0
RANSAC_ITERS = 20000
RANSAC_CONF = 0.999
MIN_INLIERS = 12         # 低于此值认为配准不可信
MIN_INLIER_RATIO = 0.15

# 第二阶段: 脸框内局部相似变换
LOCAL_MAX_PX = 20.0      # 脸框四角最大修正量上限, 超过就退回全局
LOCAL_MIN_INLIERS = 20

# 掩码 (表情): 差分变化区域 ∪ 五官框
PATCH_SMOOTH = 3.0       # 先平滑 ΔE 再阈值: 每张图都是整张重绘, 1~2px 线稿噪声会被压到阈值下
PATCH_THRESH = 12.0      # Lab ΔE76 (L 归一到 0-100); 高于平坦区噪声底 p90≈9, 远低于特征对比 p99≈50+
PATCH_CLOSE = 15         # 闭运算核: 把细碎的线稿差异并成实心块, 否则羽化后贴片永远到不了全不透明
PATCH_DILATE = 3         # 膨胀半径: 只用来吃掉抗锯齿边; 软边交给羽化, 再大就会把整片区域吞进掩码
PATCH_FEATHER_SIGMA = 4.0  # 高斯羽化 sigma, ~3sigma≈12px 支撑
FEATHER_LO = 0.18        # 覆盖率低于此值 alpha=0
FEATHER_HI = 0.55        # 覆盖率高于此值 alpha=1 (中间线性, 避免细掩码整片半透明)
PATCH_MIN_AREA = 50      # 小于此面积的连通域丢弃
PATCH_OPAQUE = 160       # 贴片只取差分图自身不透明的像素
GHOST_DE = 30.0          # 强变化判定, 用于统计"没被贴片覆盖的强变化像素"
COVER_MIN = 0.80         # 表情贴片对 master 线稿的覆盖率验收线

# 肤色匹配
RING_IN = 8              # 环形内径 (掩码外)
RING_OUT = 16            # 环形外径
RING_MIN_L = 45          # 环内只算肤色像素: 平坦环里 60%+ 是头发/阴影 (L 中位数 ~21),
                         # 用全环算出来的色偏是头发重绘差 (+1.0 ~ +2.3 L), 不是肤色
RING_MIN_PX = 120        # 肤色像素少于这个数就退回全环 (并记录)
COLOR_MAX_DE = 3.0       # 环形 ΔE 验收线

# 手势贴片: 整块替换
SEAM_RANGE = (740, 820)  # 自动找接缝线的搜索范围
SEAM_FEATHER = 48        # 接缝竖向羽化高度
CLIP_MARGIN = 10         # characterClipBottom = 最小数据下界 - 此值

# master 去色边
DEFRINGE_PX = 3          # 用往内 3px 的不透明像素颜色替换半透明边缘
# master.png 里没有任何 alpha=255 的像素: 内部平台是 252/253, 背景是 0。
# 所以"不透明"按平台值判定, 边缘带 = 0 < alpha < OPAQUE_ALPHA。
OPAQUE_ALPHA = 250

TABLE_MAX_SAT = 28
TABLE_MIN_VAL = 195


# ---------------------------------------------------------------- 工具
def load_rgba(path):
    """返回 (bgr_uint8, alpha_uint8, gray_premultiplied_uint8)。

    RGB 先乘 alpha 再转灰: 透明区的残留颜色不参与特征提取。
    """
    im = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if im is None:
        raise SystemExit(f"读不到 {path}")
    if im.ndim == 2:
        im = cv2.cvtColor(im, cv2.COLOR_GRAY2BGRA)
    if im.shape[2] == 3:
        im = cv2.cvtColor(im, cv2.COLOR_BGR2BGRA)
    alpha = im[:, :, 3]
    a = (alpha.astype(np.float32) / 255.0)[:, :, None]
    rgb = (im[:, :, :3].astype(np.float32) * a).astype(np.uint8)
    gray = cv2.cvtColor(rgb, cv2.COLOR_BGR2GRAY)
    return im[:, :, :3].copy(), alpha, gray


def box_mask(shape, box):
    m = np.zeros(shape, np.uint8)
    x0, y0, x1, y1 = box
    m[max(0, y0):y1, max(0, x0):x1] = 255
    return m


def lab(bgr):
    """L 归一到 0-100, a/b 保持 OpenCV 8 位偏移 (128 = 中性)。"""
    out = cv2.cvtColor(bgr, cv2.COLOR_BGR2Lab).astype(np.float32)
    out[:, :, 0] *= 100.0 / 255.0
    return out


def lab_to_bgr(labf):
    """lab() 的逆变换; 超出范围的值夹到 8 位区间。

    必须 np.rint 再转 uint8: 直接 astype 是截断, 会在 a/b 上造成 ~0.5 的系统偏差,
    把一次 ~1 ΔE 的修正放大成 ~2 ΔE 的错偏。
    """
    tmp = labf.copy()
    tmp[:, :, 0] *= 255.0 / 100.0
    return cv2.cvtColor(np.clip(np.rint(tmp), 0, 255).astype(np.uint8),
                        cv2.COLOR_Lab2BGR)


def delta_e(a_bgr, b_bgr):
    """ΔE76, 对色相/饱和变化敏感 (blush 这类改动 luma 几乎不变)。"""
    d = lab(a_bgr) - lab(b_bgr)
    return cv2.sqrt((d * d).sum(axis=2))


def grow_region(strong, box, limits):
    """数据驱动的扩边: 若强差异像素贴着某条边, 就把那条边往外推。

    起点是探针说明给的参考区域, 逐步长到"变化不再贴着边界"为止(有上限)。
    """
    x0, y0, x1, y1 = box
    lx0, ly0, lx1, ly1 = limits
    h, w = strong.shape
    steps = 0
    while steps < REGION_GROW_MAX:
        grew = False
        parts = {
            "top": strong[max(ly0, y0 - REGION_RING):y0, x0:x1],
            "bot": strong[y1:min(ly1, y1 + REGION_RING), x0:x1],
            "left": strong[y0:y1, max(lx0, x0 - REGION_RING):x0],
            "right": strong[y0:y1, x1:min(lx1, x1 + REGION_RING)],
        }
        need = {k: int(v.sum()) >= REGION_RING_MIN for k, v in parts.items()}
        if need["top"] and y0 > ly0:
            y0 = max(ly0, y0 - REGION_STEP); grew = True
        if need["bot"] and y1 < ly1:
            y1 = min(ly1, y1 + REGION_STEP); grew = True
        if need["left"] and x0 > lx0:
            x0 = max(lx0, x0 - REGION_STEP); grew = True
        if need["right"] and x1 < lx1:
            x1 = min(lx1, x1 + REGION_STEP); grew = True
        if not grew:
            break
        steps += 1
    return (x0, y0, x1, y1), steps


def detect(gray, mask, sift):
    return sift.detectAndCompute(gray, mask)


def estimate(kd, dd, km, dm):
    """RANSAC 估相似变换 + 用内点做最小二乘精化。返回 (H, stats)。"""
    if dd is None or dm is None or len(dd) < 4 or len(dm) < 4:
        return None, {"good": 0, "inliers": 0, "reproj": None}
    pairs = cv2.BFMatcher(cv2.NORM_L2).knnMatch(dd, dm, k=2)
    good = [p for p, q in pairs if p.distance < RATIO * q.distance]
    if len(good) < 4:
        return None, {"good": len(good), "inliers": 0, "reproj": None}
    src = np.float32([kd[g.queryIdx].pt for g in good])
    dst = np.float32([km[g.trainIdx].pt for g in good])
    H, inl = cv2.estimateAffinePartial2D(
        src, dst, method=cv2.RANSAC, ransacReprojThreshold=RANSAC_PX,
        maxIters=RANSAC_ITERS, confidence=RANSAC_CONF, refineIters=10,
    )
    stats = {"good": len(good), "inliers": 0, "reproj": None}
    if H is None or inl is None:
        return None, stats
    inl = inl.ravel().astype(bool)
    stats["inliers"] = int(inl.sum())
    # 内点最小二乘精化
    if inl.sum() >= 4:
        H = fit_similarity(np.float64(src[inl]), np.float64(dst[inl]))
    proj = (src[inl] @ H[:, :2].T) + H[:, 2]
    err = np.linalg.norm(proj - dst[inl], axis=1)
    stats["reproj"] = float(np.sqrt((err ** 2).mean()))
    return H, stats


def aff_stat(H):
    scale = float(np.hypot(H[0, 0], H[1, 0]))
    rot = float(np.degrees(np.arctan2(H[1, 0], H[0, 0])))
    return scale, rot, float(H[0, 2]), float(H[1, 2])


def fit_similarity(src, dst):
    """内点上的最小二乘相似变换: x'=a*x-b*y+tx, y'=b*x+a*y+ty。"""
    n = len(src)
    A = np.zeros((2 * n, 4), np.float64)
    b = np.zeros(2 * n, np.float64)
    A[0::2, 0] = src[:, 0]
    A[0::2, 1] = -src[:, 1]
    A[0::2, 2] = 1.0
    A[1::2, 0] = src[:, 1]
    A[1::2, 1] = src[:, 0]
    A[1::2, 3] = 1.0
    b[0::2] = dst[:, 0]
    b[1::2] = dst[:, 1]
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    a, bb, tx, ty = sol
    return np.array([[a, -bb, tx], [bb, a, ty]], np.float64)


def compose(H_inner, H_outer):
    """H_outer 先作用于点, 再 H_inner: 返回 2x3。"""
    a = np.vstack([H_outer, [0.0, 0.0, 1.0]])
    b = np.vstack([H_inner, [0.0, 0.0, 1.0]])
    return (b @ a)[:2]


def warp_rgba(bgr, alpha, H, size):
    """把差分图卷到 master 坐标系。透明区先清零, 避免颜色渗边。"""
    w, h = size
    keep = (alpha >= 8).astype(np.float32)[:, :, None]
    bgra = np.dstack([bgr.astype(np.float32) * keep, alpha.astype(np.float32)]).astype(np.uint8)
    wbgra = cv2.warpAffine(bgra, H, (w, h), flags=cv2.INTER_LINEAR,
                           borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
    return wbgra[:, :, :3], wbgra[:, :, 3]


# ---------------------------------------------------------------- 修复 4: 去色边
def defringe(bgr, alpha):
    """把边缘带 (0<alpha<OPAQUE_ALPHA) 的 RGB 换成往内 DEFRINGE_PX 内不透明像素的颜色。

    逐步把"已确定颜色"向半透明区扩张 3 次 (每次 1px, 8 邻域已知像素均值),
    所以每个被替换的像素取的都是朝内最多 3px 的不透明/已修正颜色。alpha 不动。
    """
    edge = (alpha > 0) & (alpha < OPAQUE_ALPHA)
    known = alpha >= OPAQUE_ALPHA
    filled = bgr.astype(np.float32)
    for _ in range(DEFRINGE_PX):
        acc = np.zeros_like(filled)
        cnt = np.zeros(alpha.shape, np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                acc += np.roll(filled, (dy, dx), axis=(0, 1)) * \
                    np.roll(known, (dy, dx), axis=(0, 1))[:, :, None]
                cnt += np.roll(known, (dy, dx), axis=(0, 1))
        upd = (~known) & (cnt > 0)
        if not upd.any():
            break
        filled[upd] = acc[upd] / cnt[upd][:, None]
        known = known | upd
    repl = edge & known
    out = bgr.copy()
    out[repl] = np.clip(filled[repl], 0, 255).astype(np.uint8)
    return out, {
        "opaque_alpha": OPAQUE_ALPHA,
        "edge_px": int(edge.sum()),
        "replaced_px": int(repl.sum()),
        "unreplaced_px": int((edge & ~known).sum()),
        "inward_px": DEFRINGE_PX,
    }


# ---------------------------------------------------------------- 修复 1: 第二阶段局部配准
def local_face_fit(master, w_bgr, w_alpha, sift):
    """在全局变换后的结果上, 用 master 脸框内特征再估一次相似变换。

    返回 {"H": 局部变换(warped 坐标 -> master 坐标), "correction_px": 脸框四角最大位移}。
    修正量超过 LOCAL_MAX_PX 或拟合不可信 -> applied=False, 调用方退回全局变换。
    """
    m_bgr, m_alpha, m_gray = master
    h, w = m_gray.shape
    w_gray = cv2.cvtColor(w_bgr, cv2.COLOR_BGR2GRAY)
    face = box_mask((h, w), FACE_BOX)
    mm = cv2.bitwise_and(face, (m_alpha >= ALPHA_OPAQUE).astype(np.uint8) * 255)
    dm = cv2.bitwise_and(face, (w_alpha >= ALPHA_OPAQUE).astype(np.uint8) * 255)
    km, desm = detect(m_gray, mm, sift)
    kd, desd = detect(w_gray, dm, sift)
    Hl, st = estimate(kd, desd, km, desm)
    x0, y0, x1, y1 = FACE_BOX
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    out = {"ok": Hl is not None and st["inliers"] >= LOCAL_MIN_INLIERS,
           "inliers": st["inliers"], "good": st["good"],
           "reproj": None if st["reproj"] is None else round(st["reproj"], 3),
           "applied": False}
    if not out["ok"]:
        out["reason"] = "脸框内匹配不足"
        return out
    corners = np.float32([[x0, y0], [x1, y0], [x0, y1], [x1, y1]])
    proj = corners @ Hl[:, :2].T + Hl[:, 2]
    dev = np.linalg.norm(proj - corners, axis=1)
    dcx = Hl[0, 0] * cx + Hl[0, 1] * cy + Hl[0, 2] - cx
    dcy = Hl[1, 0] * cx + Hl[1, 1] * cy + Hl[1, 2] - cy
    scale, rot, _, _ = aff_stat(Hl)
    out.update({
        "H": Hl,
        "correction_px": round(float(dev.max()), 3),
        "corner_dev_px": [round(float(v), 2) for v in dev],
        "center_delta": [round(float(dcx), 2), round(float(dcy), 2)],
        "scale": round(scale, 5), "rotation_deg": round(rot, 4),
    })
    if out["correction_px"] > LOCAL_MAX_PX:
        out["reason"] = f"局部修正量 {out['correction_px']:.1f}px > {LOCAL_MAX_PX:.0f}px"
        return out
    out["applied"] = True
    return out


# ---------------------------------------------------------------- 稳定区指标
def stable_metrics(master, w_bgr, w_alpha, kind):
    m_bgr, m_alpha, m_gray = master
    h, w = m_gray.shape
    w_gray = cv2.cvtColor(w_bgr, cv2.COLOR_BGR2GRAY)
    _, ex_box = EXCLUDE[kind]
    ex_mask = box_mask((h, w), ex_box).astype(bool)
    stable = (w_alpha >= 200) & (m_alpha >= 200) & (~ex_mask)
    if stable.sum() == 0:
        return {"stable_mad": None, "stable_edge_p90_px": None,
                "flat_noise_de": None, "stable_px": 0}
    mad = float(np.abs(w_gray.astype(np.int16) - m_gray.astype(np.int16))[stable].mean())
    # 几何对齐: 边缘 chamfer, 不受两张图重绘风格差异影响
    e1 = cv2.Canny(m_gray, 40, 100) > 0
    e2 = cv2.Canny(w_gray, 40, 100) > 0
    dt1 = cv2.distanceTransform((~e1).astype(np.uint8), cv2.DIST_L2, 5)
    ds = dt1[e2 & stable]
    chamfer = float(np.percentile(ds, 90)) if ds.size else None
    # 平坦区 ΔE 噪声底: 两张图都不在该处的边缘带上, 差异就是"重绘噪声"
    g1 = cv2.magnitude(cv2.Sobel(m_gray, cv2.CV_32F, 1, 0, ksize=3),
                       cv2.Sobel(m_gray, cv2.CV_32F, 0, 1, ksize=3))
    g2 = cv2.magnitude(cv2.Sobel(w_gray, cv2.CV_32F, 1, 0, ksize=3),
                       cv2.Sobel(w_gray, cv2.CV_32F, 0, 1, ksize=3))
    flat = stable & (g1 < 6) & (g2 < 6)
    flat_de = float(delta_e(w_bgr, m_bgr)[flat].mean()) if flat.sum() > 0 else None
    return {
        "stable_mad": round(mad, 3),
        "stable_edge_p90_px": None if chamfer is None else round(chamfer, 3),
        "flat_noise_de": None if flat_de is None else round(flat_de, 3),
        "stable_px": int(stable.sum()),
    }


# ---------------------------------------------------------------- 配准
def register(name, kind, master, sift):
    """全局两遍配准 (+ 表情的脸框局部配准)。返回 (H, w_bgr, w_alpha, metrics)。"""
    m_bgr, m_alpha, m_gray = master
    h, w = m_gray.shape
    d_bgr, d_alpha, d_gray = load_rgba(os.path.join(RAW, name + ".png"))

    m_mask = (m_alpha >= ALPHA_OPAQUE).astype(np.uint8) * 255
    d_mask = (d_alpha >= ALPHA_OPAQUE).astype(np.uint8) * 255
    km, dm = detect(m_gray, m_mask, sift)
    kd, dd = detect(d_gray, d_mask, sift)

    # pass1: 全图, 只用于给 pass2 提供"变化区域在哪里"的初值
    H1, s1 = estimate(kd, dd, km, dm)

    # pass2: 把 master 的排除区反投影到差分图坐标, 去掉落在其中的特征
    kd2, dd2 = None, None
    H_used, st_used, used_pass = H1, s1, 1
    if H1 is not None:
        _, ex_box = EXCLUDE[kind]
        ex_m = box_mask((h, w), ex_box)
        inv = cv2.invertAffineTransform(H1)
        ex_d = cv2.warpAffine(ex_m, inv, (d_gray.shape[1], d_gray.shape[0]),
                              flags=cv2.INTER_NEAREST, borderValue=0)
        ex_d = cv2.dilate(ex_d, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25)))
        d_mask2 = cv2.bitwise_and(d_mask, cv2.bitwise_not(ex_d))
        kd2, dd2 = detect(d_gray, d_mask2, sift)
        H2, s2 = estimate(kd2, dd2, km, dm)
        if H2 is not None and s2["inliers"] >= MIN_INLIERS and \
                s2["inliers"] / max(1, s2["good"]) >= MIN_INLIER_RATIO:
            H_used, st_used, used_pass = H2, s2, 2
        else:
            s1["fallback"] = True

    if H_used is None:
        raise SystemExit(f"{name}: 配准失败, 无法继续")

    g_scale, g_rot, g_tx, g_ty = aff_stat(H_used)
    w_bgr, w_alpha = warp_rgba(d_bgr, d_alpha, H_used, (w, h))

    # 第二阶段: 只在表情贴片上做脸框局部配准, 贴片用 全局 ∘ 局部 取样
    local = None
    if kind == "expr":
        local = local_face_fit(master, w_bgr, w_alpha, sift)
        if local["applied"]:
            H_final = compose(local["H"], H_used)
            w_bgr, w_alpha = warp_rgba(d_bgr, d_alpha, H_final, (w, h))
            H_used = H_final
        local.pop("H", None)

    scale, rot, tx, ty = aff_stat(H_used)
    kp_d_total = 0 if kd is None else len(kd)
    kp_d_pass2 = 0 if kd2 is None else len(kd2) if H1 is not None else 0
    metrics = {
        "name": name,
        "kind": kind,
        "kp_master": 0 if km is None else len(km),
        "kp_diff": kp_d_total,
        "kp_diff_pass2": kp_d_pass2,
        "pass1": {"good": s1["good"], "inliers": s1["inliers"],
                  "reproj": None if s1["reproj"] is None else round(s1["reproj"], 3)},
        "pass2": {"good": st_used["good"], "inliers": st_used["inliers"],
                  "reproj": None if st_used["reproj"] is None else round(st_used["reproj"], 3)},
        "used_pass": used_pass,
        "fallback": bool(s1.get("fallback", False)),
        "inlier_ratio": round(st_used["inliers"] / max(1, st_used["good"]), 4),
        "reproj_px": None if st_used["reproj"] is None else round(st_used["reproj"], 3),
        "scale_global": round(g_scale, 5),
        "rotation_deg_global": round(g_rot, 4),
        "translation_global": [round(g_tx, 2), round(g_ty, 2)],
        "scale": round(scale, 5),
        "rotation_deg": round(rot, 4),
        "translation": [round(tx, 2), round(ty, 2)],
        "local": local,
    }
    metrics.update(stable_metrics(master, w_bgr, w_alpha, kind))
    return H_used, w_bgr, w_alpha, metrics


# ---------------------------------------------------------------- 修复 1+2: 面部贴片
def build_face_patch(prefix, master, w_bgr, w_alpha):
    """掩码 = 变化区域 ∪ master 五官框 -> 羽化 -> 环形肤色匹配 -> RGBA 贴片。"""
    m_bgr, m_alpha, m_gray = master
    h, w = m_alpha.shape

    de = delta_e(w_bgr, m_bgr)
    de_s = cv2.GaussianBlur(de, (0, 0), PATCH_SMOOTH)
    have = w_alpha > PATCH_OPAQUE
    strong_raw = (de_s > GHOST_DE) & have

    ref_box = REGIONS[prefix][1]
    grown, grow_steps = grow_region(strong_raw, ref_box, EXPR_LIMITS)
    region = box_mask((h, w), grown).astype(bool)

    change = ((de_s > PATCH_THRESH).astype(np.uint8) * 255)
    change = cv2.morphologyEx(change, cv2.MORPH_CLOSE,
                              cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (PATCH_CLOSE, PATCH_CLOSE)))
    change = cv2.dilate(change, cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (PATCH_DILATE * 2 + 1, PATCH_DILATE * 2 + 1)))

    feat = np.zeros((h, w), np.uint8)
    for b in FACE_FEAT_BOXES:
        feat = cv2.bitwise_or(feat, box_mask((h, w), b))

    merged = cv2.bitwise_or(cv2.bitwise_and(change, region.astype(np.uint8) * 255), feat)
    ok = (merged > 0) & have
    mask = (ok.astype(np.uint8) * 255)
    n, lbl, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    clean = np.zeros_like(mask)
    dropped = 0
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= PATCH_MIN_AREA:
            clean[lbl == i] = 255
        else:
            dropped += 1
    sel_mask = clean > 0

    # 修复 2: 掩码外圈 8~16px 的环形区域 (不跨到透明区)
    ring = (cv2.dilate(clean, cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (RING_OUT * 2 + 1, RING_OUT * 2 + 1))) > 0) & \
        (cv2.dilate(clean, cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (RING_IN * 2 + 1, RING_IN * 2 + 1))) == 0) & \
        have & (m_alpha >= 200)
    # 环里只留"两边都不在边缘带上"的平坦像素: 否则 1~2px 的线稿几何差会被当成色差
    # (eyelid_half 本来就对齐, 全环 2.65 / 平坦环 ~1.4, 差额就是几何贡献)。
    g1 = cv2.magnitude(cv2.Sobel(m_gray, cv2.CV_32F, 1, 0, ksize=3),
                       cv2.Sobel(m_gray, cv2.CV_32F, 0, 1, ksize=3))
    g2 = cv2.magnitude(cv2.Sobel(cv2.cvtColor(w_bgr, cv2.COLOR_BGR2GRAY), cv2.CV_32F, 1, 0, ksize=3),
                       cv2.Sobel(cv2.cvtColor(w_bgr, cv2.COLOR_BGR2GRAY), cv2.CV_32F, 0, 1, ksize=3))
    flat_ring = ring & (g1 < 6) & (g2 < 6)
    # 环形区在掩码外, 修正只作用于掩码内, 所以环形 ΔE 是"这张差分图相对 master 的
    # 整体色偏"的实测值 —— 它就是被减掉的那个差值 (shift), 修正后不会再变。
    skin_ring = flat_ring & (lab(m_bgr)[:, :, 0] > RING_MIN_L)
    tone_sel = skin_ring if skin_ring.sum() >= RING_MIN_PX else flat_ring
    ring_de = None if not ring.any() else float(de[ring].mean())
    ring_de_flat = None if not flat_ring.any() else float(de[flat_ring].mean())
    ring_de_skin = None if not tone_sel.any() else float(de[tone_sel].mean())
    shift = np.zeros(3, np.float32)
    if tone_sel.any():
        shift = (lab(w_bgr) - lab(m_bgr))[tone_sel].mean(axis=0)
    corr_bgr = w_bgr
    if tone_sel.any() and sel_mask.any():
        lab_c = lab(w_bgr)
        lab_c[sel_mask] -= shift
        shifted = lab_to_bgr(lab_c)
        corr_bgr = np.where(sel_mask[:, :, None], shifted, w_bgr).astype(np.uint8)

    cov = cv2.GaussianBlur(clean.astype(np.float32) / 255.0, (0, 0), PATCH_FEATHER_SIGMA)
    feat_a = np.clip((cov - FEATHER_LO) / (FEATHER_HI - FEATHER_LO), 0.0, 1.0) * 255.0

    rgba = np.dstack([corr_bgr, feat_a.astype(np.uint8)])
    area = int(sel_mask.sum())
    ys, xs = np.nonzero(sel_mask)
    bbox = None if area == 0 else [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]

    # 修正效果: 掩码内部的色差。整体均值被内容差主导 (嘴型变了 ΔE 自然大),
    # 所以另外取"两边都平坦"的掩码像素 —— 那才是色块 (skin tone) 的度量。
    a = (feat_a / 255.0)[:, :, None]
    comp = np.clip(corr_bgr.astype(np.float32) * a + m_bgr.astype(np.float32) * (1 - a),
                   0, 255).astype(np.uint8)
    de_comp = delta_e(comp, m_bgr)
    flat_mask = sel_mask & (g1 < 6) & (g2 < 6)
    mask_de_before = None if area == 0 else float(de[sel_mask].mean())
    mask_de_after = None if area == 0 else float(delta_e(corr_bgr, m_bgr)[sel_mask].mean())
    mask_flat_before = None if not flat_mask.any() else float(de[flat_mask].mean())
    mask_flat_after = None if not flat_mask.any() else float(
        delta_e(corr_bgr, m_bgr)[flat_mask].mean())
    # 色块 = 系统性色偏: 平坦掩码像素上的平均 Lab 差向量长度 (mean|ΔE| 会被散点撑大)
    if flat_mask.any():
        bias_before = float(np.linalg.norm((lab(w_bgr) - lab(m_bgr))[flat_mask].mean(axis=0)))
        bias_after = float(np.linalg.norm((lab(corr_bgr) - lab(m_bgr))[flat_mask].mean(axis=0)))
    else:
        bias_before = bias_after = None

    # 幽灵残留: 差分确实提供了像素、强变化, 却只拿到 <50% 的贴片权重
    strong = region & (de_s > GHOST_DE) & have
    ghost = int((strong & (feat_a < 128)).sum())
    outside = int((sel_mask & (m_alpha <= 128)).sum())

    # master 线稿覆盖: 变化区域 ∪ 五官框里, master 自己的 Canny 线稿被贴片盖住的比例
    m_edges = cv2.Canny(m_gray, 40, 100) > 0
    cover_sel = (region | (feat > 0)) & m_edges
    cover = None if cover_sel.sum() == 0 else float((feat_a[cover_sel] >= 128).mean())

    # 交付残差: 叠回后与"直接卷过来的差分"还差多少, 受羽化边界影响天然不为 0
    sel_have = region & have
    residual = None if sel_have.sum() == 0 else float(delta_e(comp, corr_bgr)[sel_have].mean())

    pm = {
        "region": prefix,
        "region_ref_box": list(ref_box),
        "region_box": list(grown),
        "region_grow_steps": grow_steps,
        "mask_px": area,
        "mask_bbox": bbox,
        "mask_change_px": int((cv2.bitwise_and(change, region.astype(np.uint8) * 255) > 0).sum()),
        "mask_feature_px": int(((feat > 0) & have).sum()),
        "dropped_components": dropped,
        "mask_region_cover": None if area == 0 else round(
            float(area / max(1, int(region.sum()))), 4),
        "ring": {
            "in_px": RING_IN, "out_px": RING_OUT,
            "px": int(ring.sum()),
            "px_flat": int(flat_ring.sum()),
            "px_skin": int(skin_ring.sum()),
            "skin_fallback": bool(skin_ring.sum() < RING_MIN_PX),
            "min_l": RING_MIN_L,
            "de": None if ring_de is None else round(ring_de, 3),
            "de_flat": None if ring_de_flat is None else round(ring_de_flat, 3),
            "de_skin": None if ring_de_skin is None else round(ring_de_skin, 3),
            "shift_lab": [round(float(v), 2) for v in shift],
            "shift_de": round(float(np.linalg.norm(shift)), 3),
            "correction": "applied" if (tone_sel.any() and sel_mask.any()) else "skipped",
            "pass": bool(ring_de_skin is not None and ring_de_skin <= COLOR_MAX_DE),
        },
        "mask_de_before": None if mask_de_before is None else round(mask_de_before, 3),
        "mask_de_after": None if mask_de_after is None else round(mask_de_after, 3),
        "mask_flat_px": int(flat_mask.sum()),
        "mask_flat_de_before": None if mask_flat_before is None else round(mask_flat_before, 3),
        "mask_flat_de_after": None if mask_flat_after is None else round(mask_flat_after, 3),
        "mask_bias_before": None if bias_before is None else round(bias_before, 3),
        "mask_bias_after": None if bias_after is None else round(bias_after, 3),
        "strong_px": int(strong.sum()),
        "ghost_px": ghost,
        "ghost_ratio": None if strong.sum() == 0 else round(ghost / int(strong.sum()), 4),
        "outside_master_alpha_px": outside,
        "master_edge_px": int(cover_sel.sum()),
        "master_edge_cover": None if cover is None else round(cover, 4),
        "cover_pass": bool(cover is not None and cover >= COVER_MIN),
        "deliver": {
            "composited_de": None if sel_have.sum() == 0 else round(
                float(de_comp[sel_have].mean()), 2),
            "residual_de": None if residual is None else round(residual, 2),
        },
    }
    return rgba, pm


# ---------------------------------------------------------------- 修复 3: 手势整块替换
def find_seam(master):
    """在 y 740~820 之间找 master 纹理最弱 (竖向梯度均值最小) 的一行当接缝。"""
    m_bgr, m_alpha, m_gray = master
    gy = np.abs(cv2.Sobel(m_gray, cv2.CV_32F, 0, 1, ksize=3))
    sel = m_alpha > 200
    best_y, best_v = SEAM_RANGE[0], None
    for y in range(SEAM_RANGE[0], SEAM_RANGE[1] + 1):
        row = gy[y][sel[y]]
        if row.size == 0:
            continue
        v = float(row.mean())
        if best_v is None or v < best_v:
            best_y, best_v = y, v
    return best_y, float(best_v or 0.0)


def build_arm_patch(master, w_bgr, w_alpha, seam, seam_grad):
    """接缝以下整块用变换后的差分图, 接缝 48px 竖向羽化; 缺数据的底部为透明。"""
    m_bgr, m_alpha, m_gray = master
    h, w = m_alpha.shape
    ys = np.arange(h, dtype=np.float32)
    ramp = np.clip((ys - seam) / float(SEAM_FEATHER), 0.0, 1.0)[:, None]
    alpha = (w_alpha.astype(np.float32) / 255.0) * ramp
    feat_a = np.round(alpha * 255.0).astype(np.uint8)
    rgba = np.dstack([w_bgr, feat_a])

    have = w_alpha > PATCH_OPAQUE
    region = box_mask((h, w), (0, seam, w, h)).astype(bool)
    ys_have = np.nonzero((have & region).any(axis=1))[0]
    data_end = None if ys_have.size == 0 else int(ys_have.max())
    missing = int((region & (m_alpha > 128) & (~have)).sum())

    m_edges = cv2.Canny(m_gray, 40, 100) > 0
    edge_sel = region & m_edges
    cover = None if edge_sel.sum() == 0 else float((feat_a[edge_sel] >= 128).mean())
    pm = {
        "seam": {"y": int(seam), "feather": SEAM_FEATHER,
                 "grad": round(seam_grad, 3),
                 "search": list(SEAM_RANGE)},
        "patch_px": int((feat_a > 128).sum()),
        "data_end_y": data_end,
        "data_missing_px": missing,
        "master_edge_px": int(edge_sel.sum()),
        "master_edge_cover": None if cover is None else round(cover, 4),
    }
    return rgba, pm


# ---------------------------------------------------------------- 桌面抠图
def cutout_table():
    im = cv2.imread(os.path.join(RAW, TABLE_SRC), cv2.IMREAD_UNCHANGED)
    if im is None:
        raise SystemExit(f"读不到 {TABLE_SRC}")
    if im.shape[2] == 4:
        im = im[:, :, :3]
    h, w = im.shape[:2]
    hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV)
    s, v = hsv[:, :, 1], hsv[:, :, 2]
    bgish = ((s < TABLE_MAX_SAT) & (v > TABLE_MIN_VAL)).astype(np.uint8)

    # 只抠"与画面边界连通"的棋盘格; 桌面上的高光即使低饱和也保留。
    ff = bgish.copy()
    m2 = np.zeros((h + 2, w + 2), np.uint8)
    for seed in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1),
                 (w // 2, 0), (0, h // 2), (w - 1, h // 2)]:
        if ff[seed[1], seed[0]]:
            cv2.floodFill(ff, m2, seed, 2)
    bg = (ff == 2)
    alpha = np.where(bg, 0, 255).astype(np.uint8)
    alpha = cv2.GaussianBlur(alpha, (0, 0), 1.2)
    alpha = np.where(alpha < 8, 0, alpha).astype(np.uint8)

    rgb = im.copy()
    rgb[bg] = 0
    out = np.dstack([rgb, alpha])
    tw = 1024
    th = int(round(h * tw / w))
    out = cv2.resize(out, (tw, th), interpolation=cv2.INTER_AREA)
    # 前置乘 alpha 后缩放, 避免透明区颜色在缩小时渗入
    rows = (out[:, :, 3] > 128).mean(axis=1)
    opaque = np.nonzero(rows > 0.5)[0]
    return out, {
        "source": TABLE_SRC, "src_size": [w, h], "out_size": [tw, th],
        "bg_fraction": round(float(bg.mean()), 4),
        "alpha_px": int((out[:, :, 3] > 128).sum()),
        "opaque_top_y": None if opaque.size == 0 else int(opaque.min()),
        "row_cover_bottom": round(float(rows[-1]), 4),
    }


# ---------------------------------------------------------------- 主流程
def main():
    os.makedirs(PARTS, exist_ok=True)

    # 修复 4: master 去色边, 之后所有贴片与预览都以 master_clean 为底
    raw_bgr, raw_alpha, _ = load_rgba(MASTER_RAW)
    clean_bgr, df_info = defringe(raw_bgr, raw_alpha)
    clean_rgba = np.dstack([clean_bgr, raw_alpha])
    cv2.imwrite(MASTER_CLEAN, clean_rgba)
    print(f"master_clean: 边缘带 0<alpha<{df_info['opaque_alpha']} 共 {df_info['edge_px']}px, "
          f"替换 {df_info['replaced_px']}px, 未替换 {df_info['unreplaced_px']}px -> "
          f"{os.path.relpath(MASTER_CLEAN, ROOT)}")

    sift = cv2.SIFT_create(nfeatures=SIFT_FEATURES, contrastThreshold=SIFT_CONTRAST)
    master = load_rgba(MASTER_CLEAN)
    m_alpha = master[1]
    seam, seam_grad = find_seam(master)
    print(f"master {master[2].shape[1]}x{master[2].shape[0]}, 接缝 y={seam} "
          f"(竖向梯度均值 {seam_grad:.2f})")

    rows, bottoms = [], []
    for name, kind, out_name in DIFFS:
        prefix = out_name.split("_")[0]
        if prefix not in REGIONS:
            prefix = "arm"
        H, w_bgr, w_alpha, met = register(name, kind, master, sift)
        if kind == "expr":
            rgba, pm = build_face_patch(prefix, master, w_bgr, w_alpha)
        else:
            rgba, pm = build_arm_patch(master, w_bgr, w_alpha, seam, seam_grad)
            rows_have = np.nonzero((w_alpha > PATCH_OPAQUE).any(axis=1))[0]
            if rows_have.size:
                bottoms.append(int(rows_have.max()))
        path = os.path.join(PARTS, out_name + ".png")
        cv2.imwrite(path, rgba)
        met.update(pm)
        met["id"] = out_name
        met["out"] = "assets/parts/" + out_name + ".png"
        met["prefix"] = prefix
        rows.append(met)
        loc = met.get("local")
        loc_txt = "—" if not loc else (
            f"{loc['correction_px']:.2f}px" + ("" if loc["applied"] else "(退回)"))
        ring = met.get("ring")
        ring_txt = "—" if not ring or ring["de_skin"] is None else \
            f"{ring['de_skin']:.2f}"
        cover = met.get("master_edge_cover")
        cover_txt = "—" if cover is None else f"{cover * 100:.1f}%"
        print(f"  {name:22s} inl {met['pass2']['inliers']:4d} "
              f"reproj {str(met['reproj_px']):>6s}px 局部 {loc_txt:>12s} "
              f"线稿 {cover_txt:>6s} 环形ΔE {ring_txt:>5s} -> {met['out']}")

    if not bottoms:
        raise SystemExit("没有任何手势差分图, 无法确定 characterClipBottom")
    clip_bottom = min(bottoms) - CLIP_MARGIN
    composition = {"characterClipBottom": int(clip_bottom),
                   "tableTopMinCover": int(clip_bottom)}
    with open(os.path.join(OUT, "composition.json"), "w") as f:
        json.dump(composition, f, ensure_ascii=False, indent=2)
    print(f"composition: 手势数据下界 {bottoms} -> characterClipBottom={clip_bottom}")

    table, tinfo = cutout_table()
    tpath = os.path.join(PARTS, "fg_table_v.png")
    cv2.imwrite(tpath, table)
    print(f"  table {tinfo['src_size']} -> {tinfo['out_size']} bg {tinfo['bg_fraction']:.3f} "
          f"alpha {tinfo['alpha_px']} -> {os.path.relpath(tpath, ROOT)}")

    payload = {
        "master": {"w": int(m_alpha.shape[1]), "h": int(m_alpha.shape[0]),
                   "path": "assets/parts/master_clean.png",
                   "raw": "assets/raw/master.png",
                   "defringe": df_info},
        "composition": composition,
        "params": {
            "sift_features": SIFT_FEATURES, "sift_contrast": SIFT_CONTRAST,
            "ratio": RATIO, "ransac_px": RANSAC_PX,
            "patch_thresh": PATCH_THRESH, "patch_dilate": PATCH_DILATE,
            "patch_close": PATCH_CLOSE, "patch_feather_sigma": PATCH_FEATHER_SIGMA,
            "feather_lo": FEATHER_LO, "feather_hi": FEATHER_HI,
            "face_box": list(FACE_BOX), "local_max_px": LOCAL_MAX_PX,
            "ring_in": RING_IN, "ring_out": RING_OUT, "color_max_de": COLOR_MAX_DE,
            "seam_range": list(SEAM_RANGE), "seam_feather": SEAM_FEATHER,
            "cover_min": COVER_MIN,
        },
        "seam": {"y": int(seam), "grad": round(seam_grad, 3)},
        "patches": rows,
        "table": dict(tinfo, out="assets/parts/fg_table_v.png"),
    }
    with open(os.path.join(OUT, "metrics.json"), "w") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    # 同时写一份 .js, 让 preview.html 用 file:// 打开也能读到数值
    with open(os.path.join(OUT, "metrics.js"), "w") as f:
        f.write("// 由 align.py 生成, 勿手改\nwindow.SPIKE_METRICS = ")
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write(";\n")

    fails = []
    for r in rows:
        if r["fallback"] or r["pass2"]["inliers"] < MIN_INLIERS:
            fails.append(f"{r['id']}: 配准")
        loc = r.get("local")
        if loc and not loc["applied"]:
            fails.append(f"{r['id']}: 局部修正 {loc.get('correction_px')}px 未应用")
        if r["kind"] == "expr":
            if r["mask_px"] == 0:
                fails.append(f"{r['id']}: 掩码为空")
            if not r.get("cover_pass"):
                fails.append(f"{r['id']}: 线稿覆盖 {r['master_edge_cover']}")
            if not r["ring"]["pass"]:
                fails.append(f"{r['id']}: 环形肤色ΔE {r['ring']['de_skin']}")
        elif r.get("patch_px", 0) == 0:
            fails.append(f"{r['id']}: 贴片为空")
    print("\n产物: %d 张表情/手势贴片 + master_clean + 1 张桌面" % len(rows))
    if fails:
        print("未达标: " + "; ".join(fails))
    else:
        print("全部数值达标 (效果是否自然仍需目测)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
