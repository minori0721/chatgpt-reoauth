const DEFAULT_STATE = {
  sub2api: {
    baseUrl: '',
    email: '',
    password: '',
    proxy: '',
    maxItems: 20,
  },
  mailboxes: [],
  logs: [],
  candidates: [],
  results: [],
  currentFlow: createEmptyFlow(),
  pendingDeletions: [],
  operationDelayEnabled: true,
  operationDelayMs: 2000,
  running: false,
  currentTask: null,
};
const LOCAL_STATE_KEYS = [
  'sub2api',
  'mailboxes',
  'pendingDeletions',
  'operationDelayEnabled',
  'operationDelayMs',
];
const SESSION_STATE_KEYS = [
  'logs',
  'candidates',
  'results',
  'currentFlow',
  'running',
  'currentTask',
];
const SETTINGS_EXPORT_SCHEMA_VERSION = 1;
const SETTINGS_EXPORT_FILENAME_PREFIX = 'chatgpt-reauth-settings';
const ACCOUNT_LIST_ENDPOINTS = [
  '/api/v1/admin/accounts/all',
  '/api/v1/admin/accounts?with_count=true',
  '/api/v1/admin/accounts',
];
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const MICROSOFT_TOKEN_DNR_RULE_ID = 1001;
const HOTMAIL_MAILBOXES = ['INBOX', 'Junk'];
const MICROSOFT_TOKEN_STRATEGIES = [
  {
    name: 'entra-common-delegated',
    url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    extraData: { scope: 'offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read' },
  },
  {
    name: 'entra-consumers-delegated',
    url: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
    extraData: { scope: 'offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read' },
  },
  {
    name: 'entra-common-default',
    url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    extraData: { scope: 'https://graph.microsoft.com/.default' },
  },
  {
    name: 'entra-common-outlook',
    url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    extraData: {},
  },
];
const MICROSOFT_TRANSPORT_PLANS = [
  {
    transport: 'graph',
    strategyNames: ['entra-common-delegated', 'entra-consumers-delegated', 'entra-common-default'],
  },
  {
    transport: 'outlook',
    strategyNames: ['entra-common-outlook', 'entra-common-delegated', 'entra-consumers-delegated'],
  },
];
const OPENAI_OAUTH_CREDENTIAL_KEYS = [
  'access_token',
  'refresh_token',
  'id_token',
  'expires_at',
  'email',
  'chatgpt_account_id',
  'chatgpt_user_id',
  'organization_id',
  'plan_type',
  'client_id',
];

let runtime = {
  running: false,
  stopRequested: false,
  currentTask: null,
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
  setupMicrosoftTokenHeaderRule();
});
chrome.runtime.onStartup?.addListener?.(() => {
  setupMicrosoftTokenHeaderRule();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message, _sender).then(sendResponse).catch(error => {
    sendResponse({ ok: false, error: error?.message || String(error || '未知错误') });
  });
  return true;
});

chrome.webNavigation.onCommitted.addListener(details => {
  handleNavigation(details).catch(() => {});
});
chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  handleNavigation(details).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab?.url || '';
  if (url) {
    handleCallbackUrl(tabId, url, 'tabs.onUpdated').catch(() => {});
    driveAuthTabIfNeeded(tabId, url).catch(() => {});
  }
});

function setupMicrosoftTokenHeaderRule() {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) return;
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [MICROSOFT_TOKEN_DNR_RULE_ID],
    addRules: [{
      id: MICROSOFT_TOKEN_DNR_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'remove' },
        ],
      },
      condition: {
        urlFilter: 'login.microsoftonline.com/*/oauth2/v2.0/token',
        resourceTypes: ['xmlhttprequest'],
      },
    }],
  }).catch(error => {
    console.warn('[chatgpt-reoauth] setup Microsoft token header rule failed:', error?.message || error);
  });
}

async function handleMessage(message = {}, sender = {}) {
  switch (message.type) {
    case 'GET_STATE':
      return { ok: true, state: await getPublicState() };
    case 'SAVE_CONFIG':
      return { ok: true, state: await saveConfig(message.payload || {}) };
    case 'IMPORT_MAILBOXES':
      return importMailboxes(message.payload?.mailboxes || []);
    case 'EXPORT_SETTINGS':
      return { ok: true, ...(await exportSettingsBundle()) };
    case 'IMPORT_SETTINGS':
      return importSettingsBundle(message.payload?.bundle);
    case 'SCAN_401':
      return scan401();
    case 'START_REFRESH':
      startRefresh().catch(error => log(`刷新任务失败：${error.message}`, 'error'));
      return { ok: true };
    case 'STOP_REFRESH':
      runtime.stopRequested = true;
      await setStatePatch({ running: false });
      await log('已请求停止，当前账号处理完后停止。', 'warn');
      return { ok: true };
    case 'AUTH_PAGE_READY':
      return handleAuthPageReady(message.payload || {}, sender);
    case 'FETCH_CODE':
      return { ok: true, code: await fetchVerificationCodeForTask(message.payload?.taskId) };
    case 'AUTH_LOG':
      if (message.payload?.message) await log(message.payload.message, message.payload.level || 'info');
      return { ok: true };
    case 'AUTH_FATAL':
      return handleAuthFatal(message.payload || {});
    case 'VERIFY_MAILBOX':
      return verifyMailbox(message.payload?.id || message.payload?.email || '');
    case 'FETCH_MAILBOX_CODE':
      return fetchMailboxLatestCode(message.payload?.id || message.payload?.email || '');
    case 'DELETE_MAILBOX':
      return deleteMailbox(message.payload?.id || '');
    case 'DELETE_PENDING_DEACTIVATED':
      return deletePendingDeactivated();
    case 'CLEAR_PENDING_DEACTIVATED':
      return clearPendingDeactivated();
    default:
      return { ok: false, error: `未知消息：${message.type || ''}` };
  }
}

async function scan401() {
  const state = await getState();
  const client = await createSub2ApiClient(state.sub2api);
  const { accounts } = await client.listAccounts();
  const openaiAccounts = accounts.filter(isOpenAiAccount);
  const candidates = openaiAccounts.filter(is401Account).slice(0, normalizeMaxItems(state.sub2api.maxItems)).map(mapCandidate);
  await setStatePatch({ candidates, results: [] });
  await log(`扫描完成：共 ${openaiAccounts.length} 个 OpenAI 账号，发现 ${candidates.length} 个 401。`, candidates.length ? 'warn' : 'ok');
  return { ok: true, total: openaiAccounts.length, candidates };
}

async function startRefresh() {
  const state = await getState();
  if (runtime.running) {
    await log('刷新任务正在运行。', 'warn');
    return;
  }
  runtime.running = true;
  runtime.stopRequested = false;
  await setStatePatch({ running: true, results: [], currentFlow: createEmptyFlow() });
  await log('开始刷新 sub2api 401 账号。');

  try {
    const client = await createSub2ApiClient(state.sub2api);
    const { accounts } = await client.listAccounts();
    const candidates = accounts.filter(isOpenAiAccount).filter(is401Account).slice(0, normalizeMaxItems(state.sub2api.maxItems));
    await setStatePatch({ candidates: candidates.map(mapCandidate) });
    for (const account of candidates) {
      if (runtime.stopRequested) break;
      try {
        await refreshOne(client, account);
      } catch (error) {
        if (/用户停止刷新/.test(error.message)) break;
        const email = inferEmail(account);
        const label = email || account.name || account.id || '未知账号';
        await closeTaskTab(runtime.currentTask);
        runtime.currentTask = null;
        await setStatePatch({ currentTask: null });
        if (isDeactivatedMessage(error.message)) {
          await markCurrentAccountPendingDeletion({
            accountId: getRemoteAccountId(account),
            email,
          }, error.message);
          await setCurrentFlowStep('done', 'skipped', '账号已停用，已跳过，未删除');
          await log(`${label} 已停用，已跳过，等待用户确认是否删除。`, 'warn');
        } else if (isSkippableAccountError(error.message)) {
          await setCurrentFlowStep('done', 'skipped', getSkippableAccountReason(error.message));
          await addResult({ id: account.id, email, action: 'skipped', ok: false, message: error.message });
          await log(`${label} ${getSkippableAccountReason(error.message)}，已跳过。`, 'warn');
        } else {
          await addResult({ id: account.id, email, action: 'failed', ok: false, message: error.message });
          await log(`${label} 处理失败：${error.message}`, 'error');
        }
      }
      if (!runtime.stopRequested) {
        await sleep(getOperationDelayMs(await getState()));
      }
    }
  } finally {
    await closeTaskTab(runtime.currentTask);
    runtime.running = false;
    runtime.currentTask = null;
    await setStatePatch({ running: false, currentTask: null });
    await log('刷新任务结束。', 'ok');
  }
}

