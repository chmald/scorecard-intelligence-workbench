const $ = (selector) => document.querySelector(selector);
const model = { session: null, state: null, view: 'overview', customerId: '', trendKpiId: '', busy: false, answer: null, evaluation: null, evaluationLoading: false, lastNotice: '' };
const titles = {
  overview: ['Overview', 'From fragmented scorecards to decisions you can stand behind.', 'PERFORMANCE, WITH PROVENANCE'],
  ingest: ['Ingest scorecards', 'Bring the source. Keep the evidence. Start with what is actually there.', '01 / CONNECT YOUR EVIDENCE'],
  review: ['Review queue', 'Verify extracted values against their source before confirming.', '02 / HUMAN IN THE LOOP'],
  publish: ['Approve & publish', 'A deliberate approval. An immutable historical record.', '03 / ACCOUNTABLE BY DESIGN'],
  assistant: ['Evidence assistant', 'Ask a bounded question. Get a traceable answer, or a clear abstention.', 'ANSWERS THAT SHOW THEIR WORK'],
  evaluation: ['Evaluation', 'Measured fixture results, not promises of production accuracy.', 'MEASURE WHAT MATTERS'],
  architecture: ['Architecture & help', 'Understand the boundaries before you trust the output.', 'TRANSPARENT BY DESIGN'],
};

function node(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') element.value = value;
    else if (key === 'disabled' || key === 'hidden' || key === 'selected' || key === 'required') element[key] = Boolean(value);
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined && child !== false) element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

const button = (text, handler, variant = '', attrs = {}) => node('button', { type: 'button', class: `button ${variant}`, onClick: handler, disabled: model.busy, ...attrs }, text);
const badge = (text, tone = 'neutral') => node('span', { class: `badge ${tone}` }, text);
const card = (title, subtitle, content, accessory = null) => node('section', { class: 'card' },
  node('div', { class: 'card-header' }, node('div', {}, node('h2', {}, title), subtitle && node('p', {}, subtitle)), accessory),
  content);
