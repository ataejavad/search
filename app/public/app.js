// رابط کاربری: نمودار درختی ایجنت‌ها، پنل تسک‌ها و تنظیمات، و تأیید ابزارها.
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
const expanded = new Set();

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const byId = (id) => agents.find((a) => a.id === id);

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
  if (!selectedId || !byId(selectedId)) selectedId = agents[0]?.id ?? null;
  renderTree();
  renderPanel();
  renderApprovals();
}

function agentStatus(a) {
  if (approvals.some((p) => p.agentId === a.id)) return 'waiting';
  if (a.tasks.some((t) => t.status === 'running')) return 'running';
  // ایجنتی که والدش کاری را به او سپرده هم «در حال کار» است.
  if (agents.some((x) => x.tasks.some((t) => t.status === 'running' && t.delegates?.includes(a.id)))) return 'running';
  const last = [...a.tasks].sort((x, y) => y.updatedAt - x.updatedAt)[0];
  return last?.status === 'error' ? 'error' : 'idle';
}

// ---------- نمودار درختی ----------
const svg = d3.select('#tree');
const g = svg.append('g');
const zoom = d3.zoom().scaleExtent([0.3, 2]).on('zoom', (e) => g.attr('transform', e.transform));
svg.call(zoom).on('dblclick.zoom', null);
const W = 200, H = 58;
let firstDraw = true;

function renderTree() {
  const roots = agents.filter((a) => !a.parent || !byId(a.parent));
  const rows = [{ id: '__root', parentId: null }, ...agents.map((a) => ({ id: a.id, parentId: roots.includes(a) ? '__root' : a.parent }))];
  const root = d3.stratify().id((d) => d.id).parentId((d) => d.parentId)(rows);
  d3.tree().nodeSize([H + 22, W + 70])(root);
  const nodes = root.descendants().filter((d) => d.id !== '__root');
  const links = root.links().filter((l) => l.source.id !== '__root');
  // ریشه سمت راست است و شاخه‌ها به سمت چپ باز می‌شوند.
  const X = (d) => -d.y;

  g.selectAll('path.link')
    .data(links, (l) => l.target.id)
    .join('path')
    .attr('class', 'link')
    .attr('d', (l) => `M${X(l.source) - W / 2},${l.source.x} C${(X(l.source) + X(l.target)) / 2},${l.source.x} ${(X(l.source) + X(l.target)) / 2},${l.target.x} ${X(l.target) + W / 2},${l.target.x}`);

  const node = g.selectAll('g.node')
    .data(nodes, (d) => d.id)
    .join((enter) => {
      const n = enter.append('g').on('click', (_e, d) => select(d.id));
      n.append('rect').attr('class', 'card').attr('x', -W / 2).attr('y', -H / 2).attr('width', W).attr('height', H).attr('rx', 10);
      n.append('text').attr('class', 'icon').attr('x', W / 2 - 14).attr('y', 7).attr('font-size', 22).attr('text-anchor', 'end');
      n.append('text').attr('class', 'name').attr('x', W / 2 - 46).attr('y', -4).attr('font-size', 14).attr('font-weight', 600).attr('text-anchor', 'start');
      n.append('text').attr('class', 'sub').attr('x', W / 2 - 46).attr('y', 15).attr('text-anchor', 'start');
      n.append('circle').attr('class', 'pulse').attr('cx', -W / 2 + 14).attr('cy', -H / 2 + 14).attr('r', 5);
      return n;
    })
    .attr('transform', (d) => `translate(${X(d)},${d.x})`)
    .attr('class', (d) => `node ${agentStatus(byId(d.id))} ${d.id === selectedId ? 'selected' : ''}`);

  node.each(function (d) {
    const a = byId(d.id);
    const n = d3.select(this);
    const open = a.tasks.filter((t) => t.status === 'todo' || t.status === 'running').length;
    const st = agentStatus(a);
    n.select('.icon').text(a.icon || '🤖');
    n.select('.name').text(a.name);
    n.select('.sub').text(`${a.tasks.length} تسک${open ? ` · ${open} باز` : ''} · ${PERMISSIONS.find((p) => p[0] === a.permission)?.[1] ?? ''}`);
    n.select('.pulse').attr('fill', { idle: 'var(--link)', running: 'var(--accent)', waiting: 'var(--warn)', error: 'var(--err)' }[st]);
  });

  const running = agents.reduce((s, a) => s + a.tasks.filter((t) => t.status === 'running').length, 0);
  $('#stats').textContent = `${agents.length} ایجنت · ${running} تسک در حال اجرا · ${approvals.length} منتظر تأیید`;

  if (firstDraw && nodes.length) {
    firstDraw = false;
    requestAnimationFrame(fit);
  }
}

