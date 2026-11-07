import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// probe-skill-phase-a.mjs · 技能版本化 Phase A 的端到端探针（临时数据，不碰真实 skills.json）
import fs from 'node:fs';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-phase-a-'));
const skillsFile = path.join(tmp, 'skills.json');
const evidence = path.join(tmp, 'evidence.txt');
fs.writeFileSync(evidence, 'ok', 'utf8');
fs.writeFileSync(skillsFile, JSON.stringify({
  version: 1,
  items: [{
    id: 's-test', name: 'PhaseA 测试技能', desc: 'd', steps: ['a'],
    verify: `文件:${evidence}`, tags: [], success: 0, fail: 0, attempts: 0,
    confidence: 0.5, mastery: 0, version: 1, hints: [], history: [],
  }],
}), 'utf8');

const client = new Client({ name: 'skill-phase-a-probe', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, "/ai-companion-kit/packages/memory-mcp/src/memory-mcp.js")],
  env: { ...process.env, SKILLS_FILE: skillsFile, MEMORY_DIR: path.join(tmp, 'memory') },
}));
const txt = (r) => (r.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join(' ');
const catalog = (args) => client.callTool({ name: 'memory_tools', arguments: args }).then(txt);

console.log('RECORD →', (await catalog({ tool: 'skill_record', arguments: { id: 's-test', ok: true, version: 1 } })).slice(0, 300));
console.log('VERIFY →', (await catalog({ tool: 'skill_verify', arguments: { id: 's-test' } })).slice(0, 300));
console.log('HISTORY →', (await catalog({ tool: 'skill_history', arguments: { id: 's-test' } })).slice(0, 500));
console.log('OLD VERSION →', (await catalog({ tool: 'skill_record', arguments: { id: 's-test', ok: true, version: 99 } })).slice(0, 300));
await client.close();
fs.rmSync(tmp, { recursive: true, force: true });
