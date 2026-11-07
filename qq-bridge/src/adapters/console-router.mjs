// [SPLIT 阶段3] 最小 method + pathname 路由器。
//
// 背景：console-server.mjs 原来把 180 个路由写成一条 5400 行的 if-else ladder，
// 路由顺序就是匹配优先级，任何新增/迁移都只能整文件改、整文件回滚。
//
// 这个路由器是**渐进迁移**的接缝，不是一次性重写：
//   · 已迁出的路由注册到路由表，由 match() 精确命中；
//   · 未命中返回 null，调用方继续走 legacy ladder —— 因此优先级与行为完全不变；
//   · 后续每迁一组路由，只需往 createConsoleRouter([...]) 加一个数组并删掉 ladder 里对应分支。
//
// 设计约束（世界级标准下不可退让的几条）：
//   · key 含 method，同一 path 的 GET/POST 是两个独立条目；
//   · 重复注册直接抛错（fail fast），绝不静默覆盖——静默覆盖会让"我改了但没生效"变成幽灵 bug；
//   · 精确匹配，不做模糊/前缀匹配，避免意外截获 legacy 路由。
export function createConsoleRouter(routeGroups = []) {
  const table = new Map();

  for (const group of routeGroups) {
    if (!group) continue;
    for (const route of group) {
      if (!route || typeof route.method !== 'string' || typeof route.path !== 'string' || typeof route.handle !== 'function') {
        throw new Error('console-router: 路由条目必须有 { method, path, handle }');
      }
      const key = `${route.method.toUpperCase()} ${route.path}`;
      if (table.has(key)) {
        throw new Error(`console-router: 路由重复注册：${key}（拒绝静默覆盖）`);
      }
      table.set(key, route.handle);
    }
  }

  return {
    /** @returns {((ctx: object) => unknown) | null} */
    match(method, pathname) {
      return table.get(`${String(method ?? '').toUpperCase()} ${pathname}`) ?? null;
    },
    /** 已注册条目数（供启动日志/测试断言） */
    get size() { return table.size; },
    /** 已注册 key 列表（便于审计与迁移进度核对） */
    keys() { return [...table.keys()]; },
  };
}
