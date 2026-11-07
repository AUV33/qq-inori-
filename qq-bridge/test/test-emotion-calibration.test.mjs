import test from 'node:test';
import assert from 'node:assert/strict';
import { detectEmotionCorrection, recordEmotionFeedback, applyEmotionCalibration, calibrationFor } from '../src/domain/leaves/inori-emotion-calibration.js';

test('明确纠正才识别；沉默/短回复不算', () => {
  assert.equal(detectEmotionCorrection('没有啦，我只是在忙'), true);
  assert.equal(detectEmotionCorrection('你想多了'), true);
  assert.equal(detectEmotionCorrection('嗯'), false);
  assert.equal(detectEmotionCorrection(''), false);
});

test('两次同类纠正后才产生惩罚，且按 key/label 分开', () => {
  let s = recordEmotionFeedback({}, { key: 'private:1', label: 'tired', corrected: true, now: 1 });
  assert.equal(calibrationFor(s, 'private:1', 'tired').penalty, 0);
  s = recordEmotionFeedback(s, { key: 'private:1', label: 'tired', corrected: true, now: 2 });
  assert.ok(calibrationFor(s, 'private:1', 'tired').penalty > 0);
  assert.equal(calibrationFor(s, 'private:2', 'tired').penalty, 0);
});

test('校准后置信度下降，不改变标签', () => {
  let s = {};
  s = recordEmotionFeedback(s, { key: 'g', label: 'tired' });
  s = recordEmotionFeedback(s, { key: 'g', label: 'tired' });
  const out = applyEmotionCalibration({ label: 'tired', confidence: 0.7 }, s, 'g');
  assert.equal(out.label, 'tired');
  assert.ok(out.confidence < 0.7);
});
