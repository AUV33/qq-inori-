// voice-service 金标：语音库路径解析与越界防护、限流记账、发送链路、记账与回读校验。
//
// 只测 voice-service 自己的逻辑：路径判定、配置归一化、限流状态机、错误映射、状态迁移。
// 下游（OneBot 网关、ffmpeg、音量处理、临时文件清理）全部用注入或桩；
// 唯一「真实」的是 voice-core 的纯路径函数（listAudioFiles/safeJoinLibrary/resolveAudioSource）
// 和 inspectAudio 的前置校验——它们正是本模块安全边界/配置归一化的被测对象，不能桩掉。
// 为了让 inspectAudio 不 spawn ffprobe，走到发送链路的用例一律用 .silk（voice-core 对 SILK
// 直接放行、不探测）；因此「真实时长/编码探测」分支不在本文件覆盖范围（属 voice-core）。
//
// 确定性：临时目录来自 mkdtemp，文件级 after 清理；fetch/processAudioVolume/cleanupTemp 全部注入。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createVoiceService } from '../src/domain/send/voice-service.mjs';

const jsonRes = (body, ok = true) => ({ ok, json: async () => body });

// 所有临时语音库都落在 os.tmpdir()，跑完统一删除。
const TEMP_DIRS = [];
after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

function addAudio(h, name = 'hello.silk', content = 'SILKDATA') {
  const p = path.join(h.dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function makeHarness(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-voice-'));
  TEMP_DIRS.push(root);
  const dir = path.join(root, 'audio');
  fs.mkdirSync(dir, { recursive: true });

  const st = {
    root,
    dir,
    cfg: { snowluma: { httpUrl: 'http://127.0.0.1:3000/' }, socialV2: { voice: {} } },
    sent: [],           // 所有 fetch 请求
    routes: {},         // pathname → (body) => res
    fetchThrows: null,
    logs: [],
    activity: [],
    audits: [],
    auditThrows: false,
    guardRequests: [],
    guards: [],
    guardThrows: false,
    cleaned: [],
    processed: [],
    enqueued: 0,
    saves: 0,
    v2: new Map(),
    processThrows: null,
    processPath: null,
    processConverted: false,
  };

  const getSocialV2State = (key) => {
    if (!st.v2.has(key)) {
      st.v2.set(key, {
        recentMessages: [],
        wakeConfig: { noActionCount: 3 },
        lastAiReplyAt: 0,
        lastActionAt: 0,
      });
    }
    return st.v2.get(key);
  };

  const base = {
    cfg: st.cfg,
    root,
    fetch: async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      st.sent.push({ url, method: init?.method, headers: init?.headers ?? {}, body, hasSignal: !!init?.signal });
      if (st.fetchThrows) throw new Error(st.fetchThrows);
      const p = new URL(url).pathname;
      if (st.routes[p]) return st.routes[p](body, url, init);
      if (p === '/get_msg') {
        return jsonRes({ status: 'ok', retcode: 0, data: { message: [{ type: 'record', data: { duration: 2 } }] } });
      }
      return jsonRes({ status: 'ok', retcode: 0, data: { message_id: 9527 } });
    },
    processAudioVolume: async (file, opts) => {
      st.processed.push({ file, opts });
      if (st.processThrows) throw new Error(st.processThrows);
      const normalize = opts?.normalize === true;
      const out = st.processPath ?? file;
      return {
        path: out,
        converted: st.processConverted,
        volume: opts?.volume ?? 1,
        loudness: normalize ? -16 : null,
        mode: normalize ? 'loudnorm' : ((opts?.volume ?? 1) === 1 ? 'original' : 'volume'),
        detail: normalize ? '智能音量' : '原始音量',
      };
    },
    cleanupTemp: (file, isTemp) => { st.cleaned.push([file, isTemp]); },
    log: (m) => { st.logs.push(String(m)); },
    appendActivity: (m) => { st.activity.push(String(m)); },
    shouldAuditKey: () => true,
    // knownAgentTokens 已从 createVoiceService 解构里删除（源码从未使用）。
    assertOutboundAuditOk: (key, subject) => {
      st.audits.push([key, subject]);
      if (st.auditThrows) throw new Error('审计拦截');
    },
    captureSendGuard: (key) => {
      st.guardRequests.push(key);
      return () => {
        st.guards.push(key);
        if (st.guardThrows) throw new Error('会话已切换');
      };
    },
    getOutgoing: () => ({
      enqueue: (task) => {
        st.enqueued += 1;
        return Promise.resolve().then(task);
      },
    }),
    oneBotError: (action, res, body) => `${action} 失败: ${body?.retcode ?? 'unknown'}`,
    getSocialV2State,
    saveSocialV2State: () => { st.saves += 1; },
    truncateText: (text, n) => String(text ?? '').slice(0, n),
  };

  const svc = createVoiceService({ ...base, ...overrides });
  return { svc, st, root, dir, getSocialV2State, cfg: overrides.cfg ?? st.cfg, depKeys: Object.keys(base) };
}

// ── 接线契约 ────────────────────────────────────────────────────────────────

test('接线契约：桩覆盖 createVoiceService 解构的每个 ctx 字段', () => {
  const src = fs.readFileSync(new URL('../src/domain/send/voice-service.mjs', import.meta.url), 'utf8');
  const block = /export function createVoiceService\(\{([\s\S]*?)\}\) \{/.exec(src);
  assert.ok(block, '没找到 createVoiceService 的解构块，测试需要同步更新');
  const names = block[1].split(',')
    .map((s) => s.split(':')[0].trim()) // 兼容 `fetch: fetchImpl` 这种重命名解构
    .filter(Boolean);
  const h = makeHarness();
  const missing = names.filter((name) => !h.depKeys.includes(name));
  assert.deepEqual(missing, [], `测试桩缺少依赖：${missing.join('、')}`);
  assert.deepEqual([...names].sort(), [...h.depKeys].sort(), '桩清单应与解构清单一致，避免悄悄多/少注入');
});

// ── voiceCfg ────────────────────────────────────────────────────────────────

test('voiceCfg：默认值完整（启用/库目录/体积时长上限/限流/音量/回读）', () => {
  const h = makeHarness();
  const vc = h.svc.voiceCfg();
  assert.equal(vc.enabled, true);
  assert.equal(vc.dir, path.join(h.root, 'audio'));
  assert.equal(vc.maxSeconds, 300);
  assert.equal(vc.maxBytes, 20 * 1024 * 1024);
  assert.equal(vc.maxPerMinute, 2);
  assert.equal(vc.maxPerHour, 10);
  assert.equal(vc.allowAbsolutePath, false);
  assert.equal(vc.defaultVolume, 1);
  assert.equal(vc.loudness, 'normal');
  assert.equal(vc.autoReadback, true);
});

test('voiceCfg：非法/缺省数值回落到默认值，0 表示明确关闭（限流）', () => {
  const h = makeHarness();
  h.cfg.socialV2.voice = {
    enabled: false,
    dir: 'voice-lib',
    maxSeconds: 0,
    maxBytes: -1,
    maxPerMinute: -2,
    maxPerHour: 0,
    allowAbsolutePath: true,
    defaultVolume: 0,
    loudness: 'loud',
    autoReadback: false,
  };
  const vc = h.svc.voiceCfg();
  assert.equal(vc.enabled, false);
  assert.equal(vc.dir, path.join(h.root, 'voice-lib'));
  assert.equal(vc.maxSeconds, 300, '0 秒无意义 → 回默认 300');
  assert.equal(vc.maxBytes, 20 * 1024 * 1024);
  assert.equal(vc.maxPerMinute, 2, '负数无意义 → 回默认 2');
  assert.equal(vc.maxPerHour, 0, '0 是合法值：不限');
  assert.equal(vc.allowAbsolutePath, true);
  assert.equal(vc.defaultVolume, 1);
  assert.equal(vc.loudness, 'loud');
  assert.equal(vc.autoReadback, false);

  h.cfg.socialV2.voice = { maxSeconds: 60, maxBytes: 1024, maxPerMinute: 0, maxPerHour: 5, defaultVolume: 2 };
  const vc2 = h.svc.voiceCfg();
  assert.equal(vc2.maxSeconds, 60);
  assert.equal(vc2.maxBytes, 1024);
  assert.equal(vc2.maxPerMinute, 0);
  assert.equal(vc2.maxPerHour, 5);
  assert.equal(vc2.defaultVolume, 2);
});

test('voiceCfg：cfg.socialV2 完全缺失时也给默认语音库，不抛', () => {
  const h = makeHarness({ cfg: { snowluma: { httpUrl: 'http://127.0.0.1:3000' } } });
  const vc = h.svc.voiceCfg();
  assert.equal(vc.enabled, true);
  assert.equal(vc.dir, path.join(h.root, 'audio'));
  assert.equal(vc.maxPerMinute, 2);
});

test('voiceCfg：绝对 dir 不被拼到 root 下；ffmpegPath 显式配置优先于环境变量', (t) => {
  const old = process.env.FFMPEG_PATH;
  t.after(() => {
    if (old === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = old;
  });
  const h = makeHarness();
  delete process.env.FFMPEG_PATH;
  const absDir = path.join(h.root, 'elsewhere');
  h.cfg.socialV2.voice = { dir: absDir, ffmpegPath: 'C:/ff/config.exe' };
  assert.equal(h.svc.voiceCfg().dir, absDir);
  assert.equal(h.svc.voiceCfg().ffmpegPath, 'C:/ff/config.exe');
  process.env.FFMPEG_PATH = 'C:/ff/env.exe';
  // config 是更具体的显式配置，环境变量只做兜底（voice-core.resolveFfmpeg 的文档口径）。
  assert.equal(h.svc.voiceCfg().ffmpegPath, 'C:/ff/config.exe');
  h.cfg.socialV2.voice = {};
  assert.equal(h.svc.voiceCfg().ffmpegPath, 'C:/ff/env.exe', '没有显式配置时才轮到环境变量');
  delete process.env.FFMPEG_PATH;
  assert.equal(h.svc.voiceCfg().ffmpegPath, null);
});

// ── voiceLibrary ────────────────────────────────────────────────────────────

test('voiceLibrary：递归列出音频、相对路径用 /、非音频/隐藏文件不入库', () => {
  const h = makeHarness();
  addAudio(h, 'b.mp3', 'x'.repeat(10));
  addAudio(h, 'a.wav', 'yyy');
  addAudio(h, path.join('sub', 'c.ogg'), 'z');
  fs.writeFileSync(path.join(h.dir, 'note.txt'), 't');
  fs.writeFileSync(path.join(h.dir, '.hidden.mp3'), 'h');
  const lib = h.svc.voiceLibrary();
  assert.deepEqual(lib.map((x) => x.name).sort(), ['a.wav', 'b.mp3', 'sub/c.ogg']);
  assert.equal(lib.find((x) => x.name === 'b.mp3').bytes, 10);
  assert.ok(lib.every((x) => x.mtimeMs > 0), '要带 mtime 供 GUI 排序');
});

test('voiceLibrary：语音库目录不存在时返回空数组（不抛）', () => {
  const h = makeHarness();
  h.cfg.socialV2.voice = { dir: path.join(h.root, 'nope') };
  assert.deepEqual(h.svc.voiceLibrary(), []);
});

// ── voicePathInsideLibrary ─────────────────────────────────────────────────

test('voicePathInsideLibrary：库内文件放行、库外/目录/不存在一律 null', () => {
  const h = makeHarness();
  const vc = h.svc.voiceCfg();
  const inside = addAudio(h, 'in.mp3', 'abc');
  const outside = path.join(h.root, 'out.mp3');
  fs.writeFileSync(outside, 'abc');
  assert.equal(h.svc.voicePathInsideLibrary(vc, inside), fs.realpathSync(inside));
  assert.equal(h.svc.voicePathInsideLibrary(vc, outside), null, '库外文件必须拒绝');
  assert.equal(h.svc.voicePathInsideLibrary(vc, h.dir), null, '目录本身不是音频');
  assert.equal(h.svc.voicePathInsideLibrary(vc, path.join(h.dir, 'missing.mp3')), null);
  assert.equal(h.svc.voicePathInsideLibrary(vc, path.join(h.dir, '..', 'out.mp3')), null, '.. 逃逸必须拒绝');
});

// ── resolveVoicePathForV2（AI 通道）────────────────────────────────────────

test('resolveVoicePathForV2：空引用、base64/data/http 来源直接拒绝', () => {
  const h = makeHarness();
  assert.throws(() => h.svc.resolveVoicePathForV2(''), /缺少音频/);
  assert.throws(() => h.svc.resolveVoicePathForV2('   '), /缺少音频/);
  assert.throws(() => h.svc.resolveVoicePathForV2(null), /缺少音频/);
  assert.throws(() => h.svc.resolveVoicePathForV2('base64://eA=='), /不接受 base64:\/\/、data: 或 http/);
  assert.throws(() => h.svc.resolveVoicePathForV2('data:audio/mpeg;base64,AAA'), /不接受/);
  assert.throws(() => h.svc.resolveVoicePathForV2('https://x/a.mp3'), /不接受/);
  assert.throws(() => h.svc.resolveVoicePathForV2('HTTP://x/a.mp3'), /不接受/);
});

test('resolveVoicePathForV2：库内相对路径（含省略扩展名）', () => {
  const h = makeHarness();
  const file = addAudio(h, 'hello.mp3', 'abc');
  const hit = h.svc.resolveVoicePathForV2('hello.mp3');
  assert.equal(hit.path, fs.realpathSync(file));
  assert.equal(hit.via, 'voice-dir-safe');
  assert.equal(hit.resolvedFrom, 'hello.mp3');

  const noExt = h.svc.resolveVoicePathForV2('hello');
  assert.equal(noExt.path, fs.realpathSync(file));
  assert.equal(noExt.via, 'voice-dir-safe+ext');
});

test('resolveVoicePathForV2：库内绝对路径/file:// 放行（但要过库内复核）', () => {
  const h = makeHarness();
  const file = addAudio(h, 'abs.mp3', 'abc');
  const byAbs = h.svc.resolveVoicePathForV2(file);
  assert.equal(byAbs.path, fs.realpathSync(file));
  assert.equal(byAbs.via, 'absolute+library-confined');
  const byUrl = h.svc.resolveVoicePathForV2(pathToFileURL(file).href);
  assert.equal(byUrl.path, fs.realpathSync(file));
  assert.equal(byUrl.via, 'file-url+library-confined');
});

test('resolveVoicePathForV2：库外绝对路径即使 allowAbsolutePath=true 也拒绝', () => {
  const h = makeHarness();
  const outside = path.join(h.root, 'secret.mp3');
  fs.writeFileSync(outside, 'abc');
  assert.throws(() => h.svc.resolveVoicePathForV2(outside), /语音只能从语音库取文件/);
  h.cfg.socialV2.voice = { allowAbsolutePath: true };
  assert.throws(() => h.svc.resolveVoicePathForV2(outside), /语音只能从语音库取文件/,
    'allowAbsolutePath 不得再放宽 AI 通道（防任意本地文件外发）');
});

test('resolveVoicePathForV2：路径穿越（.. / 子目录逃逸）明确报「已拒绝」', () => {
  const h = makeHarness();
  addAudio(h, 'ok.mp3', 'abc');
  assert.throws(() => h.svc.resolveVoicePathForV2('..\\..\\secret.mp3'), /路径里出现了「\.\.」/);
  assert.throws(() => h.svc.resolveVoicePathForV2('../secret.mp3'), /路径里出现了「\.\.」/);
  assert.throws(() => h.svc.resolveVoicePathForV2('sub/../../secret.mp3'), /路径里出现了「\.\.」/);
});

test('resolveVoicePathForV2：找不到时给出库内清单与近似匹配，且不回显绝对路径', () => {
  const h = makeHarness();
  addAudio(h, 'song.mp3', 'abc');
  addAudio(h, 'other.wav', 'abc');
  assert.throws(() => h.svc.resolveVoicePathForV2('song.ogg'), /语音库里找不到「song\.ogg」；近似匹配：song\.mp3/);
  assert.throws(() => h.svc.resolveVoicePathForV2('song.ogg'), /语音库里现有：/);
  assert.throws(() => h.svc.resolveVoicePathForV2('nope'), (err) => {
    assert.match(err.message, /语音库里找不到「nope」/);
    assert.ok(!err.message.includes(h.dir), '错误文案不得回显库的绝对路径');
    return true;
  });
});

test('resolveVoicePathForV2：空库提示「目前是空的」；超过 12 个只列前 12 个', () => {
  const empty = makeHarness();
  assert.throws(() => empty.svc.resolveVoicePathForV2('nope.mp3'), /目前是空的/);

  const many = makeHarness();
  for (let i = 1; i <= 13; i += 1) addAudio(many, `f${i}.mp3`, 'a');
  assert.throws(() => many.svc.resolveVoicePathForV2('nope.mp3'), /等 13 个/);
});

// ── resolveVoicePathForOperator（操作者通道）────────────────────────────────

test('resolveVoicePathForOperator：相对路径按语音库解析，绝对路径直接放行', () => {
  const h = makeHarness();
  const file = addAudio(h, 'hello.mp3', 'abc');
  const rel = h.svc.resolveVoicePathForOperator('hello.mp3');
  assert.equal(rel.path, path.resolve(file));
  assert.equal(rel.via, 'voice-dir');

  const noExt = h.svc.resolveVoicePathForOperator('hello');
  assert.equal(noExt.path, path.resolve(file));
  assert.equal(noExt.via, 'voice-dir+ext');

  const outside = path.join(h.root, 'outside.mp3');
  fs.writeFileSync(outside, 'abc');
  const abs = h.svc.resolveVoicePathForOperator(outside);
  assert.equal(abs.path, path.resolve(outside));
  assert.equal(abs.via, 'absolute');
});

test('resolveVoicePathForOperator：空/远程来源拒绝，找不到时报近似候选', () => {
  const h = makeHarness();
  addAudio(h, 'alpha.mp3', 'a');
  assert.throws(() => h.svc.resolveVoicePathForOperator(''), /缺少音频路径/);
  assert.throws(() => h.svc.resolveVoicePathForOperator('https://x/a.mp3'), /只接受本地文件/);
  assert.throws(() => h.svc.resolveVoicePathForOperator('data:audio/mpeg;base64,AA'), /只接受本地文件/);
  assert.throws(() => h.svc.resolveVoicePathForOperator('alpha.ogg'), /找不到音频「alpha\.ogg」；语音库近似匹配：alpha\.mp3/);
  assert.throws(() => h.svc.resolveVoicePathForOperator('nope.mp3'), /找不到音频「nope\.mp3」/);
});

// ── 限流 ────────────────────────────────────────────────────────────────────

test('voiceBudgetCheck：只检查不占额度；记账后才计入，超限给出可读错误', () => {
  const h = makeHarness();
  h.cfg.socialV2.voice = { maxPerMinute: 1, maxPerHour: 10 };
  const vc = h.svc.voiceCfg();
  // 未记账 → 连查两次都不该超限（失败/被审计拦下不吃配额）
  h.svc.voiceBudgetCheck('group:1', vc);
  h.svc.voiceBudgetCheck('group:1', vc);
  h.svc.voiceBudgetCommit('group:1');
  assert.throws(() => h.svc.voiceBudgetCheck('group:1', vc), /语音发送频率超限（每分钟最多 1 条）/);
  // 不同会话各自计数
  h.svc.voiceBudgetCheck('private:2', vc);
});

test('voiceBudgetCheck：小时窗口忽略旧时间戳，超小时上限才拦截', () => {
  const h = makeHarness();
  h.cfg.socialV2.voice = { maxPerMinute: 0, maxPerHour: 2 };
  const vc = h.svc.voiceCfg();
  const old = Date.now() - 2 * 3600 * 1000;
  for (let i = 0; i < 3; i += 1) h.svc.voiceBudgetCommit('group:1', old);
  h.svc.voiceBudgetCheck('group:1', vc); // 旧的不算
  h.svc.voiceBudgetCommit('group:1');
  h.svc.voiceBudgetCheck('group:1', vc); // 1 + 1 <= 2
  h.svc.voiceBudgetCommit('group:1');
  assert.throws(() => h.svc.voiceBudgetCheck('group:1', vc), /每小时最多 2 条/);
});

test('voiceBudgetCheck：上限 0 表示不限制', () => {
  const h = makeHarness();
  h.cfg.socialV2.voice = { maxPerMinute: 0, maxPerHour: 0 };
  const vc = h.svc.voiceCfg();
  for (let i = 0; i < 10; i += 1) h.svc.voiceBudgetCommit('group:1');
  h.svc.voiceBudgetCheck('group:1', vc);
});

// ── sendVoiceV2（底层发送）──────────────────────────────────────────────────

test('sendVoiceV2：群/私聊端点与 record 段、审计、返回值、临时文件清理', async () => {
  const h = makeHarness();
  const file = addAudio(h, 'hello.silk', 'SILKDATA');
  const out = await h.svc.sendVoiceV2('group:123', file);
  assert.deepEqual(h.st.audits, [['group:123', '[语音:hello.silk]']]);
  const req = h.st.sent[0];
  assert.equal(req.url, 'http://127.0.0.1:3000/send_group_msg');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['content-type'], 'application/json');
  assert.equal(req.headers.authorization, undefined, '未配 token 时不带鉴权头');
  assert.deepEqual(req.body, { group_id: 123, message: [{ type: 'record', data: { file } }] });
  assert.equal(req.hasSignal, true, '必须带超时 signal');
  assert.equal(out.messageId, 9527);
  assert.equal(out.bytes, 8);
  assert.equal(out.duration, null);
  assert.equal(out.codec, 'silk');
  assert.deepEqual(out.warnings, []);
  assert.equal(out.detail, '8 B · silk');
  assert.equal(out.audioProcessing, '原始音量');
  assert.equal(out.volume, 1);
  assert.equal(out.loudness, null);
  assert.equal(out.audioMode, 'original');
  assert.deepEqual(h.st.cleaned, [[file, false]], '未转码就不删源文件');
  assert.equal(h.st.enqueued, 1, '必须经统一发送队列');

  const priv = await h.svc.sendVoiceV2('private:222', file);
  const req2 = h.st.sent[1];
  assert.equal(req2.url, 'http://127.0.0.1:3000/send_private_msg');
  assert.deepEqual(req2.body, { user_id: 222, message: [{ type: 'record', data: { file } }] });
  assert.equal(priv.messageId, 9527);
});

test('sendVoiceV2：accessToken 注入 Bearer 头；音量参数透传给处理层', async () => {
  const h = makeHarness();
  h.cfg.snowluma.accessToken = 'tok';
  h.cfg.socialV2.voice = { defaultVolume: 2, loudness: 'loud' };
  const file = addAudio(h, 'v.silk', 'SILKDATA');
  const out = await h.svc.sendVoiceV2('group:1', file, { audio: { normalize: true, loudness: 'quiet' } });
  assert.equal(h.st.sent[0].headers.authorization, 'Bearer tok');
  assert.deepEqual(h.st.processed[0].opts, {
    volume: 2, normalize: true, loudness: 'quiet', ffmpegPath: null,
  });
  assert.equal(out.audioMode, 'loudnorm');
  assert.equal(out.loudness, -16);
});

test('sendVoiceV2：音量处理产物发完即删，源文件不删', async () => {
  const h = makeHarness();
  h.st.processPath = path.join(h.root, 'tmp', 'vol.wav');
  h.st.processConverted = true;
  const file = addAudio(h, 'v.silk', 'SILKDATA');
  await h.svc.sendVoiceV2('group:1', file, { audio: { volume: 3 } });
  assert.deepEqual(h.st.cleaned, [[h.st.processPath, true]]);
  assert.deepEqual(h.st.sent[0].body.message[0].data.file, h.st.processPath);
});

test('sendVoiceV2：guard=true 时发送前过 captureSendGuard，guard 失败不发请求', async () => {
  const h = makeHarness();
  const file = addAudio(h, 'g.silk', 'SILKDATA');
  await h.svc.sendVoiceV2('group:1', file, { guard: true });
  assert.deepEqual(h.st.guardRequests, ['group:1']);
  assert.deepEqual(h.st.guards, ['group:1']);
  assert.equal(h.st.sent.length, 1);

  h.st.guardThrows = true;
  await assert.rejects(() => h.svc.sendVoiceV2('group:1', file, { guard: true }), /会话已切换/);
  assert.equal(h.st.sent.length, 1, 'guard 抛错后不得再发');
  assert.equal(h.st.cleaned.length, 2, '失败也要清理处理产物');
});

test('sendVoiceV2：guard=false（操作者通道）不套会话闸门', async () => {
  const h = makeHarness();
  const file = addAudio(h, 'o.silk', 'SILKDATA');
  await h.svc.sendVoiceV2('group:1', file);
  assert.deepEqual(h.st.guardRequests, [], 'captureSendGuard 根本不该被调用');
  assert.deepEqual(h.st.guards, []);
});

test('sendVoiceV2：审计拦截先于一切（不发、不探测、不处理）', async () => {
  const h = makeHarness();
  h.st.auditThrows = true;
  const file = addAudio(h, 'a.silk', 'SILKDATA');
  await assert.rejects(() => h.svc.sendVoiceV2('group:1', file), /审计拦截/);
  assert.equal(h.st.sent.length, 0);
  assert.equal(h.st.enqueued, 0);
  assert.deepEqual(h.st.processed, []);
  assert.deepEqual(h.st.cleaned, []);
});

test('sendVoiceV2：音频不可发送的三种情形（不存在/空/超体积）', async () => {
  const h = makeHarness();
  await assert.rejects(() => h.svc.sendVoiceV2('group:1', path.join(h.dir, 'nope.silk')), /音频不可发送：文件不存在或不可读/);
  const empty = path.join(h.dir, 'empty.silk');
  fs.writeFileSync(empty, '');
  await assert.rejects(() => h.svc.sendVoiceV2('group:1', empty), /音频不可发送：文件为空/);
  h.cfg.socialV2.voice = { maxBytes: 1 };
  const file = addAudio(h, 'big.silk', 'SILKDATA');
  await assert.rejects(() => h.svc.sendVoiceV2('group:1', file), /音频不可发送：文件过大/);
  assert.equal(h.st.sent.length, 0);
});

test('sendVoiceV2：音量处理失败要说清楚，且不发请求', async () => {
  const h = makeHarness();
  h.st.processThrows = 'ffmpeg 炸了';
  const file = addAudio(h, 'p.silk', 'SILKDATA');
  await assert.rejects(() => h.svc.sendVoiceV2('group:1', file), /音量处理失败：ffmpeg 炸了/);
  assert.equal(h.st.sent.length, 0);
  assert.deepEqual(h.st.cleaned, [], '没有产物可删');
});

test('sendVoiceV2：网关非 ok / 坏 JSON / 网络异常都抛错并清理', async () => {
  const h = makeHarness();
  const file = addAudio(h, 'e.silk', 'SILKDATA');

  h.st.routes['/send_group_msg'] = () => jsonRes({ status: 'failed', retcode: 120 });
  await assert.rejects(() => h.svc.sendVoiceV2('group:1', file), /send_group_msg 失败: 120/);

  h.st.routes['/send_group_msg'] = () => ({ ok: true, json: async () => { throw new Error('bad json'); } });
  await assert.rejects(() => h.svc.sendVoiceV2('group:1', file), /send_group_msg 失败: unknown/);

  delete h.st.routes['/send_group_msg'];
  h.st.fetchThrows = '网络断了';
  await assert.rejects(() => h.svc.sendVoiceV2('group:1', file), /网络断了/);
  assert.equal(h.st.cleaned.length, 3, '每种失败都要清理');
});

test('sendVoiceV2：enabled=false 只关 AI 通道，底层仍可发（操作者/CLI 不能被封死）', async () => {
  const h = makeHarness();
  h.cfg.socialV2.voice = { enabled: false };
  const file = addAudio(h, 'x.silk', 'SILKDATA');
  const out = await h.svc.sendVoiceV2('group:1', file);
  assert.equal(out.messageId, 9527);
  assert.equal(h.st.sent.length, 1);
});

// ── recordVoiceSentV2 ──────────────────────────────────────────────────────

test('recordVoiceSentV2：写入自己发的消息、更新活跃时间、复位连续无动作计数', () => {
  const h = makeHarness();
  const st = h.getSocialV2State('group:1');
  h.svc.recordVoiceSentV2('group:1', { messageId: 9527, detail: '3 秒 · 8 B · silk' });
  assert.equal(st.recentMessages.length, 1);
  const entry = st.recentMessages[0];
  assert.equal(entry.messageId, '9527');
  assert.equal(entry.sender, '我');
  assert.equal(entry.ownerLabel, '我');
  assert.equal(entry.isSelf, true);
  assert.equal(entry.isOwner, false, '她自己发的不能标成主人发的');
  assert.equal(entry.quoteTargetIsSelf, false);
  assert.equal(entry.text, '[语音 3 秒 · 8 B · silk]');
  assert.equal(entry.plain, entry.text);
  assert.equal(typeof entry.at, 'number');
  assert.equal(st.lastAiReplyAt, entry.at);
  assert.equal(st.lastActionAt, entry.at);
  assert.equal(st.wakeConfig.noActionCount, 0);
  assert.equal(h.st.saves, 1);
});

test('recordVoiceSentV2：label 覆盖展示文案；超长截断；messageId 缺省为 null', () => {
  const h = makeHarness();
  h.svc.recordVoiceSentV2('group:1', { detail: 'x' }, '给你唱一段');
  const st = h.getSocialV2State('group:1');
  assert.equal(st.recentMessages[0].text, '给你唱一段');
  assert.equal(st.recentMessages[0].messageId, null);

  h.svc.recordVoiceSentV2('group:1', { detail: 'x' }, 'z'.repeat(500));
  assert.equal(st.recentMessages[1].text.length, 200);
});

test('recordVoiceSentV2：recentMessages 封顶 200 条，丢最旧留最新', () => {
  const h = makeHarness();
  const st = h.getSocialV2State('group:1');
  const old = Array.from({ length: 200 }, (_, i) => ({ text: `old-${i}`, sender: '我' }));
  st.recentMessages = old.slice();
  h.svc.recordVoiceSentV2('group:1', { messageId: 1, detail: 'd' });
  assert.equal(st.recentMessages.length, 200);
  assert.equal(st.recentMessages[0].text, 'old-1');
  assert.equal(st.recentMessages[199].messageId, '1');
});

// ── verifyVoiceMessageSent ─────────────────────────────────────────────────

test('verifyVoiceMessageSent：无 messageId 不发请求直接 null', async () => {
  const h = makeHarness();
  assert.equal(await h.svc.verifyVoiceMessageSent(null), null);
  assert.equal(await h.svc.verifyVoiceMessageSent(0), null);
  assert.equal(h.st.sent.length, 0);
});

test('verifyVoiceMessageSent：回读到 record 段才算确认，且不回传文件路径', async () => {
  const h = makeHarness();
  h.st.routes['/get_msg'] = () => jsonRes({
    status: 'ok',
    retcode: 0,
    data: { message: [{ type: 'record', data: { duration: 3, file: 'C:/secret/a.mp3', url: 'http://x/a.mp3' } }] },
  });
  const out = await h.svc.verifyVoiceMessageSent(9527);
  assert.deepEqual(out, { confirmed: true, duration: 3 });
  assert.deepEqual(Object.keys(out).sort(), ['confirmed', 'duration'], '绝不回传 file/url（防本机路径进模型上下文）');
  const req = h.st.sent[0];
  assert.equal(req.url, 'http://127.0.0.1:3000/get_msg');
  assert.deepEqual(req.body, { message_id: 9527 });
});

test('verifyVoiceMessageSent：无 record 段/非 ok/坏 JSON 都返回 null（不影响已发送事实）', async () => {
  const h = makeHarness();
  h.st.routes['/get_msg'] = () => jsonRes({ status: 'ok', retcode: 0, data: { message: [{ type: 'text', data: { text: 'x' } }] } });
  assert.equal(await h.svc.verifyVoiceMessageSent(1), null);

  h.st.routes['/get_msg'] = () => jsonRes({ status: 'failed', retcode: 100 });
  assert.equal(await h.svc.verifyVoiceMessageSent(1), null);

  h.st.routes['/get_msg'] = () => ({ ok: false, json: async () => ({ status: 'ok', retcode: 0 }) });
  assert.equal(await h.svc.verifyVoiceMessageSent(1), null);

  h.st.routes['/get_msg'] = () => ({ ok: true, json: async () => { throw new Error('bad json'); } });
  assert.equal(await h.svc.verifyVoiceMessageSent(1), null);
});

test('verifyVoiceMessageSent：duration 缺失给 null；网络异常记日志并返回 null', async () => {
  const h = makeHarness();
  h.st.routes['/get_msg'] = () => jsonRes({ status: 'ok', retcode: 0, data: { message: [{ type: 'record', data: {} }] } });
  assert.deepEqual(await h.svc.verifyVoiceMessageSent(1), { confirmed: true, duration: null });

  h.st.fetchThrows = 'get_msg 挂了';
  assert.equal(await h.svc.verifyVoiceMessageSent(2), null);
  assert.ok(h.st.logs.some((l) => l.includes('回读校验失败')), '要留下日志');
});

// ── sendVoiceForV2（AI 通道）──────────────────────────────────────────────

test('sendVoiceForV2：enabled=false 直接关闭 AI 通道', async () => {
  const h = makeHarness();
  h.cfg.socialV2.voice = { enabled: false };
  await assert.rejects(() => h.svc.sendVoiceForV2('group:1', 'hello.mp3'), /语音功能已关闭/);
  assert.equal(h.st.sent.length, 0);
});

test('sendVoiceForV2：路径错误在限流/发送之前抛，不吃配额', async () => {
  const h = makeHarness();
  h.cfg.socialV2.voice = { maxPerMinute: 1 };
  await assert.rejects(() => h.svc.sendVoiceForV2('group:1', 'missing.mp3'), /语音库里找不到/);
  assert.equal(h.st.sent.length, 0);
  assert.deepEqual(h.st.audits, []);
});

test('sendVoiceForV2：音量参数前置校验（倍数越界/档位未知）', async () => {
  const h = makeHarness();
  addAudio(h, 'hello.mp3', 'abc');
  await assert.rejects(
    () => h.svc.sendVoiceForV2('group:1', 'hello.mp3', { audio: { volume: 99 } }),
    /音量倍数需在 0\.1~4 之间/,
  );
  await assert.rejects(
    () => h.svc.sendVoiceForV2('group:1', 'hello.mp3', { audio: { normalize: true, loudness: 'max' } }),
    /未知的响度档位「max」/,
  );
  await assert.rejects(
    () => h.svc.sendVoiceForV2('group:1', 'hello.mp3', { audio: { volume: 'abc' } }),
    /音量必须是数字/,
  );
  assert.equal(h.st.sent.length, 0);
  assert.deepEqual(h.st.processed, [], '参数错不该走到 ffmpeg');
});

test('sendVoiceForV2：限流超限时不发请求', async () => {
  const h = makeHarness();
  h.cfg.socialV2.voice = { maxPerMinute: 1 };
  addAudio(h, 'hello.mp3', 'abc');
  h.svc.voiceBudgetCommit('group:1');
  await assert.rejects(() => h.svc.sendVoiceForV2('group:1', 'hello.mp3'), /每分钟最多 1 条/);
  assert.equal(h.st.sent.length, 0);
  assert.deepEqual(h.st.audits, []);
});

// 下面的用例一律用 .silk：voice-core 的 inspectAudio 对 SILK 直接放行、不调 ffprobe，
// 这样测试绝不会启动外部进程（.mp3 会走 probeAudio → spawn ffprobe，确定性会被机器环境影响）。
test('sendVoiceForV2：成功链路 —— 解析→发送→记账→写会话→日志，默认回读 record', async () => {
  const h = makeHarness();
  const file = addAudio(h, 'hello.silk', 'abc');
  const out = await h.svc.sendVoiceForV2('group:123', 'hello.silk');
  assert.equal(out.messageId, 9527);
  assert.equal(out.key, 'group:123');
  assert.equal(out.file, fs.realpathSync(file));
  assert.equal(out.via, 'voice-dir-safe');
  assert.deepEqual(out.verification, { confirmed: true, duration: 2 }, 'autoReadback 默认开启');
  assert.equal(out.readback, null);
  assert.deepEqual(h.st.sent.map((r) => new URL(r.url).pathname), ['/send_group_msg', '/get_msg']);

  const st = h.getSocialV2State('group:123');
  assert.equal(st.recentMessages.length, 1, '要写进二代会话，AI 才知道自己刚发过语音');
  assert.equal(st.recentMessages[0].isSelf, true);
  assert.ok(st.recentMessages[0].text.startsWith('[语音 '));
  assert.ok(h.st.logs.some((l) => l.includes('[voice]') && l.includes('hello.silk')));
  assert.ok(h.st.activity.some((l) => l.includes('发送语音 hello.silk')));
});

test('sendVoiceForV2：verify=false 不读回；verify=true 强制读回', async () => {
  const h = makeHarness();
  addAudio(h, 'hello.silk', 'abc');
  const noVerify = await h.svc.sendVoiceForV2('group:1', 'hello.silk', { verify: false });
  assert.equal(noVerify.verification, null);
  assert.deepEqual(h.st.sent.map((r) => new URL(r.url).pathname), ['/send_group_msg']);

  const forced = await h.svc.sendVoiceForV2('group:1', 'hello.silk', { verify: true });
  assert.deepEqual(forced.verification, { confirmed: true, duration: 2 });
  // 第一次 verify:false → 只有发送；第二次 verify:true → 发送 + 读回
  assert.deepEqual(h.st.sent.map((r) => new URL(r.url).pathname), ['/send_group_msg', '/send_group_msg', '/get_msg']);
});

test('sendVoiceForV2：autoReadback=false 默认不读回，显式 verify 仍可读', async () => {
  const h = makeHarness();
  h.cfg.socialV2.voice = { autoReadback: false };
  addAudio(h, 'hello.silk', 'abc');
  const out = await h.svc.sendVoiceForV2('group:1', 'hello.silk');
  assert.equal(out.verification, null);
  assert.equal(h.st.sent.length, 1);
  const forced = await h.svc.sendVoiceForV2('group:1', 'hello.silk', { verify: true });
  assert.deepEqual(forced.verification, { confirmed: true, duration: 2 });
  assert.equal(h.st.sent.length, 3);
});

test('sendVoiceForV2：readback=true 拉转写文本；转写失败不影响「已发送」', async () => {
  const h = makeHarness();
  h.cfg.socialV2.voice = { maxPerMinute: 0 }; // 本用例连发 3 条，先关掉限流，专测回读
  addAudio(h, 'hello.silk', 'abc');
  h.st.routes['/fetch_ptt_text'] = () => jsonRes({ status: 'ok', retcode: 0, data: { text: '转写文本' } });
  const out = await h.svc.sendVoiceForV2('group:1', 'hello.silk', { readback: true, verify: false });
  assert.equal(out.readback, '转写文本');
  const ptt = h.st.sent.find((r) => r.url.endsWith('/fetch_ptt_text'));
  assert.deepEqual(ptt.body, { message_id: '9527' }, '转写接口要字符串 id');

  h.st.routes['/fetch_ptt_text'] = () => { throw new Error('转写服务挂了'); };
  const out2 = await h.svc.sendVoiceForV2('group:1', 'hello.silk', { readback: true, verify: false });
  assert.equal(out2.readback, null);
  assert.equal(out2.messageId, 9527);
  assert.ok(h.st.logs.some((l) => l.includes('语音转写回读失败')));

  h.st.routes['/fetch_ptt_text'] = () => jsonRes({ status: 'ok', retcode: 0, data: {} });
  const out3 = await h.svc.sendVoiceForV2('group:1', 'hello.silk', { readback: true, verify: false });
  assert.equal(out3.readback, '', '接口成功但没有 text → 空串，不是 null');
});

test('sendVoiceForV2：网关没给 messageId 时不做回读/校验请求', async () => {
  const h = makeHarness();
  addAudio(h, 'hello.silk', 'abc');
  h.st.routes['/send_group_msg'] = () => jsonRes({ status: 'ok', retcode: 0, data: {} });
  const out = await h.svc.sendVoiceForV2('group:1', 'hello.silk', { readback: true, verify: true });
  assert.equal(out.messageId, null);
  assert.equal(out.verification, null);
  assert.equal(out.readback, null);
  assert.deepEqual(h.st.sent.map((r) => new URL(r.url).pathname), ['/send_group_msg']);
});

test('sendVoiceForV2：发送失败不吃配额（改好后下一次仍能发）', async () => {
  const h = makeHarness();
  h.cfg.socialV2.voice = { maxPerMinute: 1 };
  addAudio(h, 'hello.silk', 'abc');
  h.st.routes['/send_group_msg'] = () => jsonRes({ status: 'failed', retcode: 500 });
  await assert.rejects(() => h.svc.sendVoiceForV2('group:1', 'hello.silk'), /send_group_msg 失败: 500/);
  delete h.st.routes['/send_group_msg'];
  const ok = await h.svc.sendVoiceForV2('group:1', 'hello.silk');
  assert.equal(ok.messageId, 9527);
  // 成功后记账 → 第二条被限流
  await assert.rejects(() => h.svc.sendVoiceForV2('group:1', 'hello.silk'), /每分钟最多 1 条/);
});

test('sendVoiceForV2：guard 失败不记账；回读异常返回 null 但语音照样算发出', async () => {
  const h = makeHarness();
  h.cfg.socialV2.voice = { maxPerMinute: 1 };
  addAudio(h, 'hello.silk', 'abc');
  h.st.guardThrows = true;
  await assert.rejects(() => h.svc.sendVoiceForV2('group:1', 'hello.silk'), /会话已切换/);
  h.st.guardThrows = false;
  h.st.routes['/get_msg'] = () => { throw new Error('get_msg 挂了'); };
  const out = await h.svc.sendVoiceForV2('group:1', 'hello.silk');
  assert.equal(out.verification, null);
  assert.equal(out.messageId, 9527);
  assert.ok(h.st.logs.some((l) => l.includes('发送后回读校验失败')));
});
