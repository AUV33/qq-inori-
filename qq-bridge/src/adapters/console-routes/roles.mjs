// [SPLIT 第二批] 人格管理 / 角色切换，从 console-server.mjs (320–449) 迁出。
//
// 契约同 read-only.mjs：{ method, path, handle(ctx) }，ctx 由 router 分发点构造。
// 分支体逐字搬移，只把 `__deps.` → `deps.`；判断顺序、错误处理、状态码全部保持。
// 注意 /api/roles/limit 里有 `deps.roleInjectMaxChars = next` 的属性赋值：
// __deps 在 app.mjs 里是 getter+setter 活绑定，这里保留对 deps 对象的属性写入，
// 不能解构成局部变量，否则写不回真正的状态。
export const roleRoutes = [
  {
    method: 'POST',
    path: '/api/role',
    handle: async ({ sendJson, readBody, deps }) => {
      const body = await readBody();
      const rs = deps.readRoleState();
      if (body.role && typeof body.role === 'string') {
        const name = deps.sanitizeRoleName(body.role);
        if (!deps.fs.existsSync(deps.path.join(deps.ROOT, 'roles', name + '.md'))) {
          sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
          return;
        }
        deps.writeRoleState(name, rs.mode);
        deps.log(`控制台：角色已设置为 ${name}`);
        sendJson({ ok: true, role: name });
      } else {
        deps.writeRoleState(null, rs.mode);
        deps.log('控制台：角色已清除');
        sendJson({ ok: true, role: null });
      }
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/role-mode',
    handle: async ({ sendJson, readBody, deps }) => {
      const body = await readBody();
      const rs = deps.readRoleState();
      const mode = body.mode === 'silent' ? 'silent' : 'active';
      deps.writeRoleState(rs.role, mode);
      deps.log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
      sendJson({ ok: true, roleMode: mode });
      return;
    },
  },
  {
    method: 'GET',
    path: '/api/roles',
    handle: async ({ sendJson, deps }) => {
      const rs = deps.readRoleState();
      const summaries = deps.roleSummaries();
      sendJson({
        // roles 保持「人格名字符串数组」的既有契约（scripts/test-console.mjs 等调用方依赖它）；
        // 富信息放在 summaries 里，新老调用方互不影响。
        roles: summaries.map((role) => role.name),
        summaries,
        current: rs.role ?? null,
        limits: { nameMax: deps.ROLE_NAME_MAX, contentMaxBytes: deps.ROLE_CONTENT_MAX_BYTES, injectMaxChars: deps.roleInjectMaxChars },
      });
      return;
    },
  },
  {
    method: 'GET',
    path: '/api/roles/content',
    handle: async ({ url, sendJson, deps }) => {
      let name;
      try { name = deps.validateRoleName(url.searchParams.get('name')); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
      if (!deps.fs.existsSync(deps.roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
      const content = deps.readRoleContent(name);
      sendJson({
        ok: true,
        name,
        content,
        chars: content.length,
        bytes: Buffer.byteLength(content, 'utf8'),
        warnings: deps.roleWarnings(content),
        limits: { injectMaxChars: deps.roleInjectMaxChars },
        stats: deps.roleCharStats(content),
        // 每个小节在各模式下是否会被注入，供控制台预览「这条规则到底生不生效」
        sections: { v1: deps.roleSectionReport(content, 'v1'), v2: deps.roleSectionReport(content, 'v2') },
      });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/roles/limit',
    handle: async ({ sendJson, readBody, deps }) => {
      const body = await readBody();
      const next = deps.applyRoleInjectLimit(body.maxInjectChars);
      const configFile = deps.path.join(deps.ROOT, 'config.json');
      const file = deps.readConfigObject(configFile);
      file.role = { ...(file.role ?? {}), maxInjectChars: next };
      deps.atomicWriteJson(configFile, file);
      deps.cfg.role = { ...(deps.cfg.role ?? {}), maxInjectChars: next };
      deps.roleInjectMaxChars = next;
      deps.log(`控制台：人格注入上限已设为 ${next} 字符（下一条消息生效）`);
      sendJson({ ok: true, maxInjectChars: next, limits: { injectMaxChars: next } });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/roles/create',
    handle: async ({ sendJson, readBody, deps }) => {
      const body = await readBody();
      let name; let content;
      try { name = deps.validateRoleName(body.name); content = deps.validateRoleContent(body.content); }
      catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
      // [TOCTOU-FIX] 存在判断只做快速提示；真正防并发覆盖靠 wx 独占创建。
      try {
        deps.writeRoleContent(name, content, { exclusive: true });
      } catch (error) {
        if (error?.code === 'EEXIST') { sendJson({ ok: false, error: `人格「${name}」已存在` }, 400); return; }
        throw error;
      }
      deps.log(`控制台：创建人格「${name}」（${content.length} 字符）`);
      sendJson({ ok: true, role: name, warnings: deps.roleWarnings(content) });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/roles/update',
    handle: async ({ sendJson, readBody, deps }) => {
      const body = await readBody();
      let name; let content;
      try { name = deps.validateRoleName(body.name); content = deps.validateRoleContent(body.content); }
      catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
      if (!deps.fs.existsSync(deps.roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
      deps.writeRoleContent(name, content);
      deps.log(`控制台：更新人格「${name}」（${content.length} 字符）`);
      sendJson({ ok: true, role: name, chars: content.length, warnings: deps.roleWarnings(content) });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/roles/rename',
    handle: async ({ sendJson, readBody, deps }) => {
      const body = await readBody();
      let from; let to;
      try { from = deps.validateRoleName(body.from); to = deps.validateRoleName(body.to); }
      catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
      if (from === to) { sendJson({ ok: true, role: to, renamed: false }); return; }
      if (!deps.fs.existsSync(deps.roleFilePath(from))) { sendJson({ ok: false, error: `人格「${from}」不存在` }, 404); return; }
      if (deps.fs.existsSync(deps.roleFilePath(to))) { sendJson({ ok: false, error: `人格「${to}」已存在` }, 400); return; }
      deps.fs.renameSync(deps.roleFilePath(from), deps.roleFilePath(to));
      const rs = deps.readRoleState();
      const switched = rs.role === from;
      if (switched) deps.writeRoleState(to, rs.mode);
      deps.log(`控制台：人格重命名「${from}」→「${to}」${switched ? '（当前启用中，已跟随切换）' : ''}`);
      sendJson({ ok: true, role: to, renamed: true, currentFollowed: switched });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/roles/delete',
    handle: async ({ sendJson, readBody, deps }) => {
      const body = await readBody();
      let name;
      try { name = deps.validateRoleName(body.name); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
      if (!deps.fs.existsSync(deps.roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
      deps.fs.rmSync(deps.roleFilePath(name));
      const rs = deps.readRoleState();
      const cleared = rs.role === name;
      if (cleared) deps.writeRoleState(null, rs.mode);
      deps.log(`控制台：删除人格「${name}」${cleared ? '（该人格正在启用，已同时清除当前人格）' : ''}`);
      sendJson({ ok: true, deleted: name, clearedCurrent: cleared });
      return;
    },
  },
];