const body = (...content) => node('div', { class: 'card-body' }, ...content);
const empty = (title, description, action = null) => node('div', { class: 'empty-state' }, node('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '◇'), node('h3', {}, title), node('p', {}, description), action);
const label = (id, text) => node('label', { for: id }, text);
const field = (text, control, hint = null) => node('div', { class: 'form-field' }, label(control.id, text), control, hint && node('p', { class: 'form-hint' }, hint));
const all = (key) => Array.isArray(model.state?.[key]) ? model.state[key] : [];
const scoped = (key) => all(key).filter(item => !model.customerId || item.customerId === model.customerId);
const records = () => scoped('records');
const canEdit = () => ['reviewer', 'manager'].includes(model.session?.user?.role);
const manager = () => model.session?.user?.role === 'manager';
const local = () => ['local', 'demo', 'synthetic'].includes(model.session?.authMode);
const customerName = (id) => all('customers').find(customer => customer.id === id)?.name || 'Unmapped entity';
const entityLabel = () => model.session?.config?.entityLabel || 'Entity';
const period = () => model.session?.config?.period || records()[0]?.period || '';
const kpis = () => model.session?.config?.kpis || all('kpis');
const isPublished = (record) => all('published').some(snapshot => snapshot.customerId === record.customerId && snapshot.period === record.period);
const pct = (value) => Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100)}%` : 'Not available';
const pretty = (value) => typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? 'Not available');
const readable = (key) => String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, char => char.toUpperCase());
const formatDate = (date) => {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? String(date || 'Date unavailable') : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
};
const valueText = (record) => record.value === null || record.value === undefined || record.value === '' ? 'Not reported' : `${record.value}${record.unit === '%' ? '' : ' '}${record.unit || ''}`.trim();
const statusTone = (status) => /good|target|track|pass|healthy|success/i.test(status) ? 'success' : /critical|risk|fail|breach|red/i.test(status) ? 'danger' : /watch|warning|missing|review/i.test(status) ? 'warning' : 'neutral';
const statusLabel = status => model.session?.config?.statusLabels?.[status] || ({ on_target: 'On Track', watch: 'On Track (watch)', warning: 'Warning', critical: 'Off Track', missing: 'Not Measured', uncertain: 'Not Measured', unknown: 'Not Measured' })[status] || 'Not Measured';
const extractionMode = (mode) => /local/i.test(mode || '') ? 'Local · real text / cell extraction' : /content-understanding/i.test(mode || '') ? 'Azure · Content Understanding' : 'Extraction mode not reported';

async function api(path, options = {}) {
  const token = bearer();
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  let data;
  try { data = await response.json(); } catch { throw new Error(`The server returned an unreadable response (${response.status}).`); }
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function notice(text) {
  model.lastNotice = text;
  $('#status').textContent = text;
}

function showError(error) {
  const target = $('#error');
  target.textContent = error?.message || String(error);
  if (error?.status === 401 && model.session?.authMode === 'entra') target.append(node('p', {}, button('Sign in with Microsoft', () => beginSignIn().catch(showError), 'small')));
  target.hidden = false;
  target.tabIndex = -1;
  target.focus();
}

async function run(task, success) {
  if (model.busy) return;
  const active = document.activeElement;
  const focusLabel = active?.getAttribute('aria-label');
  const focusId = active?.id;
  const previousAnswer = model.answer;
  model.busy = true;
  $('#error').hidden = true;
  $('#workspace').setAttribute('aria-busy', 'true');
  const controls = [...document.querySelectorAll('button:not([role="tab"]), input, textarea, #role-switch, #customer-filter')];
  const disabled = new Map(controls.map(control => [control, control.disabled]));
  controls.forEach(control => { control.disabled = true; });
  notice('Working… Your request is being validated by the server.');
  try {
    await task();
    if (success) notice(success);
  } catch (error) {
    notice('');
    showError(error);
  } finally {
    model.busy = false;
    $('#workspace').removeAttribute('aria-busy');
    controls.forEach(control => { if (control.isConnected) control.disabled = disabled.get(control); });
    render();
    if (model.answer && model.answer !== previousAnswer) $('[data-testid="evidence-answer"]')?.focus({ preventScroll: true });
    else {
      const restore = focusId ? document.getElementById(focusId) : focusLabel ? document.querySelector(`[aria-label="${CSS.escape(focusLabel)}"]`) : null;
      if (restore && !restore.disabled) restore.focus({ preventScroll: true });
      else if (!document.activeElement || document.activeElement === document.body) $('#workspace').focus({ preventScroll: true });
    }
  }
}

async function refresh() {
  model.state = await api('/api/state');
  updateShell();
}

function providerLabel(kind) {
  const value = model.state?.provider?.[kind] ?? model.session?.provider?.[kind] ?? 'unavailable';
  return typeof value === 'object' ? value.mode || value.name || value.provider || pretty(value) : String(value);
}

function providerIsLocal(kind) {
  return /local|deterministic/i.test(providerLabel(kind));
}

function updateShell() {
  const { session } = model;
  if (!session) return;
  document.title = session.config?.title || 'Performance Intelligence Workbench';
  $('#user-name').textContent = session.user?.name || 'Authenticated user';
  $('#user-role').textContent = `${readable(session.user?.role || 'authorized')} · ${local() ? 'demo session' : 'Entra session'}`;
  $('#user-avatar').textContent = (session.user?.name || 'AU').split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
  $('#environment-label').replaceChildren(node('span', { class: 'status-dot' }), local() ? 'SYNTHETIC · LOCAL DEMO' : 'ENTRA · SECURED SESSION');
  $('#period-label').textContent = period() || 'No period';
  $('#footer-provider').textContent = `${providerIsLocal('extraction') ? 'Local extraction' : `Extraction: ${providerLabel('extraction')}`} · ${providerIsLocal('answer') ? 'Deterministic answers · not an LLM' : `Answers: ${providerLabel('answer')}`}`;
  $('#queue-count').textContent = String(all('records').filter(record => !record.confirmed).length);
  const select = $('#role-switch');
  select.hidden = !local();
  if (local()) {
    select.replaceChildren(...(session.roles?.length ? session.roles : [{ id: 'reviewer', label: 'Reviewer' }, { id: 'manager', label: 'Manager' }, { id: 'auditor', label: 'Auditor' }]).map(role => node('option', { value: role.id, selected: role.id === session.user.role }, `Demo: ${role.label}`)));
  }
  const filter = $('#customer-filter');
  if (model.customerId && !all('customers').some(customer => customer.id === model.customerId)) model.customerId = '';
  filter.replaceChildren(node('option', { value: '' }, `All visible ${entityLabel().toLowerCase()}s`), ...all('customers').map(customer => node('option', { value: customer.id, selected: customer.id === model.customerId }, customer.name)));
  filter.value = model.customerId;
  filter.setAttribute('aria-label', `${entityLabel()} scope`);
}

function navigate(view, { focus = true } = {}) {
  if (!titles[view]) view = 'overview';
  if (!model.busy) notice('');
  model.view = view;
  history.replaceState(null, '', `#${view}`);
  document.querySelectorAll('[data-view]').forEach(tab => {
    const active = tab.dataset.view === view;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  for (const key of Object.keys(titles)) $(`#panel-${key}`).hidden = key !== view;
  const [title, description, eyebrow] = titles[view];
  $('#page-title').textContent = title;
  $('#page-description').textContent = description;
  $('#page-eyebrow').textContent = eyebrow;
  $('#breadcrumb-current').textContent = title;
  render();
  if (focus) $('#workspace').focus({ preventScroll: true });
  if (view === 'evaluation' && !model.evaluation && !model.evaluationLoading) loadEvaluation();
}

function render() {
  if (!model.session || !model.state) return;
  const panels = { overview: overview, ingest, review, publish, assistant, evaluation, architecture };
  const target = $(`#panel-${model.view}`);
  target.replaceChildren();
  if (model.session.user?.role === 'auditor') target.append(node('p', { class: 'scope-notice', 'data-testid': 'auditor-notice' }, 'Auditor view · Read-only. Only server-authorized evidence is available. Hidden content is excluded before answers and calculations.'));
  target.append(panels[model.view]());
}

function sourceLink(documentId, text = 'Open source ↗') {
  return documentId ? node('a', { class: 'source-link', href: `/api/documents/${encodeURIComponent(documentId)}/source`, target: '_blank', rel: 'noopener', onClick: event => {
    const token = bearer();
    if (!token && model.session?.authMode !== 'entra') return;
    event.preventDefault();
    if (!token) { const error = new Error('Your API session has expired. Sign in again to open this source.'); error.status = 401; showError(error); return; }
    downloadSource(documentId, token).catch(showError);
  } }, text) : node('span', { class: 'muted tiny' }, 'Source unavailable');
}

async function downloadSource(documentId, token) {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/source`, { credentials: 'same-origin', headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) { const error = new Error('The source could not be opened. Check your session and document access.'); error.status = response.status; throw error; }
  const url = URL.createObjectURL(await response.blob());
  const name = all('documents').find(document => document.id === documentId)?.name || 'source-document';
  const link = node('a', { href: url, download: name.replace(/[\\/:*?"<>|]/g, '_') });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  notice('Authenticated source downloaded. The access token was not placed in the URL.');
}

function heroVisual() {
  return node('div', { class: 'hero-visual', 'aria-hidden': 'true' },
    node('div', { class: 'visual-orbit' }), node('div', { class: 'visual-orbit' }),
    node('div', { class: 'visual-sheet' }, node('div', { class: 'sheet-eyebrow' }), node('div', { class: 'sheet-title' }), node('div', { class: 'sheet-bars' }, ...Array.from({ length: 5 }, () => node('span'))), node('div', { class: 'sheet-line' }), node('div', { class: 'sheet-line' })),
    node('div', { class: 'visual-check' }, '✓'),
    node('div', { class: 'visual-chip one' }, node('span', { class: 'chip-square' }, '✓'), node('div', {}, node('b', {}, 'Source linked'), node('small', {}, 'Evidence you can inspect'))),
    node('div', { class: 'visual-chip two' }, node('span', {}, '✧'), node('div', {}, node('b', {}, 'Human verified'), node('small', {}, 'No silent approvals'))));
}

function metric(title, value, note, icon, tone = '', noteTone = '') {
  return node('article', { class: `metric-card ${tone}` }, node('div', { class: 'metric-label' }, title, node('span', { class: 'metric-icon', 'aria-hidden': 'true' }, icon)), node('div', { class: 'metric-value' }, value), node('div', { class: `metric-note ${noteTone}` }, note));
}

function overview() {
  const visible = records();
  const confirmed = visible.filter(record => record.confirmed).length;
  const outstanding = visible.filter(record => !record.confirmed && !isPublished(record)).length;
  const snapshots = scoped('published');
  const panel = node('div', {},
    node('section', { class: 'hero', 'aria-label': 'Evidence-first workbench introduction' },
      node('div', { class: 'hero-copy' },
        node('p', { class: 'eyebrow' }, node('span', { class: 'status-dot' }), 'LESS SPREADSHEET CHASING. MORE CERTAINTY.'),
        node('h2', {}, 'Turn scorecards into', node('br'), 'confident next steps.'),
        node('p', {}, 'One connected path from source documents to verified KPIs, approved actions, and a defensible performance history.'),
        node('div', { class: 'hero-actions' },
          button(visible.length ? 'Continue reviewing  →' : 'Load synthetic scorecards  ↗', visible.length ? () => navigate('review') : () => loadSamples(), 'primary', { disabled: model.busy || (!visible.length && !canEdit()) }),
          button('Explore the workflow', () => navigate('architecture'), 'ghost'))), heroVisual()),
    node('div', { class: 'metrics' },
      metric('Source documents', String(scoped('documents').length), 'Actual PDF, XLSX, CSV & text inputs', '▤'),
      metric('Extracted KPI values', String(visible.length), `${kpis().length} configured performance measures`, '▥', 'purple'),
      metric('Awaiting review', String(outstanding), outstanding ? 'Human verification required' : 'No unconfirmed values in this scope', '◷', 'amber'),
      metric('Verified evidence', visible.length ? pct(confirmed / visible.length) : '—', `${confirmed} of ${visible.length} values confirmed`, '✓', 'teal', confirmed ? 'positive' : '')),
    node('div', { class: 'grid-two' },
      node('div', { class: 'stack' }, performanceCard(), documentsCard(true)),
      node('div', { class: 'stack' }, workflowCard(), coverageCard(visible, snapshots))),
    node('div', { class: 'grid-equal mt-20' }, trendCard(), internalSignalsCard()),
    providerStrip());
  return panel;
}

function trendCard() {
  const rows = scoped('trends');
  const customerId = model.customerId || rows[0]?.customerId;
  const kpiId = kpis().some(kpi => kpi.id === model.trendKpiId) ? model.trendKpiId : kpis()[0]?.id;
  const kpi = kpis().find(item => item.id === kpiId);
  const values = rows.filter(row => row.customerId === customerId && row.kpiId === kpiId && row.value !== null && Number.isFinite(Number(row.value))).sort((a, b) => String(a.period).localeCompare(String(b.period))).slice(-12);
  const select = node('select', { id: 'trend-kpi', 'aria-label': 'Trend measure', onChange: event => { model.trendKpiId = event.target.value; render(); } }, ...kpis().map(item => node('option', { value: item.id, selected: item.id === kpiId }, item.name)));
  if (!values.length) return card('Internal trend reference', 'Synthetic internal data · separate from published history', empty('No visible trend reference', 'No historical values are inferred from the current scorecard.'), select);
  const minimum = Math.min(...values.map(row => Number(row.value)));
  const maximum = Math.max(...values.map(row => Number(row.value)));
  const point = (row, index) => [20 + index / Math.max(1, values.length - 1) * 360, 98 - (Number(row.value) - minimum) / (maximum - minimum || 1) * 65];
  const svgNode = (tag, attrs = {}, text) => {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const chart = svgNode('svg', { viewBox: '0 0 400 132', role: 'img', 'aria-label': `Synthetic internal ${kpi?.name || 'measure'} trend for ${customerName(customerId)}. ${values.map(row => `${row.period}: ${row.value} ${row.unit || ''}`).join('; ')}` });
  chart.append(svgNode('line', { x1: 20, y1: 109, x2: 380, y2: 109, stroke: '#e5eaf3' }),
    svgNode('polyline', { points: values.map((row, index) => point(row, index).join(',')).join(' '), fill: 'none', stroke: '#159e8e', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    ...values.map((row, index) => { const [cx, cy] = point(row, index); return svgNode('circle', { cx, cy, r: 4, fill: '#fff', stroke: '#159e8e', 'stroke-width': 2 }); }),
    svgNode('text', { x: 20, y: 128, fill: '#7c8aa0', 'font-size': 10 }, values[0].period),
    svgNode('text', { x: 380, y: 128, fill: '#7c8aa0', 'font-size': 10, 'text-anchor': 'end' }, values.at(-1).period));
  return card('Internal trend reference', 'Synthetic internal data · not published historical performance', body(
    node('div', { class: 'list-heading' }, node('span', { class: 'small-text entity-name' }, customerName(customerId)), badge('Synthetic reference', 'purple')),
    node('p', { class: 'form-hint' }, `${kpi?.name || 'Measure'} · latest ${values.at(-1).value} ${values.at(-1).unit || ''}`),
    chart,
    node('p', { class: 'form-hint' }, 'Relative vertical scale, not a target comparison. Use the scope filter to inspect another entity.'),
    node('details', { class: 'mt-13' }, node('summary', { class: 'small-text' }, 'Inspect trend values & provenance'), node('ul', { class: 'list-clean' }, ...values.map(row => node('li', {}, `${row.period}: ${row.value} ${row.unit || ''}`, node('div', { class: 'tiny muted' }, row.provenance || 'Provenance not reported')))))), select);
}

function internalSignalsCard() {
  const momentum = scoped('momentum');
  const escalations = scoped('escalations');
  return card('Internal signals & escalation context', 'Server-returned context · never an automatic action', body(
    momentum.length ? node('ul', { class: 'list-clean' }, ...momentum.map(item => node('li', {},
      node('div', { class: 'list-heading' }, node('span', { class: 'entity-name' }, customerName(item.customerId)), badge(`${pretty(item.value)} · ${item.synthetic ? 'synthetic' : 'internal reference'}`, 'purple')),
      node('p', { class: 'form-hint' }, item.label || 'Internal momentum reference'),
      node('p', { class: 'form-hint' }, item.provenance || 'Provenance not reported. Do not treat as a source-derived score.')))) : node('p', { class: 'form-hint' }, 'No visible internal momentum reference. No aggregate is inferred.'),
    escalations.length ? node('details', { class: 'mt-13' }, node('summary', { class: 'small-text' }, 'Inspect escalation context'), node('ul', { class: 'list-clean' }, ...escalations.map(item => node('li', {},
      node('div', { class: 'list-heading' }, node('strong', {}, customerName(item.customerId)), badge(`${readable(item.status)}${item.synthetic ? ' · synthetic' : ''}`, 'warning')),
      node('p', {}, item.text), node('p', { class: 'form-hint' }, item.provenance || 'Provenance not reported.'))))) : node('p', { class: 'form-hint mt-13' }, 'No visible escalation context.'),
    node('p', { class: 'form-hint mt-13' }, 'These internal references do not replace evidence review, source ratings, published snapshots, or a human-approved action.')));
}

function performanceCard() {
  const visible = records();
  const entities = all('customers').filter(customer => !model.customerId || customer.id === model.customerId);
  const content = visible.length ? node('div', { class: 'table-wrap' },
    node('table', { class: 'overview-table' }, node('caption', { class: 'sr-only' }, 'Visible extracted KPI values by entity. Values are not inferred when missing.'),
      node('thead', {}, node('tr', {}, node('th', { scope: 'col' }, entityLabel()), ...kpis().map(kpi => node('th', { scope: 'col' }, kpi.name)), node('th', { scope: 'col' }, 'Review'))),
      node('tbody', {}, ...entities.map(customer => {
        const rows = visible.filter(record => record.customerId === customer.id);
        return node('tr', {}, node('th', { scope: 'row', class: 'entity-name' }, customer.name),
          ...kpis().map(kpi => {
                    const matches = rows.filter(item => item.kpiId === kpi.id);
                    const record = matches[0];
                    const alternatives = [...new Set(matches.map(item => valueText(item)))];
                    if (alternatives.length > 1) return node('td', {}, node('span', { class: 'number' }, 'Multiple values'), node('span', { class: 'entity-sub' }, alternatives.join(' / ')), node('span', { class: 'entity-sub' }, 'Conflicting sources · review each'));
                    return node('td', {}, record ? node('span', { class: 'number' }, valueText(record)) : node('span', { class: 'muted' }, 'Not reported'), record && node('div', {}, badge(statusLabel(record.status), statusTone(record.status || ''))));
          }),
          node('td', {}, rows.length ? badge(rows.every(record => record.confirmed) ? 'Confirmed' : 'In review', rows.every(record => record.confirmed) ? 'success' : 'purple') : badge('No evidence')));
      })))) : empty('Your evidence starts here', 'Load the synthetic pack or upload your own scorecard to see the reviewable performance picture.', canEdit() && button('Add scorecards', () => navigate('ingest'), 'small'));
  return card('Performance at a glance', 'Current visible evidence · no estimated or filled-in values', node('div', {}, content, node('p', { class: 'section-note' }, 'Badges show internal rules, not source ratings. Conflicting source values are not collapsed into a single KPI. Inspect source ratings, baselines, and assessment details in the review queue.')), button('Review evidence →', () => navigate('review'), 'link'));
}

function workflowCard() {
  const visible = records();
  const complete = [visible.length > 0, visible.length > 0 && visible.every(record => record.confirmed), scoped('published').length > 0];
  return card('Your path to publish', 'Three deliberate steps. No silent decisions.', body(
    node('ol', { class: 'workflow' }, ...[
      ['Ingest source documents', 'Extract real text and cells; preserve source links.', 'ingest'],
      ['Verify the evidence', 'Correct, then confirm every extracted KPI.', 'review'],
      ['Approve & publish', 'Manager approves; publication locks the period.', 'publish'],
    ].map(([title, description, view], index) => node('li', { class: complete[index] ? 'complete' : index === complete.findIndex(value => !value) ? 'active' : '' }, node('span', { class: 'step-number' }, complete[index] ? '✓' : `0${index + 1}`), node('div', { class: 'step-copy' }, node('strong', {}, title), node('p', {}, description), button('Open →', () => navigate(view), 'link')))))));
}

function coverageCard(visible, snapshots) {
  const confirmed = visible.filter(record => record.confirmed).length;
  const actions = scoped('actions');
  return card('Decision readiness', 'A small, transparent control surface', body(
    node('div', { class: 'coverage-row' }, node('span', {}, 'Evidence verified'), node('strong', {}, `${confirmed} / ${visible.length}`)),
    node('progress', { class: 'verification-progress', 'aria-label': 'Visible evidence verification', max: visible.length || 1, value: confirmed }),
    node('div', { class: 'coverage-row' }, node('span', {}, 'Published snapshots'), node('strong', {}, snapshots.length)),
    node('div', { class: 'coverage-row' }, node('span', {}, 'Action proposals'), node('strong', {}, actions.length)),
    node('p', { class: 'small-text muted' }, 'Counts reflect only the evidence this session is authorized to see.'),
    button('Ask your evidence  ✧', () => navigate('assistant'), 'small')));
}

function providerStrip() {
  return node('div', { class: 'provider-strip' }, node('strong', {}, 'PROVIDER TRANSPARENCY'),
    badge(providerIsLocal('extraction') ? 'Local text / cell extraction' : `Extraction: ${providerLabel('extraction')}`, 'success'),
    badge(providerIsLocal('answer') ? 'Local deterministic Q&A · not an LLM' : `Answers: ${providerLabel('answer')}`, 'purple'),
    node('span', {}, providerIsLocal('extraction') ? 'No OCR, scan recognition, or chart interpretation in local mode.' : 'Content Understanding extracts fields; native structured files stay local. Verify every source.'));
}

async function loadSamples() {
  await run(async () => { await api('/api/samples/load', { method: 'POST', body: { scenario: 'monthly-scorecards' } }); model.answer = null; model.evaluation = null; await refresh(); }, 'Synthetic source pack extracted. Review each value against its evidence before confirming.');
}

function ingest() {
  if (!canEdit()) return node('div', {}, node('div', { class: 'callout info' }, 'This is a read-only session. Switch to a local reviewer or manager session to ingest evidence.'), documentsCard());
  const fileInput = node('input', { type: 'file', id: 'source-file', accept: (model.session.config?.acceptedFileTypes || ['.pdf', '.xlsx', '.csv', '.txt', '.json']).join(','), required: true });
  const customer = node('select', { id: 'upload-customer' }, node('option', { value: '' }, 'Unassigned workspace'), ...all('customers').map(item => node('option', { value: item.id, selected: item.id === model.customerId }, item.name)));
  const periodInput = node('input', { type: 'month', id: 'upload-period', value: period() });
  const upload = node('form', { onSubmit: async event => {
    event.preventDefault();
    const file = fileInput.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { showError(new Error('Choose a file no larger than 10 MiB. The server also enforces format-specific limits.')); return; }
    await run(async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      const payload = { name: file.name, mediaType: file.type || 'application/octet-stream', contentBase64: btoa(binary) };
      if (customer.value) payload.customerId = customer.value;
      if (periodInput.value) payload.period = periodInput.value;
      const result = await api('/api/documents', { method: 'POST', body: payload });
      await refresh();
      const warnings = result.warnings?.length ? ` ${result.warnings.map(pretty).join(' ')}` : '';
      notice(`Uploaded ${file.name}. ${result.records?.length || 0} values extracted.${warnings}`);
    });
  } },
  node('div', { class: 'dropzone', onDragOver: event => { event.preventDefault(); event.currentTarget.classList.add('drag-over'); }, onDragLeave: event => event.currentTarget.classList.remove('drag-over'), onDrop: event => {
    event.preventDefault(); event.currentTarget.classList.remove('drag-over');
    if (event.dataTransfer?.files?.length) { fileInput.files = event.dataTransfer.files; fileInput.dispatchEvent(new Event('change')); }
  } }, node('div', { class: 'upload-icon', 'aria-hidden': 'true' }, '↥'), node('h3', {}, 'Your next insight starts with a source.'), node('p', {}, 'Choose a separately authorized scorecard or drop one here. Text-bearing documents only in local mode.'),
  node('p', { class: 'form-hint' }, `Available formats: ${(model.session.config?.acceptedFileTypes || []).join(', ')}. Never upload mixed restricted content.`),
  label('source-file', 'Scorecard file'), node('br'), fileInput),
  node('div', { class: 'form-grid' }, field(`${entityLabel()} mapping`, customer, 'Select an existing entity, or keep the upload in an unassigned workspace.'), field('Reporting period', periodInput, 'Evidence remains attached to its reporting period.')),
  node('div', { class: 'inline-space' }, node('button', { type: 'submit', class: 'button primary', disabled: model.busy }, 'Upload & extract'), node('p', { class: 'form-hint' }, 'No automatic confirmation or publication.')));
  return node('div', {}, node('div', { class: 'grid-equal' },
    card('Upload a scorecard', 'Your file → actual server extraction → review queue', body(upload)),
    card('Or start with synthetic evidence', 'A reproducible, non-customer sample pack', body(
      node('p', { class: 'small-text muted' }, 'Load generated source files through the same ingestion pipeline as an upload. Compare formats, inspect extraction confidence signals, and rehearse the approval story.'),
      node('div', { class: 'sample-formats' }, ...['PDF', 'XLSX', 'CSV', 'TEXT'].map(format => node('span', { class: 'format-tile' }, format))),
      node('div', { class: 'callout info' }, 'Synthetic data only. Local extraction reads PDF text and spreadsheet cells. It does not recognize scanned pages or chart images.'),
      button('Load synthetic scorecards', () => loadSamples(), 'purple'),
      node('p', { class: 'form-hint mt-13' }, 'Loading is a server operation. Existing published history cannot be overwritten.')))),
    node('div', { class: 'mt-20' }, documentsCard()), providerStrip());
}

function documentsCard(compact = false) {
  const documents = scoped('documents');
  return card('Source library', `${documents.length} visible document${documents.length === 1 ? '' : 's'} · authenticated source access`,
    documents.length ? node('div', { class: 'table-wrap' }, node('table', {}, node('caption', { class: 'sr-only' }, 'Ingested source documents'),
      node('thead', {}, node('tr', {}, ...['Document', 'Format', 'Period', 'Evidence'].map(title => node('th', { scope: 'col' }, title)))),
      node('tbody', {}, ...(compact ? documents.slice(0, 4) : documents).map(document => node('tr', {},
        node('td', {}, node('span', { class: 'entity-name' }, document.name), node('span', { class: 'entity-sub' }, customerName(document.customerId))),
        node('td', {}, badge(String(document.format || document.name?.split('.').pop() || 'file').toUpperCase()), node('span', { class: 'entity-sub' }, extractionMode(document.mode))),
        node('td', {}, document.period || 'Not reported'),
        node('td', {}, sourceLink(document.id))))))) : empty('No sources yet', 'Add a file to establish an inspectable evidence trail.'),
    compact ? button('View all →', () => navigate('ingest'), 'link') : null);
}

function review() {
  const visible = records();
  const pending = visible.filter(record => !record.confirmed).length;
  const top = node('div', { class: 'review-meta' }, badge(`${visible.length} visible values`), badge(`${pending} awaiting confirmation`, pending ? 'warning' : 'success'), badge('Confidence = extraction signal, not accuracy', 'purple'));
  if (!visible.length) return node('div', {}, top, card('Evidence review', 'Nothing is confirmed automatically', empty('No extracted values to review', 'Load synthetic scorecards or upload a supported document.', canEdit() && button('Go to ingest', () => navigate('ingest'), 'primary'))));
  const table = node('table', { class: 'review-table' },
    node('caption', {}, 'Inspect the source, correct a value if needed, save the correction, and confirm it separately. A correction invalidates prior confirmation and approval. Published evidence is read-only.'),
    node('thead', {}, node('tr', {}, ...[entityLabel() + ' / KPI', 'Extracted value', 'Source evidence', 'Signal / status', 'Human review'].map(title => node('th', { scope: 'col' }, title)))),
    node('tbody', {}, ...visible.map(record => reviewRow(record))));
  return node('div', {}, top, card('Verify the numbers. Keep the provenance.', 'Every confirmation is recorded by the server', node('div', { class: 'table-wrap' }, table)), providerStrip());
}

function reviewRow(record) {
  const locked = isPublished(record);
  const editable = canEdit() && !locked;
  const id = `record-${record.id}`;
  const input = node('input', { id: `${id}-value`, class: 'value-input', type: 'text', inputmode: 'decimal', value: record.value ?? '', disabled: !editable || model.busy, 'aria-label': `${record.kpiName} value for ${customerName(record.customerId)}` });
  const unit = node('input', { id: `${id}-unit`, class: 'value-input', type: 'text', maxlength: 30, value: record.unit || '', placeholder: 'Unit', disabled: !editable || model.busy, 'aria-label': `${record.kpiName} unit for ${customerName(record.customerId)}` });
  const comment = node('input', { id: `${id}-comment`, class: 'comment-input', type: 'text', maxlength: 500, value: record.comment || '', placeholder: 'Reason for correction (optional)', disabled: !editable || model.busy, 'aria-label': `Correction comment for ${record.kpiName} for ${customerName(record.customerId)}` });
  const controls = editable ? node('div', { class: 'record-tools' },
    button('Save correction', () => run(async () => {
      const normalized = input.value.trim().replace(',', '.');
      const value = Number(normalized);
      if (!normalized || !Number.isFinite(value)) throw new Error('Enter a finite number supported by the source. Missing values cannot be confirmed until resolved.');
      await api(`/api/records/${encodeURIComponent(record.id)}`, { method: 'PATCH', body: { value, unit: unit.value.trim(), comment: comment.value.trim(), expectedVersion: record.version } });
      await refresh();
    }, 'Correction saved. Confirmation and any prior period approval have been cleared. Confirm the corrected evidence again.'), 'small', { 'aria-label': `Save correction for ${record.kpiName} for ${customerName(record.customerId)}` }),
    button(record.confirmed ? 'Confirmed ✓' : 'Confirm value', () => run(async () => {
      await api(`/api/records/${encodeURIComponent(record.id)}/confirm`, { method: 'POST', body: {} });
      await refresh();
    }, `${record.kpiName} confirmed against source evidence.`), 'small primary', { disabled: model.busy || record.confirmed || record.value === null || !kpis().some(kpi => kpi.id === record.kpiId && kpi.unit === record.unit), 'aria-label': `Confirm ${record.kpiName} for ${customerName(record.customerId)}` }))
    : badge(locked ? 'Published · locked' : record.confirmed ? 'Confirmed' : 'Read-only', locked || record.confirmed ? 'success' : 'neutral');
  const evidence = record.source || {};
  const document = all('documents').find(document => document.id === record.documentId);
  const location = [evidence.page && `Page ${evidence.page}`, evidence.cell && `Cell ${evidence.cell}`, evidence.row && `Row ${evidence.row}`].filter(Boolean).join(' · ');
  const reportedRating = record.customerRating ?? record.sourceRating;
  return node('tr', { 'data-record-id': record.id },
    node('th', { scope: 'row', class: 'entity-name' }, record.kpiName || kpis().find(kpi => kpi.id === record.kpiId)?.name || 'Configured KPI', node('span', { class: 'entity-sub' }, customerName(record.customerId)), node('span', { class: 'entity-sub' }, record.period)),
    node('td', {}, editable ? node('div', { class: 'review-value' }, input, unit) : node('span', { class: 'number' }, valueText(record)), editable && node('div', { class: 'record-comment' }, comment), node('span', { class: 'entity-sub' }, `Source value: ${pretty(record.rawValue)}`), !editable && record.comment && node('p', { class: 'form-hint' }, `Review note: ${record.comment}`)),
    node('td', { class: 'record-evidence' }, sourceLink(record.documentId, evidence.file || 'Open source ↗'), location && node('span', { class: 'entity-sub' }, location), node('span', { class: 'entity-sub' }, extractionMode(document?.mode)), node('details', {}, node('summary', {}, 'Inspect extracted evidence'), node('blockquote', { class: 'evidence-quote' }, evidence.text || 'No source excerpt available. Inspect the original document.'),
      ...Object.entries(evidence.fields || {}).filter(([, field]) => field.spans?.length).map(([name, field]) => node('p', { class: 'tiny' }, `${name}: “${field.text}” · ${pct(field.confidence)} field confidence · ${field.spans.map(span => `span ${span.offset}+${span.length}`).join(', ')}${field.regions?.length ? ` · ${field.regions.map(region => `page ${region.page} (${region.coordinates.join(', ')} ${region.unit || ''})`).join('; ')}` : ''}`))),
      node('span', { class: 'entity-sub' }, 'Source rating · as reported'), reportedRating === null || reportedRating === undefined || reportedRating === '' ? node('span', { class: 'tiny muted' }, 'Not reported') : badge(pretty(reportedRating))),
    node('td', {}, badge(`${pct(record.confidence)} signal`, record.status === 'uncertain' ? 'warning' : 'neutral'), node('span', { class: 'entity-sub' }, record.confidenceSignal), node('div', { class: 'mt-7' }, node('span', { class: 'entity-sub' }, 'Internal rule result'), badge(statusLabel(record.status), statusTone(record.status || ''))), assessmentDetails(record), node('span', { class: 'entity-sub' }, `Version ${record.version ?? '—'}`)),
    node('td', {}, controls));
}

function assessmentDetails(record) {
  const baseline = record.baselineComparison;
  const assessment = record.assessment;
  const rule = kpis().find(kpi => kpi.id === record.kpiId);
  const supporting = (assessment?.evidenceIds || []).map(id => all('records').find(item => item.id === id)).filter(Boolean);
  const accumulation = assessment?.accumulation || rule?.accumulation;
  const annual = assessment?.ruleType === 'annual_cumulative' || rule?.direction === 'annual_cumulative';
  const annualFacts = annual && node('dl', { class: 'assessment-facts' },
    node('dt', {}, 'Year'), node('dd', {}, pretty(assessment?.year || String(record.period).slice(0, 4))),
    node('dt', {}, 'Annual limit'), node('dd', {}, `${pretty(assessment?.annualLimit ?? rule?.annualLimit)} ${record.unit || ''}`),
    node('dt', {}, 'Supported total'), node('dd', {}, assessment?.annualTotal === null || assessment?.annualTotal === undefined ? 'Not measured' : `${assessment.annualTotal} ${record.unit || ''}`),
    node('dt', {}, 'Accumulation'), node('dd', {}, accumulation === 'reported_ytd' ? 'Reported year-to-date' : accumulation === 'monthly_sum' ? 'Complete monthly sum' : 'Not configured'));
  return node('details', { class: 'assessment-details' },
    node('summary', {}, 'Rules & comparison'),
    annualFacts,
    !annual && rule && node('p', { class: 'tiny muted' }, `${readable(rule.direction)} is better · configured target: ${pretty(rule.target)} ${rule.unit || ''}`),
    assessment && node('p', { class: 'assessment-copy' }, typeof assessment === 'object' ? assessment.explanation || 'No assessment explanation reported.' : assessment),
    node('strong', { class: 'tiny' }, 'Internal baseline comparison'),
    baseline?.available === false ? node('p', { class: 'tiny muted' }, baseline.explanation || 'No internal baseline comparison available. No gap inferred.')
      : baseline && typeof baseline === 'object' ? node('div', {},
        badge(baseline.synthetic ? 'Synthetic internal baseline' : 'Configured internal baseline', 'purple'),
        node('dl', { class: 'assessment-facts' }, node('dt', {}, 'Baseline'), node('dd', {}, `${pretty(baseline.baseline)} ${baseline.unit || ''}`), node('dt', {}, 'Arithmetic gap'), node('dd', {}, baseline.gap === null || baseline.gap === undefined ? 'Not inferred' : `${baseline.gap} ${baseline.unit || ''}`)),
        node('p', { class: 'tiny muted' }, baseline.provenance || 'Provenance not reported.'),
        node('p', { class: 'tiny muted' }, 'A baseline comparison is not an overall customer score.'))
        : node('p', { class: 'tiny muted' }, baseline ? pretty(baseline) : 'No internal baseline comparison available. No gap inferred.'),
    supporting.length > 0 && node('details', { class: 'mt-7' }, node('summary', {}, 'Supporting source evidence'), node('ul', { class: 'list-clean' }, ...supporting.map(item => node('li', {}, sourceLink(item.documentId, item.source?.file || 'Source evidence'))))));
}

function publish() {
  const customers = all('customers').filter(customer => !model.customerId || customer.id === model.customerId);
  const groups = customers.flatMap(customer => [...new Set(all('records').filter(record => record.customerId === customer.id).map(record => record.period))].map(month => ({ customer, month })));
  const content = groups.length ? node('div', { class: 'grid-equal' }, ...groups.map(({ customer, month }) => {
    const rows = all('records').filter(record => record.customerId === customer.id && record.period === month);
    const confirmed = rows.filter(record => record.confirmed).length;
    const complete = rows.every(record => record.assessment?.complete !== false);
    const published = all('published').find(item => item.customerId === customer.id && item.period === month);
    const approval = model.state?.approvals?.[`${customer.id}:${month}`];
    return node('section', { class: 'card publish-card', 'aria-label': `${customer.name} ${month} publication` },
      node('div', { class: 'publish-top' }, node('h3', {}, customer.name), badge(published ? 'Published · immutable' : approval ? 'Approved · ready to publish' : 'Awaiting manager', published || approval ? 'success' : 'purple')),
      node('p', {}, `${month} · ${rows.length} extracted values`),
      node('div', { class: 'publish-rule' }, node('span', { class: confirmed === rows.length ? 'pass' : 'fail', 'aria-hidden': 'true' }, confirmed === rows.length ? '✓' : '○'), `${confirmed} / ${rows.length} values explicitly confirmed`),
      !complete && node('div', { class: 'publish-rule' }, node('span', { class: 'fail', 'aria-hidden': 'true' }, '○'), 'Incomplete rule evidence. Resolve the assessment before approval.'),
      node('div', { class: 'publish-rule' }, node('span', { class: published || approval ? 'pass' : 'fail', 'aria-hidden': 'true' }, published || approval ? '✓' : '○'), published ? 'Approved and preserved as a historical snapshot' : approval ? `Manager approved ${formatDate(approval.approvedAt)}` : 'Separate manager approval required before publication'),
      published ? node('p', { class: 'small-text muted' }, `Published ${formatDate(published.publishedAt)}. Subsequent corrections to this period are rejected by the server.`)
        : manager() ? node('div', { class: 'publish-actions' },
          button('Approve period', () => run(async () => {
            await api(`/api/periods/${encodeURIComponent(month)}/approve`, { method: 'POST', body: { customerId: customer.id } });
            await refresh();
          }, `${customer.name} / ${month} approved by the manager. Publish separately to create an immutable snapshot.`), 'small', { disabled: model.busy || confirmed !== rows.length || !complete || Boolean(approval) }),
          button('Publish snapshot', () => run(async () => {
            await api(`/api/periods/${encodeURIComponent(month)}/publish`, { method: 'POST', body: { customerId: customer.id } });
            await refresh();
          }, `${customer.name} / ${month} published. Its evidence and rule snapshot are now immutable.`), 'small primary', { disabled: model.busy || confirmed !== rows.length || !complete || !approval }))
          : node('p', { class: 'form-hint' }, 'Manager identity required. Reviewers verify evidence; auditors have read-only access.'));
  })) : card('Period publication', 'No evidence, no approval', empty('No periods are ready yet', 'Ingest scorecards and confirm their values first.'));
  return node('div', {}, node('div', { class: 'callout info' }, node('strong', {}, 'Two decisions, two server checks. '), 'Approval requires every applicable extracted value to be confirmed. Publication requires valid approval. Edits invalidate approval; published periods reject edits.'), content, snapshotsCard(), auditCard());
}

function snapshotsCard() {
  const snapshots = scoped('published');
  return node('div', { class: 'published-list' }, card('Historical snapshots', 'Immutable values, evidence, and rules captured at publication', snapshots.length ? body(...snapshots.map(snapshot => node('article', { class: 'snapshot', 'data-testid': 'published-snapshot' }, node('div', { class: 'list-heading' }, node('h3', {}, `${customerName(snapshot.customerId)} · ${snapshot.period}`), badge('Locked', 'success')), node('p', {}, `${formatDate(snapshot.publishedAt)} · ${snapshot.records?.length ?? 0} visible records`), node('details', {}, node('summary', { class: 'small-text' }, 'Inspect published values'), node('ul', { class: 'list-clean' }, ...(snapshot.records || []).map(record => node('li', {}, `${record.kpiName || record.kpiId}: ${valueText(record)}`))))))) : empty('No published history', 'Only manager-published snapshots appear here.')));
}

function auditCard() {
  const entries = all('auditLog');
  return node('div', { class: 'mt-20' }, card('Server audit trail', 'Authorization-filtered events · latest visible entries', entries.length ? body(...entries.slice(-12).reverse().map(entry => node('article', { class: 'audit-entry' }, node('strong', {}, readable(entry.type || entry.action || entry.event || 'Event')), node('time', {}, formatDate(entry.at || entry.timestamp || entry.createdAt)), entry.message && node('div', {}, entry.message), entry.actor && node('span', { class: 'muted' }, pretty(entry.actor))))) : empty('No visible events', 'Actions are recorded by the server, not by the browser.')));
}

function assistant() {
  const question = node('textarea', { id: 'evidence-question', required: true, maxlength: 1500, placeholder: 'Ask about a KPI, its source, or a missing value…', 'aria-describedby': 'question-help' });
  const suggestions = kpis().slice(0, 2).map(kpi => `What is the ${kpi.name.toLowerCase()}?`);
  suggestions.push('Who authored these files?');
  const left = node('section', { class: 'card' },
    node('div', { class: 'assistant-intro' }, node('div', { class: 'assistant-spark', 'aria-hidden': 'true' }, '✧'), node('h2', {}, 'Let your evidence answer.'), node('p', {}, 'Answers use only source evidence authorized for this session. Missing or unsupported information should produce an abstention—not an invented number.')),
    node('form', { class: 'question-form', onSubmit: event => {
      event.preventDefault();
      const text = question.value.trim();
      if (!text) return;
      run(async () => {
        model.answer = await api('/api/questions', { method: 'POST', body: { question: text, ...(model.customerId ? { customerId: model.customerId } : {}) } });
      }, 'Answer returned. Inspect the citations and provider mode before relying on it.');
    } }, label('evidence-question', 'Your question'), question,
    node('div', { class: 'question-actions' }, node('span', { id: 'question-help', class: 'tiny muted' }, providerIsLocal('answer') ? 'Local deterministic retrieval · not a language model' : `Provider: ${providerLabel('answer')} · verify all claims`), node('button', { type: 'submit', class: 'button purple', disabled: model.busy }, 'Ask evidence  ↗')),
    node('div', { class: 'suggestion-list', 'aria-label': 'Example questions' }, ...suggestions.map(text => button(text, () => { question.value = text; question.focus(); }, 'suggestion', { class: 'suggestion' })))),
    model.answer && answerCard(model.answer));
  return node('div', {}, node('div', { class: 'assistant-layout' }, left, node('div', { class: 'stack' }, actionDraftCard(), actionsCard())), providerStrip());
}

function answerCard(answer) {
  return node('section', { class: 'answer-block', 'aria-label': 'Evidence answer', 'data-testid': 'evidence-answer', tabIndex: -1 },
    node('div', { class: 'list-heading' }, node('h3', {}, 'Evidence-grounded response'), badge(answer.mode || providerLabel('answer'), 'purple')),
    node('p', { class: 'answer-text' }, answer.answer || 'No supported answer was returned.'),
    Array.isArray(answer.claims) && answer.claims.length > 0 && node('details', {}, node('summary', { class: 'small-text' }, `${answer.claims.length} source-backed claim${answer.claims.length === 1 ? '' : 's'}`), node('ul', { class: 'list-clean' }, ...answer.claims.map(claim => node('li', {}, claim.text, node('div', { class: 'tiny muted' }, `Evidence: ${(claim.evidenceIds || []).join(', ')}`))))),
    answer.citations?.length ? node('div', {}, node('h3', {}, 'Source citations'), node('ol', { class: 'citations' }, ...answer.citations.map(citation => {
      const location = [citation.page && `Page ${citation.page}`, citation.cell && `Cell ${citation.cell}`, citation.row && `Row ${citation.row}`].filter(Boolean).join(' · ');
      return node('li', { class: 'citation' }, node('strong', {}, `${citation.id} · ${pretty(citation.source || 'Source evidence')}`), location && node('div', { class: 'muted' }, location), node('p', {}, citation.text || 'Inspect the original source for context.'), sourceLink(citation.documentId));
    }))) : node('p', { class: 'form-hint' }, 'No supporting citations. Treat this as an abstention, not a measured result.'),
    answer.hiddenItems && node('p', { class: 'form-hint' }, 'Some information is outside this session’s access scope. It was not used to answer this question.'));
}

function actionDraftCard() {
  if (!canEdit()) return card('Human-approved actions', 'Read-only session', body(node('p', { class: 'small-text muted' }, 'Only authorized reviewers or managers can propose actions. A manager must explicitly approve each draft. Nothing is executed automatically.')));
  const recordSelect = node('select', { id: 'action-record', required: true }, node('option', { value: '' }, 'Choose source evidence'), ...records().map(record => node('option', { value: record.id }, `${customerName(record.customerId)} · ${record.kpiName}`)));
  const text = node('textarea', { id: 'action-text', required: true, maxlength: 1000, placeholder: 'Describe a concrete improvement action supported by this evidence.' });
  return card('Propose an improvement action', 'OPL-style action log · draft first, never auto-executed', body(
    node('form', { onSubmit: event => {
      event.preventDefault();
      if (!recordSelect.value || !text.value.trim()) return;
      run(async () => {
        await api('/api/actions', { method: 'POST', body: { recordId: recordSelect.value, text: text.value.trim() } });
        await refresh();
      }, 'Action saved as a draft. A human manager must approve it separately.');
    } }, field('Grounding record', recordSelect), field('Proposed action', text, 'Do not include personal or confidential data. No owner is guessed or assigned.'),
    node('button', { class: 'button', type: 'submit', disabled: model.busy || !records().length }, 'Propose action'))));
}

function actionsCard() {
  const actions = all('actions').filter(action => !model.customerId || action.customerId === model.customerId || all('records').some(record => record.id === action.recordId && record.customerId === model.customerId));
  return card('Action approval log', 'Draft proposals stay separate from approved decisions', actions.length ? body(...actions.map(action => node('article', { class: 'action-item' }, node('div', { class: 'list-heading' }, node('strong', {}, 'Evidence-linked proposal'), badge(readable(action.status), action.status === 'approved' ? 'success' : 'purple')), node('p', {}, action.text), manager() && action.status !== 'approved' && button('Approve action', () => run(async () => {
    await api(`/api/actions/${encodeURIComponent(action.id)}/approve`, { method: 'POST', body: {} });
    await refresh();
  }, 'Action approved by a human manager. Approval does not execute external work.'), 'small primary')))) : empty('No proposals yet', 'Turn a verified observation into a draft action. A manager makes the approval decision.'));
}

async function loadEvaluation() {
  model.evaluationLoading = true;
  render();
  try {
    model.evaluation = await api('/api/evaluation');
  } catch (error) { showError(error); }
  finally { model.evaluationLoading = false; if (model.view === 'evaluation') render(); }
}

function evaluation() {
  const data = model.evaluation;
  if (model.evaluationLoading) return card('Running reproducible evaluation', 'Actual fixture measurements', empty('Measuring the synthetic fixtures…', 'The server evaluates its extraction and guardrail behavior. No production corpus is implied.'));
  if (!data) return card('Measured results', 'Evaluation is performed by the server', empty('Evaluation has not run yet', 'Run the bounded fixture suite and inspect its limitations.', button('Run evaluation', () => loadEvaluation(), 'primary')));
  const results = Array.isArray(data.results) ? data.results : Object.entries(data.results || {}).map(([name, value]) => ({ name, ...(typeof value === 'object' ? value : { measured: value }) }));
  const summary = typeof data.summary === 'object' ? Object.entries(data.summary || {}).filter(([, value]) => typeof value !== 'object') : [['Summary', data.summary]];
  const keys = [...new Set(results.flatMap(result => Object.keys(result)))].filter(key => !['details', 'error', 'evidence', 'fixtures'].includes(key));
  const limitations = Array.isArray(data.limitations) ? data.limitations : [data.limitations].filter(Boolean);
  const targets = model.session.config?.evaluationTargets;
  const proposed = targets && typeof targets === 'object' && Object.keys(targets).length
    ? node('dl', { class: 'definition-grid' }, ...Object.entries(targets).flatMap(([key, value]) => [node('dt', {}, readable(key)), node('dd', {}, pretty(value))]))
    : node('p', { class: 'small-text muted' }, 'No numeric acceptance targets are configured in this workbench. Agree targets for a representative authorized corpus before making a production decision.');
  const measuredTable = results.length ? node('div', { class: 'table-wrap' },
    node('table', {},
      node('caption', {}, 'Measured results and any proposed targets remain separately labeled.'),
      node('thead', {}, node('tr', {}, ...keys.map(key => node('th', { scope: 'col' }, readable(key))))),
      node('tbody', {}, ...results.map(result => node('tr', {}, ...keys.map((key, index) => {
        const value = result[key];
        return node(index ? 'td' : 'th', index ? {} : { scope: 'row' }, typeof value === 'boolean' ? badge(value ? 'Pass' : 'Fail', value ? 'success' : 'danger') : pretty(value));
      }))))))
    : empty('No individual check rows', 'See the measured summary and limitations above.');
  return node('div', {},
    node('div', { class: 'callout warning' }, node('strong', {}, 'Measured ≠ proven at scale. '), 'These are tiny synthetic-fixture measurements. Brief or production targets are proposed acceptance goals—not achieved results on a customer corpus. Local mode does not evaluate OCR or a live LLM.'),
    node('div', { class: 'grid-equal' },
      card('Measured fixture summary', 'Actual server-reported measurements', body(node('dl', { class: 'definition-grid' }, ...summary.flatMap(([key, value]) => [node('dt', {}, readable(key)), node('dd', {}, pretty(value))])))),
      card('Evaluation boundaries', 'What this run does not establish', body(node('ul', { class: 'list-clean' }, ...limitations.map(text => node('li', {}, pretty(text)))), button('Run evaluation again', () => loadEvaluation(), 'small')))),
    node('div', { class: 'mt-20' }, card('Proposed acceptance targets', 'Goals only · separate from measured synthetic results', body(proposed))),
    node('div', { class: 'mt-20' }, card('Reproducible checks', 'Reported by the backend, not fabricated in the client', measuredTable)),
    providerStrip());
}

function architecture() {
  return node('div', {},
    card('An inspectable path from source to decision', 'Bounded single-workbench proof of concept—not a production-scale design', body(
      node('div', { class: 'architecture-flow' }, ...[
        ['Source files', 'PDF · Office · images · exports · text'],
        ['Extraction', 'Native parsers + opt-in Content Understanding'],
        ['Human review', 'Evidence → correction → confirm'],
        ['Approval', 'Manager → immutable snapshot'],
      ].flatMap(([title, subtitle], index) => [index > 0 && node('span', { class: 'architecture-arrow', 'aria-hidden': 'true' }, '→'), node('div', { class: 'architecture-node' }, node('strong', {}, title), node('span', {}, subtitle))])),
      node('p', { class: 'small-text muted' }, 'The browser is not the security boundary. The server enforces identity, object access, evidence filtering, review state, and publication locks. Source files are served through authenticated document endpoints.'))),
    node('div', { class: 'grid-equal mt-20' },
      card('Rehearse the full story', 'A practical presenter walkthrough', body(node('ol', { class: 'list-clean' },
        ...['Use a reviewer session and load the synthetic source pack.', 'Open the review queue. Inspect source evidence, correct a value, then confirm each value.', 'Switch to a manager session. Approve the period, then publish its immutable snapshot.', 'Ask a grounded KPI question and inspect citations. Ask an unsupported question to see abstention.', 'Propose an evidence-linked improvement action. Approve it separately as a manager.', 'Switch to auditor. Inspect the read-only, server-filtered view and compare measured evaluation results.'].map(text => node('li', {}, text))))),
      card('Know the boundaries', 'Honest modes and explicit controls', body(node('ul', { class: 'list-clean' },
        node('li', {}, node('strong', {}, 'Synthetic local identities. '), 'The role selector only appears in local demo mode. It asks the server to issue a session cookie; it does not attach role or audit flags to data requests.'),
        node('li', {}, node('strong', {}, 'Local is not AI. '), 'Text extraction and deterministic answers are labeled. Varied-layout documents and scans use opt-in Content Understanding; structured spreadsheets and exports keep native parsers. Upload only separately authorized whole documents.'),
        node('li', {}, node('strong', {}, 'No invented completeness. '), 'Missing values remain missing. Extraction confidence is a signal, not a calibrated probability of correctness.'),
        node('li', {}, node('strong', {}, 'Historical means locked. '), 'Publication preserves values, rules, and evidence. Server-side checks reject later edits.'),
        node('li', {}, node('strong', {}, 'Authorization before retrieval. '), 'Restricted evidence must not enter answer context, citations, audit events, or aggregates for an unauthorized identity.'),
        !local() && node('li', {}, node('strong', {}, 'Public SPA sign-in, independent API validation. '), 'Authorization Code + PKCE signs you in without an application secret. Access tokens stay in memory and accompany API and source-download requests. The server independently validates tokens and roles. Refreshing this page requires signing in again; there is no silent token refresh. ', button('Sign out', () => signOut().catch(showError), 'link')))))),
    providerStrip(),
    local() && manager() && node('div', { class: 'mt-20' }, card('Reset this local rehearsal', 'Destructive · synthetic local state only', body(node('p', { class: 'small-text muted' }, 'Reset removes the local workbench evidence and history. It is not available in Entra mode.'), node('details', {}, node('summary', { class: 'small-text' }, 'Show reset control'), node('p', { class: 'form-hint' }, 'Use only when you intend to start this synthetic rehearsal from scratch.'), button('Reset local demo', () => run(async () => {
      await api('/api/reset', { method: 'POST', body: {} });
      model.answer = null; model.evaluation = null; model.customerId = ''; await refresh();
    }, 'Local synthetic rehearsal reset.'), 'danger small'))))));
}

document.querySelectorAll('[data-view]').forEach(tab => {
  tab.addEventListener('click', () => navigate(tab.dataset.view));
  tab.addEventListener('keydown', event => {
    const tabs = [...document.querySelectorAll('[data-view]')];
    const index = tabs.indexOf(tab);
    let next;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) { event.preventDefault(); navigate(tabs[next].dataset.view, { focus: false }); tabs[next].focus(); }
  });
});

$('#role-switch').addEventListener('change', event => {
  const role = event.target.value;
  run(async () => {
    model.session = await api('/api/session', { method: 'POST', body: { role } });
    model.answer = null; model.evaluation = null; model.customerId = ''; model.state = null;
    for (const view of Object.keys(titles)) $(`#panel-${view}`).replaceChildren();
    await refresh();
  }, 'Server session switched. Evidence, citations, and counts have been reloaded for this identity.');
});
$('#customer-filter').addEventListener('change', event => { model.customerId = event.target.value; model.answer = null; render(); });
window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));

async function initialize() {
  $('#panel-overview').append(empty('Connecting to your workbench…', 'Verifying the server session and loading authorized evidence.'));
  try {
    await completeSignIn();
    model.session = await api('/api/session');
    await refresh();
    navigate(location.hash.slice(1) || 'overview', { focus: false });
  } catch (error) {
    const unauthorized = error.status === 401 || /sign-in|identity provider|authorization code/i.test(error.message || '');
    $('#panel-overview').replaceChildren(empty(
      unauthorized ? 'Sign in to your secured workspace' : 'The workbench is not available yet',
      unauthorized ? 'Use Microsoft sign-in with Authorization Code + PKCE. The API independently validates the access token and your application role. No application secret or pasted token is required.' : 'Check that the server is running and your session is authorized.',
      node('div', { class: 'signin-actions' },
        unauthorized && button('Sign in with Microsoft', () => beginSignIn().catch(showError), 'primary'),
        button('Try again', () => initialize(), unauthorized ? '' : 'primary'))));
    showError(error);
  }
}
initialize();
import { bearer, beginSignIn, completeSignIn, signOut } from './auth.mjs';

