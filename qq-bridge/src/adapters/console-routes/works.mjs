// [SPLIT 第二批] 分身工作台（works），从 console-server.mjs (3347–3411) 迁出。
//
// 与 roles 组的差别：这组请求可能带 x-agent-token（AI 侧工具），因此分支体用到
// agentTokenOk 与 v2SessionAllowed 两个闭包函数。迁移时在 handle 开头从 ctx 显式解构：
//   · agentTokenOk ← ctx.auth（createConsoleAuth 的返回对象）
//   · v2SessionAllowed ← deps.isSessionAllowedInCurrentMode（原闭包就是它的别名）
// 这样分支体仍能逐字保留，鉴权语义不变。
export const workRoutes = [
  {
    method: 'GET',
    path: '/api/works/list',
    handle: async ({ req, url, sendJson, deps, auth }) => {
      const { agentTokenOk } = auth;
      const key = String(url.searchParams.get('key') ?? '').trim();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (deps.cfg.socialV2?.tools?.works === false) { sendJson({ ok: false, error: '工具未启用：work_*' }, 403); return; }
      const active = deps.activeWorks(deps.worksStore);
      sendJson({
        ok: true,
        running: deps.runningWorks(deps.worksStore).length,
        queued: deps.queuedWorks(deps.worksStore).length,
        works: active.map((w) => ({
          id: w.id, title: w.title, status: w.status, updatedAt: w.updatedAt,
          lastNote: Array.isArray(w.progress) && w.progress.length ? w.progress[w.progress.length - 1].note : '',
        })),
      });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/works/start',
    handle: async ({ req, sendJson, readBody, deps, auth }) => {
      const { agentTokenOk } = auth;
      const v2SessionAllowed = deps.isSessionAllowedInCurrentMode;
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (deps.cfg.socialV2?.tools?.works === false) { sendJson({ ok: false, error: '工具未启用：work_*' }, 403); return; }
      try {
        const work = await deps.startWork({ title: body.title, goal: body.goal, acceptance: body.acceptance, reportTo: body.reportTo, intentionId: body.intentionId });
        sendJson({ ok: true, work: { id: work.id, title: work.title, status: work.status, taskId: work.taskId }, hint: '分身开工了；进度会回到你这边的唤醒里，也可以 work_peek 随时看。' });
      } catch (error) { sendJson({ ok: false, error: `开工失败：${error?.message ?? error}` }, 500); }
      return;
    },
  },
  {
    method: 'GET',
    path: '/api/works/peek',
    handle: async ({ req, url, sendJson, deps, auth }) => {
      const { agentTokenOk } = auth;
      const key = String(url.searchParams.get('key') ?? '').trim();
      const id = String(url.searchParams.get('id') ?? '').trim();
      if (!key || !id) { sendJson({ ok: false, error: 'key/id 不能为空' }, 400); return; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      const w = deps.findWork(deps.worksStore, id);
      if (!w) { sendJson({ ok: false, error: '没有这件活（work_list 看现有 id）' }, 404); return; }
      sendJson({ ok: true, work: w });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/works/update',
    handle: async ({ req, sendJson, readBody, deps, auth }) => {
      const { agentTokenOk } = auth;
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const id = String(body.id ?? '').trim();
      if (!key || !id) { sendJson({ ok: false, error: 'key/id 不能为空' }, 400); return; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      const status = String(body.status ?? '').trim() || deps.WORK_STATUS.RUNNING;
      const note = String(body.note ?? '');
      const w = deps.updateWorkById(id, (cur) => deps.setWorkStatus(cur, status, Date.now(), note));
      if (!w) { sendJson({ ok: false, error: '没有这件活' }, 404); return; }
      sendJson({ ok: true, work: { id: w.id, title: w.title, status: w.status, updatedAt: w.updatedAt } });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/works/note',
    handle: async ({ req, sendJson, readBody, deps, auth }) => {
      const { agentTokenOk } = auth;
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const id = String(body.id ?? '').trim();
      if (!key || !id) { sendJson({ ok: false, error: 'key/id 不能为空' }, 400); return; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      const w = deps.updateWorkById(id, (cur) => deps.addProgress(cur, String(body.note ?? '')));
      if (!w) { sendJson({ ok: false, error: '没有这件活' }, 404); return; }
      sendJson({ ok: true, work: { id: w.id, title: w.title, status: w.status } });
      return;
    },
  },
];
