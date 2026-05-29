const els = {
  runningBadge: document.getElementById('runningBadge'),
  sub2apiBaseUrl: document.getElementById('sub2apiBaseUrl'),
  sub2apiEmail: document.getElementById('sub2apiEmail'),
  sub2apiPassword: document.getElementById('sub2apiPassword'),
  sub2apiProxy: document.getElementById('sub2apiProxy'),
  sub2apiMaxItems: document.getElementById('sub2apiMaxItems'),
  operationDelayEnabled: document.getElementById('operationDelayEnabled'),
  operationDelayMs: document.getElementById('operationDelayMs'),
  settingsFile: document.getElementById('settingsFile'),
  mailboxImport: document.getElementById('mailboxImport'),
  mailboxList: document.getElementById('mailboxList'),
  pendingDeleteCounter: document.getElementById('pendingDeleteCounter'),
  pendingDeleteList: document.getElementById('pendingDeleteList'),
  flowCounter: document.getElementById('flowCounter'),
  flowAccount: document.getElementById('flowAccount'),
  flowSteps: document.getElementById('flowSteps'),
  candidateList: document.getElementById('candidateList'),
  resultList: document.getElementById('resultList'),
  logList: document.getElementById('logList'),
  toastContainer: document.getElementById('toastContainer'),
  saveConfig: document.getElementById('saveConfig'),
  exportSettings: document.getElementById('exportSettings'),
  importSettings: document.getElementById('importSettings'),
  importMailboxes: document.getElementById('importMailboxes'),
  scan401: document.getElementById('scan401'),
  startRefresh: document.getElementById('startRefresh'),
  stopRefresh: document.getElementById('stopRefresh'),
  deletePendingDeactivated: document.getElementById('deletePendingDeactivated'),
  clearPendingDeactivated: document.getElementById('clearPendingDeactivated'),
  toggleMailboxList: document.getElementById('toggleMailboxList'),
  toggleCandidateList: document.getElementById('toggleCandidateList'),
  toggleResultList: document.getElementById('toggleResultList'),
};

let currentState = null;

document.addEventListener('DOMContentLoaded', init);

chrome.runtime.onMessage.addListener(message => {
  if (message.type === 'STATE_CHANGED') renderState(message.state);
  if (message.type === 'LOG_ENTRY') {
    showImportantLogToast(message.entry);
    requestState().catch(() => {});
  }
});

async function init() {
  bindEvents();
  await requestState();
}

function bindEvents() {
  els.saveConfig.addEventListener('click', saveConfig);
  els.exportSettings.addEventListener('click', exportSettings);
  els.importSettings.addEventListener('click', () => els.settingsFile.click());
  els.settingsFile.addEventListener('change', importSettingsFromFile);
  els.importMailboxes.addEventListener('click', importMailboxes);
  els.scan401.addEventListener('click', () => runAction('SCAN_401'));
  els.startRefresh.addEventListener('click', () => runAction('START_REFRESH'));
  els.stopRefresh.addEventListener('click', () => runAction('STOP_REFRESH'));
  els.deletePendingDeactivated.addEventListener('click', deletePendingDeactivated);
  els.clearPendingDeactivated.addEventListener('click', clearPendingDeactivated);
  bindListToggle(els.toggleMailboxList, els.mailboxList);
  bindListToggle(els.toggleCandidateList, els.candidateList);
  bindListToggle(els.toggleResultList, els.resultList);
  els.mailboxList.addEventListener('click', handleMailboxAction);
}

async function requestState() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  if (response?.ok) renderState(response.state);
}

async function runAction(type) {
  try {
    if (type !== 'STOP_REFRESH') await saveConfig(false);
    const response = await chrome.runtime.sendMessage({ type });
    if (!response?.ok) throw new Error(response?.error || '操作失败');
    await requestState();
  } catch (error) {
    alert(error.message);
  }
}

async function saveConfig(showAlert = true) {
  const sub2api = {
    baseUrl: els.sub2apiBaseUrl.value.trim(),
    email: els.sub2apiEmail.value.trim(),
    password: els.sub2apiPassword.value,
    proxy: els.sub2apiProxy.value.trim(),
    maxItems: Number(els.sub2apiMaxItems.value) || 20,
  };
  if (sub2api.password === '********') delete sub2api.password;
  const payload = { sub2api };
  payload.operationDelayEnabled = els.operationDelayEnabled.checked;
  payload.operationDelayMs = Number(els.operationDelayMs.value) || 0;
  const response = await chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', payload });
  if (!response?.ok) throw new Error(response?.error || '保存失败');
  renderState(response.state);
  if (showAlert) toast('配置已保存');
}

