# rerank-server.py · 交叉重排服务（bge-reranker-v2-m3）
# 用法：python qq-bridge/scripts/rerank-server.py
# 端口 8792；POST /rerank {"query": "...", "documents": ["..."]} -> {"scores":[..]}
#
# [ON-DEMAND] 不再常驻：由 qq-bridge 在真要重排时按需拉起（src/rerank-on-demand.js），
# 空闲 RERANK_IDLE_EXIT 秒（默认 900，设 0 则常驻）没有任何请求就自己退出，把内存还回去。
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

_ROOT = os.environ.get('QQ_INORI_ROOT') or os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
MODEL_DIR = os.environ.get("RERANK_MODEL", os.path.join(_ROOT, 'models', 'bge-reranker-v2-m3'))
PORT = int(os.environ.get("RERANK_PORT", "8792"))
IDLE_EXIT_SEC = int(os.environ.get("RERANK_IDLE_EXIT", "900"))
USAGE = {"last": time.time()}


def _idle_watcher():
    """空闲太久就退出：这是按需启动的另一半，否则跑起来就再也不走了。"""
    while True:
        time.sleep(10)
        if IDLE_EXIT_SEC > 0 and time.time() - USAGE["last"] > IDLE_EXIT_SEC:
            print(f"[rerank] idle {IDLE_EXIT_SEC}s, exiting to free memory", flush=True)
            os._exit(0)


print(f"[rerank] loading {MODEL_DIR} ...", flush=True)

tok = AutoTokenizer.from_pretrained(MODEL_DIR)
model = AutoModelForSequenceClassification.from_pretrained(MODEL_DIR, torch_dtype=torch.float16)
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
model = model.to(device).eval()
print(f"[rerank] ready on {device}", flush=True)


def score_pairs(query: str, documents):
    pairs = [[query, str(d)] for d in documents]
    with torch.no_grad():
        inputs = tok(pairs, padding=True, truncation=True, max_length=512, return_tensors="pt").to(device)
        logits = model(**inputs).logits.view(-1).float()
        # bge-reranker 的输出是 logit，转 0~1 便于观察
        scores = torch.sigmoid(logits).tolist()
    return scores


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        USAGE["last"] = time.time()
        if self.path.startswith("/health"):
            self._send(200, {"ok": True, "device": str(device), "model": MODEL_DIR, "idleExitSec": IDLE_EXIT_SEC})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        USAGE["last"] = time.time()
        if not self.path.startswith("/rerank"):
            self._send(404, {"ok": False, "error": "not found"})
            return
        try:
            n = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(n) or b"{}")
            query = str(body.get("query") or "")
            documents = body.get("documents") or []
            if not query or not isinstance(documents, list) or not documents:
                self._send(400, {"ok": False, "error": "query/documents required"})
                return
            t0 = time.time()
            scores = score_pairs(query, documents)
            self._send(200, {"ok": True, "scores": scores, "ms": int((time.time() - t0) * 1000)})
        except Exception as e:  # noqa: BLE001
            self._send(500, {"ok": False, "error": str(e)})


if __name__ == "__main__":
    if IDLE_EXIT_SEC > 0:
        threading.Thread(target=_idle_watcher, daemon=True).start()
    print(f"[rerank] listening :{PORT} (idle exit {IDLE_EXIT_SEC}s)", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
