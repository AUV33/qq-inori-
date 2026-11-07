// 只读现场诊断：各会话未读水位 + 日志尾部（原 scripts/_snap.mjs，2026-10-27 迁入 diagnostics/）
import fs from 'node:fs';
import { bridgePath } from '../../src/domain/shared/project-paths.js';

const j = JSON.parse(fs.readFileSync(bridgePath('state', 'social-v2.json'), 'utf8'));
for (const [k, v] of Object.entries(j.conversations)) {
  console.log(k, 'unread=', (v.unread || []).length, 'lastIn=', v.lastIncomingAt ? new Date(v.lastIncomingAt).toLocaleTimeString('sv-SE', { hour12: false }) : '-');
}
const raw = fs.readFileSync(bridgePath('state', 'bridge.log'), 'utf8').trim().split('\n');
console.log('日志尾部:', raw.slice(-3).join(' | '));
