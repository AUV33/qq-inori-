// verify-agency-markers.mjs · 统计 MCP/桥接日志里她各类自主动作的痕迹
import fs from 'node:fs';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';
const base = `${PROJECT_ROOT}/qq-bridge/state/`;
const read = (f) => { try { return fs.readFileSync(base + f, 'utf8'); } catch { return ''; } };
const dsh = read('dshweb-console-err.log') + '\n' + read('dshweb-console.log');
const bridge = read('bridge.log') + '\n' + read('bridge.log.1') + '\n' + read('bridge.log.2');

const countIn = (text, needle) => text.split(needle).length - 1;
const dshMarks = ['phone_look', 'phone_dump', 'phone_tap', 'phone_open_app', 'qzone_', 'video_feed', 'video_watch', 'watch_video', 'qq_workshop', 'qq_self_wake', 'qq_wish', 'qq_curiosity', 'qq_set_own_life_rhythm', 'adjust_wall', 'gate_tune', 'tool_boundary', 'qq_slang_judge', 'qq_group_'];
console.log('=== MCP 侧痕迹（DSH 控制台日志）===');
for (const m of dshMarks) console.log(String(countIn(dsh, m)).padStart(5), m);

const bridgeMarks = ['[thoughts]', '[own-life]', '[wish]', '[selfWake]', '[curiosity]', '[workshop', '[slang-judge]', '[group-admin]', '[task-pool] 开跑', '[join]'];
console.log('\n=== 桥接日志痕迹 ===');
for (const m of bridgeMarks) console.log(String(countIn(bridge, m)).padStart(5), m);

// 她的发言：工具统一发送 + 各类 key
console.log('\n=== 她的发言（工具统一发送）===');
console.log(String(countIn(bridge, '工具统一发送')).padStart(5), 'total');