async function exportSettings() {
  if (!confirm('导出的配置会包含 sub2api 密码和邮箱 refresh_token，请只保存在可信位置。继续导出吗？')) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'EXPORT_SETTINGS' });
    if (!response?.ok) throw new Error(response?.error || '导出失败');
    downloadTextFile(response.fileName || 'chatgpt-reauth-settings.json', response.fileContent || '{}');
    toast('配置已导出');
  } catch (error) {
    alert(error.message);
  }
}

async function importSettingsFromFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (currentState?.running) {
    alert('当前刷新任务正在运行，不能导入配置。');
    return;
  }
  try {
    const text = await file.text();
    const bundle = JSON.parse(text);
    if (!confirm('导入会更新 sub2api 配置，并合并邮箱池；不会清空日志和结果。继续导入吗？')) return;
    const response = await chrome.runtime.sendMessage({
      type: 'IMPORT_SETTINGS',
      payload: { bundle },
    });
    if (!response?.ok) throw new Error(response?.error || '导入失败');
    renderState(response.state);
    const summary = response.summary || {};
    toast(`配置已导入：邮箱新增 ${summary.added || 0}，更新 ${summary.updated || 0}`);
  } catch (error) {
    alert(`导入失败：${error.message}`);
  }
}

function downloadTextFile(fileName, content) {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importMailboxes() {
  const rawText = els.mailboxImport.value;
  const parsed = parseMailboxImport(rawText);
  if (!parsed.length) {
    alert(buildMailboxImportFailureMessage(rawText));
    return;
  }
  const response = await chrome.runtime.sendMessage({
    type: 'IMPORT_MAILBOXES',
    payload: { mailboxes: parsed },
  });
  if (!response?.ok) throw new Error(response?.error || '导入失败');
  els.mailboxImport.value = '';
  renderState(response.state);
  const summary = response.summary || {};
  toast(`导入完成：新增 ${summary.added || 0}，更新 ${summary.updated || 0}`);
}

function parseMailboxImport(text) {
  const rows = splitMailboxImportRows(text);
  const parsed = [];
  const fallbackClientIds = rows.filter(row => isClientId(row));
  let pendingEmail = '';
  for (const row of rows) {
    if (row.startsWith('#')) continue;
    let item = null;
    const emailOnly = extractImportEmail(row);
    if (emailOnly && emailOnly === row.toLowerCase()) {
      pendingEmail = emailOnly;
      continue;
    }
    if (pendingEmail && isClientId(row)) {
      item = { email: pendingEmail, clientId: row, refreshToken: '' };
      pendingEmail = '';
    }
    if (row.startsWith('{')) {
      try {
        item = JSON.parse(row);
      } catch {
        item = null;
      }
    }
    if (!item) {
      const parts = splitMailboxImportLine(row);
      if (parts.length >= 4) {
        item = { email: parts[0], password: parts[1], clientId: parts[2], refreshToken: parts.slice(3).join('----') };
      } else if (parts.length >= 3) {
        item = { email: parts[0], clientId: parts[1], refreshToken: parts.slice(2).join('----') };
      }
    }
    const email = extractImportEmail(item?.email);
    if (email && item?.clientId) {
      parsed.push({
        email,
        clientId: normalizeImportValue(item.clientId || item.client_id),
        refreshToken: normalizeImportValue(item.refreshToken || item.refresh_token),
        aliases: item.aliases || [],
      });
    }
  }
  if (fallbackClientIds.length === 1) {
    for (const item of parsed) {
      if (!item.clientId) item.clientId = fallbackClientIds[0];
    }
  }
  return parsed;
}

function splitMailboxImportRows(text) {
  return String(text || '')
    .replace(/\uFEFF/g, '')
    .split(/\r?\n/)
    .map(row => normalizeImportLine(row))
    .filter(Boolean);
}

function normalizeImportLine(value = '') {
  return String(value || '')
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
    .replace(/\u3000/g, ' ')
    .trim();
}

function splitMailboxImportLine(row = '') {
  const normalized = normalizeImportLine(row);
  const separatorPatterns = [
    /\s*-{3,}\s*/g,
    /\s*\|+\s*/g,
    /\t+/g,
    /\s*,\s*/g,
  ];
  for (const pattern of separatorPatterns) {
    const parts = normalized.split(pattern).map(part => part.trim()).filter(Boolean);
    if (parts.length >= 3) return parts;
  }

  const email = extractImportEmail(normalized);
  const clientIdMatch = normalized.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i);
  const tokenMatch = normalized.match(/\bM\.[A-Z0-9_]+\.[0-9A-Z]\.U\.-\S+/i);
  if (email && clientIdMatch && tokenMatch) {
    return [email, clientIdMatch[0], tokenMatch[0]];
  }
  return [normalized];
}

