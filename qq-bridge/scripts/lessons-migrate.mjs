#!/usr/bin/env node
// lessons-migrate.mjs · 宪章 S5b：旧三账（lessons / cognition / insights）→ lessons-ledger 候选
//
// 用法：
//   node scripts/lessons-migrate.mjs            # 只报告（默认 dry-run）
//   node scripts/lessons-migrate.mjs --apply    # 真正追加缺失候选（append-only，不改旧账）
//   node scripts/lessons-migrate.mjs --json     # 机器读
//   node scripts/lessons-migrate.mjs --limit=200
//
// 幂等：按 legacyId / 归一化 rule 去重；重复运行不会重复追加。
// 不做什么：不改/不删旧账；不做语义合并；不替她裁决。
import fs from 'node:fs';
import { obsPaths } from './lib/observability-paths.mjs';
import { createLessonsLedger, legacyCandidates, mergeLegacyCandidates } from '../src/domain/mind/lessons-ledger.mjs';

function readJsonl(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const rows = [];
    let corrupt = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { corrupt += 1; }
    }
    return { rows, corrupt, exists: true };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { rows: [], corrupt: 0, exists: false };
    throw error;
  }
}

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const limitArg = args.find((a) => a.startsWith('--limit='));
const parsedLimit = limitArg ? Number(limitArg.slice('--limit='.length)) : 0;
const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 0;

const paths = obsPaths();
const legacy = {
  lessons: readJsonl(paths.lessons),
  cognition: readJsonl(paths.cognition),
  insights: readJsonl(paths.insights),
};
const converted = legacyCandidates({
  lessons: legacy.lessons.rows,
  cognition: legacy.cognition.rows,
  insights: legacy.insights.rows,
}, { now: Date.now() });
const candidates = limit > 0 ? converted.candidates.slice(0, limit) : converted.candidates;

const ledger = createLessonsLedger({ file: paths.lessonsLedger });
const existing = await ledger.readAll();
const merged = mergeLegacyCandidates(existing.rows, candidates);

let appended = 0;
if (has('--apply')) {
  for (const candidate of merged.fresh) {
    await ledger.appendEvent(candidate, { writer: 'digest' });
    appended += 1;
  }
}

const body = {
  apply: has('--apply'),
  source: {
    lessons: { path: paths.lessons, exists: legacy.lessons.exists, rows: legacy.lessons.rows.length, corrupt: legacy.lessons.corrupt },
    cognition: { path: paths.cognition, exists: legacy.cognition.exists, rows: legacy.cognition.rows.length, corrupt: legacy.cognition.corrupt },
    insights: { path: paths.insights, exists: legacy.insights.exists, rows: legacy.insights.rows.length, corrupt: legacy.insights.corrupt },
  },
  converted: converted.candidates.length,
  bySource: converted.bySource,
  skipped: converted.skipped,
  duplicates: merged.duplicates.length,
  fresh: merged.fresh.length,
  appended,
  ledger: { path: paths.lessonsLedger, events: existing.rows.length + appended, corrupt: existing.corrupt.length },
};

if (has('--json')) {
  process.stdout.write(JSON.stringify(body, null, 2) + '\n');
} else {
  process.stdout.write(`旧账 → 教训账：lessons ${legacy.lessons.rows.length} / cognition ${legacy.cognition.rows.length} / insights ${legacy.insights.rows.length}\n`);
  process.stdout.write(`转换 ${body.converted} 条（跳过 ${body.skipped}），去重后待写入 ${body.fresh} 条（重复 ${body.duplicates}）\n`);
  process.stdout.write(has('--apply') ? `已追加 ${appended} 条（append-only，旧账未改）\n` : 'dry-run：加 --apply 才写入\n');
}

if (has('--apply') && appended < merged.fresh.length) process.exit(1);
