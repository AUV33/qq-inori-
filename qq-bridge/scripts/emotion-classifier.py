#!/usr/bin/env python
# emotion-classifier.py · 本地 ONNX 情绪分类器（不新增模型文件：拿 bge-m3 当特征，自己训一个线性头）
#
# 为什么这么做：情绪判读现在 3B 每轮 0.5~4s、还占显存；ONNX 小头是 CPU 毫秒级。
# 但本机没有现成的中文情绪 ONNX 模型，也不联网下载，所以：
#   1) --label：用已在跑的 3B 给真实消息打弱标签（蒸馏），和手写小样本一起存成训练集；
#   2) --train：用 bge-m3（8790）算嵌入，训练 softmax 回归，导出 MatMul+Add+Softmax 的 ONNX；
#   3) --serve：起 8793 的 HTTP 分类服务，输入文本 → 8790 嵌入 → ONNX 推理 → 标签+置信度。
#
# 用法：
#   python scripts/emotion-classifier.py --label            # 生成/更新 data/state/emotion-labels.jsonl
#   python scripts/emotion-classifier.py --train            # 训练 + 导出 data/models/emotion-classifier.onnx
#   python scripts/emotion-classifier.py --serve            # 前台起 8793
#   python scripts/emotion-classifier.py --eval             # 只评估（读 report）
import argparse
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

ROOT = os.environ.get('QQ_INORI_ROOT') or os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
STATE = os.path.join(ROOT, 'data', 'state')
MODELS = os.path.join(ROOT, 'data', 'models')
LABELS_FILE = os.path.join(STATE, 'emotion-labels.jsonl')
REPORT_FILE = os.path.join(STATE, 'emotion-train-report.json')
MODEL_FILE = os.path.join(MODELS, 'emotion-classifier.onnx')
META_FILE = os.path.join(MODELS, 'emotion-classifier.json')
EMBED_URL = os.environ.get('EMOTION_EMBED_URL', 'http://127.0.0.1:8790/v1/embeddings')
LLM_URL = os.environ.get('EMOTION_LLM_URL', 'http://127.0.0.1:18080/v1/chat/completions')
LABELS = ['倾诉', '发火', '试探', '玩笑', '亲近', '平稳']
HAND = [
    ('我真的撑不住了', '倾诉'), ('我快崩溃了，没人听我说', '倾诉'),
    ('你他妈烦不烦', '发火'), ('滚吧别管我', '发火'), ('太傻逼了这个人', '发火'), ('这软件真恶心', '发火'),
    ('你是不是嫌我烦', '试探'), ('你是不是在敷衍我', '试探'),
    ('哈哈哈哈哈笑死', '玩笑'), ('你个傻蛋哈哈哈', '玩笑'),
    ('谢谢你还记得', '亲近'), ('今天下午三点开会', '平稳'), ('你看我干嘛', '平稳'),
]


def post_json(url, payload, timeout=60):
    data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def lexical_features(text):
    """确定性的词法特征（和 JS 侧无需同步：特征只在 Python 服务里算，入参仍是纯文本）。"""
    t = str(text or '')
    n = max(1, len(t))
    def has(*words):
        return 1.0 if any(w in t for w in words) else 0.0
    bang = t.count('!') + t.count('！')
    ques = t.count('?') + t.count('？')
    dots = t.count('…') + t.count('...')
    tilde = t.count('~') + t.count('～')
    repeat = 1.0 if any(ch * 3 in t for ch in '哈呵呜啊哎唉') else 0.0
    return [
        min(1.0, n / 60.0),                                   # 长度（归一到 60 字）
        1.0 if n <= 6 else 0.0,                               # 极短
        min(1.0, bang / 3.0), min(1.0, ques / 2.0),
        min(1.0, dots / 2.0), min(1.0, tilde / 2.0),
        repeat,
        has('哈哈', 'hhh', '笑死', '乐死', '草', '绷不住'),      # 玩笑
        has('傻逼', '傻蛋', '笨蛋', '蠢', '滚', '烦不烦', '恶心', '他妈', '妈的', '气死', '无语'),  # 发火
        has('呜呜', '哭', '难受', '崩', '撑不住', '累', '委屈', '难过', '不开心', '烦'),  # 倾诉
        has('是不是', '嫌我', '敷衍', '你还', '到底', '有没有', '在吗', '理我'),          # 试探
        has('谢谢', '喜欢你', '想你', '爱你', '晚安', '早安', '辛苦', '抱抱', '亲亲', '陪'),  # 亲近
        has('明天', '今天', '几点', '开会', '吃', '睡了', '上班', '下班', '买了', '去了'),  # 平稳（日常）
        1.0 if t.endswith(('吗', '呢', '吧', '？', '?')) else 0.0,
        1.0 if '@' in t else 0.0,
        sum(1 for ch in t if ord(ch) > 0x1F000) / 3.0,         # emoji 数量
        1.0 if t.strip() in ('。', '。。。', '...', '？', '?') else 0.0,
    ]