function extractImportEmail(value = '') {
  const match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : '';
}

function isClientId(value = '') {
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(normalizeImportValue(value));
}

function normalizeImportValue(value = '') {
  return String(value || '').trim();
}

function buildMailboxImportFailureMessage(text) {
  const rows = splitMailboxImportRows(text);
  if (!rows.length) return '没有解析到邮箱账号：输入框是空的。';
  const previews = rows.slice(0, 5).map((row, index) => {
    const parts = splitMailboxImportLine(row);
    const email = extractImportEmail(parts[0] || row);
    const clientId = parts.length >= 4 ? parts[2] : parts[1];
    const token = parts.length >= 4 ? parts.slice(3).join('----') : parts.slice(2).join('----');
    const reason = [
      email ? '' : '缺邮箱',
      isClientId(clientId) ? '' : '缺 client_id',
      normalizeImportValue(token) ? '' : '缺 refresh_token',
    ].filter(Boolean).join('，') || `字段数 ${parts.length}`;
    return `${index + 1}. ${row.slice(0, 80)}...（${reason}）`;
  }).join('\n');
  return `没有解析到邮箱账号。\n\n已读取 ${rows.length} 行，但没有符合格式的记录。\n支持格式：邮箱----密码----client_id----refresh_token\n也支持用 |、Tab、逗号分隔。\n\n前几行诊断：\n${previews}`;
}

function renderState(state) {
  currentState = state || {};
  const sub2api = currentState.sub2api || {};
  els.sub2apiBaseUrl.value = sub2api.baseUrl || '';
  els.sub2apiEmail.value = sub2api.email || '';
  els.sub2apiPassword.value = sub2api.password || '';
  els.sub2apiProxy.value = sub2api.proxy || '';
  els.sub2apiMaxItems.value = sub2api.maxItems || 20;
  els.operationDelayEnabled.checked = currentState.operationDelayEnabled !== false;
  els.operationDelayMs.value = currentState.operationDelayMs ?? 2000;
  els.runningBadge.textContent = currentState.running ? '运行中' : '空闲';
  els.runningBadge.classList.toggle('running', Boolean(currentState.running));
  els.startRefresh.disabled = Boolean(currentState.running);
  els.scan401.disabled = Boolean(currentState.running);
  els.stopRefresh.disabled = !currentState.running;
  renderMailboxes(currentState.mailboxes || []);
  renderPendingDeletions(currentState.pendingDeletions || []);
  renderCurrentFlow(currentState.currentFlow);
  renderCandidates(currentState.candidates || []);
  renderResults(currentState.results || []);
  renderLogs(currentState.logs || []);
}

function renderCurrentFlow(flow = {}) {
  const steps = Array.isArray(flow?.steps) ? flow.steps : [];
  const completed = steps.filter(step => ['success', 'warn', 'failed', 'skipped'].includes(step.status)).length;
  els.flowCounter.textContent = `${completed} / ${steps.length || 9}`;
  els.flowAccount.textContent = flow?.label || flow?.email || '等待开始';
  if (!steps.length) {
    els.flowSteps.innerHTML = '<div class="item"><span>还没有流程状态</span></div>';
    return;
  }
  els.flowSteps.innerHTML = steps.map((step, index) => `
    <div class="flow-step ${escapeHtml(step.status || 'pending')}">
      <div class="flow-index">${index + 1}</div>
      <div class="flow-body">
        <div class="flow-title">${escapeHtml(step.title || step.id || '-')}</div>
        <div class="flow-detail">${escapeHtml(step.detail || statusLabel(step.status))}</div>
      </div>
    </div>
  `).join('');
}

function statusLabel(status = '') {
  return ({
    pending: '等待中',
    running: '进行中',
    success: '完成',
    warn: '已降级',
    failed: '失败',
    skipped: '已跳过',
  })[status] || '';
}