async function refreshOne(client, account) {
  await closeTaskTab(runtime.currentTask);
  const email = inferEmail(account);
  const label = email || account.name || account.id || '未知账号';
  await resetCurrentFlow(account);
  await setCurrentFlowStep('start', 'running', '开始处理');
  await log(`${label} 开始处理。`);

  try {
    await setCurrentFlowStep('refresh', 'running', '尝试 sub2api refresh');
    await client.refreshAccount(account);
    await client.clearError(account);
    await setCurrentFlowStep('refresh', 'success', 'sub2api refresh 成功');
    await setCurrentFlowStep('done', 'success', '完成');
    await addResult({ id: account.id, email, action: 'refreshed', ok: true, message: 'sub2api refresh 成功' });
    await log(`${label} refresh_token 刷新成功。`, 'ok');
    return;
  } catch (error) {
    await setCurrentFlowStep('refresh', 'warn', 'refresh_token 失效，进入 OAuth');
    await log(`${label} refresh_token 刷新失败：${error.message}`, 'warn');
  }

  await setCurrentFlowStep('mailbox', 'running', '匹配托管邮箱');
  const mailbox = await findMailboxForTarget(email);
  if (!mailbox) {
    await setCurrentFlowStep('mailbox', 'failed', '没有匹配托管邮箱');
    await setCurrentFlowStep('done', 'skipped', '已跳过');
    await addResult({ id: account.id, email, action: 'skipped', ok: false, message: '没有匹配的托管邮箱' });
    await log(`${label} 没有匹配的托管邮箱，已跳过。`, 'warn');
    return;
  }
  if (!normalizeString(mailbox.clientId) || !normalizeString(mailbox.refreshToken)) {
    await setCurrentFlowStep('mailbox', 'failed', '托管邮箱缺少 token');
    await setCurrentFlowStep('done', 'skipped', '已跳过');
    await addResult({ id: account.id, email, action: 'failed', ok: false, message: `${mailbox.email} 缺少 client_id 或 refresh_token，无法自动读取验证码` });
    await log(`${label} 匹配到托管邮箱 ${mailbox.email}，但缺少 client_id 或 refresh_token，已跳过。`, 'error');
    return;
  }
  await setCurrentFlowStep('mailbox', 'success', `使用 ${mailbox.email}`);

  await setCurrentFlowStep('auth_url', 'running', '生成 OAuth 授权链接');
  const authSession = await client.generateOpenAiAuthUrl();
  await setCurrentFlowStep('auth_url', 'success', '已生成 OAuth 授权链接');
  const task = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    accountId: account.id,
    email,
    mailboxId: mailbox.id,
    authSession,
    startedAt: Date.now(),
    callbackUrl: '',
    tabId: 0,
  };
  runtime.currentTask = task;
  await setStatePatch({ currentTask: task });
  await log(`${label} 已生成 OAuth 授权链接，打开 Chrome 标签页。`);

  const tab = await chrome.tabs.create({ url: authSession.authUrl, active: true });
  task.tabId = tab.id;
  await setStatePatch({ currentTask: task });

  await setCurrentFlowStep('browser', 'running', '等待浏览器 OAuth');
  const callbackUrl = await waitForTaskCallback(task, 10 * 60 * 1000);
  await setCurrentFlowStep('browser', 'success', 'OAuth 页面完成');
  await setCurrentFlowStep('callback', 'success', '已捕获 OAuth callback');
  await setCurrentFlowStep('apply', 'running', '交换 OAuth code');
  const tokenInfo = await client.exchangeOpenAiCode(authSession, callbackUrl);
  await setCurrentFlowStep('apply', 'running', '更新 sub2api 凭证');
  await client.applyOAuthCredentials(account, tokenInfo);
  await client.clearError(account);
  await closeTaskTab(task);
  runtime.currentTask = null;
  await setStatePatch({ currentTask: null });
  await setCurrentFlowStep('apply', 'success', '已更新 sub2api 凭证');
  await setCurrentFlowStep('done', 'success', 'OAuth 重授权成功');
  await addResult({ id: account.id, email, action: 'reauthorized', ok: true, message: 'OAuth 重授权成功' });
  await log(`${label} OAuth 重授权成功，已更新 sub2api。`, 'ok');
}

async function handleAuthPageReady(payload = {}, sender = {}) {
  const task = runtime.currentTask;
  if (!task) return { ok: true, idle: true };
  const tabId = Number(payload.tabId || sender?.tab?.id) || 0;
  if (task.tabId && tabId && task.tabId !== tabId) return { ok: true, ignored: true };
  const state = await getState();
  const mailbox = state.mailboxes.find(item => item.id === task.mailboxId);
  return {
    ok: true,
    task: {
      id: task.id,
      email: task.email,
      authSession: task.authSession,
      code: null,
      mailboxEmail: mailbox?.email || '',
      operationDelayEnabled: state.operationDelayEnabled !== false,
      operationDelayMs: getOperationDelayMs(state),
    },
  };
}

async function handleAuthFatal(payload = {}) {
  const task = runtime.currentTask;
  const reason = normalizeString(payload.reason || payload.message || '认证页失败');
  if (task) {
    if (isDeactivatedMessage(reason)) {
      await markCurrentAccountPendingDeletion(task, reason);
      await setCurrentFlowStep('browser', 'failed', '账号已停用');
      await setCurrentFlowStep('done', 'skipped', '账号已停用，已跳过，未删除');
    } else if (isPhoneVerificationBlockMessage(reason)) {
      await setCurrentFlowStep('browser', 'failed', '需要手机号/WhatsApp 验证');
      await setCurrentFlowStep('done', 'skipped', '手机号验证，已跳过');
    } else if (isMicrosoftMailboxAuthError(reason)) {
      await setCurrentFlowStep('code', 'failed', '托管邮箱 token/权限不可用');
      await setCurrentFlowStep('done', 'skipped', '邮箱取码失败，已跳过');
    } else {
      await setCurrentFlowStep('browser', 'failed', reason);
    }
    await closeTaskTab(task);
    runtime.currentTask = { ...task, fatalError: reason };
    await setStatePatch({ currentTask: runtime.currentTask });
    return { ok: true };
  }
  return { ok: false, error: reason };
}

async function markCurrentAccountPendingDeletion(task, reason = '') {
  const state = await getState();
  const item = {
    id: task.accountId || '',
    email: task.email || '',
    reason,
    markedAt: Date.now(),
  };
  const alreadyPending = state.pendingDeletions.some(existing => String(existing.id || existing.email) === String(item.id || item.email));
  const next = [
    ...state.pendingDeletions.filter(existing => String(existing.id || existing.email) !== String(item.id || item.email)),
    item,
  ];
  await setStatePatch({ pendingDeletions: next });
  if (!alreadyPending) {
    await addResult({ id: item.id, email: item.email, action: 'pending_delete', ok: false, message: '账号已停用，已跳过，等待用户确认是否删除' });
    await log(`${item.email || item.id} 账号已停用，已加入待确认删除清单（未删除）。`, 'warn');
  }
}

