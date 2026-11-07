// [M4] 单回复内并行多任务调度器。
// 把一次回复里她决定并行做的事拆成「任务单元」，每个单元获得独立命名空间（scope），
// 并发执行、统一汇聚。任务单元之间只通过显式输入/结果通信，不共享可变状态。
// 配合 M2 的 scope() 可实现「任务态物理隔离」；配合 M5 的失败域可实现「单单元崩不影响其他」。
//
// 任务单元签名：run(ctx) => Promise<result>，其中 ctx = { id, index, scope }。
// scope 由调用方通过 scopeFactory 注入（如 stateStore.scope(id)）；不传则 ctx.scope = null，
// 单元自行管理自己的临时状态。这样调度器保持「与持久化实现无关」，便于单测与真实接入复用。
//
// 选项：
//   scopeFactory(id) -> 该单元的独立状态命名空间对象
//   propagate=false（默认）：单单元抛错不阻断其他单元，结果里每项标记 ok/error，便于上层做「部分成功」合成
//   propagate=true：任一单元抛错则 runParallel 整体 reject（严格模式）
export async function runParallel(tasks, options = {}) {
  const { scopeFactory = null, propagate = false } = options;
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  const results = new Array(tasks.length);
  await Promise.all(tasks.map((task, index) => {
    const id = task && task.id != null ? String(task.id) : `task:${index}`;
    const scope = scopeFactory ? scopeFactory(id) : null;
    const ctx = { id, index, scope };
    return Promise.resolve()
      .then(() => task.run(ctx))
      .then((value) => { results[index] = { id, index, ok: true, value }; })
      .catch((error) => {
        results[index] = { id, index, ok: false, error };
        if (propagate) throw error;
      });
  }));
  return results;
}

// 汇聚助手：从 runParallel 的结果里按顺序取出成功单元的值（失败项置 undefined）。
export function collectValues(results) {
  return Array.isArray(results) ? results.map((r) => (r && r.ok ? r.value : undefined)) : [];
}
