// رابط کاربری: ثبت سریع ذهن، نمودار درختی ایجنت‌ها و گروه‌ها، تخته‌ی کارها، شناخت من،
// پنل تسک‌ها و تنظیمات، و تأیید ابزارها.
const MODELS = [
  ['claude-opus-5-5', 'Opus 5.5 (پیش‌فرض)'],
  ['claude-sonnet-5-5', 'Sonnet 5.5 (سریع‌تر و ارزان‌تر)'],
  ['claude-haiku-4-5', 'Haiku 4.5 (خیلی سریع و ارزان)'],
  ['claude-fable-5-1', 'Fable 5.1 (قوی‌ترین)'],
];
const TOOLS = [
  ['Read', 'خواندن فایل'],
  ['Write', 'نوشتن فایل'],
  ['Edit', 'ویرایش فایل'],
  ['Glob', 'پیدا کردن فایل'],
  ['Grep', 'جست‌وجو در فایل'],
  ['Bash', 'اجرای دستور'],
  ['WebSearch', 'جست‌وجوی وب'],
  ['WebFetch', 'خواندن صفحه‌ی وب'],
  ['Agent', 'واگذاری به ایجنت دیگر'],
  ['TodoWrite', 'فهرست کارها'],
];
const PERMISSIONS = [
  ['ask', 'با تأیید من', 'خواندن آزاد است؛ برای هر کار دیگر از شما اجازه می‌گیرد.'],
  ['auto', 'ویرایش خودکار', 'ساختن و ویرایش فایل‌ها خودکار؛ دستورها و کارهای دیگر با تأیید شما.'],
  ['full', 'دسترسی کامل', 'همه‌ی ابزارهای مجاز را بدون پرسیدن اجرا می‌کند (شامل MCPها).'],
];
const STATUS = { todo: 'در انتظار', running: 'در حال اجرا', done: 'انجام شد', error: 'خطا', stopped: 'متوقف شد' };

let agents = [];
let approvals = [];
let selectedId = null;
let tab = 'tasks';
let view = 'tree';
let showArchived = false;
const expanded = new Set();
const logs = new Map(); // taskId -> entries (فقط برای تسک‌های بازشده بارگیری می‌شود)

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const byId = (id) => agents.find((a) => a.id === id);
const isGroup = (u) => u?.kind === 'group';
const fmtDate = (ms) => new Date(ms).toLocaleDateString('fa-IR', { month: 'short', day: 'numeric' });

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || `خطا (${res.status})`);
    throw new Error(err.error);
  }
  return res.status === 204 || res.status === 202 ? null : res.json();
}

async function load() {
  const data = await api('GET', '/api/state');
  agents = data.agents;
  approvals = data.approvals;
  if (!selectedId || !byId(selectedId)) selectedId = agents.find((a) => !a.archived)?.id ?? null;
  renderAll();
}

function renderAll() {
  renderTree();
  if (view === 'board') renderBoard();
  renderPanel();
  renderApprovals();
  renderStats();
}

function createdByLabel(t) {
  if (t.createdBy === 'me' || !t.createdBy) return '';
  if (t.createdBy === 'capture') return 'از ثبت سریع';
  return `ثبت توسط ${byId(t.createdBy)?.name ?? t.createdBy}`;
}

function unitStatus(u) {
  if (approvals.some((p) => p.agentId === u.id)) return 'waiting';
  if (u.tasks.some((t) => t.status === 'running')) return 'running';
  // ایجنتی که کاری به او سپرده شده هم «در حال کار» است.
  if (agents.some((x) => x.tasks.some((t) => t.status === 'running' && t.delegates?.includes(u.id)))) return 'running';
  const last = [...u.tasks].filter((t) => !t.archived).sort((x, y) => y.updatedAt - x.updatedAt)[0];
  return last?.status === 'error' ? 'error' : 'idle';
}

function renderStats() {
  const live = agents.filter((a) => !a.archived);
  const open = live.reduce((s, a) => s + a.tasks.filter((t) => !t.archived && (t.status === 'todo' || t.status === 'stopped')).length, 0);
  const runningCount = live.reduce((s, a) => s + a.tasks.filter((t) => t.status === 'running').length, 0);
  $('#stats').textContent =
    `${live.filter((a) => !isGroup(a)).length} ایجنت · ${live.filter(isGroup).length} گروه · ${open} کار باز · ${runningCount} در حال اجرا` +
    (approvals.length ? ` · ${approvals.length} منتظر تأیید` : '');
}

