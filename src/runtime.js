import { createCredentialVault } from './credential-vault.js';
import { apiError } from './extension-api.js';
import { createReleaseMonitor } from './release-monitor.js';

const environment = () => window.__LINGHUASHI_ENV__ || {};
const secretRequests = new Map();
const storageRequests = new Map();
let previewVault;
const assistantRequests = new Map();
const extensionChatRequests = new Map();
const releaseRequests = new Map();
const updateRequests = new Map();
const releaseListeners = new Set();
let previewReleaseMonitor;
let hostReleaseState;
function receiveReleaseState(value) {
  if (!value || !['idle', 'checking', 'available', 'current', 'error'].includes(value.status)) return;
  hostReleaseState = value;
  for (const listener of releaseListeners) listener(value);
}
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== window.parent) return;
  if (event.data?.type === 'linghuashi:release-state') receiveReleaseState(event.data.value);
  if (event.data?.type === 'linghuashi:release-result') {
    const pending = releaseRequests.get(event.data.requestId);
    if (!pending) return;
    releaseRequests.delete(event.data.requestId); clearTimeout(pending.timer);
    receiveReleaseState(event.data.value); pending.resolve(event.data.value);
  }
  if (event.data?.type === 'linghuashi:update-result') {
    const pending = updateRequests.get(event.data.requestId);
    if (!pending) return;
    updateRequests.delete(event.data.requestId); clearTimeout(pending.timer);
    if (event.data.error) pending.reject(new Error(event.data.error));
    else pending.resolve(event.data.value);
  }
});
function previewReleases() {
  if (!previewReleaseMonitor) {
    previewReleaseMonitor = createReleaseMonitor({ storage: localStorage });
    previewReleaseMonitor.subscribe(receiveReleaseState);
  }
  return previewReleaseMonitor;
}
export function getReleaseState() {
  return isInstalled() ? hostReleaseState || environment().releaseState
    || { status: 'idle', release: null, checkedAt: 0, error: '' } : previewReleases().getState();
}
export function subscribeReleaseState(listener) {
  releaseListeners.add(listener);
  return () => releaseListeners.delete(listener);
}
export function checkReleaseVersion() {
  if (!isInstalled()) return previewReleases().check({ force: true });
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { releaseRequests.delete(requestId); reject(new Error('检查更新超时，请稍后重试')); }, 20000);
    releaseRequests.set(requestId, { resolve, reject, timer });
    window.parent.postMessage({ type: 'linghuashi:release-check', requestId }, location.origin);
  });
}
export function openExtensionManager() {
  if (isInstalled()) window.parent.postMessage({ type: 'linghuashi:extension-manager' }, location.origin);
}
export function updateExtensionVersion(version) {
  if (!isInstalled()) return Promise.reject(new Error('请在酒馆内执行更新，设计预览可从发布页下载'));
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      updateRequests.delete(requestId); reject(new Error('更新响应超时，请先到扩展管理核对结果'));
    }, 285000);
    updateRequests.set(requestId, { resolve, reject, timer });
    window.parent.postMessage({ type: 'linghuashi:update', requestId, version }, location.origin);
  });
}
export function reloadUpdatedExtension() {
  if (isInstalled()) window.parent.postMessage({ type: 'linghuashi:update-reload' }, location.origin);
}
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'linghuashi:extension-chat-result') return;
  extensionChatRequests.get(event.data.requestId)?.(event.data);
});

export function extensionChatRequest(value) {
  if (!isInstalled()) return Promise.reject(apiError('CHAT_TARGET_INVALID', '聊天目标需在酒馆内使用'));
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      extensionChatRequests.delete(requestId);
      reject(apiError('CHAT_TARGET_INVALID', '聊天关联超时，请核对消息与任务记录'));
    }, 125000);
    extensionChatRequests.set(requestId, (data) => {
      clearTimeout(timer); extensionChatRequests.delete(requestId);
      if (data.error) reject(apiError(data.error.code, data.error.message)); else resolve(data.value);
    });
    window.parent.postMessage({ type: 'linghuashi:extension-chat-request', requestId, ...value }, location.origin);
  });
}

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'linghuashi:assistant-result') return;
  const pending = assistantRequests.get(event.data.requestId);
  if (!pending) return;
  pending.finish(event.data.error ? new Error(event.data.error) : null, event.data.value);
});

