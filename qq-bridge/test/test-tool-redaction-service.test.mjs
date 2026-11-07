// tool-redaction-service 的金标：嵌套脱敏、原型链键过滤、JSON 多层解析、截断。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolRedaction } from '../src/domain/memory/tool-redaction-service.mjs';

const svc = createToolRedaction({
  redactSensitiveText: (text) => String(text).replace(/sk-[a-z0-9]+/gi, '***'),
  truncateText: (text, n) => String(text).slice(0, n),
});

test('redactSensitive：敏感键替换，嵌套/数组递归', () => {
  const out = svc.redactSensitive({
    token: 'abc', Authorization: 'Bearer x', password: 'p',
    nested: { api_key: 'k', safe: 'sk-123' },
    list: [{ cookie: 'c' }, 'sk-999'],
  });
  assert.equal(out.token, '***');
  assert.equal(out.Authorization, '***');
  assert.equal(out.password, '***');
  assert.equal(out.nested.api_key, '***');
  assert.equal(out.nested.safe, '***');
  assert.equal(out.list[0].cookie, '***');
  assert.equal(out.list[1], '***');
});

test('redactSensitive：跳过 __proto__/constructor/prototype', () => {
  const out = svc.redactSensitive(JSON.parse('{"__proto__":{"x":1},"constructor":{"y":2},"prototype":{"z":3},"ok":1}'));
  assert.equal(Object.keys(out).includes('__proto__'), false);
  assert.equal(Object.keys(out).includes('constructor'), false);
  assert.equal(Object.keys(out).includes('prototype'), false);
  assert.equal(out.ok, 1);
});

test('sanitizeToolArgs：双层 JSON 字符串、普通字符串、null', () => {
  assert.equal(svc.sanitizeToolArgs(null), null);
  assert.equal(svc.sanitizeToolArgs(undefined), null);
  const inner = JSON.stringify({ token: 'secret', text: 'hello' });
  const outer = JSON.stringify(inner);
  const parsed = JSON.parse(svc.sanitizeToolArgs(outer));
  assert.equal(parsed.token, '***');
  assert.equal(parsed.text, 'hello');
  // 非 JSON 字符串按普通字符串脱敏
  assert.equal(svc.sanitizeToolArgs('sk-abc'), '"***"');
});

test('sanitizeToolArgs：超过 2000 字截断', () => {
  const long = { text: 'x'.repeat(3000) };
  const out = svc.sanitizeToolArgs(long);
  assert.ok(out.length < 2020, `实际 ${out.length}`);
  assert.match(out, /truncated/);
});