async function verifyMailbox(identifier) {
  const state = await getState();
  const mailbox = findMailboxByIdentifier(state.mailboxes, identifier);
  if (!mailbox) throw new Error('未找到托管邮箱');
  const result = await fetchMicrosoftMailboxMessages(mailbox, ['INBOX'], 3);
  if (result.nextRefreshToken) await rotateMailboxRefreshToken(mailbox.id, result.nextRefreshToken);
  await log(`${mailbox.email} 邮箱验证成功：${result.transport}/${result.tokenStrategy}，最近 ${result.messages.length} 封。`, 'ok');
  return { ok: true, messageCount: result.messages.length, transport: result.transport, tokenStrategy: result.tokenStrategy, state: await getPublicState() };
}

async function fetchMailboxLatestCode(identifier) {
  const state = await getState();
  const mailbox = findMailboxByIdentifier(state.mailboxes, identifier);
  if (!mailbox) throw new Error('未找到托管邮箱');
  const result = await fetchMicrosoftMailboxMessages(mailbox, HOTMAIL_MAILBOXES, 10);
  if (result.nextRefreshToken) await rotateMailboxRefreshToken(mailbox.id, result.nextRefreshToken);
  const code = findCodeInMessages(result.messages, mailbox.email, mailbox) || findAnyCodeInMessages(result.messages);
  if (!code) throw new Error('最近邮件里没有找到验证码');
  await log(`${mailbox.email} 手动取码：${code}（${result.transport}/${result.tokenStrategy}）`, 'ok');
  return { ok: true, code, transport: result.transport, tokenStrategy: result.tokenStrategy, state: await getPublicState() };
}

async function deleteMailbox(identifier) {
  const state = await getState();
  const mailbox = findMailboxByIdentifier(state.mailboxes, identifier);
  if (!mailbox) throw new Error('未找到托管邮箱');
  const mailboxes = state.mailboxes.filter(item => item.id !== mailbox.id);
  await setStatePatch({ mailboxes });
  await log(`已删除托管邮箱：${mailbox.email}`, 'warn');
  return { ok: true, state: await getPublicState() };
}

async function deletePendingDeactivated() {
  const state = await getState();
  const pending = state.pendingDeletions.filter(item => normalizeString(item.id));
  if (!pending.length) throw new Error('没有待确认删除的已停用账号');

  const client = await createSub2ApiClient(state.sub2api);
  const pendingIds = new Set(pending.map(item => normalizeString(item.id)));
  const { accounts } = await client.listAccounts();
  const byId = new Map(accounts.map(account => [getRemoteAccountId(account), account]));
  const results = [];
  let deleted = 0;
  let failed = 0;
  let skipped = 0;

  for (const item of pending) {
    const id = normalizeString(item.id);
    const remote = byId.get(id);
    const email = item.email || inferEmail(remote);
    if (!remote) {
      skipped += 1;
      results.push({ id, email, action: 'delete_skipped', ok: false, message: 'sub2api 中已找不到这个账号' });
      continue;
    }
    try {
      await client.deleteAccount(remote);
      deleted += 1;
      results.push({ id, email, action: 'deleted_deactivated', ok: true, message: '已确认删除 sub2api 旧账号' });
    } catch (error) {
      failed += 1;
      results.push({ id, email, action: 'delete_failed', ok: false, message: error.message });
    }
  }

  const failedIds = new Set(results.filter(item => item.action === 'delete_failed').map(item => normalizeString(item.id)));
  const pendingDeletions = state.pendingDeletions.filter(item => {
    const id = normalizeString(item.id);
    return !pendingIds.has(id) || failedIds.has(id);
  });
  await setStatePatch({
    pendingDeletions,
    results: [...state.results, ...results],
  });
  await log(`已停用账号删除完成：删除 ${deleted}，失败 ${failed}，跳过 ${skipped}。`, failed ? 'warn' : 'ok');
  return { ok: true, summary: { deleted, failed, skipped }, state: await getPublicState() };
}

async function clearPendingDeactivated() {
  await setStatePatch({ pendingDeletions: [] });
  await log('已清空待确认删除清单（未删除 sub2api 账号）。', 'warn');
  return { ok: true, state: await getPublicState() };
}

async function driveAuthTabIfNeeded(tabId, url = '') {
  const task = runtime.currentTask;
  if (!task || !task.tabId || Number(tabId) !== Number(task.tabId)) return;
  if (!/^https:\/\/(auth|auth0|accounts)\.openai\.com\//i.test(url)) return;
  const state = await getState();
  const mailbox = state.mailboxes.find(item => item.id === task.mailboxId);
  const driverTask = {
    id: task.id,
    email: task.email,
    authSession: task.authSession,
    code: null,
    mailboxEmail: mailbox?.email || '',
    operationDelayEnabled: state.operationDelayEnabled !== false,
    operationDelayMs: getOperationDelayMs(state),
  };
  try {
    await chrome.tabs.sendMessage(Number(tabId), { type: 'DRIVE_AUTH_PAGE', task: driverTask });
  } catch {
    // Content script may not be ready yet; retry once after Chrome finishes injecting it.
    setTimeout(() => {
      chrome.tabs.sendMessage(Number(tabId), { type: 'DRIVE_AUTH_PAGE', task: driverTask }).catch(() => {});
    }, 1000);
  }
}

async function closeTaskTab(task) {
  const tabId = Number(task?.tabId || 0);
  if (!tabId) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // The tab may already be closed by the user or the browser.
  }
}

async function waitForTaskCallback(task, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (runtime.stopRequested) throw new Error('用户停止刷新');
    if (runtime.currentTask?.id === task.id && runtime.currentTask.fatalError) {
      throw new Error(runtime.currentTask.fatalError);
    }
    if (runtime.currentTask?.id === task.id && runtime.currentTask.callbackUrl) {
      return runtime.currentTask.callbackUrl;
    }
    await sleep(800);
  }
  throw new Error('等待 OAuth callback 超时');
}

async function handleNavigation(details = {}) {
  if (details.frameId !== 0) return;
  await handleCallbackUrl(details.tabId, details.url, 'webNavigation');
}

async function handleCallbackUrl(tabId, url, source) {
  const task = runtime.currentTask;
  if (!task || !url || task.callbackUrl) return;
  if (task.tabId && Number(tabId) !== Number(task.tabId)) return;
  const callbackState = getOAuthCallbackState(url);
  if (!callbackState.matches) return;
  if (callbackState.error) {
    const reason = `OAuth callback 返回错误：${callbackState.error}${callbackState.errorDescription ? ` - ${callbackState.errorDescription}` : ''}`;
    runtime.currentTask = { ...task, fatalError: reason };
    await setStatePatch({ currentTask: runtime.currentTask });
    await log(`${task.email} ${reason}`, 'error');
    return;
  }
  if (!callbackState.hasCode) return;
  task.callbackUrl = url;
  runtime.currentTask = task;
  await setStatePatch({ currentTask: task });
  await log(`${task.email} 已捕获 OAuth callback（${source}）。`, 'ok');
}