// ---------- نماها ----------
document.querySelectorAll('.views button').forEach((b) => {
  b.onclick = () => setView(b.dataset.view);
});
function setView(v) {
  view = v;
  document.querySelectorAll('.views button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  for (const name of ['tree', 'board', 'me']) $(`#view-${name}`).hidden = name !== v;
  $('#fit').hidden = v !== 'tree';
  if (v === 'tree') fit();
  if (v === 'board') renderBoard();
  if (v === 'me') renderMe();
}

$('#capture').onsubmit = async (e) => {
  e.preventDefault();
  const input = e.target.text;
  const value = input.value.trim();
  if (!value) return;
  input.disabled = true;
  try {
    await api('POST', '/api/capture', { text: value });
    input.value = '';
    input.placeholder = 'ثبت شد ✓ ستاد دارد مرتبش می‌کند. فکر بعدی؟';
  } finally {
    input.disabled = false;
    input.focus();
  }
};

$('#new-agent').onclick = async () => {
  const parent = byId(selectedId);
  const created = await api('POST', '/api/agents', { parent: parent && !isGroup(parent) && !parent.archived ? parent.id : null });
  tab = 'settings';
  select(created.id);
};
$('#new-group').onclick = async () => {
  const created = await api('POST', '/api/agents', { kind: 'group' });
  tab = 'settings';
  select(created.id);
};
$('#show-archived').onchange = (e) => {
  showArchived = e.target.checked;
  renderTree();
  if (view === 'board') renderBoard();
};

// ---------- نمودار درختی ----------
const svg = d3.select('#tree');
const g = svg.append('g');
const zoom = d3.zoom().scaleExtent([0.3, 2]).on('zoom', (e) => g.attr('transform', e.transform));
svg.call(zoom).on('dblclick.zoom', null);
const W = 200, H = 58;
let firstDraw = true;

function renderTree() {
  const visible = agents.filter((a) => showArchived || !a.archived);
  const shown = new Set(visible.map((a) => a.id));
  const rows = [{ id: '__root', parentId: null }];
  // اول درخت ایجنت‌ها، بعد گروه‌ها با اعضایشان (اعضا نقطه‌چین و فقط ارجاع به ایجنت اصلی‌اند).
  for (const a of visible.filter((x) => !isGroup(x))) rows.push({ id: a.id, parentId: a.parent && shown.has(a.parent) ? a.parent : '__root', unit: a });
  for (const grp of visible.filter(isGroup)) {
    rows.push({ id: grp.id, parentId: '__root', unit: grp });
    for (const m of grp.members) {
      const member = byId(m);
      if (member && (showArchived || !member.archived)) rows.push({ id: `${grp.id}::${m}`, parentId: grp.id, unit: member, ref: true });
    }
  }
  const root = d3.stratify().id((d) => d.id).parentId((d) => d.parentId)(rows);
  d3.tree().nodeSize([H + 22, W + 70])(root);
  const nodes = root.descendants().filter((d) => d.id !== '__root');
  const links = root.links().filter((l) => l.source.id !== '__root');
  // ریشه سمت راست است و شاخه‌ها به سمت چپ باز می‌شوند.
  const X = (d) => -d.y;

  g.selectAll('path.link')
    .data(links, (l) => l.target.id)
    .join('path')
    .attr('class', (l) => `link ${l.target.data.ref ? 'ref' : ''}`)
    .attr('d', (l) => {
      const mid = (X(l.source) + X(l.target)) / 2;
      return `M${X(l.source) - W / 2},${l.source.x} C${mid},${l.source.x} ${mid},${l.target.x} ${X(l.target) + W / 2},${l.target.x}`;
    });

  const node = g.selectAll('g.node')
    .data(nodes, (d) => d.id)
    .join((enter) => {
      const n = enter.append('g').on('click', (_e, d) => select(d.data.unit.id));
      n.append('rect').attr('class', 'card').attr('x', -W / 2).attr('y', -H / 2).attr('width', W).attr('height', H).attr('rx', 10);
      n.append('text').attr('class', 'icon').attr('x', W / 2 - 14).attr('y', 7).attr('font-size', 22).attr('text-anchor', 'end');
      n.append('text').attr('class', 'name').attr('x', W / 2 - 46).attr('y', -4).attr('font-size', 14).attr('font-weight', 600).attr('text-anchor', 'start');
      n.append('text').attr('class', 'sub').attr('x', W / 2 - 46).attr('y', 15).attr('text-anchor', 'start');
      n.append('circle').attr('class', 'pulse').attr('cx', -W / 2 + 14).attr('cy', -H / 2 + 14).attr('r', 5);
      return n;
    })
    .attr('transform', (d) => `translate(${X(d)},${d.x})`)
    .attr('class', (d) => {
      const u = d.data.unit;
      return ['node', unitStatus(u), isGroup(u) && 'group', d.data.ref && 'ref', u.archived && 'archived', u.id === selectedId && !d.data.ref && 'selected']
        .filter(Boolean)
        .join(' ');
    });

  node.each(function (d) {
    const u = d.data.unit;
    const n = d3.select(this);
    const open = u.tasks.filter((t) => !t.archived && (t.status === 'todo' || t.status === 'running' || t.status === 'stopped')).length;
    const st = unitStatus(u);
    n.select('.icon').text(u.icon || '🤖');
    n.select('.name').text(u.name);
    let sub;
    if (d.data.ref) sub = 'عضو گروه';
    else if (u.archived) sub = 'بایگانی‌شده';
    else if (isGroup(u)) sub = `گروه · ${u.members.length} عضو${open ? ` · ${open} کار باز` : ''}`;
    else sub = `${open ? `${open} کار باز` : 'بدون کار باز'} · ${PERMISSIONS.find((p) => p[0] === u.permission)?.[1] ?? ''}`;
    n.select('.sub').text(sub);
    n.select('.pulse').attr('fill', { idle: 'var(--link)', running: 'var(--accent)', waiting: 'var(--warn)', error: 'var(--err)' }[st]);
  });

  if (firstDraw && nodes.length) {
    firstDraw = false;
    requestAnimationFrame(fit);
  }
}

function fit() {
  if (view !== 'tree') return;
  const box = g.node().getBBox();
  const { width, height } = svg.node().getBoundingClientRect();
  if (!box.width || !width) return;
  const k = Math.min(1.2, 0.9 * Math.min(width / box.width, height / box.height));
  const t = d3.zoomIdentity.translate(width / 2 - k * (box.x + box.width / 2), height / 2 - k * (box.y + box.height / 2)).scale(k);
  svg.transition().duration(400).call(zoom.transform, t);
}
$('#fit').onclick = fit;

function select(id) {
  selectedId = id;
  renderTree();
  renderPanel();
}

// ---------- تخته‌ی کارها: همه‌ی کارهای همه‌ی ایجنت‌ها در یک نگاه ----------
function renderBoard() {
  const all = agents
    .filter((a) => showArchived || !a.archived)
    .flatMap((u) => u.tasks.filter((t) => showArchived || !t.archived).map((t) => ({ u, t })));
  const cols = [
    ['در انتظار', all.filter(({ t }) => t.status === 'todo' || t.status === 'stopped' || t.status === 'error').sort((a, b) => b.t.createdAt - a.t.createdAt)],
    ['در حال اجرا', all.filter(({ t }) => t.status === 'running')],
    ['انجام شده', all.filter(({ t }) => t.status === 'done').sort((a, b) => b.t.updatedAt - a.t.updatedAt).slice(0, 30)],
  ];
  $('#view-board').innerHTML = `<div class="board">${cols
    .map(
      ([title, items]) => `
      <div class="col">
        <h3>${title} <span class="hint">${items.length}</span></h3>
        ${items
          .map(
            ({ u, t }) => `
          <div class="card ${t.status}" data-unit="${u.id}" data-task="${t.id}">
            <div class="card-unit">${esc(u.icon)} ${esc(u.name)}</div>
            <div class="card-title">${esc(t.title)}</div>
            <div class="hint">${fmtDate(t.createdAt)}${createdByLabel(t) ? ` · ${createdByLabel(t)}` : ''}${t.status === 'error' ? ' · <span style="color:var(--err)">خطا</span>' : ''}</div>
          </div>`,
          )
          .join('') || '<div class="hint">—</div>'}
      </div>`,
    )
    .join('')}</div>`;
  document.querySelectorAll('#view-board .card').forEach((c) => {
    c.onclick = () => {
      tab = 'tasks';
      expanded.add(c.dataset.task);
      select(c.dataset.unit);
    };
  });
}

// ---------- شناخت من ----------
async function renderMe() {
  const me = await api('GET', '/api/me');
  const s = me.stats;
  $('#view-me').innerHTML = `
    <div class="me">
      <h2>🪞 شناخت من</h2>
      <p class="hint">
        ایجنت‌ها هر چه از ترجیحات، عادت‌ها و تصمیم‌های شما می‌فهمند این‌جا می‌نویسند و قبل از هر کار آن را می‌خوانند.
        خودتان هم می‌توانید آن را ویرایش کنید. همه‌ی نسخه‌های قبلی در دفتر رویدادها می‌ماند.
      </p>
      <textarea id="me-text" rows="16">${esc(me.text)}</textarea>
      <div class="row"><button class="primary" id="me-save">ذخیره</button></div>

      <h3>آن‌چه تا امروز ذخیره شده</h3>
      <div class="stats-grid">
        <div><strong>${s.events}</strong><span>رویداد ثبت‌شده</span></div>
        <div><strong>${s.captures}</strong><span>ثبت سریع ذهن</span></div>
        <div><strong>${s.tasks}</strong><span>تسک</span></div>
        <div><strong>${s.approvals}</strong><span>تصمیم اجازه/رد</span></div>
        <div><strong>${s.notes}</strong><span>نکته درباره‌ی شما</span></div>
      </div>
      <p class="hint">
        ${s.since ? `از ${new Date(s.since).toLocaleDateString('fa-IR')} · ` : ''}همه‌ی داده‌ها در این پوشه است: <code>${esc(me.dataDir)}</code><br />
        هیچ داده‌ای پاک نمی‌شود: ایجنت‌ها و تسک‌ها بایگانی می‌شوند و تاریخچه‌شان می‌ماند.
      </p>
      <div class="row"><a class="button" href="/api/export">⬇ خروجی کامل همه‌ی داده‌ها (JSON)</a></div>
    </div>`;
  $('#me-save').onclick = async () => {
    await api('PUT', '/api/me', { text: $('#me-text').value });
    renderMe();
  };
}

// ---------- پنل ایجنت / گروه ----------
let panelFor = null;
function renderPanel() {
  const u = byId(selectedId);
  const panel = $('#panel');
  // وسط ویرایش تنظیمات، به‌روزرسانی‌های زنده فرم را پاک نکنند.
  if (u && panelFor === u.id && tab === 'settings' && panel.contains(document.activeElement) && document.activeElement !== document.body) return;
  panelFor = u?.id ?? null;
  if (!u) {
    panel.innerHTML = '<div class="empty">یک ایجنت یا گروه را انتخاب کنید.</div>';
    return;
  }
  const visibleTasks = u.tasks.filter((t) => !t.archived);
  panel.innerHTML = `
    <div class="agent-head"><span class="icon">${esc(u.icon)}</span><h2>${esc(u.name)}</h2>
      ${isGroup(u) ? '<span class="chip">گروه</span>' : ''}${u.archived ? '<span class="chip">بایگانی</span>' : ''}</div>
    <p class="agent-desc">${esc(u.description)}</p>
    ${isGroup(u) ? `<p class="hint">اعضا: ${u.members.map((m) => esc(byId(m)?.name ?? m)).join('، ') || '—'}</p>` : ''}
    <div class="tabs">
      <button data-tab="tasks" class="${tab === 'tasks' ? 'active' : ''}">تسک‌ها (${visibleTasks.length})</button>
      <button data-tab="settings" class="${tab === 'settings' ? 'active' : ''}">تنظیمات و دسترسی‌ها</button>
    </div>
    <div id="tab-body"></div>`;
  panel.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; renderPanel(); }));
  if (tab === 'tasks') renderTasks(u);
  else renderSettings(u);
}