def embed(texts, batch=16):
    out = []
    for i in range(0, len(texts), batch):
        part = texts[i:i + batch]
        data = post_json(EMBED_URL, {'input': part, 'model': 'bge-m3'}, timeout=120)
        vecs = [row['embedding'] for row in data['data']]
        out.extend(vecs)
    return out


def collect_messages():
    path = os.path.join(ROOT, 'qq-bridge', 'state', 'social-v2.json')
    with open(path, encoding='utf-8') as f:
        d = json.load(f)
    seen = []
    for _, conv in (d.get('conversations') or {}).items():
        for m in (conv.get('recentMessages') or []):
            if not m or m.get('isSelf'):
                continue
            t = str(m.get('text') or m.get('plain') or '').strip()
            if 4 <= len(t) <= 120 and t not in seen:
                seen.append(t)
    return seen


def collect_memory_utterances():
    """从记忆库提取可标注的单句：事实/事件整条；群/日 digest 按 " / " 切开、剥掉"谁："前缀。
    digest 是多条消息的摘要，整条没有情绪可言；切成发言单元才能当训练样本。"""
    import glob
    out = []
    for path in glob.glob(os.path.join(ROOT, 'data', 'memory', 'memory*.jsonl')):
        for line in open(path, encoding='utf-8'):
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            text = str(o.get('text') or '').strip()
            kind = str(o.get('kind') or '')
            if not text:
                continue
            if kind in ('group-digest', 'day-digest', 'group-compact'):
                body = text.split('：', 1)[1] if '：' in text else text
                for seg in body.split(' / '):
                    seg = seg.strip()
                    if '：' in seg:
                        seg = seg.split('：', 1)[1].strip()
                    if 4 <= len(seg) <= 80 and not seg.startswith(('群里在聊', '这天')):
                        out.append(seg)
            elif 4 <= len(text) <= 120:
                out.append(text)
    return out


def label_one(text):
    prompt = (
        '判断下面这句话的情绪。只输出 JSON，不要解释：'
        '{"affect":"倾诉|发火|试探|玩笑|亲近|平稳"}\n'
        '倾诉=在倒苦水求安慰；发火=生气骂人；试探=在确认关系/态度；玩笑=打趣吐槽；'
        '亲近=表达信任喜欢；平稳=普通陈述。\n\n'
        f'句子：{text}'
    )
    try:
        data = post_json(LLM_URL, {
            'model': 'qwen2.5-3b-instruct-q4_k_m',
            'messages': [{'role': 'user', 'content': prompt}],
            'max_tokens': 40, 'temperature': 0.1, 'stream': False,
        }, timeout=60)
        raw = data['choices'][0]['message']['content']
        start = raw.find('{')
        end = raw.rfind('}')
        if start < 0 or end < 0:
            return None
        label = json.loads(raw[start:end + 1]).get('affect')
        return label if label in LABELS else None
    except Exception as e:  # noqa: BLE001
        print(f'  标注失败：{e}', file=sys.stderr)
        return None


