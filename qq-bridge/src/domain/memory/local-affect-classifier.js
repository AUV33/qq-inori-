// local-affect-classifier.js · 本地 ONNX 情绪分类器的客户端与接线判据
//
// 现状（2026-10-28 实测，训练脚本 scripts/emotion-classifier.py）：
//  - 6 类验证准确率 51~57%，二分类「平稳 vs 有情绪」68.6%，高置信子集 68.8%；
//  - 结论：**不够替代 3B**，只在 3B 没起来（冷启动/被回收）时当兜底，或作为低权重参考；
//  - 判据保守：只有置信度 ≥ minConfidence 才采信，否则仍走规则。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR, projectPath } from '../shared/project-paths.js';

export const DEFAULT_ONNX_URL = 'http://127.0.0.1:8793';
const SPAWN_COOLDOWN_MS = 60 * 1000;
let lastSpawnAt = 0;

/** 服务不可用时按需拉起（和本地 3B 同一思路：不写进启动脚本，谁用谁拉） */
export function ensureEmotionServer({ log = () => {}, python = '' } = {}) {
  if (Date.now() - lastSpawnAt < SPAWN_COOLDOWN_MS) return false;
  lastSpawnAt = Date.now();
  const py = python || process.env.INORI_PYTHON || projectPath('ai-companion-kit', 'packages', 'phone-mcp', '.venv', 'Scripts', 'python.exe');
  const script = projectPath('qq-bridge', 'scripts', 'emotion-classifier.py');
  if (!fs.existsSync(py) || !fs.existsSync(script)) { log('[affect-onnx] 缺少 python 或训练脚本，跳过'); return false; }
  try {
    const logFile = path.join(LOG_DIR, 'emotion-server.log');
    const out = fs.openSync(logFile, 'a');
    const child = spawn(py, [script, '--serve'], { cwd: projectPath(), detached: true, stdio: ['ignore', out, out], windowsHide: true });
    child.unref();
    log('[affect-onnx] 拉起本地情绪分类器（8793）');
    return true;
  } catch (error) {
    log(`[affect-onnx] 拉起失败: ${error?.message ?? error}`);
    return false;
  }
}

/** 调一次分类：失败/超时返回 null，调用方自己降级 */
export async function classifyAffectOnnx(text, { url = DEFAULT_ONNX_URL, timeoutMs = 1500, fetchImpl = fetch } = {}) {
  const body = String(text ?? '').trim();
  if (!body) return null;
  const t0 = Date.now();
  try {
    const res = await fetchImpl(`${String(url).replace(/\/+$/, '')}/classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: body }),
      signal: AbortSignal.timeout(Math.max(300, Number(timeoutMs) || 1500)),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.ok === false || !data.label) return null;
    return {
      label: String(data.label),
      confidence: Number(data.confidence) || 0,
      margin: Number(data.margin) || 0,
      scores: data.scores && typeof data.scores === 'object' ? data.scores : {},
      ms: Number(data.ms) || (Date.now() - t0),
    };
  } catch { return null; }
}

/**
 * 采信判据（纯函数，便于单测）：置信度够高、margin 不太窄才用。
 * 阈值定得高是故意的——2026-10-28 实测它只有 ~69%，宁可退回规则/3B。
 */
export function shouldTrustOnnx(result, { minConfidence = 0.7, minMargin = 0.15 } = {}) {
  if (!result || !result.label) return false;
  if (!Number.isFinite(Number(result.confidence)) || Number(result.confidence) < minConfidence) return false;
  if (Number.isFinite(Number(result.margin)) && Number(result.margin) < minMargin) return false;
  return true;
}

/** ONNX 标签映射到影响注入的字段（和 3B 判读同一套标签） */
export function onnxJudgement(result) {
  if (!result) return null;
  return {
    affect: result.label,
    target: '无',
    confidence: Number(result.confidence) || 0,
    intent: '',
    evidence: '',
  };
}