function renderTasks(u) {
  const body = $('#tab-body');
  const tasks = u.tasks.filter((t) => !t.archived).sort((x, y) => y.createdAt - x.createdAt);
  const archivedCount = u.tasks.length - tasks.length;
  body.innerHTML = `
    ${u.archived ? '' : `
    <form id="new-task" class="task">
      <input type="text" name="title" placeholder="عنوان تسک، مثلاً: بودجه‌ی این ماه را ببند" required />
      <textarea name="prompt" placeholder="توضیحات بیشتر برای ${isGroup(u) ? 'گروه' : 'ایجنت'} (اختیاری)"></textarea>
      <div class="row">
        <button class="primary" name="run" value="1">افزودن و اجرا</button>
        <button name="later" value="1">فقط افزودن</button>
      </div>
    </form>`}
    <div id="task-list">${tasks.map(taskHtml).join('') || '<div class="empty">هنوز تسکی ندارد.</div>'}</div>
    ${archivedCount ? `<p class="hint">${archivedCount} تسک بایگانی‌شده (در خروجی و تاریخچه موجود است).</p>` : ''}`;

  const form = $('#new-task');
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      await api('POST', `/api/agents/${u.id}/tasks`, { title: fd.get('title'), prompt: fd.get('prompt'), run: e.submitter?.name === 'run' });
      form.reset();
    };
  }
  bindTasks(u);
  for (const id of expanded) if (u.tasks.some((t) => t.id === id) && !logs.has(id)) loadLog(u, id);
}