async function fetchVerificationCodeForTask(taskId) {
  const task = runtime.currentTask;
  if (!task || task.id !== taskId) throw new Error('当前没有匹配的 OAuth 任务');
  const state = await getState();
  const mailbox = state.mailboxes.find(item => item.id === task.mailboxId);
  try {
    if (!mailbox) throw new Error('托管邮箱不存在');
    if (!normalizeString(mailbox.clientId) || !normalizeString(mailbox.refreshToken)) {
      throw new Error(`${mailbox.email} 缺少 client_id 或 refresh_token，无法读取 Microsoft Graph 邮件`);
    }
    await setCurrentFlowStep('code', 'running', '读取邮箱验证码');
    await log(`${task.email} 正在读取邮箱验证码...`);
    const code = await fetchMicrosoftGraphCode(mailbox, task.email, task.startedAt);
    await setCurrentFlowStep('code', 'success', '已获取邮箱验证码');
    await log(`${task.email} 已获取邮箱验证码。`, 'ok');
    return code;
  } catch (error) {
    await setCurrentFlowStep('code', 'failed', error.message);
    await log(`${task.email} 读取邮箱验证码失败：${error.message}`, 'error');
    throw error;
  }
}

async function getState() {
  const [localData, sessionData] = await Promise.all([
    chrome.storage.local.get(LOCAL_STATE_KEYS),
    chrome.storage.session?.get ? chrome.storage.session.get(SESSION_STATE_KEYS) : Promise.resolve({}),
  ]);
  const data = { ...localData, ...sessionData };
  return {
    ...DEFAULT_STATE,
    ...data,
    sub2api: { ...DEFAULT_STATE.sub2api, ...(data.sub2api || {}) },
    mailboxes: Array.isArray(data.mailboxes) ? data.mailboxes : [],
    logs: Array.isArray(data.logs) ? data.logs : [],
    candidates: Array.isArray(data.candidates) ? data.candidates : [],
    results: Array.isArray(data.results) ? data.results : [],
    pendingDeletions: Array.isArray(data.pendingDeletions) ? data.pendingDeletions : [],
    currentFlow: data.currentFlow || DEFAULT_STATE.currentFlow,
  };
}

async function getPublicState() {
  const state = await getState();
  return {
    ...state,
    sub2api: { ...state.sub2api, password: state.sub2api.password ? '********' : '' },
    mailboxes: state.mailboxes.map(mailbox => ({
      ...mailbox,
      refreshToken: mailbox.refreshToken ? '********' : '',
      password: mailbox.password ? '********' : '',
    })),
  };
}

async function setStatePatch(patch) {
  const localPatch = {};
  const sessionPatch = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (LOCAL_STATE_KEYS.includes(key)) {
      localPatch[key] = value;
    } else if (SESSION_STATE_KEYS.includes(key)) {
      sessionPatch[key] = value;
    } else {
      sessionPatch[key] = value;
    }
  }
  const writes = [];
  if (Object.keys(localPatch).length) writes.push(chrome.storage.local.set(localPatch));
  if (Object.keys(sessionPatch).length) {
    writes.push(chrome.storage.session?.set
      ? chrome.storage.session.set(sessionPatch)
      : chrome.storage.local.set(sessionPatch));
  }
  await Promise.all(writes);
  await notifyState();
}

async function resetCurrentFlow(account = {}) {
  const flow = createEmptyFlow({
    id: getRemoteAccountId(account),
    email: inferEmail(account),
    label: inferEmail(account) || account.name || account.id || '未知账号',
  });
  await setStatePatch({ currentFlow: flow });
}

async function setCurrentFlowStep(stepId, status, detail = '') {
  const state = await getState();
  const currentFlow = state.currentFlow || createEmptyFlow();
  const steps = currentFlow.steps.map(step => {
    if (step.id === stepId) {
      return {
        ...step,
        status,
        detail,
        updatedAt: Date.now(),
      };
    }
    return step;
  });
  await setStatePatch({
    currentFlow: {
      ...currentFlow,
      steps,
      currentStepId: stepId,
      updatedAt: Date.now(),
    },
  });
}

function createEmptyFlow(meta = {}) {
  return {
    id: meta.id || '',
    email: meta.email || '',
    label: meta.label || '',
    currentStepId: '',
    updatedAt: Date.now(),
    steps: [
      { id: 'start', title: '开始处理', status: 'pending', detail: '' },
      { id: 'refresh', title: '尝试 sub2api refresh', status: 'pending', detail: '' },
      { id: 'mailbox', title: '匹配托管邮箱', status: 'pending', detail: '' },
      { id: 'auth_url', title: '生成 OAuth 授权链接', status: 'pending', detail: '' },
      { id: 'browser', title: '浏览器登录授权', status: 'pending', detail: '' },
      { id: 'code', title: '读取并提交验证码', status: 'pending', detail: '' },
      { id: 'callback', title: '捕获 OAuth callback', status: 'pending', detail: '' },
      { id: 'apply', title: '更新 sub2api 凭证', status: 'pending', detail: '' },
      { id: 'done', title: '完成 / 跳过', status: 'pending', detail: '' },
    ],
  };
}

async function saveConfig(payload = {}) {
  const state = await getState();
  const sub2api = {
    ...state.sub2api,
    ...(payload.sub2api || {}),
  };
  if (payload.sub2api?.password === '********') sub2api.password = state.sub2api.password;
  let mailboxes = state.mailboxes;
  if (Array.isArray(payload.mailboxes)) {
    mailboxes = payload.mailboxes.map((mailbox, index) => normalizeMailbox(mailbox, index, state.mailboxes));
  }
  const operationDelayEnabled = payload.operationDelayEnabled === undefined
    ? state.operationDelayEnabled
    : payload.operationDelayEnabled !== false;
  const operationDelayMs = payload.operationDelayMs === undefined
    ? getOperationDelayMs(state)
    : getOperationDelayMs(payload);
  await setStatePatch({ sub2api, mailboxes, operationDelayEnabled, operationDelayMs });
  await log('配置已保存。', 'ok');
  return getPublicState();
}

async function importMailboxes(incoming = []) {
  if (!Array.isArray(incoming) || !incoming.length) throw new Error('没有可导入的邮箱');
  const state = await getState();
  const { mailboxes, added, updated, skipped } = mergeMailboxLists(state.mailboxes, incoming);
  await setStatePatch({ mailboxes });
  await log(`邮箱池导入完成：新增 ${added}，更新 ${updated}，跳过 ${skipped}，当前共 ${mailboxes.length} 个。`, 'ok');
  return {
    ok: true,
    summary: { added, updated, skipped, total: mailboxes.length },
    state: await getPublicState(),
  };
}

async function exportSettingsBundle() {
  const state = await getState();
  const settings = {
    sub2api: state.sub2api,
    mailboxes: state.mailboxes,
    pendingDeletions: state.pendingDeletions,
    operationDelayEnabled: state.operationDelayEnabled,
    operationDelayMs: state.operationDelayMs,
  };
  const bundle = {
    schemaVersion: SETTINGS_EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    extensionName: chrome.runtime.getManifest().name,
    extensionVersion: chrome.runtime.getManifest().version,
    settings,
  };
  return {
    fileName: buildSettingsExportFilename(),
    fileContent: JSON.stringify(bundle, null, 2),
  };
}

