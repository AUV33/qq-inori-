#!/usr/bin/env python
# phone_vision_server.py · 手机画面本地识别服务（OCR + 模板匹配 + 裁剪）
#
# 为什么常驻：RapidOCR 的 onnxruntime 会话初始化要 1~2 秒，每次调用新建太贵。
# 常驻后第一次请求付一次初始化，之后每张图只付推理时间。
#
# 接口（JSON in/out，只监听 127.0.0.1）：
#   GET  /health                     → {ok, loaded}
#   POST /ocr    {path, region?}     → {ok, items:[{text,score,box:{x1,y1,x2,y2},center:{x,y}}], ms}
#   POST /find   {image, template, threshold?} → {ok, score, center:{x,y}, box, ms}
#   POST /crop   {image, x,y,w,h, out}        → {ok, out, ms}
#
# [AUDIT-FIX] 说明：只监听 127.0.0.1，且所有 POST 都要带启动方下发的 token；
#   图片路径限定在包内 vision/、指定截图目录与系统临时目录内，
#   避免本机任意进程借这个端口读取或写出任意路径的文件。
import json
import os
import sys
import time
import tempfile
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np

_engine = None

VISION_TOKEN = (os.environ.get('PHONE_VISION_TOKEN') or '').strip()
VISION_DIR = os.path.dirname(os.path.abspath(__file__))
TMP_ROOT = os.path.realpath(tempfile.gettempdir())
ALLOWED_ROOTS = [
    os.path.realpath(os.environ.get('PHONE_VISION_SHOT_DIR') or os.path.join(VISION_DIR, 'shots')),
    os.path.realpath(os.path.join(VISION_DIR, 'templates')),
    TMP_ROOT,
]


def safe_path(value, for_write=False):
    """返回白名单内的真实路径；越界或空值返回 None（realpath 防符号链接/junction 逃逸）。"""
    if value is None or value == '':
        return None
    try:
        target = os.path.realpath(os.path.abspath(str(value)))
    except Exception:
        return None
    for root in ALLOWED_ROOTS:
        if target == root or target.startswith(root + os.sep):
            # 裁剪结果只允许写回包内目录，不接受系统临时目录作为输出位置。
            if for_write and root == TMP_ROOT:
                return None
            return target
    return None


def get_engine():
    global _engine
    if _engine is None:
        from rapidocr_onnxruntime import RapidOCR
        _engine = RapidOCR()
    return _engine


