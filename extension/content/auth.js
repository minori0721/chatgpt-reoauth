const AUTH_PREFIX = '[chatgpt-reoauth]';
let activeDriveTaskId = '';

main().catch(error => {
  console.warn(AUTH_PREFIX, error?.message || error);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'REQUEST_RESEND_CODE') {
    const button = findResendButton();
    if (button) {
      stableClick(button).then(() => {
        sendResponse({ ok: true });
      }).catch(error => {
        sendResponse({ ok: false, error: error?.message || '重发验证码失败' });
      });
    } else {
      sendResponse({ ok: false, error: '没有找到重发验证码按钮' });
    }
    return true;
  }
  if (message.type === 'DRIVE_AUTH_PAGE') {
    driveAuthPageOnce(message.task).then(() => {
      sendResponse({ ok: true });
    }).catch(error => {
      sendResponse({ ok: false, error: error?.message || String(error || '驱动认证页失败') });
    });
    return true;
  }
  return false;
});

async function main() {
  await sleep(600);
  const response = await chrome.runtime.sendMessage({
    type: 'AUTH_PAGE_READY',
    payload: { url: location.href },
  });
  if (!response?.ok || !response.task) return;
  await driveAuthPageOnce(response.task);
}

async function driveAuthPageOnce(task) {
  if (!task?.id || activeDriveTaskId === task.id) return;
  activeDriveTaskId = task.id;
  try {
    await driveAuthPage(task);
  } catch (error) {
    await reportFatal(task, error?.message || String(error || '认证页驱动失败'));
    throw error;
  } finally {
    if (activeDriveTaskId === task.id) activeDriveTaskId = '';
  }
}

async function driveAuthPage(task) {
  let lastActionKey = '';
  let repeatedActionCount = 0;
  for (let round = 0; round < 40; round += 1) {
    const snapshot = await waitForKnownAuthState(15000, task);
    if (snapshot.state === 'callback') return;
    if (snapshot.state === 'fatal') {
      await reportFatal(task, snapshot.fatal);
      return;
    }
    if (snapshot.state === 'unknown') {
      await authLog(`${task.email} 认证页仍在加载，等待页面稳定...`);
      await sleep(1200);
      continue;
    }

    const actionKey = `${snapshot.state}:${location.href}`;
    repeatedActionCount = actionKey === lastActionKey ? repeatedActionCount + 1 : 0;
    lastActionKey = actionKey;
    if (repeatedActionCount >= 3) {
      await authLog(`${task.email} 页面停留在 ${snapshot.state}，暂停重复点击，等待页面继续加载...`, 'warn');
      await sleep(3000);
      repeatedActionCount = 0;
      continue;
    }

    const before = getPageSignature();
    let handled = false;
    try {
      handled = await handleAuthState(task, snapshot);
    } catch (error) {
      if (error?.name === 'PageStateChangedError') {
        await authLog(`${task.email} ${error.message}，继续识别新页面状态...`, 'info');
        await sleep(300);
        continue;
      }
      throw error;
    }
    if (!handled) {
      await sleep(1000);
      continue;
    }
    await waitForPageTransition(before, snapshot.state, 12000);
  }
}

