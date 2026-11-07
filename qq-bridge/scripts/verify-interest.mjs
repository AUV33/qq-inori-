// verify-interest.mjs · 兴趣/好奇模块核对：机制 + 数据 + 断点
import fs from 'node:fs';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';
const B = `${PROJECT_ROOT}/qq-bridge/`;
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const logs = ['bridge.log', 'bridge.log.1', 'bridge.log.2'].map((f) => read(B + 'state/' + f)).join('\n');
const count = (s, m) => s.split(m).length - 1;

console.log('=== 1. 模块文件 ===');
for (const f of ['src/domain/leaves/inori-curiosity.js', 'src/inori-wish.js', 'src/domain/leaves/inori-gloss.js', 'src/inori-autonomy.js', 'src/inori-ownlife.js']) {
  console.log(fs.existsSync(B + f) ? 'OK  ' + f : 'MISS ' + f);
}

console.log('\n=== 2. 数据现状 ===');
for (const p of ['state/curiosity.json', 'state/wishes.json', 'data/state/thought-goals.jsonl']) {
  const t = read(B + p);
  if (!t) { console.log(p, '(不存在或空)'); continue; }
  try {
    const j = JSON.parse(t);
    const loops = Array.isArray(j.loops) ? j.loops : [];
    const items = Array.isArray(j.items) ? j.items : [];
    console.log(p, `loops=${loops.length} items=${items.length}`);
  } catch { console.log(p, '存在但无法解析'); }
}

console.log('\n=== 3. 日志痕迹（近两天） ===');
for (const m of ['[curiosity-seed]', '[interest]', '[wish', '[WISH', 'qq_curiosity', 'qq_wish', 'video_feed', 'watch_video', 'qzone', 'web_search', 'web_fetch']) {
  console.log(String(count(logs, m)).padStart(5), m);
}

console.log('\n=== 4. 关键接线（代码） ===');
const bridge = read(B + 'src/bridge.js');
const checks = {
  '好奇容器写入端点 /api/socialV2/curiosity': bridge.includes("url.pathname === '/api/socialV2/curiosity'"),
  '好奇种子 seedCuriosityFromChat': bridge.includes('seedCuriosityFromChat'),
  '好奇刺激充电 [P1] appendToolLog 钩子': bridge.includes("[P1]") && bridge.includes('web_search|web_fetch|video_feed'),
  '愿望端点 /api/socialV2/wish': bridge.includes("url.pathname === '/api/socialV2/wish'"),
  '到点愿望扫描 wishScanTimer': bridge.includes('wishScanTimer'),
  '唤醒注入兴趣容器 [INTEREST]': bridge.includes('[INTEREST]'),
  'own-life 挂好奇清单/愿望': bridge.includes('curiosityLoops:') && bridge.includes('renderWishLine'),
};
for (const [k, v] of Object.entries(checks)) console.log(v ? 'WIRED ' : 'MISS  ', k);

const life = read(B + 'src/inori-lifestate.js');
console.log('\n=== 5. curiosity 生理量 ===');
console.log('lifestate 含 curiosity 字段:', /curiosity/.test(life));
console.log('renderCuriosityDrive 存在:', /export function renderCuriosityDrive/.test(life));
