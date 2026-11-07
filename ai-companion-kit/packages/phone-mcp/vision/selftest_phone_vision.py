#!/usr/bin/env python
# selftest_phone_vision.py · 用合成图自测识别服务（不依赖手机）
# 断言：OCR 能读出文字；模板匹配能把已知位置的红块找回来（±6px）。
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

import cv2
import numpy as np
_INORI_ROOT = os.environ.get('QQ_INORI_ROOT') or os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '..'))
_TMP_ROOT = os.path.join(_INORI_ROOT, '_tmp')

PORT = int(os.environ.get('PHONE_VISION_PORT') or 8791)
BASE = 'http://127.0.0.1:%d' % PORT
HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.join(HERE, '..', '.venv', 'Scripts', 'python.exe')
if not os.path.exists(PY):
    PY = os.path.join(HERE, '..', '.venv', 'bin', 'python')


def post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode('utf-8'),
                                 headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode('utf-8'))


def health():
    try:
        with urllib.request.urlopen(BASE + '/health', timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def main():
    tmp = tempfile.mkdtemp(prefix='phone-vision-', dir=_TMP_ROOT) if os.path.isdir(_TMP_ROOT) else tempfile.mkdtemp(prefix='phone-vision-')
    img = np.full((2400, 1080, 3), 245, np.uint8)
    cv2.putText(img, 'START ACTION', (100, 220), cv2.FONT_HERSHEY_SIMPLEX, 2.2, (20, 20, 20), 5, cv2.LINE_AA)
    cv2.rectangle(img, (600, 800), (700, 860), (0, 0, 255), -1)
    cv2.putText(img, 'GO', (610, 855), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (255, 255, 255), 3, cv2.LINE_AA)
    cv2.line(img, (600, 800), (700, 860), (0, 0, 0), 3)
    shot = os.path.join(tmp, 'screen.png')
    ok, buf = cv2.imencode('.png', img); open(shot, 'wb').write(buf.tobytes())

    started = False
    if not health():
        subprocess.Popen([PY, os.path.join(HERE, 'phone_vision_server.py')], cwd=HERE,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        started = True
        for _ in range(100):
            time.sleep(0.3)
            if health():
                break
    assert health(), '服务没起来'
    print('health OK', '（本次自测拉起）' if started else '（已有服务）')

    ocr = post('/ocr', {'path': shot})
    assert ocr.get('ok'), ocr
    texts = ' '.join(i['text'] for i in ocr['items'])
    assert 'START' in texts.upper(), 'OCR 没读到 START: ' + texts
    print('OCR OK:', len(ocr['items']), '行', ocr['ms'], 'ms |', texts[:60])

    crop_out = os.path.join(tmp, 'tpl.png')
    c = post('/crop', {'image': shot, 'x': 600, 'y': 800, 'w': 100, 'h': 60, 'out': crop_out})
    assert c.get('ok') and os.path.exists(crop_out), c
    f = post('/find', {'image': shot, 'template': crop_out, 'threshold': 0.8})
    assert f.get('ok'), f
    assert f['hit'] and f['score'] > 0.9, f
    cx, cy = f['center']['x'], f['center']['y']
    assert abs(cx - 650) <= 6 and abs(cy - 830) <= 6, '中心偏了: %s,%s' % (cx, cy)
    print('FIND OK: score', f['score'], 'center', (cx, cy), f['ms'], 'ms')

    # 找不存在的图（黑块）不应该命中
    black = os.path.join(tmp, 'nope.png')
    cv2.rectangle(img, (0, 0), (40, 40), (0, 0, 0), -1)
    ok2, buf2 = cv2.imencode('.png', img[0:40, 0:40]); open(black, 'wb').write(buf2.tobytes())
    n = post('/find', {'image': shot, 'template': black, 'threshold': 0.8})
    print('MISS OK: score', n.get('score'), 'hit', n.get('hit'))
    print('ALL OK')


if __name__ == '__main__':
    main()
