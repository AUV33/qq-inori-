#!/usr/bin/env python
# debug_vision.py · 手动打各端点，打印状态与错误体
import json, os, subprocess, sys, time, tempfile, urllib.request, urllib.error
import cv2, numpy as np
_INORI_ROOT = os.environ.get('QQ_INORI_ROOT') or os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '..'))
_TMP_ROOT = os.path.join(_INORI_ROOT, '_tmp')

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.join(HERE, '..', '.venv', 'Scripts', 'python.exe')
PORT = 8791
BASE = 'http://127.0.0.1:%d' % PORT

def req(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, headers={'content-type': 'application/json'} if data else {})
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:500]

def health():
    try:
        with urllib.request.urlopen(BASE + '/health', timeout=2) as r:
            return r.status == 200
    except Exception:
        return False

if not health():
    subprocess.Popen([PY, os.path.join(HERE, 'phone_vision_server.py')], cwd=HERE)
    for _ in range(100):
        time.sleep(0.3)
        if health(): break
print('health', health())

tmp = tempfile.mkdtemp(prefix='dbg-', dir=_TMP_ROOT) if os.path.isdir(_TMP_ROOT) else tempfile.mkdtemp(prefix='dbg-')
img = np.full((2400, 1080, 3), 245, np.uint8)
cv2.putText(img, 'START ACTION', (100, 220), cv2.FONT_HERSHEY_SIMPLEX, 2.2, (20, 20, 20), 5, cv2.LINE_AA)
cv2.rectangle(img, (600, 800), (700, 860), (0, 0, 255), -1)
shot = os.path.join(tmp, 'screen.png')
ok, buf = cv2.imencode('.png', img); open(shot, 'wb').write(buf.tobytes())
print('ocr', req('/ocr', {'path': shot}))
crop = os.path.join(tmp, 'tpl.png')
print('crop', req('/crop', {'image': shot, 'x': 600, 'y': 800, 'w': 100, 'h': 60, 'out': crop}))
print('find', req('/find', {'image': shot, 'template': crop, 'threshold': 0.8}))