async function importSettingsBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new Error('配置文件内容无效');
  }
  const schemaVersion = Number(bundle.schemaVersion);
  if (schemaVersion !== SETTINGS_EXPORT_SCHEMA_VERSION) {
    throw new Error(`仅支持导入 schemaVersion=${SETTINGS_EXPORT_SCHEMA_VERSION} 的配置文件`);
  }
  const incoming = bundle.settings;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    throw new Error('配置文件缺少 settings 配置段');
  }
  const state = await getState();
  if (state.running || runtime.running) {
    throw new Error('当前刷新任务正在运行，不能导入配置');
  }

  const patch = {};
  if (incoming.sub2api && typeof incoming.sub2api === 'object' && !Array.isArray(incoming.sub2api)) {
    patch.sub2api = normalizeSub2ApiSettings(incoming.sub2api, state.sub2api);
  }
  let mailSummary = { added: 0, updated: 0, skipped: 0, total: state.mailboxes.length };
  if (Array.isArray(incoming.mailboxes)) {
    const merged = mergeMailboxLists(state.mailboxes, incoming.mailboxes);
    patch.mailboxes = merged.mailboxes;
    mailSummary = {
      added: merged.added,
      updated: merged.updated,
      skipped: merged.skipped,
      total: merged.mailboxes.length,
    };
  }
  if (Array.isArray(incoming.pendingDeletions)) {
    patch.pendingDeletions = mergePendingDeletions(state.pendingDeletions, incoming.pendingDeletions);
  }
  if (Object.prototype.hasOwnProperty.call(incoming, 'operationDelayEnabled')) {
    patch.operationDelayEnabled = incoming.operationDelayEnabled !== false;
  }
  if (Object.prototype.hasOwnProperty.call(incoming, 'operationDelayMs')) {
    patch.operationDelayMs = getOperationDelayMs({ operationDelayMs: incoming.operationDelayMs });
  }
  if (!Object.keys(patch).length) throw new Error('配置文件里没有可导入的内容');

  await setStatePatch(patch);
  await log(`配置导入完成：邮箱新增 ${mailSummary.added}，更新 ${mailSummary.updated}，跳过 ${mailSummary.skipped}。`, 'ok');
  return {
    ok: true,
    summary: mailSummary,
    state: await getPublicState(),
  };
}

function buildSettingsExportFilename(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${SETTINGS_EXPORT_FILENAME_PREFIX}-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.json`;
}

function normalizeSub2ApiSettings(value = {}, previous = {}) {
  return {
    baseUrl: normalizeString(value.baseUrl || value.url || previous.baseUrl),
    email: normalizeString(value.email || previous.email),
    password: value.password === '********' ? (previous.password || '') : String(value.password ?? previous.password ?? ''),
    proxy: normalizeString(value.proxy || previous.proxy),
    maxItems: normalizeMaxItems(value.maxItems ?? previous.maxItems),
  };
}

function mergePendingDeletions(existing = [], incoming = []) {
  const map = new Map();
  for (const item of [...existing, ...incoming]) {
    const normalized = normalizePendingDeletion(item);
    if (!normalized) continue;
    map.set(`${normalized.id || ''}|${normalized.email || ''}`, normalized);
  }
  return Array.from(map.values());
}

function normalizePendingDeletion(item = {}) {
  const id = normalizeString(item.id || item.accountId);
  const email = normalizeString(item.email).toLowerCase();
  if (!id && !email) return null;
  return {
    id,
    email,
    reason: normalizeString(item.reason),
    markedAt: Math.max(0, Number(item.markedAt) || Date.now()),
  };
}

function mergeMailboxLists(existing = [], incoming = []) {
  const map = new Map();
  for (const mailbox of existing) {
    const normalized = normalizeMailbox(mailbox, map.size, existing);
    if (normalized.email) map.set(normalized.email, normalized);
  }

  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const rawMailbox of incoming) {
    const email = normalizeString(rawMailbox?.email).toLowerCase();
    if (!email) {
      skipped += 1;
      continue;
    }
    const previous = map.get(email);
    const aliases = mergeAliasLists(previous?.aliases, rawMailbox.aliases);
    const normalized = normalizeMailbox({
      ...(previous || {}),
      ...rawMailbox,
      id: previous?.id || rawMailbox.id,
      aliases,
      refreshToken: rawMailbox.refreshToken || rawMailbox.refresh_token || previous?.refreshToken,
    }, map.size, existing);
    if (!normalized.clientId || !normalized.refreshToken) {
      skipped += 1;
      continue;
    }
    map.set(email, normalized);
    if (previous) updated += 1;
    else added += 1;
  }

  return { mailboxes: Array.from(map.values()), added, updated, skipped };
}

function normalizeMailbox(mailbox, index, previous = []) {
  const existing = previous.find(item => item.id && item.id === mailbox.id)
    || previous.find(item => normalizeString(item.email).toLowerCase() === normalizeString(mailbox.email).toLowerCase())
    || {};
  return {
    id: mailbox.id || existing.id || `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
    email: normalizeString(mailbox.email || existing.email).toLowerCase(),
    clientId: normalizeString(mailbox.clientId || mailbox.client_id || existing.clientId),
    refreshToken: normalizeString(
      mailbox.refreshToken === '********' ? existing.refreshToken : (mailbox.refreshToken || mailbox.refresh_token || existing.refreshToken)
    ),
    aliases: normalizeAliasList(mailbox.aliases || existing.aliases),
  };
}

function normalizeAliasList(value) {
  if (Array.isArray(value)) return value.map(item => normalizeString(item).toLowerCase()).filter(Boolean);
  return normalizeString(value).split(/[\s,，;；]+/).map(item => item.toLowerCase()).filter(Boolean);
}

function mergeAliasLists(...values) {
  return Array.from(new Set(values.flatMap(value => normalizeAliasList(value))));
}

async function notifyState() {
  const state = await getPublicState();
  chrome.runtime.sendMessage({ type: 'STATE_CHANGED', state }).catch(() => {});
}

async function log(message, level = 'info') {
  const state = await getState();
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    time: new Date().toLocaleTimeString(),
    level,
    message,
  };
  const logs = [...state.logs, entry].slice(-300);
  await setStatePatch({ logs });
  chrome.runtime.sendMessage({ type: 'LOG_ENTRY', entry }).catch(() => {});
}

async function addResult(result) {
  const state = await getState();
  const results = [...state.results, result];
  await setStatePatch({ results });
}

async function createSub2ApiClient(options) {
  const client = new Sub2ApiClient(options);
  await client.init();
  return client;
}

class Sub2ApiClient {
  constructor(options = {}) {
    this.options = options;
    this.origin = normalizeOrigin(options.baseUrl, 'sub2api 地址');
    this.token = '';
    this.resolvedProxy = undefined;
  }

