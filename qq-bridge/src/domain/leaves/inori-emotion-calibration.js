// inori-emotion-calibration.js · 情绪假设的误差校正（纯函数，零 IO）
//
// 只从**明确纠正**里学习：用户说“没有啦/不是/只是忙/你想多了”才记错；
// 沉默、短回复、没回应都不算错，避免把冷淡误学成“我说对了/说错了”。
//
// 输出的是同类标签的置信度惩罚，不改变情绪分类器本身，也不给她贴标签。

const CORRECTION_RE = /(没有啦?|不是啦?|不是这个|只是.{0,8}(忙|累|困|不想|随便)|你想多了|别瞎猜|没那么严重|还好啦?|我没事|不用担心)/;

export function detectEmotionCorrection(text) {
  return CORRECTION_RE.test(String(text ?? ''));
}

export function createEmotionCalibration() {
  return { byKey: {}, updatedAt: 0 };
}

export function recordEmotionFeedback(store, { key = '', label = 'unknown', corrected = true, now = Date.now() } = {}) {
  const next = store && typeof store === 'object' ? { ...store, byKey: { ...(store.byKey || {}) } } : createEmotionCalibration();
  if (!label || label === 'unknown') return next;
  const k = String(key || 'global');
  const row = next.byKey[k] || { samples: 0, wrong: 0, byLabel: {} };
  const lab = row.byLabel[label] || { samples: 0, wrong: 0 };
  row.samples += 1;
  lab.samples += 1;
  if (corrected) { row.wrong += 1; lab.wrong += 1; }
  row.byLabel[label] = lab;
  next.byKey[k] = row;
  next.updatedAt = now;
  return next;
}

export function calibrationFor(store, key, label) {
  const row = store?.byKey?.[String(key || 'global')];
  const lab = row?.byLabel?.[String(label || '')];
  if (!lab || !lab.samples) return { samples: 0, wrong: 0, penalty: 0 };
  const rate = lab.wrong / lab.samples;
  // 至少 2 次样本才惩罚，避免一次纠正就把词永久打死；最多扣 0.25。
  const penalty = lab.samples >= 2 ? Math.min(0.25, rate * 0.35) : 0;
  return { samples: lab.samples, wrong: lab.wrong, penalty: Number(penalty.toFixed(2)) };
}

export function applyEmotionCalibration(hypothesis, store, key) {
  if (!hypothesis || !hypothesis.label || hypothesis.label === 'unknown') return hypothesis;
  const c = calibrationFor(store, key, hypothesis.label);
  if (!c.penalty) return { ...hypothesis, calibration: c };
  return {
    ...hypothesis,
    confidence: Number(Math.max(0, Math.min(1, Number(hypothesis.confidence) - c.penalty)).toFixed(2)),
    calibration: c,
  };
}