async function loadLog(u, taskId) {
  logs.set(taskId, await api('GET', `/api/agents/${u.id}/tasks/${taskId}/log`));
  refreshTask(u, taskId);
}

function logLine(e) {
  const prefix = { user: '👤 ', tool: '🔧 ', wait: '⏳ ', error: '⚠️ ' }[e.kind] || '';
  return `<div class="${e.kind} ${e.from === 'sub' ? 'sub' : ''}">${prefix}${esc(e.text)}</div>`;
}

function taskHtml(t) {
  const open = expanded.has(t.id);
  const isRunning = t.status === 'running';
  const by = createdByLabel(t);
  return `
    <div class="task" data-id="${t.id}">
      <div class="task-top">
        <span class="task-title">${open ? '▾' : '▸'} ${esc(t.title)}</span>
        <span class="chip ${t.status}">${STATUS[t.status] || t.status}</span>
      </div>
      ${by ? `<div class="hint">${by}</div>` : ''}
      ${open ? `
        <div class="task-body">
          ${t.prompt ? `<details><summary class="hint">دستور کامل</summary><div class="hint pre">${esc(t.prompt)}</div></details>` : ''}
          ${t.result ? `<div class="result">${esc(t.result)}</div>` : ''}
          ${t.error ? `<div class="hint" style="color:var(--err)">خطا: ${esc(t.error)}</div>` : ''}
          <div class="log">${logs.has(t.id) ? logs.get(t.id).map(logLine).join('') : '<div class="hint">در حال بارگیری…</div>'}</div>
          ${t.sessionId && !isRunning ? `
            <div class="row"><input type="text" class="followup" placeholder="ادامه‌ی گفتگو درباره‌ی همین تسک…" /></div>` : ''}
          <div class="row">
            ${isRunning ? '<button class="small" data-act="stop">توقف</button>' : `<button class="small primary" data-act="run">${t.sessionId ? 'ادامه / اجرای دوباره' : 'اجرا'}</button>`}
            <button class="small" data-act="archive">بایگانی</button>
            ${t.costUsd ? `<span class="hint">هزینه‌ی تقریبی: $${t.costUsd.toFixed(3)}</span>` : ''}
          </div>
        </div>` : ''}
    </div>`;
}

