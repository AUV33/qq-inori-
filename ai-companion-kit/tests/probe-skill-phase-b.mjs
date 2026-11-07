import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// probe-skill-phase-b.mjs · Phase B 工具端到端（临时 skills.json，不碰真实库）
import fs from 'node:fs';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-phase-b-'));
const skillsFile = path.join(tmp, 'skills.json');
const base = (id, name, step) => ({
  id, name, desc: 'd', steps: [step], verify: '', tags: [], success: 0, fail: 0,
  attempts: 0, confidence: 0.5, mastery: 0, version: 1, hints: [], history: [],
});
fs.writeFileSync(skillsFile, JSON.stringify({ version: 1, items: [base('s-a', '技能 A', '旧步骤'), base('s-b', '技能 B', 'B 步骤')] }), 'utf8');

const client = new Client({ name: 'skill-phase-b-probe', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, "/ai-companion-kit/packages/memory-mcp/src/memory-mcp.js")],
  env: { ...process.env, SKILLS_FILE: skillsFile, MEMORY_DIR: path.join(tmp, 'memory') },
}));
const txt = (r) => (r.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join(' ');
const call = (tool, args) => client.callTool({ name: 'memory_tools', arguments: { tool, arguments: args } }).then(txt);

console.log('REVISE →', (await call('skill_revise', { id: 's-a', steps: ['新步骤'], reason: '上次卡住' })).slice(0, 250));
console.log('HISTORY →', (await call('skill_history', { id: 's-a' })).slice(0, 400));
console.log('ROLLBACK →', (await call('skill_rollback', { id: 's-a', version: 1 })).slice(0, 250));
console.log('MERGE →', (await call('skill_merge', { sourceId: 's-b', targetId: 's-a', reason: '同名同类' })).slice(0, 250));
await client.close();
fs.rmSync(tmp, { recursive: true, force: true });