export function assistantHostRequest(action, value = {}, { signal, timeout = 120 } = {}) {
  if (!isInstalled()) {
    return action === 'characters' ? Promise.resolve({ chatKey: '', name: '', avatars: [], characters: [] })
      : action === 'context' ? Promise.resolve({ target: '', messages: [], characters: [], world: '', summary: { messages: 0, characters: 0, worldCharacters: 0 } })
      : Promise.reject(new Error('跟随酒馆文字模型需要在酒馆内使用，设计预览可配置独立 API'));
  }
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const cancel = () => {
      window.parent.postMessage({ type: 'linghuashi:assistant-request', requestId, action: 'cancel' }, location.origin);
      finish(new Error('提示词助手操作已取消'));
    };
    const finish = (error, result) => {
      if (!assistantRequests.has(requestId)) return;
      assistantRequests.delete(requestId);
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => {
      window.parent.postMessage({ type: 'linghuashi:assistant-request', requestId, action: 'cancel' }, location.origin);
      finish(new Error('文字处理超时，请核对接口后手动重试'));
    }, Math.min(300, timeout) * 1000);
    assistantRequests.set(requestId, { finish });
    signal?.addEventListener('abort', cancel, { once: true });
    window.parent.postMessage({ type: 'linghuashi:assistant-request', requestId, action, ...value }, location.origin);
  });
}

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'linghuashi:secret-result') return;
  const pending = secretRequests.get(event.data.requestId);
  if (!pending) return;
  secretRequests.delete(event.data.requestId);
  clearTimeout(pending.timer);
  if (event.data.error) pending.reject(new Error(event.data.error));
  else pending.resolve(event.data.value);
});

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'linghuashi:storage-result') return;
  const pending = storageRequests.get(event.data.requestId);
  if (!pending) return;
  storageRequests.delete(event.data.requestId);
  clearTimeout(pending.timer);
  if (event.data.error) pending.reject(new Error(event.data.error));
  else pending.resolve(event.data.value);
});

export function storageRequest(action, body = {}) {
  if (!isInstalled()) return Promise.reject(new Error('酒馆服务器存图需在酒馆内使用'));
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      storageRequests.delete(requestId);
      reject(new Error('酒馆服务器存图请求超时，请重试'));
    }, 125000);
    storageRequests.set(requestId, { resolve, reject, timer });
    window.parent.postMessage({ type: 'linghuashi:storage-request', requestId, action, body }, location.origin);
  });
}

export function currentAccount() { return environment().account || 'preview'; }

export function credentialRequest(action, provider, value = {}) {
  if (!isInstalled()) {
    previewVault ||= createCredentialVault({ account: 'preview', storage: localStorage });
    return action === 'read' ? previewVault.read(provider, value.ref) : previewVault.write(provider, value.key, value.ref);
  }
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      secretRequests.delete(requestId);
      reject(new Error('酒馆秘钥存储超时，请重试'));
    }, 12000);
    secretRequests.set(requestId, { resolve, reject, timer });
    window.parent.postMessage({ type: 'linghuashi:secret-request', requestId, action, provider, ...value }, location.origin);
  });
}

export function isInstalled() {
  return environment().mode === 'extension';
}

export function storageKey(name) {
  return isInstalled() ? `${name}:st:${encodeURIComponent(environment().account)}` : name;
}

export function readUIState(name) {
  if (isInstalled()) {
    const saved = environment().ui || {};
    try {
      const local = JSON.parse(localStorage.getItem(storageKey(name)) || '{}');
      return Number(local.updatedAt) > Number(saved.updatedAt || 0) ? local : saved;
    } catch { return saved; }
  }
  return JSON.parse(localStorage.getItem(storageKey(name)) || '{}');
}

export function notifyUIState(ui) {
  if (isInstalled()) window.parent.postMessage({ type: 'linghuashi:state', ui }, location.origin);
}

export function currentChat() {
  return environment().chat || { name: '未打开聊天', count: 0 };
}