function fit() {
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

// ---------- پنل ایجنت ----------
function renderPanel() {
  const a = byId(selectedId);
  const panel = $('#panel');
  if (!a) {
    panel.innerHTML = '<div class="empty">یک ایجنت را در نمودار انتخاب کنید.</div>';
    return;
  }
  panel.innerHTML = `
    <div class="agent-head"><span class="icon">${esc(a.icon)}</span><h2>${esc(a.name)}</h2></div>
    <p class="agent-desc">${esc(a.description)}</p>
    <div class="tabs">
      <button data-tab="tasks" class="${tab === 'tasks' ? 'active' : ''}">تسک‌ها (${a.tasks.length})</button>
      <button data-tab="settings" class="${tab === 'settings' ? 'active' : ''}">تنظیمات و دسترسی‌ها</button>
    </div>
    <div id="tab-body"></div>`;
  panel.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; renderPanel(); }));
  if (tab === 'tasks') renderTasks(a);
  else renderSettings(a);
}

function renderTasks(a) {
  const body = $('#tab-body');
  const tasks = [...a.tasks].sort((x, y) => y.createdAt - x.createdAt);
  body.innerHTML = `
    <form id="new-task" class="task">
      <input type="text" name="title" placeholder="عنوان تسک، مثلاً: بودجه‌ی این ماه را ببند" required />
      <textarea name="prompt" placeholder="توضیحات بیشتر برای ایجنت (اختیاری)"></textarea>
      <div class="row">
        <button class="primary" name="run" value="1">افزودن و اجرا</button>
        <button name="later" value="1">فقط افزودن</button>
      </div>
    </form>
    <div id="task-list">${tasks.map((t) => taskHtml(t)).join('') || '<div class="empty">هنوز تسکی ندارد.</div>'}</div>`;

  const form = $('#new-task');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const run = e.submitter?.name === 'run';
    const fd = new FormData(form);
    await api('POST', `/api/agents/${a.id}/tasks`, { title: fd.get('title'), prompt: fd.get('prompt'), run });
    form.reset();
  };
  bindTasks(a);
}

function logLine(e) {
  const prefix = { user: '👤 ', tool: '🔧 ', wait: '⏳ ', error: '⚠️ ' }[e.kind] || '';
  return `<div class="${e.kind} ${e.from === 'sub' ? 'sub' : ''}">${prefix}${esc(e.text)}</div>`;
}

function taskHtml(t) {
  const open = expanded.has(t.id);
  const isRunning = t.status === 'running';
  return `
    <div class="task" data-id="${t.id}">
      <div class="task-top">
        <span class="task-title">${open ? '▾' : '▸'} ${esc(t.title)}</span>
        <span class="chip ${t.status}">${STATUS[t.status] || t.status}</span>
      </div>
      ${open ? `
        <div class="task-body">
          ${t.prompt ? `<div class="hint">${esc(t.prompt)}</div>` : ''}
          ${t.result ? `<div class="result">${esc(t.result)}</div>` : ''}
          ${t.error ? `<div class="hint" style="color:var(--err)">خطا: ${esc(t.error)}</div>` : ''}
          <div class="log">${(t.log || []).map(logLine).join('')}</div>
          ${t.sessionId && !isRunning ? `
            <div class="row"><input type="text" class="followup" placeholder="ادامه‌ی گفتگو با ایجنت درباره‌ی همین تسک…" /></div>` : ''}
          <div class="row">
            ${isRunning ? '<button class="small" data-act="stop">توقف</button>' : `<button class="small primary" data-act="run">${t.sessionId ? 'ادامه / اجرای دوباره' : 'اجرا'}</button>`}
            <button class="small danger" data-act="delete">حذف</button>
            ${t.costUsd ? `<span class="hint">هزینه‌ی تقریبی: $${t.costUsd.toFixed(3)}</span>` : ''}
          </div>
        </div>` : ''}
    </div>`;
}

function bindTasks(a) {
  document.querySelectorAll('#task-list .task').forEach((el) => {
    const id = el.dataset.id;
    $('.task-title', el).onclick = () => {
      expanded.has(id) ? expanded.delete(id) : expanded.add(id);
      refreshTask(a, id);
    };
    el.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = async () => {
        const act = b.dataset.act;
        if (act === 'run') {
          const followUp = $('.followup', el)?.value;
          await api('POST', `/api/agents/${a.id}/tasks/${id}/run`, { followUp });
        } else if (act === 'stop') {
          await api('POST', `/api/agents/${a.id}/tasks/${id}/stop`);
        } else if (act === 'delete' && confirm('این تسک حذف شود؟')) {
          await api('DELETE', `/api/agents/${a.id}/tasks/${id}`);
        }
      };
    });
    const log = $('.log', el);
    if (log) log.scrollTop = log.scrollHeight;
  });
}

function refreshTask(a, taskId) {
  const el = document.querySelector(`#task-list .task[data-id="${taskId}"]`);
  const t = a.tasks.find((x) => x.id === taskId);
  if (!el || !t) return;
  const typing = el.contains(document.activeElement) && document.activeElement.classList.contains('followup');
  if (typing) return;
  el.outerHTML = taskHtml(t);
  bindTasks(a);
}