def load_img(path):
    data = np.fromfile(str(path), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError('图片读不出：' + str(path))
    return img


def clamp_region(img, region):
    if not region:
        return img, 0, 0
    h0, w0 = img.shape[:2]
    x = max(0, int(region.get('x', 0)))
    y = max(0, int(region.get('y', 0)))
    w = max(1, int(region.get('w', w0)))
    h = max(1, int(region.get('h', h0)))
    x2 = min(w0, x + w)
    y2 = min(h0, y + h)
    return img[y:y2, x:x2], x, y


def do_ocr(path, region=None):
    t0 = time.time()
    img = load_img(path)
    sub, ox, oy = clamp_region(img, region)
    # RapidOCR 接受 ndarray；转 BGR→RGB 更稳
    res = get_engine()(cv2.cvtColor(sub, cv2.COLOR_BGR2RGB))
    items = []
    rows = res[0] if isinstance(res, tuple) else res
    for row in (rows or []):
        box, text, score = row[0], row[1], row[2]
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        x1, x2 = int(min(xs)) + ox, int(max(xs)) + ox
        y1, y2 = int(min(ys)) + oy, int(max(ys)) + oy
        items.append({
            'text': str(text),
            'score': round(float(score), 3),
            'box': {'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2},
            'center': {'x': (x1 + x2) // 2, 'y': (y1 + y2) // 2},
        })
    items.sort(key=lambda it: (it['box']['y1'], it['box']['x1']))
    return {'ok': True, 'items': items, 'ms': int((time.time() - t0) * 1000)}


def find_template(image_path, template_path, threshold=0.8):
    t0 = time.time()
    img = load_img(image_path)
    tpl = load_img(template_path)
    g1 = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    g2 = cv2.cvtColor(tpl, cv2.COLOR_BGR2GRAY)
    # 纯色/近纯色模板的匹配分数是退化的（到处都 1.0），拒绝并让她换一块有内容的区域。
    if float(g2.std()) < 5.0:
        return {'ok': False, 'error': '模板太纯（几乎是纯色块），换一块有图案/文字的区域存模板', 'ms': int((time.time() - t0) * 1000)}
    # 先按原尺寸找：缩放会把中心算偏（实测 0.9 倍命中中心偏 20px）。
    # 原尺寸够阈值就直接用；不够再试缩放（界面分辨率变了才有用）。
    best = None
    for scale in (1.0,):
        g2s = g2
        if g2s.shape[0] > g1.shape[0] or g2s.shape[1] > g1.shape[1]:
            continue
        res = cv2.matchTemplate(g1, g2s, cv2.TM_CCOEFF_NORMED)
        _minv, maxv, _minl, maxl = cv2.minMaxLoc(res)
        if best is None or maxv > best[0]:
            best = (float(maxv), maxl, g2s.shape)
    if best is None:
        return {'ok': False, 'error': '模板比图片还大，或图片读不出', 'ms': int((time.time() - t0) * 1000)}
    if best[0] < float(threshold):
        for scale in (0.9, 1.1):
            w = max(1, int(g2.shape[1] * scale))
            h = max(1, int(g2.shape[0] * scale))
            g2s2 = cv2.resize(g2, (w, h), interpolation=cv2.INTER_AREA)
            if g2s2.shape[0] > g1.shape[0] or g2s2.shape[1] > g1.shape[1]:
                continue
            res2 = cv2.matchTemplate(g1, g2s2, cv2.TM_CCOEFF_NORMED)
            _mn, mx, _ml, ml = cv2.minMaxLoc(res2)
            if mx > best[0]:
                best = (float(mx), ml, g2s2.shape)
    # numpy shape 是 (高, 宽)，别按 (w, h) 解包（之前这里把框名反了，中心算偏 70px）
    score, (x, y), (h, w) = best
    cx, cy = x + w // 2, y + h // 2
    return {
        'ok': True,
        'score': round(score, 3),
        'center': {'x': int(cx), 'y': int(cy)},
        'box': {'x1': int(x), 'y1': int(y), 'x2': int(x + w), 'y2': int(y + h)},
        'hit': score >= float(threshold),
        'ms': int((time.time() - t0) * 1000),
    }


def do_crop(image_path, x, y, w, h, out_path):
    t0 = time.time()
    img = load_img(image_path)
    sub, _ox, _oy = clamp_region(img, {'x': x, 'y': y, 'w': w, 'h': h})
    if sub is None or sub.size == 0:
        return {'ok': False, 'error': '裁剪区域为空', 'ms': int((time.time() - t0) * 1000)}
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or '.', exist_ok=True)
    # cv2.imwrite 在中文路径上会静默失败（char* 打开文件）；用 imencode + Python 写字节。
    ok = False
    try:
        ok, buf = cv2.imencode('.png', sub)
        if ok:
            with open(str(out_path), 'wb') as f:
                f.write(buf.tobytes())
    except Exception:
        ok = False
    return {'ok': bool(ok), 'out': str(out_path), 'w': int(sub.shape[1]), 'h': int(sub.shape[0]), 'ms': int((time.time() - t0) * 1000)}


class Handler(BaseHTTPRequestHandler):
    server_version = 'phone-vision/1.0'

    def _send(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get('content-length') or 0)
        raw = self.rfile.read(n) if n else b'{}'
        try:
            return json.loads(raw.decode('utf-8') or '{}')
        except Exception:
            return {}

    def do_GET(self):
        if self.path.split('?')[0] == '/health':
            # [AUDIT-FIX] 暴露 token 指纹，让调用方能识别"旧版/别人的无鉴权服务"，
            # 但不泄漏 token 本身。
            return self._send({'ok': True, 'loaded': _engine is not None,
                               'pid': os.getpid(),
                               'tokenFp': VISION_TOKEN[:8] if VISION_TOKEN else ''})
        self._send({'ok': False, 'error': 'not found'}, 404)

    def do_POST(self):
        p = self.path.split('?')[0]
        # [AUDIT-FIX] 没有下发 token 的服务一律 fail-closed；token 不匹配直接 401。
        if not VISION_TOKEN or not hmac.compare_digest(
                str(self.headers.get('x-vision-token') or ''), VISION_TOKEN):
            return self._send({'ok': False, 'error': 'unauthorized'}, 401)
        try:
            b = self._body()
            if p == '/ocr':
                image = safe_path(b.get('path'))
                if image is None:
                    return self._send({'ok': False, 'error': 'path 路径越界'}, 403)
                return self._send(do_ocr(image, b.get('region')))
            if p == '/find':
                image = safe_path(b.get('image'))
                tpl = safe_path(b.get('template'))
                if image is None or tpl is None:
                    return self._send({'ok': False, 'error': 'image/template 路径越界'}, 403)
                return self._send(find_template(image, tpl, b.get('threshold', 0.8)))
            if p == '/crop':
                image = safe_path(b.get('image'))
                out = safe_path(b.get('out'), for_write=True)
                if image is None or out is None:
                    return self._send({'ok': False, 'error': 'image/out 路径越界'}, 403)
                return self._send(do_crop(image, b.get('x', 0), b.get('y', 0), b.get('w', 1), b.get('h', 1), out))
            return self._send({'ok': False, 'error': 'unknown endpoint'}, 404)
        except Exception as e:
            return self._send({'ok': False, 'error': str(e)}, 500)

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (time.strftime('%H:%M:%S'), fmt % args))


if __name__ == '__main__':
    port = int(os.environ.get('PHONE_VISION_PORT') or 8791)
    print('phone-vision listening on 127.0.0.1:%d' % port, flush=True)
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
