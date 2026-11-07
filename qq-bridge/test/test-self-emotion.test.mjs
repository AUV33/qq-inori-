import test from 'node:test';
import assert from 'node:assert/strict';
import { appraiseSelfEmotion, buildEmpathicStance, renderSelfEmotionBlock } from '../src/domain/leaves/inori-self-emotion.js';

test('被夸会暖，被刺会收紧；不是复制对方情绪', () => {
  const warm = appraiseSelfEmotion({ frame: { speechAct: 'compliment', evidence: ['你真好看'] }, selfState: { warmth: 0.6, energy: 0.6 } });
  assert.equal(warm.label, 'warm');
  const sting = appraiseSelfEmotion({ frame: { speechAct: 'test', stance: 'sarcastic', evidence: ['你是不是在敷衍'] }, selfState: { warmth: 0.5, energy: 0.6 } });
  assert.equal(sting.label, 'guarded');
});

test('对方倾诉时，亲近是担心，不亲近是不舒服', () => {
  const close = appraiseSelfEmotion({ frame: { speechAct: 'vent', evidence: ['好难受'] }, selfState: { energy: 0.6 }, relationship: { closeness: 0.8 } });
  assert.equal(close.label, 'concerned');
  const far = appraiseSelfEmotion({ frame: { speechAct: 'vent', evidence: ['好难受'] }, selfState: { energy: 0.6 }, relationship: { closeness: 0.1 } });
  assert.equal(far.label, 'uncomfortable');
});

test('共情有边界，不命令必须安慰', () => {
  const self = appraiseSelfEmotion({ frame: { speechAct: 'vent', evidence: ['难受'] }, selfState: { energy: 0.6 }, relationship: { closeness: 0.8 } });
  const emp = buildEmpathicStance({ frame: { emotion: { label: 'sad' }, speechAct: 'vent' }, selfEmotion: self, relationship: { closeness: 0.8 } });
  assert.match(emp.boundary, /不等于/);
  const text = renderSelfEmotionBlock(self, emp);
  assert.match(text, /【你这边的情绪】/);
  assert.match(text, /【边界】/);
  assert.doesNotMatch(text, /你(必须|应该)安慰/);
});

test('精力很低时，自身疲惫优先于被带暖', () => {
  const e = appraiseSelfEmotion({ frame: { speechAct: 'compliment' }, selfState: { warmth: 0.8, energy: 0.1 } });
  assert.equal(e.label, 'tired');
});