def do_label():
    os.makedirs(STATE, exist_ok=True)
    existing = {}
    if os.path.exists(LABELS_FILE):
        for line in open(LABELS_FILE, encoding='utf-8'):
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
                existing[o['text']] = o
            except Exception:  # noqa: BLE001
                pass
    rows = [{'text': t, 'label': l, 'source': 'hand'} for t, l in HAND]
    msgs = collect_messages()
    if not args.no_memory:
        mem = [t for t in collect_memory_utterances() if t not in set(msgs)]
        print(f'记忆库发言单元 {len(mem)} 条（去重后并入训练集）')
        msgs = msgs + mem
    print(f'待标注文本 {len(msgs)} 条，开始用 3B 打弱标签…')
    t0 = time.time()
    skipped = 0
    for i, text in enumerate(msgs):
        if text in existing and existing[text].get('label'):
            rows.append(existing[text])
            continue
        label = label_one(text)
        if not label:
            skipped += 1
            continue
        rows.append({'text': text, 'label': label, 'source': '3b'})
        if (i + 1) % 20 == 0:
            print(f'  {i + 1}/{len(msgs)}…', flush=True)
    with open(LABELS_FILE, 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    print(f'训练集 {len(rows)} 条（跳过 {skipped}，{time.time() - t0:.0f}s）→ {LABELS_FILE}')


def softmax(z):
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def do_train():
    rows = [json.loads(line) for line in open(LABELS_FILE, encoding='utf-8') if line.strip()]
    texts = [r['text'] for r in rows]
    y = np.array([LABELS.index(r['label']) for r in rows], dtype=np.int64)
    print(f'样本 {len(texts)} 条，算 bge-m3 嵌入…')
    emb = np.array(embed(texts), dtype=np.float32)
    emb /= (np.linalg.norm(emb, axis=1, keepdims=True) + 1e-9)
    lex = np.array([lexical_features(t) for t in texts], dtype=np.float32)
    X = np.concatenate([lex, emb], axis=1)
    idx = list(range(len(texts)))
    random.seed(20261028)
    random.shuffle(idx)
    split = max(1, int(len(idx) * 0.8))
    tr, va = idx[:split], idx[split:]
    # 标准化（只统计训练集），推理端用同一组均值/方差；bge 嵌入本身各维尺度差很大，不标准化很难收敛
    mu = X[tr].mean(axis=0)
    sd = X[tr].std(axis=0) + 1e-6
    X = (X - mu) / sd
    W = np.zeros((X.shape[1], len(LABELS)), dtype=np.float32)
    b = np.zeros(len(LABELS), dtype=np.float32)
    lr, l2, epochs = 0.15, 3e-4, 2000
    counts = np.bincount(y, minlength=len(LABELS)).astype(np.float32)
    class_w = (len(y) / (len(LABELS) * np.maximum(counts, 1))).astype(np.float32)  # 类别不均衡：平稳占一半，必加权
    Y = np.zeros((len(tr), len(LABELS)), dtype=np.float32)
    Y[np.arange(len(tr)), y[tr]] = 1
    for _ in range(epochs):
        p = softmax(X[tr] @ W + b)
        grad = (p - Y) * class_w[y[tr]][:, None]
        W -= lr * (X[tr].T @ grad / len(tr) + l2 * W)
        b -= lr * grad.mean(axis=0)

    def probs(ids):
        return softmax(X[ids] @ W + b)

    def acc(ids):
        if not ids:
            return None
        return float((probs(ids).argmax(axis=1) == y[ids]).mean())

    # 「先量再接线」：只信高置信 + 高 margin 的子集，看它的准确率与覆盖率
    val_p = probs(va) if va else np.zeros((0, len(LABELS)))
    def trusted(min_conf, min_margin):
        if not va:
            return {'coverage': 0.0, 'accuracy': None, 'n': 0}
        top2 = np.sort(val_p, axis=1)[:, -2:]
        conf = top2[:, 1]
        margin = top2[:, 1] - top2[:, 0]
        mask = (conf >= min_conf) & (margin >= min_margin)
        n = int(mask.sum())
        if not n:
            return {'coverage': 0.0, 'accuracy': None, 'n': 0}
        accv = float((val_p[mask].argmax(axis=1) == y[va][mask]).mean())
        return {'coverage': round(n / len(va), 3), 'accuracy': accv, 'n': n}
    # 二分类（平稳 vs 有情绪）才是接线要用的判据：只有"确定平稳"时才跳过 3B
    calm_idx = LABELS.index('平稳')
    def binary(ids):
        if not ids:
            return {'accuracy': None, 'n': 0}
        pp = probs(ids)
        pred_calm = pp[:, calm_idx] >= 0.5
        true_calm = y[ids] == calm_idx
        return {'accuracy': float((pred_calm == true_calm).mean()), 'n': len(ids)}
    calm_conf = val_p[:, calm_idx] if va else np.zeros(0)
    calm_mask = calm_conf >= 0.8
    bin_trusted = None
    if va and calm_mask.any():
        bin_trusted = {
            'coverage': round(float(calm_mask.mean()), 3),
            'calmPrecision': float((y[va][calm_mask] == calm_idx).mean()),
            'n': int(calm_mask.sum()),
        }
    report = {'samples': len(texts), 'train': len(tr), 'val': len(va), 'valAcc': acc(va), 'trainAcc': acc(tr),
              'binaryCalm': binary(va), 'calmTrusted': bin_trusted,
              'classCounts': {LABELS[i]: int(counts[i]) for i in range(len(LABELS))},
              'trusted': {f'{c}/{m}': trusted(c, m) for c, m in [(0.5, 0.05), (0.6, 0.1), (0.7, 0.15)]},
              'labels': LABELS, 'at': time.strftime('%Y-%m-%dT%H:%M:%S')}
    os.makedirs(MODELS, exist_ok=True)
    export_onnx(W, b)
    with open(META_FILE, 'w', encoding='utf-8') as f:
        json.dump({'labels': LABELS, 'dim': int(W.shape[0]), 'mu': mu.tolist(), 'sd': sd.tolist()}, f, ensure_ascii=False)
    with open(REPORT_FILE, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))