function bindTasks(u) {
  document.querySelectorAll('#task-list .task').forEach((el) => {
    const id = el.dataset.id;
    $('.task-title', el).onclick = () => {
      if (expanded.has(id)) expanded.delete(id);
      else {
        expanded.add(id);
        if (!logs.has(id)) loadLog(u, id);
      }
      refreshTask(u, id);
    };
    el.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = async () => {
        const act = b.dataset.act;
        if (act === 'run') {
          await api('POST', `/api/agents/${u.id}/tasks/${id}/run`, { followUp: $('.followup', el)?.value });
        } else if (act === 'stop') {
          await api('POST', `/api/agents/${u.id}/tasks/${id}/stop`);
        } else if (act === 'archive') {
          await api('POST', `/api/agents/${u.id}/tasks/${id}/archive`, { archived: true });
        }
      };
    });
    const log = $('.log', el);
    if (log) log.scrollTop = log.scrollHeight;
  });
}

function refreshTask(u, taskId) {
  const el = document.querySelector(`#task-list .task[data-id="${taskId}"]`);
  const t = u.tasks.find((x) => x.id === taskId);
  if (!el || !t) return;
  if (el.contains(document.activeElement) && document.activeElement.classList.contains('followup')) return;
  el.outerHTML = taskHtml(t);
  bindTasks(u);
}

