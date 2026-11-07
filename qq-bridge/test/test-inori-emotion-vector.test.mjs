import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadEmotionVector, saveEmotionVector, observeOtherAffect, observeSelfEmotion,
  renderEmotionVector, emotionBias, recordSelfEmotion, EMOTION_VECTOR_FILE,
} from '../src/domain/leaves/inori-emotion-vector.js';

function tmp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emotion-vector-'));
  return path.join(dir, name);
}

test('observeOtherAffect：试探→好奇/不安，发火→烦躁，亲近→亲近', () => {
  const state = { version: 1, keys: {} };
  observeOtherAffect(state, 'private:1', { affect: '不安/在确认', confidence: 0.8 });
  observeOtherAffect(state, 'private:1', { affect: '烦躁/带火', confidence: 0.7 });
  observeOtherAffect(state, 'private:1', { affect: '亲近/心情不错', confidence: 0.6 });
  const row = state.keys['private:1'];
  assert.ok(row.curiosity > 0.1);
  assert.ok(row.fear > 0.05);
  assert.ok(row.anger > 0.05);
  assert.ok(row.affection > 0.05);
  assert.ok(row.joy > 0.02);
});

test('observeSelfEmotion：warm/stung/guarded 映射到不同维度', () => {
  const state = { version: 1, keys: {} };
  observeSelfEmotion(state, 'private:1', { label: 'warm', confidence: 0.7 });
  observeSelfEmotion(state, 'private:1', { label: 'stung', confidence: 0.7 });
  observeSelfEmotion(state, 'private:1', { label: 'guarded', confidence: 0.7 });
  const row = state.keys['private:1'];
  assert.ok(row.joy > 0.05 && row.affection > 0.02);
  assert.ok(row.anger > 0.05 && row.sadness > 0.02);
  assert.ok(row.fear > 0.05);
});

test('renderEmotionVector：低值不注入，高值出前 3；bias 有界', () => {
  const state = { version: 1, keys: {} };
  assert.equal(renderEmotionVector(state, 'private:1'), '');
  observeOtherAffect(state, 'private:1', { affect: '烦躁/带火', confidence: 1 });
  const line = renderEmotionVector(state, 'private:1');
  assert.match(line, /情绪底色/);
  assert.match(line, /烦躁/);
  const b = emotionBias(state, 'private:1');
  assert.ok(b.delta <= 0.08 && b.delta >= -0.08);
  assert.ok(b.negative > b.positive);
});

test('衰减：6 小时后减半，30 个 key 上限', () => {
  const state = { version: 1, keys: {} };
  const now = Date.now();
  observeOtherAffect(state, 'private:1', { affect: '烦躁', confidence: 1, now });
  const before = state.keys['private:1'].anger;
  // 直接写一个 6 小时前的 at，再渲染触发衰减
  state.keys['private:1'].at = now - 6 * 3600 * 1000;
  renderEmotionVector(state, 'private:1', { now });
  const after = state.keys['private:1'].anger;
  assert.ok(after < before * 0.6 && after > before * 0.4, `${before} -> ${after}`);
  for (let i = 0; i < 35; i += 1) observeOtherAffect(state, `private:${i}`, { affect: '亲近', now });
  assert.ok(Object.keys(state.keys).length <= 30);
});

test('save/load 往返；坏文件回空态', () => {
  const file = tmp('emotion-vector.json');
  const state = { version: 1, keys: {} };
  observeOtherAffect(state, 'group:1', { affect: '试探', confidence: 0.8 });
  assert.equal(saveEmotionVector(state, file), true);
  const back = loadEmotionVector(file);
  assert.ok(back.keys['group:1'].curiosity > 0.1);
  fs.writeFileSync(file, '{bad json', 'utf8');
  const broken = loadEmotionVector(file);
  assert.deepEqual(broken.keys, {});
});

test('recordSelfEmotion：追加 JSONL，坏路径不抛', () => {
  const file = tmp('self-emotion.jsonl');
  assert.equal(recordSelfEmotion({ key: 'private:1', selfEmotion: { label: 'warm', confidence: 0.7, reason: '被夸' }, file }), true);
  const row = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.equal(row.key, 'private:1');
  assert.equal(row.label, 'warm');
  assert.equal(row.reason, '被夸');
  assert.equal(recordSelfEmotion({ key: 'x', selfEmotion: {}, file: 'Z:/no/such/dir/x.jsonl' }), false);
});

test('默认路径落在 data/state/emotion-vector.json', () => {
  assert.match(EMOTION_VECTOR_FILE.replace(/\\/g, '/'), /data\/state\/emotion-vector\.json$/);
});
