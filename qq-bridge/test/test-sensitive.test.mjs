// sensitive 金标：启发式闸门要抓「像路径/像凭据赋值」的文本，但不许误伤正常聊天。
// 特别钉住注释里那条纪律：不要为了覆盖裸 32-hex 而加 [0-9a-f]{32}（表情 md5/图片 URL 会被误伤）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SENSITIVE_RE } from '../src/domain/shared/sensitive.js';

const hit = (s) => SENSITIVE_RE.test(s);

test('抓 Windows 路径与 UNC 共享路径', () => {
  assert.equal(hit('我的文件在 C:\\Users\\me\\secret.txt'), true);
  assert.equal(hit('D:/data/x.json 里'), true);
  assert.equal(hit('打开 \\\\server\\share\\x'), true);
});

test('抓 Unix 常见敏感目录', () => {
  assert.equal(hit('看看 /home/me/.ssh/id_rsa'), true);
  assert.equal(hit('/Users/x/Library/Keychains'), true);
  assert.equal(hit('/etc/passwd'), true);
  assert.equal(hit('/root/.bash_history'), true);
});

test('抓「带赋值关系」的凭据，不抓只有关键词的闲聊', () => {
  for (const s of [
    'token=abcd1234',
    'password: hunter2xx',
    '密码：123456',
    'api_key = sk-abcdef',
    'authorization: Bearer abc.def',
    'secret="s3cr3t"',
    '密钥是 abcdefg',
  ]) assert.equal(hit(s), true, s);
  for (const s of [
    '今天看了一部关于密码的电影',
    '我的密码忘了',
    'secret 这个词怎么翻译',
  ]) assert.equal(hit(s), false, s);
  // 已知的偏宽：关键词后面紧跟「是…」会被当成赋值（启发式规则宁可多拦）。
  // 这条用测试固定住现状，真要收紧再改正则并同步改这里。
  assert.equal(hit('这个 token 是什么意思'), true);
});

test('不误伤正常聊天文本', () => {
  for (const s of [
    '你好呀，今天过得怎么样',
    '这首歌好听，循环一整天',
    'https://example.com/a.png 这张图不错',
    'emoji md5: 0123456789abcdef0123456789abcdef',
    '时间 12:30 见面',
  ]) assert.equal(hit(s), false, s);
});

test('纪律：裸 32 位十六进制**不该**被这条正则拦住（那要靠精确令牌名单）', () => {
  assert.equal(hit('0123456789abcdef0123456789abcdef'), false);
});