def export_onnx(W, b):
    import numpy as np
    import onnx
    from onnx import TensorProto, helper
    dim, ncls = int(W.shape[0]), int(W.shape[1])
    x = helper.make_tensor_value_info('input', TensorProto.FLOAT, [None, dim])
    y = helper.make_tensor_value_info('probs', TensorProto.FLOAT, [None, ncls])
    nodes = [
        helper.make_node('MatMul', ['input', 'W'], ['logits0']),
        helper.make_node('Add', ['logits0', 'b'], ['logits']),
        helper.make_node('Softmax', ['logits'], ['probs'], axis=1),
    ]
    graph = helper.make_graph(nodes, 'emotion_softmax',
                              [x], [y],
                              initializer=[
                                  helper.make_tensor('W', TensorProto.FLOAT, [dim, ncls], W.astype(np.float32).tobytes(), raw=True),
                                  helper.make_tensor('b', TensorProto.FLOAT, [ncls], b.astype(np.float32).tobytes(), raw=True),
                              ])
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 13)])
    model.ir_version = 8
    onnx.checker.check_model(model)
    onnx.save(model, MODEL_FILE)
    print(f'ONNX 已导出：{MODEL_FILE}（{dim} → {ncls}）')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path == '/health':
            meta = json.load(open(META_FILE, encoding='utf-8')) if os.path.exists(META_FILE) else {}
            self._json(200, {'status': 'ok', 'labels': meta.get('labels', [])})
        else:
            self._json(404, {'error': 'not found'})

    def do_POST(self):  # noqa: N802
        if self.path != '/classify':
            self._json(404, {'error': 'not found'})
            return
        try:
            n = int(self.headers.get('Content-Length') or 0)
            req = json.loads(self.rfile.read(n).decode('utf-8'))
            text = str(req.get('text') or '').strip()
            if not text:
                self._json(400, {'ok': False, 'error': 'text required'})
                return
            vecs = embed([text])
            embv = np.array(vecs, dtype=np.float32)
            embv /= (np.linalg.norm(embv, axis=1, keepdims=True) + 1e-9)
            x = np.concatenate([np.array([lexical_features(text)], dtype=np.float32), embv], axis=1)
            meta = json.load(open(META_FILE, encoding='utf-8'))
            if meta.get('mu') and meta.get('sd'):
                x = (x - np.array(meta['mu'], dtype=np.float32)) / np.array(meta['sd'], dtype=np.float32)
            t0 = time.time()
            probs = session.run(['probs'], {'input': x})[0][0]
            order = np.argsort(probs)[::-1]
            labels = json.load(open(META_FILE, encoding='utf-8'))['labels']
            best = int(order[0])
            second = float(probs[int(order[1])]) if len(order) > 1 else 0.0
            self._json(200, {
                'ok': True,
                'label': labels[best],
                'confidence': float(probs[best]),
                'margin': float(probs[best]) - second,
                'scores': {labels[i]: float(probs[i]) for i in range(len(labels))},
                'ms': int((time.time() - t0) * 1000),
            })
        except Exception as e:  # noqa: BLE001
            self._json(500, {'ok': False, 'error': str(e)})


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--label', action='store_true')
    ap.add_argument('--no-memory', action='store_true', help='不把记忆库并入标注集')
    ap.add_argument('--train', action='store_true')
    ap.add_argument('--serve', action='store_true')
    ap.add_argument('--port', type=int, default=8793)
    args = ap.parse_args()
    if args.label:
        do_label()
    elif args.train:
        do_train()
    elif args.serve:
        import onnxruntime as ort
        if not os.path.exists(MODEL_FILE):
            print('没有 ONNX 模型，先跑 --train', file=sys.stderr)
            sys.exit(2)
        session = ort.InferenceSession(MODEL_FILE, providers=['CPUExecutionProvider'])
        print(f'情绪分类器已就绪：127.0.0.1:{args.port}（模型 {MODEL_FILE}）', flush=True)
        ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
    else:
        ap.print_help()
