"""Shared helpers: PSD access, native-space mapping, colour metrics, check figures."""
import json
import os

import cv2
import numpy as np
from PIL import Image, ImageDraw
from psd_tools import PSDImage

cv2.setNumThreads(1)


# ----------------------------------------------------------------------------- io

def load_rgba(path):
    return np.array(Image.open(path).convert('RGBA'), dtype=np.float32)


def save_rgba(arr, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    a = np.ascontiguousarray(np.clip(arr, 0, 255).astype(np.uint8))
    Image.fromarray(a, 'RGBA').save(path)


def write_json(obj, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2, sort_keys=False)
        f.write('\n')


def read_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


# ------------------------------------------------------------------- psd access

class Part:
    """One pixel layer lifted into an RGBA array with a native-space origin.

    `blend` is the compositing mode psd2live will use for this layer ('normal' or 'multiply');
    util.composite honours it so the pipeline's own flattening matches the exported model.
    """

    def __init__(self, name, img, left, top, blend='normal'):
        self.name = name
        self.img = np.asarray(img, dtype=np.float32)
        self.left = int(left)
        self.top = int(top)
        self.blend = blend

    @property
    def size(self):
        return self.img.shape[1], self.img.shape[0]

    def save(self, layer_dir):
        save_rgba(self.img, os.path.join(layer_dir, f'{self.name}.png'))

    @staticmethod
    def load(layer_dir, name):
        j = read_json(os.path.join(layer_dir, f'{name}.json'))
        return Part(name, load_rgba(os.path.join(layer_dir, f'{name}.png')),
                    *j['origin'], blend=j.get('blend', 'normal'))


def psd_pixel_layers(path):
    """Pixel layers of a PSD, bottom -> top (psd_tools iteration order)."""
    psd = PSDImage.open(path)
    return psd.size, [l for l in psd.descendants() if l.kind == 'pixel']


def layer_rgba(layer):
    """Layer pixels as RGBA. psd-tools moves alpha into a layer mask when the PSD is RGB mode,
    so fold an active mask back into the alpha channel."""
    arr = np.array(layer.topil().convert('RGBA'), dtype=np.float32)
    try:
        has_mask = layer.has_mask()
    except Exception:
        has_mask = False
    if not has_mask:
        return arr
    mask = layer.mask
    if mask is None or getattr(mask, 'disabled', False):
        return arr
    ma = np.array(mask.topil().convert('L'), dtype=np.float32)
    lx, ly = layer.bbox[0], layer.bbox[1]
    mx, my = mask.bbox[0], mask.bbox[1]
    h, w = arr.shape[:2]
    canvas = np.full((h, w), 255.0, np.float32)
    ox, oy = mx - lx, my - ly
    mh, mw = ma.shape[:2]
    x0, y0 = max(ox, 0), max(oy, 0)
    x1, y1 = min(ox + mw, w), min(oy + mh, h)
    if x1 > x0 and y1 > y0:
        canvas[y0:y1, x0:x1] = ma[y0 - oy:y1 - oy, x0 - ox:x1 - ox]
    arr[..., 3] *= canvas / 255.0
    return arr


def save_parts(parts, layer_dir):
    """Persist each Part as <name>.png + <name>.json origin (step hand-off)."""
    index = []
    os.makedirs(layer_dir, exist_ok=True)
    for p in parts:
        p.save(layer_dir)
        write_json({'origin': [p.left, p.top], 'blend': getattr(p, 'blend', 'normal')},
                   os.path.join(layer_dir, f'{p.name}.json'))
        index.append({'name': p.name, 'left': p.left, 'top': p.top,
                      'width': p.size[0], 'height': p.size[1],
                      'blend': getattr(p, 'blend', 'normal')})
    write_json(index, os.path.join(layer_dir, 'index.json'))
    return index


def load_parts(layer_dir):
    index = read_json(os.path.join(layer_dir, 'index.json'))
    return [Part.load(layer_dir, e['name']) for e in index]


# ------------------------------------------------------------------ native mapping

class Mapping:
    """PSD-canvas pixels -> original-image pixels: native = psd / s - pad."""

    def __init__(self, psd_size, orig_size, reference_size=None):
        pw, ph = psd_size
        ow, oh = orig_size
        side = max(ow, oh)
        self.padx = (side - ow) / 2.0
        self.pady = (side - oh) / 2.0
        self.s = float(pw) / side
        self.psd_size = (pw, ph)
        self.orig_size = (ow, oh)

    def to_native(self, x, y):
        return x / self.s - self.padx, y / self.s - self.pady

    def to_psd(self, x, y):
        return (x + self.padx) * self.s, (y + self.pady) * self.s

    def bbox_native(self, bbox, clip=True):
        x1, y1 = self.to_native(bbox[0], bbox[1])
        x2, y2 = self.to_native(bbox[2], bbox[3])
        if clip:
            ow, oh = self.orig_size
            x1, y1 = max(int(np.floor(x1)), 0), max(int(np.floor(y1)), 0)
            x2, y2 = min(int(np.ceil(x2)), ow), min(int(np.ceil(y2)), oh)
        return x1, y1, x2, y2

    def affine(self, scale=1.0, dx=0.0, dy=0.0):
        """2x3 matrix mapping PSD-canvas px -> original px, optionally nudged.

        scale is applied about the original image centre so the search is symmetric.
        """
        ow, oh = self.orig_size
        k = float(scale)
        # x' = k*(x/s - padx) - k*ow/2 + ow/2 + dx
        a = k / self.s
        cx = k * (-self.padx) - k * ow / 2.0 + ow / 2.0 + dx
        cy = k * (-self.pady) - k * oh / 2.0 + oh / 2.0 + dy
        return np.array([[a, 0.0, cx], [0.0, a, cy]], dtype=np.float64)

    def warp(self, psd_canvas, scale=1.0, dx=0.0, dy=0.0):
        ow, oh = self.orig_size
        return cv2.warpAffine(psd_canvas, self.affine(scale, dx, dy), (ow, oh),
                              flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT,
                              borderValue=(0, 0, 0, 0))


# ------------------------------------------------------------------- compositing

def composite(parts, size, background=None):
    """Alpha-over composite of Parts (bottom -> top) into an RGBA array."""
    w, h = size
    if background is None:
        canvas = np.zeros((h, w, 4), np.float32)
    else:
        canvas = np.zeros((h, w, 4), np.float32)
        canvas[..., :3] = np.asarray(background, np.float32)
        canvas[..., 3] = 255.0
    for p in parts:
        img = p.img
        ph, pw = img.shape[:2]
        x0, y0 = p.left, p.top
        x1, y1 = min(x0 + pw, w), min(y0 + ph, h)
        x0c, y0c = max(x0, 0), max(y0, 0)
        if x1 <= x0c or y1 <= y0c:
            continue
        sub = img[y0c - y0:y1 - y0, x0c - x0:x1 - x0]
        a = sub[..., 3:4] / 255.0
        region = canvas[y0c:y1, x0c:x1]
        if getattr(p, 'blend', 'normal') == 'multiply':
            # multiply the existing pixels, then take that result by the layer's own alpha
            src = region[..., :3] * sub[..., :3] / 255.0
        else:
            src = sub[..., :3]
        region[..., :3] = src * a + region[..., :3] * (1.0 - a)
        region[..., 3:4] = a * 255.0 + region[..., 3:4] * (1.0 - a)
    return canvas


# --------------------------------------------------------------------- measures

def gated_diff(orig, mapped, alpha_gate=0.85):
    """Mean absolute per-channel colour difference and the gate mask."""
    gate = ((orig[..., 3] > alpha_gate * 255) & (mapped[..., 3] > alpha_gate * 255))
    if not gate.any():
        return float('nan'), gate
    d = np.abs(orig[..., :3] - mapped[..., :3]).mean(axis=2)
    return float(d[gate].mean()), gate


def edge_map(rgba, gate, percentile=85.0):
    lum = cv2.cvtColor(np.clip(rgba[..., :3], 0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)
    lum = cv2.GaussianBlur(lum, (3, 3), 0)
    gx = cv2.Sobel(lum, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(lum, cv2.CV_32F, 0, 1, ksize=3)
    mag = np.hypot(gx, gy)
    inside = mag[gate] if gate.any() else mag.ravel()
    thr = np.percentile(inside, percentile) if inside.size else 0.0
    return (mag > max(thr, 1e-6)) & gate


def edge_misalignment(orig, mapped, alpha_gate=0.85, percentile=85.0):
    """Mean bidirectional distance (px) between edge pixels of the two images."""
    _, gate = gated_diff(orig, mapped, alpha_gate)
    ea = edge_map(orig, gate, percentile)
    eb = edge_map(mapped, gate, percentile)
    if not ea.any() or not eb.any():
        return float('nan'), float('nan'), 0, 0
    da = cv2.distanceTransform((~ea).astype(np.uint8), cv2.DIST_L2, 5)
    db = cv2.distanceTransform((~eb).astype(np.uint8), cv2.DIST_L2, 5)
    fwd = float(db[ea].mean())   # orig edge -> mapped edge
    bwd = float(da[eb].mean())
    return fwd, bwd, int(ea.sum()), int(eb.sum())


def coverage_mask(parts, size, level=0.5):
    """Per-pixel maximum alpha of the parts (0..1)."""
    w, h = size
    cov = np.zeros((h, w), np.float32)
    for p in parts:
        a = p.img[..., 3] / 255.0
        ph, pw = a.shape
        x0, y0 = max(p.left, 0), max(p.top, 0)
        x1, y1 = min(p.left + pw, w), min(p.top + ph, h)
        if x1 <= x0 or y1 <= y0:
            continue
        sub = a[y0 - p.top:y1 - p.top, x0 - p.left:x1 - p.left]
        np.maximum(cov[y0:y1, x0:x1], sub, out=cov[y0:y1, x0:x1])
    return cov


def blobs(mask, min_area=0):
    n, lab, stats, cent = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    out = []
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < min_area:
            continue
        x, y, w, h = (int(stats[i, cv2.CC_STAT_LEFT]), int(stats[i, cv2.CC_STAT_TOP]),
                      int(stats[i, cv2.CC_STAT_WIDTH]), int(stats[i, cv2.CC_STAT_HEIGHT]))
        out.append(dict(label=i, area=area, bbox=[x, y, x + w, y + h],
                        centroid=[round(float(cent[i][0]), 1), round(float(cent[i][1]), 1)]))
    out.sort(key=lambda b: -b['area'])
    return out, lab


def smoothstep(x, lo=0.0, hi=1.0):
    t = np.clip((x - lo) / (hi - lo + 1e-12), 0, 1)
    return t * t * (3 - 2 * t)


# --------------------------------------------------------------------- figures

def _label(img, text, pad=2):
    canvas = Image.new('RGB', (img.width, img.height + 12), (24, 24, 24))
    canvas.paste(img.convert('RGB'), (0, 12))
    ImageDraw.Draw(canvas).text((pad, 1), text[:60], fill=(235, 235, 235))
    return canvas


def checker_background(w, h, cell=8, a=(70, 70, 70), b=(110, 110, 110)):
    yy, xx = np.mgrid[0:h, 0:w]
    m = ((yy // cell + xx // cell) % 2).astype(np.uint8)
    out = np.zeros((h, w, 3), np.float32)
    out[:] = np.array(a, np.float32)
    out[m == 1] = np.array(b, np.float32)
    return out


def on_checker(rgba):
    h, w = rgba.shape[:2]
    bg = checker_background(w, h)
    a = rgba[..., 3:4] / 255.0
    return rgba[..., :3] * a + bg * (1 - a)


def montage(tiles, cols, cell, labels=None, checker=False, pad=4):
    """tiles: list of HxWx3 float arrays. Returns a PIL image."""
    rows = (len(tiles) + cols - 1) // cols
    W = cols * (cell[0] + pad) + pad
    H = rows * (cell[1] + 12 + pad) + pad
    sheet = Image.new('RGB', (W, H), (16, 16, 16))
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        x = pad + c * (cell[0] + pad)
        y = pad + r * (cell[1] + 12 + pad)
        arr = np.clip(t, 0, 255).astype(np.uint8)
        im = Image.fromarray(arr, 'RGB' if arr.ndim == 3 else 'L')
        if im.size != tuple(cell):
            im = im.resize(cell, Image.LANCZOS)
        if labels and i < len(labels):
            im = _label(im, labels[i])
            sheet.paste(im, (x, y))
        else:
            sheet.paste(im, (x, y + 12))
    return sheet


def thumb(rgba, max_side=180, checker=True):
    if rgba.ndim == 3 and rgba.shape[2] == 4:
        rgb = on_checker(rgba) if checker else rgba[..., :3]
    elif rgba.ndim == 2:
        rgb = np.repeat(rgba[..., None], 3, axis=2)
    else:
        rgb = rgba[..., :3]
    h, w = rgb.shape[:2]
    k = min(1.0, max_side / max(h, w))
    if k < 1.0:
        rgb = cv2.resize(rgb, (max(1, int(w * k)), max(1, int(h * k))), interpolation=cv2.INTER_AREA)
    return rgb


def overlay50(a, b):
    return on_checker(a) * 0.5 + on_checker(b) * 0.5


def diff_heatmap(a, b, gate=None, scale=3.0):
    d = np.abs(a[..., :3] - b[..., :3]).mean(axis=2)
    if gate is not None:
        d = d * gate
    v = np.clip(d * scale, 0, 255).astype(np.uint8)
    heat = cv2.applyColorMap(v, cv2.COLORMAP_INFERNO)
    return cv2.cvtColor(heat, cv2.COLOR_BGR2RGB).astype(np.float32)