function renderSettings(u) {
  const body = $('#tab-body');
  const others = agents.filter((x) => x.id !== u.id && !isGroup(x) && !x.archived);
  const placement = isGroup(u)
    ? `<label>اعضای گروه <span class="hint">— گروه کار را بین این ایجنت‌ها (و زیرمجموعه‌هایشان) تقسیم می‌کند</span></label>
       <div class="checks">${agents.filter((x) => !isGroup(x) && !x.archived).map((x) => `
         <label><input type="checkbox" name="members" value="${x.id}" ${u.members.includes(x.id) ? 'checked' : ''} />${esc(x.icon)} ${esc(x.name)}</label>`).join('')}
       </div>`
    : `<label>زیرمجموعه‌ی</label>
       <select name="parent"><option value="">— (ریشه)</option>${others.map((p) => `<option value="${p.id}" ${u.parent === p.id ? 'selected' : ''}>${esc(p.icon)} ${esc(p.name)}</option>`).join('')}</select>`;

  body.innerHTML = `
    <form id="settings">
      <div class="row" style="margin-top:0">
        <div style="width:70px"><label>آیکون</label><input type="text" name="icon" value="${esc(u.icon)}" /></div>
        <div style="flex:1"><label>نام</label><input type="text" name="name" value="${esc(u.name)}" /></div>
      </div>
      <label>توضیح کوتاه <span class="hint">— بقیه بر اساس این تصمیم می‌گیرند کار را به ${isGroup(u) ? 'این گروه' : 'این ایجنت'} بسپارند</span></label>
      <input type="text" name="description" value="${esc(u.description)}" />
      <label>دستورالعمل (System Prompt)</label>
      <textarea name="prompt" rows="6">${esc(u.prompt)}</textarea>
      <label>مدل</label>
      <select name="model">${MODELS.map(([v, l]) => `<option value="${v}" ${u.model === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${placement}

      <label>سطح دسترسی</label>
      <div class="radios">${PERMISSIONS.map(([v, l, h]) => `
        <label><input type="radio" name="permission" value="${v}" ${u.permission === v ? 'checked' : ''} /><span>${l}<span class="hint">${h}</span></span></label>`).join('')}
      </div>
      <p class="hint">وقتی کار به اعضای تیم سپرده می‌شود، همین سطح دسترسی برای آن‌ها هم اعمال می‌شود.</p>

      <label>ابزارهای مجاز</label>
      <div class="checks">${TOOLS.map(([v, l]) => `
        <label title="${v}"><input type="checkbox" name="tools" value="${v}" ${u.tools.includes(v) ? 'checked' : ''} />${l}</label>`).join('')}
      </div>
      <p class="hint">ابزارهای داخلی اپ (ثبت تسک، خواندن و ثبت «شناخت من») همیشه در دسترس‌اند.</p>

      <label>سرورهای MCP <span class="hint">— اتصال به سرویس‌ها (ایمیل، تقویم، …) به‌صورت JSON</span></label>
      <textarea name="mcpServers" class="code" rows="5">${esc(JSON.stringify(u.mcpServers || {}, null, 2))}</textarea>

      <div class="row">
        <button class="primary">ذخیره</button>
        ${isGroup(u) ? '' : '<button type="button" id="add-child">+ زیرمجموعه</button>'}
        <button type="button" id="archive-unit" class="${u.archived ? '' : 'danger'}">${u.archived ? 'بازگردانی از بایگانی' : 'بایگانی'}</button>
      </div>
      <p class="hint">شناسه: <code>${esc(u.id)}</code> · بایگانی چیزی را پاک نمی‌کند؛ فقط از درخت و همکاری‌ها بیرون می‌رود.</p>
    </form>`;

  $('#settings').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    let mcpServers;
    try {
      mcpServers = JSON.parse(fd.get('mcpServers') || '{}');
    } catch {
      return alert('JSON سرورهای MCP معتبر نیست.');
    }
    const patch = {
      icon: fd.get('icon'),
      name: fd.get('name'),
      description: fd.get('description'),
      prompt: fd.get('prompt'),
      model: fd.get('model'),
      permission: fd.get('permission'),
      tools: fd.getAll('tools'),
      mcpServers,
    };
    if (isGroup(u)) patch.members = fd.getAll('members');
    else patch.parent = fd.get('parent') || null;
    await api('PUT', `/api/agents/${u.id}`, patch);
  };
  $('#add-child')?.addEventListener('click', async () => {
    const created = await api('POST', '/api/agents', { parent: u.id });
    tab = 'settings';
    select(created.id);
  });
  $('#archive-unit').onclick = async () => {
    if (!u.archived && !confirm(`«${u.name}» بایگانی شود؟${isGroup(u) ? '' : ' زیرمجموعه‌هایش به والد آن منتقل می‌شوند.'} تاریخچه‌اش حفظ می‌شود.`)) return;
    await api('POST', `/api/agents/${u.id}/archive`, { archived: !u.archived });
  };
}

// ---------- تأییدها ----------
function renderApprovals() {
  $('#approvals').innerHTML = approvals.map((p) => `
    <div class="approval" data-id="${p.id}">
      <strong>${esc(p.agentName)}</strong>${p.viaSubagent ? ' (از طریق یکی از اعضای تیم)' : ''} می‌خواهد ابزار <strong>${esc(p.toolName)}</strong> را اجرا کند
      <div class="hint">تسک: ${esc(p.taskTitle)}</div>
      <pre>${esc(JSON.stringify(p.input, null, 2))}</pre>
      <div class="row">
        <button class="primary small" data-allow="1">اجازه</button>
        <button class="small danger" data-allow="0">رد</button>
      </div>
    </div>`).join('');
  document.querySelectorAll('.approval button').forEach((b) => {
    b.onclick = () => api('POST', `/api/approvals/${b.closest('.approval').dataset.id}`, { allow: b.dataset.allow === '1' });
  });
}

// ---------- رویدادهای زنده ----------
function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (msg) => {
    const ev = JSON.parse(msg.data);
    if (ev.type === 'agents') return load();
    if (ev.type === 'me') {
      if (view === 'me' && !$('#me-text')?.matches(':focus')) renderMe();
      return;
    }
    const u = byId(ev.agentId);
    if (ev.type === 'task' && u) {
      const t = u.tasks.find((x) => x.id === ev.task.id);
      if (t) Object.assign(t, ev.task);
      renderTree();
      renderStats();
      if (view === 'board') renderBoard();
      if (u.id === selectedId && tab === 'tasks') refreshTask(u, ev.task.id);
    } else if (ev.type === 'log' && u) {
      if (!logs.has(ev.taskId)) return;
      logs.get(ev.taskId).push(ev.entry);
      const log = document.querySelector(`#task-list .task[data-id="${ev.taskId}"] .log`);
      if (log && u.id === selectedId) {
        log.insertAdjacentHTML('beforeend', logLine(ev.entry));
        log.scrollTop = log.scrollHeight;
      }
    } else if (ev.type === 'approval') {
      approvals.push(ev.approval);
      renderApprovals();
      renderTree();
      renderStats();
    } else if (ev.type === 'approval-done') {
      approvals = approvals.filter((p) => p.id !== ev.id);
      renderApprovals();
      renderTree();
      renderStats();
    }
  };
  es.onerror = () => {
    es.close();
    setTimeout(() => { connect(); load(); }, 2000);
  };
}

load().then(connect);
