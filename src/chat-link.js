import { bindImageSlots, bindSmartSlot, bindingIsCurrent, chatIdentity, CHAT_PENDING } from './chat.js';
import { normalizeAssistant } from './prompt-assistant.js';
import { openChatStore } from './chat-storage.js';
import { getCharacterTheme } from './ui/appearance.js';
import { icon, paintIcons } from './icons.js';
import { locatePromptRanges, replacePromptRange, restorePromptRange } from './chat-render.js';

const labels = {
  preparing: '准备生图', confirming: '等待确认提示词', queued: '排队中', running: '正在生图',
  completed: '图片已保存', failed: '生成失败', cancelled: '已取消',
  drafted: '提示词已准备', skipped: '本条无需配图',
};
const phases = { submitting: '正在提交', retrieving: '正在取图', downloading: '正在下载', saving: '正在保存' };

export function createChatLink({ account, getContext, settings, send, open, notice, storageRequest }) {
  const entries = new Map();
  const requests = new Map();
  const listeners = [];
  const objectURLs = new Set();
  const pendingReplies = new Set();
  const replacements = [];
  let store;
  let destroyed = false;
  let revision = 0;
  let stopped = false;
  let generating = false;
  let renderTimer;
  let observer;
  let channel;
  const ready = openChatStore(account, {
    mode: () => ['server', 'local'].includes(settings().cacheLocation) ? 'server' : 'browser', request: storageRequest,
    ownsRequest: (id) => requests.has(id),
  }).then((value) => { store = value; return value; }).catch(() => {
    notice('聊天任务存储不可用，请检查浏览器存储权限');
  });

  const isCurrent = (entry) => bindingIsCurrent(entry, getContext(), settings());
  const scheduledRender = () => {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => { void reconcile(); }, 60);
  };

  function removeCards() {
    for (const replacement of replacements.reverse()) restorePromptRange(replacement);
    replacements.length = 0;
    document.querySelectorAll('.linghuashi-chat-images,.linghuashi-smart-entry').forEach((node) => node.remove());
    for (const url of objectURLs) URL.revokeObjectURL(url);
    objectURLs.clear();
  }

  async function updateRecord(entry, value) {
    if (!store || !entry.requestId) return;
    const result = await store.update(entry.binding.id, entry.requestId, value);
    if (result) {
      entry.record = result;
      channel?.postMessage({ id: entry.binding.id });
    }
  }

  async function reconcile() {
    const turn = ++revision;
    await ready;
    if (destroyed || !store) return;
    const context = getContext();
    const options = settings();
    try { await store.sync(chatIdentity(context)); }
    catch { notice('酒馆服务器配图记录无法读取，请刷新后重试'); return; }
    const assistant = normalizeAssistant(options.assistant);
    if (!options.auto && !assistant.autoPrompt) pendingReplies.clear();
    const visible = new Map();
    if (options.enabled && chatIdentity(context)) {
      const nodes = [...document.querySelectorAll('#chat .mes[mesid]')];
      await Promise.all(nodes.map(async (node) => {
        const message = context.chat[Number(node.getAttribute('mesid'))];
        const text = message?.mes;
        const slots = await bindImageSlots(context, message, options.triggerPrefix, options.triggerSuffix);
        if (!slots.length) {
          const smart = await bindSmartSlot(context, message);
          if (smart) slots.push(smart);
        }
        for (const slot of slots) {
          let entry = entries.get(slot.binding.id);
          if (!entry || entry.message !== message) {
            entry = { ...slot, message, text, record: await store.get(slot.binding.id) };
            entries.set(slot.binding.id, entry);
          } else entry.record = await store.get(slot.binding.id);
          if (entry.binding.kind === 'smart') entry.prompt = entry.record?.assistant?.positive || '';
          if (bindingIsCurrent(entry, context, options)) visible.set(entry.binding.id, { entry, node });
        }
      }));
    }
    if (turn !== revision || destroyed) return;
    for (const entry of requests.values()) {
      if (!isCurrent(entry) && !entry.invalidated) {
        entry.invalidated = true;
        send('linghuashi:chat-cancel', { requestId: entry.requestId, pendingOnly: true });
      }
    }
    for (const [id] of entries) {
      if (!visible.has(id) && ![...requests.values()].some((entry) => entry.binding.id === id)) entries.delete(id);
    }
    const byNode = new Map();
    for (const value of visible.values()) {
      if (!byNode.has(value.node)) byNode.set(value.node, []);
      byNode.get(value.node).push(value.entry);
    }
    const urls = new Set();
    const cards = new Map(await Promise.all([...visible.values()].map(async ({ entry }) =>
      [entry.binding.id, await createCard(entry, options, urls, turn)])));
    if (turn !== revision || destroyed) {
      for (const url of urls) URL.revokeObjectURL(url);
      return;
    }
    // Build asynchronously, then change the message DOM in one pass so our own
    // replacements do not trigger the observer or interrupt Tavern rendering.
    observer?.disconnect();
    try {
      removeCards();
      for (const url of urls) objectURLs.add(url);
      for (const [node, rows] of byNode) {
        if (!node.isConnected) continue;
        const current = rows.filter(isCurrent).sort((left, right) => left.binding.slot - right.binding.slot);
        const located = options.inline !== false
          ? locatePromptRanges(node.querySelector('.mes_text'), current.filter((entry) => entry.binding.kind !== 'smart'), options.triggerPrefix, options.triggerSuffix) : [];
        const placed = new Set();
        for (const { entry, range } of located.reverse()) {
          const card = cards.get(entry.binding.id);
          card.dataset.placement = 'inline';
          replacements.push(replacePromptRange(range, card));
          placed.add(entry.binding.id);
        }
        for (const entry of current) {
          if (placed.has(entry.binding.id)) continue;
          const card = cards.get(entry.binding.id);
          card.dataset.placement = 'footer';
          const target = entry.binding.kind === 'smart' && options.inline !== false
            ? node.querySelector('.mes_text') : node.querySelector('.mes_block');
          target?.append(card);
        }
      }
    } finally {
      observeChat();
    }
    if ((options.auto || assistant.autoPrompt) && !stopped) {
      for (const { entry } of visible.values()) {
        const smart = entry.binding.kind === 'smart';
        const eligible = smart ? assistant.autoPrompt && !generating : options.auto;
        if (eligible && pendingReplies.has(entry.message) && !entry.record) {
          if (smart && assistant.frequency === 'interval') {
            const count = context.chat.slice(0, context.chat.indexOf(entry.message) + 1).filter((item) =>
              !item.is_user && !item.is_system && typeof item.mes === 'string').length;
            if (count % assistant.every !== 0) continue;
          }
          if (smart) entry.previous = [...visible.values()].map((item) => item.entry)
            .filter((item) => context.chat.indexOf(item.message) < context.chat.indexOf(entry.message) && item.record?.assistant?.shouldDraw)
            .at(-1)?.record?.assistant || null;
          void request(entry, true);
        }
      }
    }
    if (!generating) pendingReplies.clear();
  }

  async function createCard(entry, options, urls, turn) {
    const container = document.createElement('span');
    const smart = entry.binding.kind === 'smart';
    container.className = smart && !entry.record ? 'linghuashi-smart-entry' : 'linghuashi-chat-images';
    const shadow = container.attachShadow({ mode: 'open' });
    const accent = getCharacterTheme(options.characterTheme).accent || '#3672ce';
    shadow.innerHTML = `<style>
      :host { display:block; max-width:100%; margin:10px 0; color:inherit; font:inherit; text-indent:0; }
      *,*::before,*::after { box-sizing:border-box; } button { font:inherit; cursor:pointer; }
      .slot { padding:8px 0; }
      header { display:flex; flex-wrap:wrap; align-items:center; gap:8px; font-size:13px; }
      strong { font-weight:600; } .status { opacity:.8; flex:1; min-width:100px; }
      .actions { display:flex; gap:6px; flex-wrap:wrap; }
      button { display:inline-flex; align-items:center; justify-content:center; gap:5px; border:1px solid color-mix(in srgb,${accent} 55%,transparent); background:color-mix(in srgb,${accent} 12%,transparent); color:inherit; border-radius:5px; padding:5px 9px; }
      button:disabled { cursor:default; opacity:.55; } button:focus-visible { outline:2px solid ${accent}; outline-offset:2px; }
      svg { width:15px; height:15px; flex:none; pointer-events:none; }
      details { margin-top:6px; font-size:12px; } summary { cursor:pointer; opacity:.8; }
      .prompt,.error { overflow-wrap:anywhere; white-space:pre-wrap; margin:6px 0; font-size:12px; }
      .error { color:inherit; opacity:.85; } .pictures { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:9px; }
      .picture { display:block; padding:0; max-width:100%; width:min(360px,100%); border:0; background:transparent; }
      .picture-entry { width:min(360px,100%); max-width:100%; }
      .picture-edit { display:inline-flex; align-items:center; gap:5px; margin-top:5px; }
      img { display:block; max-width:100%; width:100%; height:auto; max-height:480px; object-fit:contain; border-radius:5px; }
    </style>`;
    const section = document.createElement('section');
    section.className = 'slot';
    section.dataset.slot = entry.binding.id;
    const record = entry.record;
    const owned = requests.has(record?.requestId);
    const pending = CHAT_PENDING.has(record?.status);
    section.innerHTML = `<header><strong>${smart ? '灵画师 · 智能配图' : `灵画师 · 配图 ${entry.index + 1}`}</strong><span class="status"></span><div class="actions"></div></header><details><summary>提示词</summary><p class="prompt"></p></details>`;
    section.querySelector('.prompt').textContent = entry.prompt;
    if (smart && !record) {
      section.querySelector('strong').hidden = true;
      section.querySelector('.status').hidden = true;
      section.querySelector('details').hidden = true;
    }
    if (record?.assistant?.scene) section.querySelector('.prompt').textContent =
      `${record.assistant.scene}\n\n${record.assistant.positive}\n\n负面：${record.assistant.negative || '未填写'}`;
    section.querySelector('.status').textContent = pending && !owned
      ? record?.taskId ? '其他页面执行中，等待同步' : '任务记录待核对'
      : (pending ? phases[record?.phase] : '') || labels[record?.status] || '等待生成';
    const command = (label, glyph, action, disabled = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.innerHTML = `${icon(glyph)}<span></span>`;
      button.querySelector('span').textContent = label;
      button.disabled = disabled;
      button.addEventListener('click', action);
      section.querySelector('.actions').append(button);
    };
    if (pending && !owned && record?.taskId) command('查看任务', 'list-checks', () => open('generate'));
    else if (pending && owned) command('取消', 'x', () => send('linghuashi:chat-cancel', { requestId: record.requestId }));
    else if (record?.status === 'failed' && record.recoverable) {
      command('继续取图', 'download', () => send('linghuashi:chat-recover', { requestId: record.requestId }));
    } else if (smart && record?.assistant?.shouldDraw && record.status === 'drafted') {
      command('编辑提示词', 'pencil', () => openDraft(entry));
      command('生成图片', 'sparkles', () => generateDraft(entry));
    } else if (record?.status !== 'completed') {
      if (smart) command(record ? '重新分析' : '智能配图', 'sparkles', () => { void request(entry, false); });
      else
      command(pending ? '核对后重试' : record ? '重新生成' : '生成图片', 'sparkles', () => { void request(entry, false); });
    }
    if (record?.assistant?.reason && !record.error) {
      const explanation = document.createElement('p');
      explanation.className = 'prompt'; explanation.textContent = record.assistant.reason; section.append(explanation);
    }
    if (record?.error) {
      const error = document.createElement('p');
      error.className = 'error';
      error.textContent = record.error;
      section.append(error);
    }
    if (record?.savedIds?.length) {
      command('绘图管理', 'images', () => { open('gallery'); send('linghuashi:chat-view', { id: record.savedIds[0] }); });
      if (options.inline !== false) {
        const pictures = document.createElement('div');
        pictures.className = 'pictures';
        section.prepend(pictures);
        let imageReadFailed = false;
        for (const id of record.savedIds.slice(0, 32)) {
          let row;
          try { row = await store.image(id); }
          catch { imageReadFailed = true; break; }
          if (turn !== revision || destroyed) return container;
          if (!row?.blob) continue;
          const url = row.thumbnailURL || URL.createObjectURL(row.thumbnail || row.blob);
          if (url.startsWith('blob:')) urls.add(url);
          const button = document.createElement('button');
          button.type = 'button'; button.className = 'picture';
          button.setAttribute('aria-label', '查看配图大图和生图参数');
          const image = document.createElement('img');
          image.src = url; image.alt = row.title; image.loading = 'lazy'; image.decoding = 'async';
          image.width = row.width; image.height = row.height;
          button.append(image);
          button.addEventListener('click', () => { open('gallery'); send('linghuashi:chat-view', { id: row.id }); });
          const entry = document.createElement('div'); entry.className = 'picture-entry'; entry.append(button);
          const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'picture-edit';
          edit.innerHTML = `${icon('pencil')}<span>编辑这张图</span>`;
          edit.disabled = !row.snapshot;
          edit.addEventListener('click', () => { open('gallery'); send('linghuashi:chat-edit', { id: row.id }); });
          entry.append(edit); pictures.append(entry);
        }
        if (imageReadFailed) {
          section.querySelector('.status').textContent = '图片记录暂时无法读取，请稍后刷新';
        } else if (!pictures.childElementCount) {
          section.querySelector('.status').textContent = record.storageLocation === 'server'
            ? '服务器图片已删除或文件缺失' : '浏览器图片已清理或位于其他设备';
          command('重新生成', 'sparkles', () => { void request(entry, false); });
        }
      }
    }
    shadow.append(section);
    paintIcons(shadow);
    return container;
  }

  async function request(entry, automatic, draftPlan) {
    const smart = entry.binding.kind === 'smart';
    const assistant = normalizeAssistant(settings().assistant);
    if (!store || !isCurrent(entry) || (automatic && !(smart ? assistant.autoPrompt : settings().auto))) return;
    if ([...requests.values()].some((item) => item.binding.id === entry.binding.id && CHAT_PENDING.has(item.record?.status))) return;
    const execute = async (lock) => {
      if (destroyed || !isCurrent(entry)) return;
      if (!lock && navigator.locks) { notice('这个配图任务已在其他标签页运行'); return; }
      const previous = await store.get(entry.binding.id);
      if (previous && automatic) return;
      if (draftPlan && previous?.status !== 'drafted') { notice('配图草稿已变化，请刷新消息后重试'); return; }
      if (previous && (!navigator.locks && CHAT_PENDING.has(previous.status))) {
        notice('任务记录待核对，请先检查服务端任务'); return;
      }
      if (previous && !draftPlan && !window.confirm('这张配图有任务记录。请先核对服务端是否已经生成；继续会重新提交生图请求，可能再次计费。')) return;
      const requestId = crypto.randomUUID();
      const record = await store.reserve(entry.binding, requestId, Boolean(previous));
      if (!record) return;
      if (!isCurrent(entry)) {
        await store.update(entry.binding.id, requestId, { status: 'cancelled' });
        return;
      }
      const current = { ...entry, requestId, record, invalidated: false };
      if (draftPlan) await store.update(entry.binding.id, requestId, { status: 'preparing', assistant: draftPlan });
      requests.set(requestId, current);
      channel?.postMessage({ id: entry.binding.id });
      scheduledRender();
      await new Promise((resolve) => {
        current.release = resolve;
        Promise.resolve(send(draftPlan ? 'linghuashi:chat-draft-generate' : smart ? 'linghuashi:chat-assist' : 'linghuashi:chat-generate', {
          requestId, prompt: entry.prompt, binding: entry.binding, automatic,
          plan: draftPlan,
          previous: smart ? entry.previous : undefined,
          openEditor: entry.openEditor === true,
          storageLocation: record.storageLocation,
        })).catch(async () => {
          await updateRecord(current, { status: 'failed', error: '控制台未能载入，请重试' });
          resolve(); scheduledRender();
        });
      });
    };
    if (navigator.locks) {
      await navigator.locks.request(`linghuashi:${account}:${entry.binding.id}`, { ifAvailable: true }, execute);
    } else await execute(true);
  }

  function openDraft(entry) {
    if (!isCurrent(entry) || !entry.record?.assistant) return;
    open('assistant');
    void send('linghuashi:chat-assistant-open', {
      requestId: entry.record.requestId, binding: entry.binding,
      plan: entry.record.assistant, storageLocation: entry.record.storageLocation,
    });
  }

  function generateDraft(entry) {
    if (!isCurrent(entry) || !entry.record?.assistant?.shouldDraw) return;
    void request(entry, false, entry.record.assistant);
  }

  async function receive(data) {
    if (data.type === 'linghuashi:chat-current-assist') {
      const context = getContext();
      const message = [...context.chat].reverse().find((item) => !item.is_user && !item.is_system && typeof item.mes === 'string');
      const entry = [...entries.values()].find((item) => item.message === message && item.binding.kind === 'smart');
      if (!entry) { notice('请打开角色回复；已有生图标签的消息可直接使用原生图入口'); return; }
      entry.openEditor = true;
      void request(entry, false);
      return;
    }
    const restored = data.binding ? entries.get(data.binding.id) : null;
    const entry = requests.get(data.requestId) || (restored?.record?.requestId === data.requestId ? restored : null);
    if (entry && data.type === 'linghuashi:chat-draft-submit') {
      if (!isCurrent(entry) || !['drafted', 'skipped'].includes(entry.record?.status)) {
        notice('原消息或草稿状态已变化，请在消息上重新操作'); return;
      }
      await updateRecord(entry, { status: 'drafted', assistant: data.plan, savedIds: [] });
      void request(entry, false, data.plan);
      return;
    }
    if (data.type === 'linghuashi:chat-validate') {
      send('linghuashi:chat-valid', { validationId: data.validationId,
        valid: Boolean(entry && !entry.invalidated && isCurrent(entry)
          && (!data.automatic || (entry.binding.kind === 'smart'
            ? normalizeAssistant(settings().assistant).autoPrompt : settings().auto))) });
      return;
    }
    if (entry && data.type === 'linghuashi:chat-draft' && data.plan) {
      if (!isCurrent(entry) || ['queued', 'running', 'completed'].includes(entry.record?.status)) return;
      entry.requestId = data.requestId;
      await updateRecord(entry, { status: data.generating ? 'preparing' : data.plan.shouldDraw ? 'drafted' : 'skipped', assistant: data.plan, savedIds: [] });
      if (!data.generating) entry.release?.();
      scheduledRender(); return;
    }
    if (!entry || data.type !== 'linghuashi:chat-task' || !Object.hasOwn(labels, data.status)) return;
    entry.requestId = data.requestId;
    await updateRecord(entry, {
      status: data.status, phase: typeof data.phase === 'string' ? data.phase.slice(0, 30) : '',
      error: typeof data.error === 'string' ? data.error.slice(0, 500) : '',
      recoverable: data.recoverable === true,
      savedIds: Array.isArray(data.savedIds) ? data.savedIds.filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id)).slice(0, 32) : [],
    });
    if (!CHAT_PENDING.has(data.status)) {
      entry.release?.();
      const finished = [...requests.values()].filter((item) => !CHAT_PENDING.has(item.record?.status));
      for (const old of finished.slice(0, Math.max(0, finished.length - 50))) requests.delete(old.requestId);
    }
    scheduledRender();
  }

  const context = getContext();
  const on = (key, handler) => {
    const type = context.eventTypes[key];
    if (type) { context.eventSource.on(type, handler); listeners.push([type, handler]); }
  };
  on('GENERATION_STARTED', (type, _options, dryRun) => { if (!dryRun && type !== 'quiet') { stopped = false; generating = true; } });
  on('GENERATION_STOPPED', () => { stopped = true; generating = false; pendingReplies.clear(); });
  on('GENERATION_ENDED', () => { generating = false; scheduledRender(); });
  on('MESSAGE_RECEIVED', (id, type) => {
    const current = getContext();
    if (type !== 'first_message' && !stopped && !current.streamingProcessor?.isStopped
      && (settings().auto || normalizeAssistant(settings().assistant).autoPrompt)) {
      pendingReplies.add(current.chat[Number(id)]);
    }
    scheduledRender();
  });
  for (const key of ['CHAT_CHANGED', 'CHAT_LOADED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED',
    'MESSAGE_DELETED', 'MORE_MESSAGES_LOADED', 'CHARACTER_MESSAGE_RENDERED',
    'MESSAGE_SWIPE_DELETED', 'GENERATION_ENDED']) on(key, scheduledRender);
  const chat = document.getElementById('chat');
  function observeChat() {
    if (chat && !destroyed) observer?.observe(chat, { childList: true, characterData: true, subtree: true });
  }
  if (chat) {
    observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => {
        const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
        return target?.closest('.mes_text') || [...mutation.addedNodes, ...mutation.removedNodes].some((node) =>
          node.nodeType === 1 && (node.matches?.('.mes,.mes_text') || node.querySelector?.('.mes,.mes_text')));
      })) scheduledRender();
    });
    observeChat();
  }
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(`linghuashi-chat:${account}`);
    channel.onmessage = scheduledRender;
  }
  void reconcile();
  const syncTimer = setInterval(() => {
    if (settings().enabled && document.visibilityState === 'visible') scheduledRender();
  }, 15000);
  return {
    receive,
    refresh: scheduledRender,
    destroy() {
      destroyed = true; revision++; clearTimeout(renderTimer); clearInterval(syncTimer); observer?.disconnect(); removeCards();
      channel?.close(); store?.close();
      for (const [type, handler] of listeners) context.eventSource.removeListener(type, handler);
      for (const entry of requests.values()) entry.release?.();
    },
  };
}
