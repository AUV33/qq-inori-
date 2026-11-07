// inori-failure-reflect 金标：失败归因分「环境/能力/策略」、解决追踪、可执行建议与摘要。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  explainFailure, resolveFailure, renderReflectDigest, KIND, FIX, KIND_LABEL,
} from '../src/domain/leaves/inori-failure-reflect.js';

const NOW = 1_800_000_000_000;

test('explainFailure：禁言/网络是环境问题，权限是能力问题，参数是策略问题', () => {
  const mute = explainFailure('群已禁言，无法发送');
  assert.equal(mute.cause, 'mute');
  assert.equal(mute.kind, 'environment');
  assert.equal(mute.kindLabel, '环境/外部条件');
  assert.ok(mute.fix.includes('等解禁'));

  const auth = explainFailure('没权限 / 未授权 token');
  assert.equal(auth.kind, 'capability');
  assert.ok(auth.fix.includes('没权限就别硬试'));

  const validation = explainFailure('参数不合法，先读未读再设水位');
  assert.equal(validation.kind, 'strategy');
});

test('explainFailure：认不出时归 unknown，仍给一条可执行建议', () => {
  const r = explainFailure('莫名其妙的错误 XYZ');
  assert.equal(r.kind, 'unknown');
  assert.equal(r.kindLabel, '暂不好说');
  assert.ok(r.fix.length > 0);
});

test('KIND/FIX 覆盖同一批原因，标签齐全', () => {
  for (const key of Object.keys(KIND)) {
    assert.ok(FIX[key], `${key} 缺少建议文本`);
    assert.ok(KIND_LABEL[KIND[key]], `${key} 的分类没有中文标签`);
  }
});

test('resolveFailure：同 key+工具、3 分钟内最近一条未解决失败被标成 resolved', () => {
  const log = { events: [
    { key: 'group:1', tool: 'qq_send', at: NOW - 60_000 },
    { key: 'group:1', tool: 'qq_send', at: NOW - 10_000 },
  ] };
  const hit = resolveFailure(log, { key: 'group:1', tool: 'qq_send', at: NOW });
  assert.ok(hit);
  assert.equal(hit.at, NOW - 10_000, '最近那条');
  assert.equal(hit.resolved, true);
  assert.equal(hit.tookMs, 10_000);
});

test('resolveFailure：超过窗口/工具不符/key 不符/已解决 都不动', () => {
  const log = { events: [{ key: 'group:1', tool: 'qq_send', at: NOW - 200_000 }] };
  assert.equal(resolveFailure(log, { key: 'group:1', tool: 'qq_send', at: NOW }), null, '超过 3 分钟');

  const other = { events: [{ key: 'group:2', tool: 'qq_send', at: NOW - 1000 }] };
  assert.equal(resolveFailure(other, { key: 'group:1', tool: 'qq_send', at: NOW }), null);

  const tool = { events: [{ key: 'group:1', tool: 'phone', at: NOW - 1000 }] };
  assert.equal(resolveFailure(tool, { key: 'group:1', tool: 'qq_send', at: NOW }), null);

  const done = { events: [{ key: 'group:1', tool: 'qq_send', at: NOW - 1000, resolved: true }] };
  assert.equal(resolveFailure(done, { key: 'group:1', tool: 'qq_send', at: NOW }), null);

  assert.equal(resolveFailure({}, { at: NOW }), null);
});

test('renderReflectDigest：没有失败返回空串（不加噪声）', () => {
  assert.equal(renderReflectDigest({ events: [] }, { now: NOW }), '');
  assert.equal(renderReflectDigest(null, { now: NOW }), '');
});

test('renderReflectDigest：带次数、归因、可执行建议与已解决数', () => {
  // summarizeFailures 按事件里已经归好的 cause 统计（写库时就归因过）
  const log = { events: [
    { key: 'group:1', tool: 'qq_send', cause: 'mute', at: NOW - 1000, text: '群已禁言，无法发送' },
    { key: 'group:1', tool: 'qq_send', cause: 'mute', at: NOW - 2000, text: '群已禁言，无法发送', resolved: true },
  ] };
  const text = renderReflectDigest(log, { now: NOW, windowMs: 30 * 60_000 });
  assert.ok(text.includes('最近 30 分钟失败'));
  assert.ok(text.includes('已解决 1'));
  assert.ok(text.includes('工具：qq_send×2'));
  assert.ok(text.includes('可以这样试：'));
  assert.ok(text.includes('环境/外部条件，不是你做错'), '要明确告诉她不是她的错');
});

test('renderReflectDigest：同次数时优先挑「能动手改」的归因给建议（策略 > 环境 > 能力）', () => {
  const log = { events: [
    { tool: 'a', cause: 'auth', at: NOW - 1000, text: '没权限' },        // capability
    { tool: 'a', cause: 'validation', at: NOW - 2000, text: '参数不合法' }, // strategy
  ] };
  const text = renderReflectDigest(log, { now: NOW, windowMs: 30 * 60_000 });
  assert.ok(text.includes('策略/参数问题，可以换法'), text);
});