async function handleAuthState(task, snapshot) {
  switch (snapshot.state) {
    case 'consent_page':
      await performPageAction(task, '点击 OAuth 继续按钮', async () => {
        await stableClick(() => findConsentButton(), 'OAuth 继续按钮');
      }, 1800);
      return true;
    case 'code_page': {
      const code = await fetchCode(task.id);
      await performPageAction(task, '提交邮箱验证码', async () => {
        fillVerificationCode(snapshot.codeInput, code);
        await sleep(350);
        const submit = findSubmitButton();
        if (submit) await stableClick(() => findSubmitButton(), '验证码提交按钮');
      }, 1800);
      return true;
    }
    case 'one_time_code_entry':
      await performPageAction(task, '切换一次性验证码登录', async () => {
        await stableClick(() => findOneTimeCodeButton(), '一次性验证码入口');
      }, 1800);
      return true;
    case 'email_page':
      await performPageAction(task, '填写并提交邮箱', async () => {
        fillInput(snapshot.emailInput, task.email);
        await sleep(450);
        await submitLoginForm(snapshot.emailInput);
      }, 1800);
      return true;
    case 'choose_account_page':
      await authLog(`${task.email} 账号选择页：${snapshot.chooseAction.label}`);
      await performPageAction(task, snapshot.chooseAction.label, async () => {
        await stableClick(() => findChooseAccountAction(task.email)?.target, snapshot.chooseAction.label, {
          expectedState: 'choose_account_page',
          task,
        });
      }, 2200);
      return true;
    case 'retry_error_page':
      await recoverRetryErrorPage(task, snapshot.retryPage);
      return true;
    default:
      return false;
  }
}

function inspectAuthPage(task = {}) {
  const fatal = detectFatalAuthError();
  if (fatal) return { state: 'fatal', fatal };
  if (isCallbackLikePage()) return { state: 'callback' };

  const phoneBlock = detectPhoneVerificationBlock();
  if (phoneBlock) return { state: 'fatal', fatal: phoneBlock };

  const retryPage = detectAuthRetryPage();
  if (retryPage?.fatal) return { state: 'fatal', fatal: retryPage.fatal };
  if (retryPage) return { state: 'retry_error_page', retryPage };

  const consentButton = findConsentButton();
  if (consentButton) return { state: 'consent_page', consentButton };

  const codeInput = findCodeInput();
  if (codeInput) return { state: 'code_page', codeInput };

  const emailInput = findEmailInput();
  if (emailInput) return { state: 'email_page', emailInput };

  const chooseAction = findChooseAccountAction(task.email);
  if (chooseAction?.target) return { state: 'choose_account_page', chooseAction };

  const oneTimeCodeButton = findOneTimeCodeButton();
  if (oneTimeCodeButton) return { state: 'one_time_code_entry', oneTimeCodeButton };

  return { state: 'unknown' };
}

async function recoverRetryErrorPage(task, retryPage) {
  const maxAttempts = 5;
  const key = `chatgpt_reoauth_retry_${task.id}`;
  const current = Math.max(0, Number(sessionStorage.getItem(key)) || 0);
  if (current >= maxAttempts) {
    throw new Error(`认证页进入临时超时/重试页，已连续点击“重试” ${current} 次仍未恢复，跳过当前账号。`);
  }
  sessionStorage.setItem(key, String(current + 1));
  await performPageAction(task, `认证页超时，点击“重试”恢复（${current + 1}/${maxAttempts}）`, async () => {
    await stableClick(() => detectAuthRetryPage()?.retryButton, '认证页重试按钮');
  }, 3000);
}

async function waitForKnownAuthState(timeoutMs = 15000, task = {}) {
  const start = Date.now();
  let snapshot = inspectAuthPage(task);
  while (Date.now() - start < timeoutMs) {
    snapshot = inspectAuthPage(task);
    if (snapshot.state !== 'unknown') return snapshot;
    await sleep(250);
  }
  return snapshot;
}

async function performPageAction(task, label, action, fallbackDelayMs = 1800) {
  await waitForStablePageSnapshot(700, 4000);
  await humanPause(450, 1200);
  await action();
  await authLog(`${task.email} ${label}`);
  await operationDelay(task, fallbackDelayMs);
}

async function waitForStablePageSnapshot(stableMs = 700, timeoutMs = 4000) {
  const start = Date.now();
  let previous = getPageSignature();
  let stableSince = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(150);
    const current = getPageSignature();
    if (current === previous && document.readyState !== 'loading') {
      if (Date.now() - stableSince >= stableMs) return;
    } else {
      previous = current;
      stableSince = Date.now();
    }
  }
}