function renderSettings(a) {
  const body = $('#tab-body');
  const parents = agents.filter((x) => x.id !== a.id);
  body.innerHTML = `
    <form id="settings">
      <div class="row" style="margin-top:0">
        <div style="width:70px"><label>آیکون</label><input type="text" name="icon" value="${esc(a.icon)}" /></div>
        <div style="flex:1"><label>نام</label><input type="text" name="name" value="${esc(a.name)}" /></div>
      </div>
      <label>توضیح کوتاه <span class="hint">— ایجنت والد بر اساس این تصمیم می‌گیرد کار را به این ایجنت بسپارد</span></label>
      <input type="text" name="description" value="${esc(a.description)}" />
      <label>دستورالعمل (System Prompt)</label>
      <textarea name="prompt" rows="6">${esc(a.prompt)}</textarea>
      <label>مدل</label>
      <select name="model">${MODELS.map(([v, l]) => `<option value="${v}" ${a.model === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label>زیرمجموعه‌ی</label>
      <select name="parent"><option value="">— (ریشه)</option>${parents.map((p) => `<option value="${p.id}" ${a.parent === p.id ? 'selected' : ''}>${esc(p.icon)} ${esc(p.name)}</option>`).join('')}</select>

      <label>سطح دسترسی</label>
      <div class="radios">${PERMISSIONS.map(([v, l, h]) => `
        <label><input type="radio" name="permission" value="${v}" ${a.permission === v ? 'checked' : ''} /><span>${l}<span class="hint">${h}</span></span></label>`).join('')}
      </div>
      <p class="hint">وقتی این ایجنت کار را به زیرمجموعه‌هایش می‌سپارد، همین سطح دسترسی برای آن‌ها هم اعمال می‌شود.</p>

      <label>ابزارهای مجاز</label>
      <div class="checks">${TOOLS.map(([v, l]) => `
        <label title="${v}"><input type="checkbox" name="tools" value="${v}" ${a.tools.includes(v) ? 'checked' : ''} />${l}</label>`).join('')}
      </div>

      <label>سرورهای MCP <span class="hint">— اتصال به سرویس‌ها (ایمیل، تقویم، …) به‌صورت JSON</span></label>
      <textarea name="mcpServers" class="code" rows="5">${esc(JSON.stringify(a.mcpServers || {}, null, 2))}</textarea>
      <p class="hint">برای ابزارهای MCP، نام آن‌ها را هم در فهرست ابزارها نیاز ندارید؛ همه‌ی ابزارهای سرورهای این‌جا در دسترس ایجنت قرار می‌گیرند.</p>

      <div class="row">
        <button class="primary">ذخیره</button>
        <button type="button" id="add-child">+ ایجنت زیرمجموعه</button>
        <button type="button" id="del-agent" class="danger">حذف ایجنت</button>
      </div>
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
    await api('PUT', `/api/agents/${a.id}`, {
      icon: fd.get('icon'),
      name: fd.get('name'),
      description: fd.get('description'),
      prompt: fd.get('prompt'),
      model: fd.get('model'),
      parent: fd.get('parent') || null,
      permission: fd.get('permission'),
      tools: fd.getAll('tools'),
      mcpServers,
    });
  };
  $('#add-child').onclick = async () => {
    const created = await api('POST', '/api/agents', { parent: a.id });
    tab = 'settings';
    select(created.id);
  };
  $('#del-agent').onclick = async () => {
    if (!confirm(`«${a.name}» حذف شود؟ زیرمجموعه‌هایش به والد آن منتقل می‌شوند.`)) return;
    await api('DELETE', `/api/agents/${a.id}`);
    selectedId = a.parent;
  };
}

// ---------- تأییدها ----------
function renderApprovals() {
  $('#approvals').innerHTML = approvals.map((p) => `
    <div class="approval" data-id="${p.id}">
      <strong>${esc(p.agentName)}</strong>${p.viaSubagent ? ' (از طریق یکی از زیرمجموعه‌ها)' : ''} می‌خواهد ابزار <strong>${esc(p.toolName)}</strong> را اجرا کند
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
    const a = byId(ev.agentId);
    if (ev.type === 'task' && a) {
      const t = a.tasks.find((x) => x.id === ev.task.id);
      if (t) Object.assign(t, ev.task, { log: t.log });
      renderTree();
      if (a.id === selectedId && tab === 'tasks') refreshTask(a, ev.task.id);
    } else if (ev.type === 'log' && a) {
      const t = a.tasks.find((x) => x.id === ev.taskId);
      if (!t) return;
      t.log.push(ev.entry);
      const log = document.querySelector(`#task-list .task[data-id="${t.id}"] .log`);
      if (log && a.id === selectedId) {
        log.insertAdjacentHTML('beforeend', logLine(ev.entry));
        log.scrollTop = log.scrollHeight;
      }
    } else if (ev.type === 'approval') {
      approvals.push(ev.approval);
      renderApprovals();
      renderTree();
    } else if (ev.type === 'approval-done') {
      approvals = approvals.filter((p) => p.id !== ev.id);
      renderApprovals();
      renderTree();
    }
  };
  es.onerror = () => {
    es.close();
    setTimeout(() => { connect(); load(); }, 2000);
  };
}

load().then(connect);