function renderMailboxes(items) {
  if (!items.length) {
    els.mailboxList.innerHTML = '<div class="item"><span>还没有托管邮箱</span></div>';
    return;
  }
  els.mailboxList.innerHTML = items.map(item => `
    <div class="item">
      <strong>${escapeHtml(item.email || '-')}</strong>
      <span>${escapeHtml(item.clientId || '')}</span>
      <span class="${hasRefreshToken(item) ? 'ok' : 'error'}">${hasRefreshToken(item) ? 'refresh_token 已配置' : '缺少 refresh_token，不能自动读验证码'}</span>
      <div class="mini-actions">
        <button type="button" data-mailbox-action="verify" data-mailbox-id="${escapeHtml(item.id || '')}">验证</button>
        <button type="button" data-mailbox-action="code" data-mailbox-id="${escapeHtml(item.id || '')}">取码</button>
        <button type="button" data-mailbox-action="delete" data-mailbox-id="${escapeHtml(item.id || '')}" class="danger">删除</button>
      </div>
    </div>
  `).join('');
}

function hasRefreshToken(item = {}) {
  return Boolean(item.refreshToken || item.refresh_token);
}

function renderPendingDeletions(items) {
  els.pendingDeleteCounter.textContent = String(items.length);
  els.deletePendingDeactivated.disabled = currentState.running || items.length === 0;
  els.clearPendingDeactivated.disabled = currentState.running || items.length === 0;
  if (!items.length) {
    els.pendingDeleteList.innerHTML = '<div class="item"><span>没有待确认删除的账号</span></div>';
    return;
  }
  els.pendingDeleteList.innerHTML = items.map(item => `
    <div class="item">
      <strong>${escapeHtml(item.email || item.id || '-')}</strong>
      <span>${escapeHtml(compactCandidateMessage(item.reason || '账号已停用'))}</span>
    </div>
  `).join('');
}

async function deletePendingDeactivated() {
  const pending = currentState?.pendingDeletions || [];
  if (!pending.length) return;
  const names = pending.slice(0, 8).map(item => item.email || item.id || '-').join('\n');
  const suffix = pending.length > 8 ? `\n...等 ${pending.length} 个账号` : '';
  if (!confirm(`确认删除 sub2api 里的已停用旧账号？\n\n${names}${suffix}\n\n取消则不会删除。`)) return;
  await runDangerAction('DELETE_PENDING_DEACTIVATED', '已确认删除完成');
}

async function clearPendingDeactivated() {
  const pending = currentState?.pendingDeletions || [];
  if (!pending.length) return;
  if (!confirm(`确认清空 ${pending.length} 个待删除记录吗？不会删除 sub2api 账号。`)) return;
  await runDangerAction('CLEAR_PENDING_DEACTIVATED', '已清空清单');
}

async function runDangerAction(type, successMessage) {
  try {
    const response = await chrome.runtime.sendMessage({ type });
    if (!response?.ok) throw new Error(response?.error || '操作失败');
    if (response.state) renderState(response.state);
    toast(successMessage);
  } catch (error) {
    alert(error.message);
  }
}

function renderCandidates(items) {
  if (!items.length) {
    els.candidateList.innerHTML = '<div class="item"><span>还没有扫描结果</span></div>';
    return;
  }
  els.candidateList.innerHTML = items.map(item => `
    <div class="item">
      <strong>${escapeHtml(item.email || item.name || item.id || '-')}</strong>
      <span>${escapeHtml(compactCandidateMessage(item.message || item.status || ''))}</span>
    </div>
  `).join('');
}