async function waitForPageTransition(before, state, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isCallbackLikePage()) return { changed: true, state: 'callback' };
    const fatal = detectFatalAuthError();
    if (fatal) return { changed: true, state: 'fatal' };
    const after = getPageSignature();
    if (after !== before) return { changed: true, state };
    await sleep(250);
  }
  return { changed: false, state };
}

function getPageSignature() {
  const text = String(document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 600);
  const inputs = Array.from(document.querySelectorAll('input'))
    .filter(isVisible)
    .map(input => [
      input.type || '',
      input.name || '',
      input.placeholder || '',
      input.getAttribute('autocomplete') || '',
      input.getAttribute('aria-label') || '',
    ].join(':'))
    .join('|');
  return `${location.href}::${document.readyState}::${text}::${inputs}`;
}

function getPageTextSnapshot() {
  return String(document.body?.innerText || document.body?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectFatalAuthError() {
  const text = document.body?.innerText || '';
  if (/account_deactivated|deleted or deactivated|账户已被删除或停用|账号已停用|账户已停用|身份验证错误/i.test(text)) {
    return text.replace(/\s+/g, ' ').slice(0, 500);
  }
  return '';
}

function detectPhoneVerificationBlock() {
  const text = getPageTextSnapshot();
  const path = `${location.pathname || ''} ${location.href || ''}`;
  const combined = `${document.title || ''} ${text}`;
  const isPhoneVerificationRoute = /\/phone-verification(?:[/?#]|$)/i.test(path);
  const isPhoneOtpRoute = /\/phone-otp(?:[/?#\/]|$)/i.test(path);
  const isAddPhoneRoute = /\/add-phone(?:[/?#]|$)/i.test(path);
  const looksLikeAddPhone = /添加(?:手机|手机号|电话号码)|绑定(?:手机|手机号|电话号码)|需要(?:手机|手机号|电话号码)|provide\s+(?:a\s+)?phone\s+number|phone\s+number\s+(?:required|verification)|verify\s+(?:your\s+)?phone/i.test(combined);
  if (!isPhoneVerificationRoute && !isPhoneOtpRoute && !(isAddPhoneRoute && looksLikeAddPhone)) return '';
  return `认证页进入手机号/WhatsApp 验证，当前 reauth 没有接码流程，已跳过当前账号。URL: ${location.href}`;
}

function detectAuthRetryPage() {
  const retryButton = findAuthRetryButton({ allowDisabled: true });
  if (!retryButton) return null;

  const text = getPageTextSnapshot();
  const combined = `${document.title || ''} ${text}`;
  const titleMatched = /糟糕[，,]?\s*出错|出错了|oops|something\s+went\s+wrong/i.test(combined);
  const detailMatched = /operation\s+timed\s+out|timed\s*out|timeout|请求超时|登录超时|failed\s+to\s+fetch|network\s+error|fetch\s+failed/i.test(combined);
  const routeErrorMatched = /max_check_attempts|too\s+many\s+requests|rate\s+limit|cloudflare/i.test(combined);
  if (!titleMatched && !detailMatched && !routeErrorMatched) return null;

  if (/max_check_attempts|cloudflare/i.test(combined)) {
    return {
      fatal: '认证页触发安全/重试限制，请先暂停 15-30 分钟后再继续。',
    };
  }

  return {
    retryButton,
    retryEnabled: !isDisabled(retryButton),
    detail: combined.replace(/\s+/g, ' ').slice(0, 300),
  };
}

function findAuthRetryButton({ allowDisabled = false } = {}) {
  const direct = document.querySelector('button[data-dd-action-name="Try again"]');
  if (direct && isVisible(direct) && (allowDisabled || !isDisabled(direct))) return direct;
  const candidates = getClickableCandidates();
  return candidates.find(element => {
    if (!isVisible(element) || (!allowDisabled && isDisabled(element))) return false;
    return /重试|再试一次|try\s+again|retry/i.test(getText(element));
  }) || null;
}

function findEmailInput() {
  return firstVisible([
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[autocomplete="username"]',
    'input[placeholder*="email" i]',
    'input[aria-label*="email" i]',
    'input[placeholder*="邮箱" i]',
    'input[aria-label*="邮箱" i]',
  ]);
}

function findCodeInput() {
  const single = firstVisible([
    'input[name="code"]',
    'input[inputmode="numeric"]',
    'input[autocomplete="one-time-code"]',
    'input[placeholder*="code" i]',
    'input[aria-label*="code" i]',
    'input[placeholder*="验证码" i]',
    'input[aria-label*="验证码" i]',
  ]);
  if (single) return single;
  const splitInputs = getSplitCodeInputs();
  return splitInputs.length >= 6 ? splitInputs[0] : null;
}

function findSubmitButton() {
  return findPrimarySubmitButton()
    || firstVisibleSubmit(['button[type="submit"]', 'input[type="submit"]']);
}

function findConsentButton() {
  const text = document.body?.innerText || '';
  const looksLikeConsent = /使用\s*chatgpt\s*登录|sign\s+in\s+to\s+codex|log\s+in\s+to\s+codex|authorize|授权|allow|允许/i.test(text);
  if (!looksLikeConsent) return null;
  return findButtonByText(/继续|授权|允许|continue|authorize|allow|agree/i);
}

function findOneTimeCodeButton() {
  return findButtonByText(/一次性验证码|验证码登录|使用验证码|one[-\s]*time|passcode|use.*code|email.*code/i);
}

function findResendButton() {
  return findButtonByText(/重新发送|再次发送|重发|没收到|未收到|resend|send.*again|new code/i);
}

function findChooseAccountAction(targetEmail) {
  if (!isChooseAccountPageReady()) return null;
  const target = normalizeEmail(targetEmail);
  const bodyCompact = compactText(document.body?.innerText || '');
  const buttons = getClickableCandidates()
    .filter(element => isVisible(element) && !isDisabled(element));
  const accountButtons = buttons.filter(element => {
    const text = getText(element);
    const value = String(element.getAttribute('value') || '').trim();
    const name = String(element.getAttribute('name') || '').trim().toLowerCase();
    const ddAction = String(element.getAttribute('data-dd-action-name') || '').trim().toLowerCase();
    return Boolean(extractEmail(text) || value || compactText(text).includes('@')) || name === 'session_id' || ddAction === 'select existing session';
  });
  const exact = accountButtons.find(element => {
    const text = getText(element);
    return normalizeEmail(extractEmail(text)) === target || compactText(text).includes(compactText(target));
  });
  if (exact) return { target: exact, label: '点击匹配的已有账号' };

  const otherAccount = findOtherAccountButton()
    || findButtonByText(/登录至另一个账户|登录到另一个账户|登录另一个账户|使用另一个账户|使用其他账户|换一个账户|另一个账户|其他账户|add another|use another|another account|sign in to another|log in to another|continue with another/i)
    || findTextClickable(/登录至另一个账户|登录到另一个账户|登录另一个账户|使用另一个账户|使用其他账户|换一个账户|另一个账户|其他账户|add another|use another|another account/i)
    || findChooseAnotherAccountFallback(buttons);
  if (otherAccount) return { target: otherAccount, label: '当前已有账号不匹配，切换到另一个账号登录' };

  if (accountButtons.length === 1 && normalizeEmail(extractEmail(getText(accountButtons[0]))) === target) {
    return { target: accountButtons[0], label: '点击唯一匹配账号' };
  }
  if (target && !bodyCompact.includes(compactText(target))) {
    const accountLike = findChooseAnotherAccountFallback(buttons);
    if (accountLike) return { target: accountLike, label: '账号选择页兜底切换入口' };
  }
  return null;
}

function findChooseAnotherAccountFallback(buttons = []) {
  const visibleButtons = buttons.filter(element => isVisible(element) && !isDisabled(element));
  const exact = visibleButtons.find(element => {
    const text = getText(element);
    if (isSocialOrAlternateLoginButton(element)) return false;
    return /登录至另一个账户|登录到另一个账户|登录另一个账户|使用另一个账户|使用其他账户|换一个账户|另一个账户|其他账户|another account|use another|sign in to another|log in to another/i.test(text);
  });
  if (exact) return exact;
  return visibleButtons.find(element => {
    const text = getText(element);
    if (isSocialOrAlternateLoginButton(element)) return false;
    if (!/账户|账号|account/i.test(text)) return false;
    if (/@/.test(text)) return false;
    if (/创建|注册|create|sign up|条款|隐私|terms|privacy/i.test(text)) return false;
    return true;
  }) || null;
}

function isChooseAccountPageReady() {
  const path = `${location.pathname || ''} ${location.href || ''}`;
  const text = document.body?.innerText || '';
  if (/\/choose-an-account(?:[/?#]|$)/i.test(path) && findOtherAccountButton()) return true;
  const hasExistingSession = Boolean(findChooseAccountExistingSessionButton({ allowDisabled: true }));
  if (/\/choose-an-account(?:[/?#]|$)/i.test(path) && hasExistingSession) return true;
  return /欢迎回来|welcome\s+back|选择一个帐户以继续|选择一个账户以继续|选择一个账号以继续|choose\s+an?\s+account\s+to\s+continue/i.test(text)
    && hasExistingSession;
}

function findOtherAccountButton() {
  const candidates = Array.from(document.querySelectorAll('a[href], button, [role="button"], [role="link"], [tabindex], [data-testid]'));
  return candidates.find(element => {
    if (!isVisible(element) || isDisabled(element)) return false;
    if (isSocialOrAlternateLoginButton(element)) return false;
    const text = getText(element);
    const href = String(element.getAttribute?.('href') || element.closest?.('a[href]')?.getAttribute?.('href') || '');
    if (/\/log-in-or-create-account(?:[/?#]|$)/i.test(href)) return true;
    return /登录至另一个账户|登录到另一个账户|登录另一个账户|使用另一个账户|使用其他账户|换一个账户|另一个账户|其他账户|another account|use another|sign in to another|log in to another/i.test(text);
  }) || null;
}

function findChooseAccountExistingSessionButton({ allowDisabled = false } = {}) {
  const candidates = Array.from(document.querySelectorAll('button[name="session_id"], button[data-dd-action-name], button'));
  return candidates.find(element => {
    if (!isVisible(element)) return false;
    if (!allowDisabled && isDisabled(element)) return false;
    if (isSocialOrAlternateLoginButton(element)) return false;
    const ddActionName = String(element.getAttribute?.('data-dd-action-name') || '').trim().toLowerCase();
    const name = String(element.getAttribute?.('name') || '').trim().toLowerCase();
    const value = String(element.getAttribute?.('value') || '').trim();
    const text = getText(element);
    return ddActionName === 'select existing session'
      || (name === 'session_id' && Boolean(value))
      || (/选择帐户|选择账户|select\s+account|欢迎回来|welcome\s+back/i.test(text) && Boolean(value));
  }) || null;
}

function findButtonByText(pattern) {
  const candidates = getClickableCandidates();
  return candidates.find(element => isVisible(element) && !isDisabled(element) && pattern.test(getText(element))) || null;
}

function findPrimarySubmitButton() {
  const candidates = getClickableCandidates()
    .filter(element => isVisible(element) && !isDisabled(element))
    .filter(element => !isSocialOrAlternateLoginButton(element));
  const exact = candidates.find(element => /^(继续|下一步|提交|登录|验证|continue|next|submit|sign in|log in|verify)$/i.test(getText(element)));
  if (exact) return exact;
  return candidates.find(element => /继续|下一步|提交|登录|验证|continue|next|submit|sign in|log in|verify/i.test(getText(element))) || null;
}

async function submitLoginForm(input) {
  const form = input?.form || input?.closest?.('form') || null;
  const submit = findSubmitButton();
  if (submit) {
    await stableClick(() => findSubmitButton(), '邮箱提交按钮');
    return;
  }
  if (form && typeof form.requestSubmit === 'function') {
    form.requestSubmit();
    return;
  }
  if (form) {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }
}

function firstVisibleSubmit(selectors) {
  for (const selector of selectors) {
    const element = Array.from(document.querySelectorAll(selector))
      .find(candidate => isVisible(candidate) && !isDisabled(candidate) && !isSocialOrAlternateLoginButton(candidate));
    if (element) return element;
  }
  return null;
}

function isSocialOrAlternateLoginButton(element) {
  const text = getText(element);
  const label = [
    text,
    element?.getAttribute?.('aria-label'),
    element?.getAttribute?.('data-provider'),
    element?.getAttribute?.('data-testid'),
    element?.id,
    element?.className,
  ].filter(Boolean).join(' ');
  return /google|apple|microsoft|github|sso|phone|电话号码|手机号|使用电话|使用\s*google|使用\s*apple|使用\s*microsoft|google\s*账户|apple\s*账户|microsoft\s*账户/i.test(label);
}

function findTextClickable(pattern) {
  const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"], [tabindex], [data-testid], div, span, p'))
    .filter(element => isVisible(element) && pattern.test(getText(element)));
  for (const node of nodes) {
    const clickable = node.closest?.('button, a, [role="button"], [role="link"], [tabindex], [data-testid]') || node;
    if (isVisible(clickable) && !isDisabled(clickable)) return clickable;
  }
  return null;
}

function getClickableCandidates() {
  return Array.from(document.querySelectorAll([
    'button',
    'a',
    '[role="button"]',
    '[role="link"]',
    'input[type="button"]',
    'input[type="submit"]',
    '[tabindex]',
    '[data-testid]',
  ].join(','))).filter(isVisible);
}

function firstVisible(selectors) {
  for (const selector of selectors) {
    const element = Array.from(document.querySelectorAll(selector)).find(isVisible);
    if (element) return element;
  }
  return null;
}

function fillInput(input, value) {
  input.focus();
  input.value = '';
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
  input.value = value;
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function fillVerificationCode(input, code) {
  const splitInputs = getSplitCodeInputs();
  if (splitInputs.length >= 6 && splitInputs.includes(input)) {
    const chars = String(code || '').split('');
    splitInputs.slice(0, chars.length).forEach((element, index) => {
      fillInput(element, chars[index]);
    });
    return;
  }
  fillInput(input, code);
}

function getSplitCodeInputs() {
  return Array.from(document.querySelectorAll('input'))
    .filter(input => isVisible(input) && !input.disabled)
    .filter(input => {
      const maxLength = Number(input.getAttribute('maxlength') || input.maxLength || 0);
      const width = input.getBoundingClientRect().width;
      return maxLength === 1 || width <= 80;
    })
    .slice(0, 8);
}

function clickElement(element) {
  element.scrollIntoView({ block: 'center', inline: 'center' });
  element.focus?.();
  const form = element.form || element.closest?.('form') || null;
  const tagName = String(element.tagName || '').toLowerCase();
  const type = String(element.getAttribute?.('type') || element.type || '').toLowerCase();
  const isSubmitControl = type === 'submit' || (tagName === 'button' && !element.getAttribute?.('type'));
  if (form && typeof form.requestSubmit === 'function' && isSubmitControl) {
    form.requestSubmit(element);
    return;
  }
  if (typeof element.click === 'function') {
    element.click();
    return;
  }
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
}

async function stableClick(element, label = '按钮', options = {}) {
  const target = await waitForElementReady(element, 10000, label, options);
  target.scrollIntoView({ block: 'center', inline: 'center' });
  target.focus?.();
  await waitForStableRect(target, 1500);
  clickElement(target);
}

async function waitForElementReady(elementOrGetter, timeoutMs = 10000, label = '按钮', options = {}) {
  const start = Date.now();
  let lastState = '';
  while (Date.now() - start < timeoutMs) {
    if (options.expectedState && inspectAuthPage(options.task || {}).state !== options.expectedState) {
      throw new PageStateChangedError(`页面已离开 ${options.expectedState}，取消等待${label}`);
    }
    const element = typeof elementOrGetter === 'function' ? elementOrGetter() : elementOrGetter;
    if (isVisible(element) && !isDisabled(element)) return element;
    lastState = describeElementState(element);
    await sleep(150);
  }
  throw new Error(`等待${label}可点击超时（${lastState || '未找到元素'}；${location.pathname}）`);
}

class PageStateChangedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PageStateChangedError';
  }
}

function describeElementState(element) {
  if (!element) return '未找到元素';
  const rect = element.getBoundingClientRect?.();
  return [
    isVisible(element) ? '可见' : '不可见',
    isDisabled(element) ? 'disabled' : '未禁用',
    getText(element).slice(0, 40) || element.tagName || '',
    rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : '',
  ].filter(Boolean).join('，');
}

async function waitForStableRect(element, timeoutMs = 1500) {
  let previous = null;
  let stableSamples = 0;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rect = element?.getBoundingClientRect?.();
    if (rect && rect.width > 0 && rect.height > 0) {
      const current = [rect.left, rect.top, rect.width, rect.height].map(value => Math.round(value)).join(':');
      if (current === previous) {
        stableSamples += 1;
        if (stableSamples >= 2) return;
      } else {
        previous = current;
        stableSamples = 0;
      }
    }
    await sleep(150);
  }
}

async function humanPause(min = 250, max = 850) {
  const low = Math.max(0, Number(min) || 0);
  const high = Math.max(low, Number(max) || low);
  await sleep(low + Math.floor(Math.random() * (high - low + 1)));
}

async function fetchCode(taskId) {
  const response = await chrome.runtime.sendMessage({ type: 'FETCH_CODE', payload: { taskId } });
  if (!response?.ok || !response.code) throw new Error(response?.error || '没有获取到验证码');
  return response.code;
}

function isCallbackLikePage() {
  return /\/auth\/callback/i.test(location.pathname) && /[?&]code=/.test(location.search);
}

function getText(element) {
  return String(element?.innerText || element?.textContent || element?.value || element?.ariaLabel || '').replace(/\s+/g, ' ').trim();
}

function extractEmail(text = '') {
  const match = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : '';
}

function normalizeEmail(value = '') {
  return String(value || '').trim().toLowerCase();
}

function compactText(value = '') {
  return normalizeEmail(value).replace(/\s+/g, '');
}

async function authLog(message, level = 'info') {
  try {
    await chrome.runtime.sendMessage({ type: 'AUTH_LOG', payload: { message, level } });
  } catch {
    // Logging is best-effort.
  }
}

async function reportFatal(task, reason) {
  try {
    await chrome.runtime.sendMessage({
      type: 'AUTH_FATAL',
      payload: {
        taskId: task?.id || '',
        email: task?.email || '',
        reason,
      },
    });
  } catch {
    // Best-effort; background timeout handling remains as fallback.
  }
}

async function operationDelay(task, fallbackMs = 1000) {
  const delayMs = task?.operationDelayEnabled === false
    ? Math.min(600, fallbackMs)
    : Math.max(fallbackMs, Math.min(10000, Number(task?.operationDelayMs) || 2000));
  await sleep(delayMs);
}

function isVisible(element) {
  if (!element) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
}

function isDisabled(element) {
  return Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