  async init() {
    const email = normalizeString(this.options.email);
    const password = String(this.options.password || '');
    if (!email) throw new Error('请填写 sub2api 登录邮箱');
    if (!password) throw new Error('请填写 sub2api 登录密码');
    const data = await requestJson(this.origin, '/api/v1/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    this.token = normalizeString(data?.access_token || data?.accessToken || data?.token);
    if (!this.token) throw new Error('sub2api 登录返回缺少 access_token');
    return this;
  }

  async request(pathname, options = {}) {
    return requestJson(this.origin, pathname, { ...options, token: this.token });
  }

  async listAccounts() {
    const errors = [];
    let emptyMatch = null;
    for (const endpoint of ACCOUNT_LIST_ENDPOINTS) {
      try {
        const payload = await this.request(endpoint, { method: 'GET' });
        const { matched, accounts } = extractAccountsFromPayload(payload);
        if (matched && accounts.length > 0) return { endpoint, accounts };
        if (matched && !emptyMatch) emptyMatch = { endpoint, accounts };
        if (!matched) errors.push(`${endpoint}: 响应中没有账号数组`);
      } catch (error) {
        errors.push(`${endpoint}: ${error.message}`);
      }
    }
    if (emptyMatch) return emptyMatch;
    throw new Error(`无法读取 sub2api 账号列表：${errors.join('；')}`);
  }

  async refreshAccount(account) {
    const id = getRemoteAccountId(account);
    if (!id) throw new Error('缺少 sub2api 账号 ID');
    return this.request(`/api/v1/admin/accounts/${encodeURIComponent(id)}/refresh`, {
      method: 'POST',
      timeoutMs: 120000,
    });
  }

  async generateOpenAiAuthUrl() {
    const proxy = await this.resolveProxy();
    const proxyId = normalizeProxyId(proxy?.id);
    const body = { redirect_uri: REDIRECT_URI };
    if (proxyId) body.proxy_id = proxyId;
    const data = await this.request('/api/v1/admin/openai/generate-auth-url', {
      method: 'POST',
      body,
    });
    const authUrl = normalizeString(data?.auth_url || data?.authUrl);
    const sessionId = normalizeString(data?.session_id || data?.sessionId);
    const state = normalizeString(data?.state || extractStateFromAuthUrl(authUrl));
    if (!authUrl || !sessionId) throw new Error('sub2api 未返回 auth_url / session_id');
    return { authUrl, sessionId, state, proxyId, redirectUri: REDIRECT_URI };
  }

  async exchangeOpenAiCode(authSession, callbackUrl) {
    const callback = parseOAuthCallbackUrl(callbackUrl, authSession.state);
    const body = {
      session_id: authSession.sessionId,
      code: callback.code,
      state: callback.state,
      redirect_uri: authSession.redirectUri || REDIRECT_URI,
    };
    if (authSession.proxyId) body.proxy_id = authSession.proxyId;
    return this.request('/api/v1/admin/openai/exchange-code', {
      method: 'POST',
      timeoutMs: 120000,
      body,
    });
  }

  async applyOAuthCredentials(account, tokenInfo) {
    const id = getRemoteAccountId(account);
    const credentials = {};
    for (const key of OPENAI_OAUTH_CREDENTIAL_KEYS) {
      if (tokenInfo?.[key] !== undefined && tokenInfo?.[key] !== null && tokenInfo?.[key] !== '') {
        credentials[key] = tokenInfo[key];
      }
    }
    if (!credentials.access_token) throw new Error('sub2api OAuth exchange 未返回 access_token');
    const extra = {};
    for (const key of ['email', 'name', 'privacy_mode']) {
      if (tokenInfo?.[key]) extra[key] = tokenInfo[key];
    }
    const body = { type: 'oauth', credentials };
    if (Object.keys(extra).length) body.extra = extra;
    return this.request(`/api/v1/admin/accounts/${encodeURIComponent(id)}/apply-oauth-credentials`, {
      method: 'POST',
      timeoutMs: 120000,
      body,
    });
  }

  async clearError(account) {
    const id = getRemoteAccountId(account);
    if (!id) return false;
    try {
      await this.request(`/api/v1/admin/accounts/${encodeURIComponent(id)}/clear-error`, { method: 'POST' });
      return true;
    } catch {
      return false;
    }
  }

  async deleteAccount(account) {
    const id = getRemoteAccountId(account);
    if (!id) throw new Error('缺少 sub2api 账号 ID，无法删除');
    return this.request(`/api/v1/admin/accounts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      timeoutMs: 30000,
    });
  }

  async resolveProxy() {
    if (this.resolvedProxy !== undefined) return this.resolvedProxy;
    this.resolvedProxy = await resolveSub2ApiProxy(this, this.options.proxy);
    return this.resolvedProxy;
  }
}

async function resolveSub2ApiProxy(client, preference = '') {
  const raw = normalizeString(preference);
  if (!raw) return null;
  const proxies = await client.request('/api/v1/admin/proxies/all?with_count=true', { method: 'GET' });
  if (!Array.isArray(proxies)) throw new Error('sub2api 代理列表返回格式异常');
  const active = proxies.filter(proxy => normalizeProxyId(proxy.id) && (!proxy.status || String(proxy.status).toLowerCase() === 'active'));
  const preferredId = normalizeProxyId(raw);
  if (preferredId) {
    const matched = active.find(proxy => normalizeProxyId(proxy.id) === preferredId);
    if (matched) return matched;
    throw new Error(`sub2api 代理 ID ${raw} 不存在或未启用`);
  }
  const lower = raw.toLowerCase();
  const exact = active.filter(proxy => normalizeString(proxy.name).toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`sub2api 代理 ${raw} 匹配到多个，请填 ID`);
  const fuzzy = active.filter(proxy => [proxy.id, proxy.name, proxy.host, proxy.protocol, proxy.port].map(normalizeString).join(' ').toLowerCase().includes(lower));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) throw new Error(`sub2api 代理 ${raw} 匹配到多个，请填 ID`);
  throw new Error(`sub2api 代理 ${raw} 不存在或未启用`);
}

async function fetchMicrosoftGraphCode(mailbox, targetEmail, filterAfterTimestamp) {
  const sinceMs = Math.max(0, Number(filterAfterTimestamp) || Date.now() - 10 * 60 * 1000);
  let lastResendAt = 0;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const result = await fetchMicrosoftMailboxMessages(mailbox, HOTMAIL_MAILBOXES, 10);
      if (result.nextRefreshToken) {
        await rotateMailboxRefreshToken(mailbox.id, result.nextRefreshToken);
        mailbox = { ...mailbox, refreshToken: result.nextRefreshToken };
      }
      const messages = result.messages.filter(message => {
        const ts = normalizeTimestamp(message.receivedDateTime || message.receivedTimestamp);
        return !ts || ts >= sinceMs - 60 * 1000;
      });
      const code = findCodeInMessages(messages, targetEmail, mailbox);
      if (code) return code;
      if (attempt % 5 === 0) {
        await log(`${targetEmail} Microsoft API 已检查 ${messages.length} 封邮件（${result.transport}/${result.tokenStrategy}），暂未匹配验证码。`, 'info');
      }
    } catch (error) {
      throw error;
    }

    if (attempt >= 8 && Date.now() - lastResendAt > 45000) {
      await requestAuthPageResendCode();
      lastResendAt = Date.now();
    }
    await sleep(attempt < 8 ? 2500 : 4000);
  }
  throw new Error('等待邮箱验证码超时');
}

async function requestAuthPageResendCode() {
  const task = runtime.currentTask;
  if (!task?.tabId) return false;
  try {
    const response = await chrome.tabs.sendMessage(task.tabId, { type: 'REQUEST_RESEND_CODE' });
    if (response?.ok) {
      await log(`${task.email} 已请求认证页重发验证码。`, 'warn');
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function refreshMicrosoftAccessToken(mailbox) {
  return exchangeMicrosoftRefreshToken(
    normalizeString(mailbox.clientId),
    normalizeString(mailbox.refreshToken),
    'entra-common-delegated'
  );
}

async function fetchMicrosoftMailboxMessages(mailbox, mailboxes = HOTMAIL_MAILBOXES, top = 10) {
  const clientId = normalizeString(mailbox.clientId);
  const refreshToken = normalizeString(mailbox.refreshToken);
  if (!clientId || !refreshToken) throw new Error(`${mailbox.email} 缺少 client_id 或 refresh_token`);
  const errors = [];
  for (const plan of MICROSOFT_TRANSPORT_PLANS) {
    for (const strategyName of plan.strategyNames) {
      try {
        const tokenData = await exchangeMicrosoftRefreshToken(clientId, refreshToken, strategyName);
        const mailboxResults = [];
        for (const label of mailboxes) {
          const messages = plan.transport === 'graph'
            ? await fetchGraphMessages(tokenData.access_token, label, top)
            : await fetchOutlookMessages(tokenData.access_token, label, top);
          mailboxResults.push({ mailbox: normalizeMailboxLabel(label), messages });
        }
        return {
          transport: plan.transport,
          tokenStrategy: strategyName,
          nextRefreshToken: normalizeString(tokenData.refresh_token),
          mailboxResults,
          messages: mailboxResults.flatMap(item => item.messages),
        };
      } catch (error) {
        errors.push(`${plan.transport}/${strategyName}: ${error.message}`);
      }
    }
  }
  throw new Error(`Microsoft API 对接失败：${errors.join(' | ')}`);
}

async function exchangeMicrosoftRefreshToken(clientId, refreshToken, strategyName) {
  const strategy = MICROSOFT_TOKEN_STRATEGIES.find(item => item.name === strategyName) || MICROSOFT_TOKEN_STRATEGIES[0];
  const body = new URLSearchParams();
  body.set('client_id', clientId);
  body.set('refresh_token', refreshToken);
  body.set('grant_type', 'refresh_token');
  for (const [key, value] of Object.entries(strategy.extraData || {})) {
    body.set(key, value);
  }
  const response = await fetch(strategy.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${strategy.name}: ${payload.error_description || payload.error || `Microsoft token HTTP ${response.status}`}`);
  const accessToken = normalizeString(payload.access_token);
  if (!accessToken) throw new Error(`${strategy.name}: Microsoft 未返回 access_token`);
  return {
    ...payload,
    access_token: accessToken,
  };
}

async function fetchGraphMessages(accessToken, mailbox = 'INBOX', top = 10) {
  const mailboxId = normalizeMailboxId(mailbox);
  const url = new URL(`https://graph.microsoft.com/v1.0/me/mailFolders/${mailboxId}/messages`);
  url.searchParams.set('$top', String(Math.max(1, Math.min(Number(top) || 10, 30))));
  url.searchParams.set('$orderby', 'receivedDateTime desc');
  url.searchParams.set('$select', 'id,internetMessageId,subject,from,bodyPreview,body,receivedDateTime,toRecipients,ccRecipients,bccRecipients');
  const data = await requestJson(url.origin, `${url.pathname}${url.search}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
    timeoutMs: 30000,
  });
  return normalizeMicrosoftMessages(data?.value, mailbox);
}

async function fetchOutlookMessages(accessToken, mailbox = 'INBOX', top = 10) {
  const mailboxId = normalizeMailboxId(mailbox);
  const url = new URL(`https://outlook.office.com/api/v2.0/me/mailfolders/${mailboxId}/messages`);
  url.searchParams.set('$top', String(Math.max(1, Math.min(Number(top) || 10, 30))));
  url.searchParams.set('$orderby', 'ReceivedDateTime desc');
  url.searchParams.set('$select', 'Id,Subject,From,BodyPreview,Body,ReceivedDateTime,ToRecipients,CcRecipients,BccRecipients');
  const data = await requestJson(url.origin, `${url.pathname}${url.search}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
    timeoutMs: 30000,
  });
  return normalizeMicrosoftMessages(data?.value, mailbox);
}

async function rotateMailboxRefreshToken(mailboxId, refreshToken) {
  const state = await getState();
  const mailboxes = state.mailboxes.map(mailbox => mailbox.id === mailboxId ? { ...mailbox, refreshToken } : mailbox);
  await setStatePatch({ mailboxes });
}

function findCodeInMessages(messages, targetEmail, mailbox = {}) {
  for (const message of messages) {
    const matchText = [
      message.subject,
      message.bodyPreview,
      message.body?.content,
      ...(message.recipients?.all || []),
      ...(message.toRecipients || []).map(item => item.emailAddress?.address || item.EmailAddress?.Address),
    ].filter(Boolean).join('\n');
    const codeText = [
      message.subject,
      message.bodyPreview,
      message.body?.content,
    ].filter(Boolean).join('\n');
    const matchState = getTargetEmailMatchState(matchText, targetEmail, mailbox);
    if (!matchState.matches && matchState.hasExplicitEmail) continue;
    const code = extractCode(codeText);
    if (code) return code;
  }
  return '';
}

function findAnyCodeInMessages(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    const code = extractCode([message.subject, message.bodyPreview, message.body?.content].filter(Boolean).join('\n'));
    if (code) return code;
  }
  return '';
}

function findMailboxByIdentifier(mailboxes = [], identifier = '') {
  const id = normalizeString(identifier).toLowerCase();
  return (Array.isArray(mailboxes) ? mailboxes : []).find(mailbox => normalizeString(mailbox.id).toLowerCase() === id || normalizeString(mailbox.email).toLowerCase() === id) || null;
}

function maskCode(code = '') {
  const raw = String(code || '');
  if (raw.length <= 2) return '*'.repeat(raw.length);
  return `${raw.slice(0, 1)}${'*'.repeat(Math.max(2, raw.length - 2))}${raw.slice(-1)}`;
}

function isDeactivatedMessage(message = '') {
  const lower = normalizeString(message).toLowerCase();
  return lower.includes('account_deactivated')
    || lower.includes('account deactivated')
    || lower.includes('deleted or deactivated')
    || lower.includes('账户已被删除或停用')
    || lower.includes('账号已停用')
    || lower.includes('账户已停用');
}

function isPhoneVerificationBlockMessage(message = '') {
  const lower = normalizeString(message).toLowerCase();
  return lower.includes('手机号/whatsapp 验证')
    || lower.includes('手机验证码页')
    || lower.includes('手机号页面')
    || lower.includes('phone-verification')
    || lower.includes('phone verification')
    || lower.includes('whatsapp');
}

function isMicrosoftMailboxAuthError(message = '') {
  const lower = normalizeString(message).toLowerCase();
  return lower.includes('aadsts50196')
    || lower.includes('aadsts90023')
    || lower.includes('no applicable permissions')
    || lower.includes('client request loop')
    || lower.includes('microsoft api 对接失败')
    || /outlook\/.+http 401/i.test(message)
    || /graph\/.+failed to fetch/i.test(message);
}

function isSkippableAccountError(message = '') {
  return isPhoneVerificationBlockMessage(message) || isMicrosoftMailboxAuthError(message);
}

function getSkippableAccountReason(message = '') {
  if (isPhoneVerificationBlockMessage(message)) return '进入手机号/WhatsApp 验证';
  if (isMicrosoftMailboxAuthError(message)) return '托管邮箱 token/权限不可用';
  return '不可自动处理';
}

function normalizeMicrosoftMessages(messages, mailbox = 'INBOX') {
  return (Array.isArray(messages) ? messages : []).map(message => normalizeMicrosoftMessage(message, mailbox));
}

function normalizeMicrosoftMessage(message = {}, mailbox = 'INBOX') {
  const sender = message.From || message.from || {};
  const senderEmail = sender.EmailAddress || sender.emailAddress || {};
  const body = message.Body || message.body || {};
  const recipients = normalizeMessageRecipients({
    toRecipients: message.ToRecipients || message.toRecipients || message.to,
    ccRecipients: message.CcRecipients || message.ccRecipients || message.cc,
    bccRecipients: message.BccRecipients || message.bccRecipients || message.bcc,
  });
  return {
    id: normalizeString(message.Id || message.id || message.internetMessageId),
    mailbox: normalizeMailboxLabel(mailbox),
    subject: normalizeString(message.Subject || message.subject),
    from: {
      emailAddress: {
        address: normalizeString(senderEmail.Address || senderEmail.address),
        name: normalizeString(senderEmail.Name || senderEmail.name),
      },
    },
    bodyPreview: normalizeString(message.BodyPreview || message.bodyPreview),
    body: {
      content: normalizeString(body.Content || body.content),
    },
    receivedDateTime: normalizeString(message.ReceivedDateTime || message.receivedDateTime),
    recipients,
  };
}

function normalizeMessageRecipients(message = {}) {
  const to = normalizeMailAddressList(message.toRecipients || message.to);
  const cc = normalizeMailAddressList(message.ccRecipients || message.cc);
  const bcc = normalizeMailAddressList(message.bccRecipients || message.bcc);
  return {
    to,
    cc,
    bcc,
    all: Array.from(new Set([...to, ...cc, ...bcc])),
  };
}

function normalizeMailAddressList(value) {
  const source = Array.isArray(value) ? value : (value ? [value] : []);
  return source.map(normalizeMailAddress).filter(Boolean);
}

function normalizeMailAddress(value) {
  if (!value) return '';
  if (typeof value === 'string') return normalizeString(value);
  const emailAddress = value.EmailAddress || value.emailAddress || {};
  return normalizeString(emailAddress.Address || emailAddress.address || value.Address || value.address || value.email);
}

function getTargetEmailMatchState(text, targetEmail, mailbox = {}) {
  const target = parseEmailParts(targetEmail);
  if (!target) return { matches: true, hasExplicitEmail: false };
  const lower = String(text || '').toLowerCase();
  const emails = Array.from(new Set(lower.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || []))
    .map(parseEmailParts)
    .filter(Boolean);
  const mailboxEmail = parseEmailParts(mailbox.email);
  const aliasSet = new Set([...(mailbox.aliases || []), target.full].map(item => normalizeString(item).toLowerCase()).filter(Boolean));
  const targetFamily = emails.filter(email => email.domain === target.domain && email.localPart.split('+')[0] === target.localPart.split('+')[0]);
  const explicitAliases = targetFamily.filter(email => {
    if (mailboxEmail?.full === email.full) return false;
    return email.localPart.includes('+') || target.localPart.includes('+') || aliasSet.has(email.full);
  });
  const hasExplicitEmail = explicitAliases.length > 0;
  if (targetFamily.some(email => email.full === target.full || aliasSet.has(email.full))) return { matches: true, hasExplicitEmail };
  if (hasExplicitEmail) return { matches: false, hasExplicitEmail: true };
  return { matches: true, hasExplicitEmail: false };
}

function extractCode(text) {
  const normalized = stripHtml(String(text || ''));
  const patterns = [
    /(?:code|验证码|代碼|verification|verify)[^\d]{0,60}(\d{6,8})/i,
    /(\d{6,8})[^\d]{0,40}(?:code|验证码|代碼|verification|verify)/i,
    /\b(\d{6})\b/,
    /\b(\d{8})\b/,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return match[1];
  }
  return '';
}

function stripHtml(value = '') {
  return String(value)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function findMailboxForTarget(targetEmail) {
  const state = await getState();
  return state.mailboxes.find(mailbox => emailsMatchOrAlias(mailbox.email, targetEmail, mailbox.aliases)) || null;
}

function extractAccountsFromPayload(payload) {
  const candidates = [payload, payload?.accounts, payload?.items, payload?.data, payload?.data?.accounts, payload?.data?.items];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return { matched: true, accounts: candidate };
  }
  return { matched: false, accounts: [] };
}

function isOpenAiAccount(account = {}) {
  const text = [account.platform, account.provider, account.type, account.account_type, account.credentials?.type].filter(Boolean).join(' ').toLowerCase();
  return !text || text.includes('openai') || Boolean(account.credentials?.access_token);
}

function is401Account(account = {}) {
  const text = collectDiagnosticText(account).toLowerCase();
  return /\b401\b/.test(text) || text.includes('unauthorized') || text.includes('token_invalidated') || text.includes('token invalidated') || text.includes('token revoked');
}

function collectDiagnosticText(value, depth = 0, seen = new Set()) {
  if (value === undefined || value === null || depth > 5) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'object') return '';
  if (seen.has(value)) return '';
  seen.add(value);
  return Object.entries(value)
    .filter(([key]) => !/access.?token|refresh.?token|password|secret|authorization/i.test(key))
    .map(([key, entry]) => /status|error|message|reason|detail|code|invalid|unauthor|revoked|failed/i.test(key) || typeof entry === 'object'
      ? `${key} ${collectDiagnosticText(entry, depth + 1, seen)}`
      : '')
    .filter(Boolean)
    .join(' ');
}

function mapCandidate(account) {
  return {
    id: account.id,
    name: account.name || account.label || '',
    email: inferEmail(account),
    status: account.status || '',
    message: normalizeString(account.status_message || account.error || account.message || collectDiagnosticText(account)).slice(0, 240),
  };
}

function inferEmail(account = {}) {
  const candidates = [account.email, account.name, account.label, account.credentials?.email, account.extra?.email, account.user?.email];
  for (const value of candidates) {
    const match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (match) return match[0].toLowerCase();
  }
  return '';
}

function getRemoteAccountId(account) {
  const id = account?.id;
  return id === undefined || id === null || id === '' ? '' : String(id);
}

function normalizeOrigin(rawUrl, label) {
  const raw = normalizeString(rawUrl);
  if (!raw) throw new Error(`请填写 ${label}`);
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return new URL(withProtocol).origin;
}

function normalizeString(value = '') {
  return String(value || '').trim();
}

function normalizeMaxItems(value) {
  const n = Math.floor(Number(value) || 20);
  return Math.max(1, Math.min(100, n));
}

function getOperationDelayMs(state = {}) {
  if (state.operationDelayEnabled === false) return 0;
  const value = Number(state.operationDelayMs);
  if (!Number.isFinite(value)) return 2000;
  return Math.max(0, Math.min(10000, Math.floor(value)));
}

function normalizeProxyId(value) {
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeMailboxLabel(mailbox = 'INBOX') {
  return /^junk(?:\s*e-?mail|\s*email)?$/i.test(String(mailbox || '').trim()) ? 'Junk' : 'INBOX';
}

function normalizeMailboxId(mailbox = 'INBOX') {
  return normalizeMailboxLabel(mailbox) === 'Junk' ? 'junkemail' : 'inbox';
}

function normalizeTimestamp(value) {
  if (!value) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value > 0 ? value : 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function requestJson(origin, pathname, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 30000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${origin}${pathname}`, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.headers || {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'code')) {
      if (Number(payload.code) === 0) return payload.data;
      throw new Error(payload.message || payload.error || `${pathname} HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(payload?.message || payload?.error || payload?.detail || `${pathname} HTTP ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function extractStateFromAuthUrl(authUrl = '') {
  try {
    return new URL(authUrl).searchParams.get('state') || '';
  } catch {
    return '';
  }
}

function parseOAuthCallbackUrl(rawUrl = '', expectedState = '') {
  const parsed = new URL(rawUrl);
  const code = normalizeString(parsed.searchParams.get('code'));
  const state = normalizeString(parsed.searchParams.get('state'));
  if (!code || !state) throw new Error('OAuth callback 缺少 code 或 state');
  if (expectedState && state !== expectedState) throw new Error('OAuth callback state 不一致');
  return { code, state, url: parsed.toString() };
}

function isOAuthCallbackUrl(rawUrl = '', expectedState = '') {
  const state = getOAuthCallbackState(rawUrl, expectedState);
  return state.matches && state.hasCode;
}

function getOAuthCallbackState(rawUrl = '', expectedState = '') {
  try {
    const parsed = new URL(rawUrl);
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) return { matches: false };
    if (parsed.pathname !== '/auth/callback') return { matches: false };
    const state = normalizeString(parsed.searchParams.get('state'));
    if (!state || (expectedState && state !== expectedState)) return { matches: false };
    return {
      matches: true,
      hasCode: Boolean(parsed.searchParams.get('code')),
      error: normalizeString(parsed.searchParams.get('error')),
      errorDescription: normalizeString(parsed.searchParams.get('error_description')).replace(/\+/g, ' '),
      state,
    };
  } catch {
    return { matches: false };
  }
}

function emailsMatchOrAlias(mailboxEmail, targetEmail, aliases = []) {
  const target = parseEmailParts(targetEmail);
  const mailbox = parseEmailParts(mailboxEmail);
  if (!target || !mailbox) return false;
  const aliasSet = new Set((Array.isArray(aliases) ? aliases : []).map(value => normalizeString(value).toLowerCase()).filter(Boolean));
  if (aliasSet.has(target.full)) return true;
  if (mailbox.full === target.full) return true;
  if (mailbox.domain === target.domain && target.localPart.includes('+')) {
    return target.localPart.split('+')[0] === mailbox.localPart;
  }
  return false;
}

function parseEmailParts(value = '') {
  const email = normalizeString(value).toLowerCase();
  const match = email.match(/^([^@\s]+)@([^@\s]+\.[^@\s]+)$/);
  if (!match) return null;
  return { full: email, localPart: match[1], domain: match[2] };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