function compactCandidateMessage(message = '') {
  return String(message || '')
    .replace(/\b(credentials|notes|extra)\b/gi, '')
    .replace(/\b(codex_5h_reset_after_seconds|codex_7d_reset_after_seconds|codex_5h_window_minutes)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function renderResults(items) {
  if (!items.length) {
    els.resultList.innerHTML = '<div class="item"><span>还没有结果</span></div>';
    return;
  }
  els.resultList.innerHTML = items.map(item => `
    <div class="item">
      <strong class="${item.ok ? 'ok' : 'error'}">${escapeHtml(item.email || item.id || '-')} · ${escapeHtml(item.action || '')}</strong>
      <span>${escapeHtml(item.message || '')}</span>
    </div>
  `).join('');
}

async function handleMailboxAction(event) {
  const button = event.target.closest('[data-mailbox-action]');
  if (!button) return;
  const action = button.dataset.mailboxAction;
  const id = button.dataset.mailboxId;
  if (!id) return;
  try {
    button.disabled = true;
    if (action === 'delete') {
      const target = (currentState.mailboxes || []).find(item => item.id === id);
      if (!confirm(`确认删除托管邮箱 ${target?.email || id} 吗？只会删除本地配置，不会删除 sub2api 账号。`)) return;
      const response = await chrome.runtime.sendMessage({ type: 'DELETE_MAILBOX', payload: { id } });
      if (!response?.ok) throw new Error(response?.error || '删除失败');
      renderState(response.state);
      toast('邮箱已删除');
      return;
    }
    const type = action === 'verify' ? 'VERIFY_MAILBOX' : 'FETCH_MAILBOX_CODE';
    const response = await chrome.runtime.sendMessage({ type, payload: { id } });
    if (!response?.ok) throw new Error(response?.error || '操作失败');
    if (response.state) renderState(response.state);
    if (action === 'verify') {
      toast('邮箱验证成功');
    } else {
      showToast(`验证码 ${response.code || ''}`, 'success', 15000);
      try {
        await navigator.clipboard?.writeText?.(String(response.code || ''));
        toast('验证码已复制');
      } catch {
        // Clipboard permission is not always available in extension side panels.
      }
    }
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
}

function renderLogs(logs) {
  els.logList.innerHTML = logs.slice(-120).reverse().map(log => `
    <div class="log ${escapeHtml(log.level || 'info')}">
      <time>${escapeHtml(log.time || '')}</time>${escapeHtml(log.message || '')}
    </div>
  `).join('');
}

function toast(message) {
  const original = els.runningBadge.textContent;
  els.runningBadge.textContent = message;
  showToast(message, 'info', 1800);
  setTimeout(() => {
    els.runningBadge.textContent = currentState?.running ? '运行中' : original;
  }, 1200);
}

function showImportantLogToast(entry = {}) {
  const message = String(entry.message || '').trim();
  if (!message || !isImportantLogEntry(entry)) return;
  showToast(message, toastTypeFromLevel(entry.level), toastDurationFromLevel(entry.level));
}

function isImportantLogEntry(entry = {}) {
  const level = String(entry.level || 'info');
  const message = String(entry.message || '');
  if (['ok', 'warn', 'error'].includes(level)) return true;
  return /完成|结束|开始刷新|扫描完成|已生成 OAuth|已捕获 OAuth|已更新 sub2api|已跳过|已停用|手机号|WhatsApp|token\/权限不可用|OAuth callback 返回错误|导入完成/i.test(message);
}

function toastTypeFromLevel(level = '') {
  if (level === 'ok') return 'success';
  if (level === 'warn') return 'warn';
  if (level === 'error') return 'error';
  return 'info';
}

function toastDurationFromLevel(level = '') {
  if (level === 'error') return 7000;
  if (level === 'warn') return 5200;
  if (level === 'ok') return 3200;
  return 2600;
}

function showToast(message, type = 'info', duration = 3000) {
  if (!els.toastContainer) return;
  const toastNode = document.createElement('div');
  toastNode.className = `toast toast-${type}`;
  toastNode.innerHTML = `
    <span class="toast-icon">${toastIcon(type)}</span>
    <span class="toast-message">${escapeHtml(compactToastMessage(message))}</span>
    <button class="toast-close" type="button" aria-label="关闭">&times;</button>
  `;
  toastNode.querySelector('.toast-close')?.addEventListener('click', () => dismissToast(toastNode));
  els.toastContainer.appendChild(toastNode);
  const maxToasts = 4;
  while (els.toastContainer.children.length > maxToasts) {
    els.toastContainer.firstElementChild?.remove();
  }
  if (duration > 0) setTimeout(() => dismissToast(toastNode), duration);
}

function dismissToast(toastNode) {
  if (!toastNode || !toastNode.parentNode) return;
  toastNode.classList.add('toast-exit');
  toastNode.addEventListener('animationend', () => toastNode.remove(), { once: true });
  setTimeout(() => toastNode.remove(), 260);
}

function compactToastMessage(message = '') {
  return String(message || '').replace(/\s+/g, ' ').trim().slice(0, 260);
}

function toastIcon(type = '') {
  return ({
    success: '&#10003;',
    warn: '!',
    error: '&times;',
    info: 'i',
  })[type] || 'i';
}

function bindListToggle(button, list) {
  if (!button || !list) return;
  button.addEventListener('click', () => {
    const expanded = list.classList.toggle('expanded');
    button.textContent = expanded ? '收起列表' : '展开列表';
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}
