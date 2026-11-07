#!/usr/bin/env python
# dbg_match.py · 直接算：crop 与 matchTemplate 的真实位置
import os, cv2, numpy as np, tempfile
_INORI_ROOT = os.environ.get('QQ_INORI_ROOT') or os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '..'))
_TMP_ROOT = os.path.join(_INORI_ROOT, '_tmp')
tmp = tempfile.mkdtemp(prefix='dbgmatch-', dir=_TMP_ROOT)
img = np.full((2400, 1080, 3), 245, np.uint8)
cv2.rectangle(img, (600, 800), (700, 860), (0, 0, 255), -1)
cv2.putText(img, 'GO', (610, 855), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (255, 255, 255), 3, cv2.LINE_AA)
cv2.line(img, (600, 800), (700, 860), (0, 0, 0), 3)
shot = os.path.join(tmp, 's.png'); ok, buf = cv2.imencode('.png', img); open(shot, 'wb').write(buf.tobytes())
tpl = img[800:860, 600:700]
tplp = os.path.join(tmp, 't.png'); ok2, b2 = cv2.imencode('.png', tpl); open(tplp, 'wb').write(b2.tobytes())
g1 = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY); g2 = cv2.cvtColor(tpl, cv2.COLOR_BGR2GRAY)
res = cv2.matchTemplate(g1, g2, cv2.TM_CCOEFF_NORMED)
mn, mx, ml, mxl = cv2.minMaxLoc(res)
print('template', tpl.shape, 'std', float(g2.std()))
print('max', mx, 'loc', mxl, 'center', (mxl[0] + tpl.shape[1] // 2, mxl[1] + tpl.shape[0] // 2))
# 看看有多少个 0.99+ 的点
ys, xs = np.where(res >= 0.99)
print('points >=0.99:', len(xs), 'first', (xs[:5], ys[:5]) if len(xs) else None)
