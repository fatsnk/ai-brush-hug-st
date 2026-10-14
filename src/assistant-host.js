import { bindSmartSlot, chatIdentity, digest, eligibleMessage } from './chat.js';
import { normalizeAssistant } from './prompt-assistant.js';
import { createTavernTextAccess } from './tavern-text.js';

const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';

export function characterDirectory(context) {
  const group = context.groupId ? context.groups?.find((item) => String(item.id) === String(context.groupId)) : null;
  const current = group ? group.members || [] : [context.characters?.[context.characterId]?.avatar].filter(Boolean);
  return { chatKey: chatIdentity(context), name: text(group?.name || context.name2, 120),
    avatars: current, characters: (context.characters || []).filter((item) => typeof item.avatar === 'string')
      .slice(0, 1000).map((item) => ({ avatar: text(item.avatar, 512),
        name: text(item.data?.name || item.name || item.avatar, 120), current: current.includes(item.avatar) })) };
}

export async function findBoundMessage(context, binding) {
  if (!binding || chatIdentity(context) !== binding.chatKey) return null;
  for (const message of context.chat || []) {
    if (!eligibleMessage(message) || (message.swipe_id || 0) !== binding.swipe) continue;
    if (await digest(message.mes) !== binding.branch) continue;
    const slot = await bindSmartSlot(context, message);
    if (slot?.binding.id === binding.id) return message;
  }
  return null;
}

export async function collectAssistantContext(context, options, binding, previous, signal) {
  const settings = normalizeAssistant(options);
  const message = binding ? await findBoundMessage(context, binding)
    : [...(context.chat || [])].reverse().find(eligibleMessage);
  if (binding && !message) throw new Error('原消息已变化，请在当前回复上重新配图');
  const index = message ? context.chat.indexOf(message) : context.chat?.length - 1;
  const selected = (context.chat || []).slice(0, index + 1).filter((item) =>
    !item.is_system && typeof item.mes === 'string').slice(-settings.contextMessages);
  let remaining = settings.contextCharacters;
  const messages = [];
  for (const item of selected.slice().reverse()) {
    if (remaining <= 0) break;
    const content = item.mes.slice(-remaining);
    messages.unshift({ name: text(item.name, 120), role: item.is_user ? 'user' : 'character', content });
    remaining -= content.length;
  }
  const group = context.groupId ? context.groups?.find((item) => String(item.id) === String(context.groupId)) : null;
  const character = context.characters?.[context.characterId];
  const selectedCharacters = group
    ? (context.characters || []).filter((item) => group.members?.includes(item.avatar)).slice(0, 16)
    : character ? [character] : [];
  let characterBudget = 12000;
  const characters = settings.includeCharacters ? selectedCharacters.map((item) => {
    const data = item.data || item;
    const result = { name: text(data.name || item.name, 120) };
    for (const key of ['description', 'personality', 'scenario']) {
      result[key] = text(data[key] || item[key], Math.min(4000, characterBudget));
      characterBudget -= result[key].length;
    }
    return result;
  }) : [];
  let world = '';
  if (settings.includeWorld && message) {
    if (typeof context.getWorldInfoPrompt !== 'function') throw new Error('当前酒馆不支持世界书提取，请关闭“参考世界书”后重试');
    const data = character?.data || character || {};
    const info = await context.getWorldInfoPrompt(
      messages.map((item) => `${item.name}: ${item.content}`).reverse(),
      Math.min(Number(context.maxContext) || 8192, 16000), true,
      { personaDescription: '', characterDescription: text(data.description, 4000),
        characterPersonality: text(data.personality, 4000), characterDepthPrompt: '',
        scenario: text(data.scenario, 4000), creatorNotes: '', trigger: 'normal' },
    );
    const parts = [info.worldInfoString, ...(info.worldInfoDepth || []).map((item) => item.entries?.join('\n') || ''),
      ...(info.worldInfoExamples || []).map((item) => item.content || ''), ...(info.anBefore || []), ...(info.anAfter || [])];
    world = parts.filter((part) => typeof part === 'string').join('\n').slice(0, 12000);
  }
  signal?.throwIfAborted();
  if (binding && !await findBoundMessage(context, binding)) throw new Error('原消息已变化，提取已取消');
  return { chatKey: chatIdentity(context), characterAvatars: characterDirectory(context).avatars,
    target: text(message?.mes, 32000), messages, characters, world, previous: previous || null,
    summary: { messages: messages.length, characters: characters.length, worldCharacters: world.length } };
}

export function createAssistantHost({ getContext, settings, post, isBusy = () => false, textAccess }) {
  textAccess ||= createTavernTextAccess({ getContext });
  const active = new Map();
  let textBusy = false;
  let destroyed = false;
  async function receive(data) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(data.requestId || '')) return;
    if (data.action === 'cancel') { active.get(data.requestId)?.abort(); return; }
    if (active.has(data.requestId) || active.size >= 4 || destroyed) return;
    const controller = new AbortController();
    active.set(data.requestId, controller);
    try {
      let value;
      const options = normalizeAssistant(settings());
      if (data.action === 'context') {
        value = await collectAssistantContext(getContext(), options, data.binding, data.previous, controller.signal);
      } else if (data.action === 'characters') {
        value = characterDirectory(getContext());
      } else if (data.action === 'models') {
        value = await textAccess.models({ refresh: data.refresh === true, signal: controller.signal });
      } else if (data.action === 'text') {
        if (textBusy || isBusy()) throw new Error('酒馆文字模型正在使用，请等待当前回复完成后重试');
        if (!Array.isArray(data.messages) || data.messages.length !== 2
          || data.messages.some((item) => !['system', 'user'].includes(item.role) || typeof item.content !== 'string' || item.content.length > 150000)) {
          throw new Error('提示词助手请求格式无效');
        }
        textBusy = true;
        try {
          const generate = async () => {
            controller.signal.throwIfAborted();
            if (isBusy()) throw new Error('酒馆正在生成回复，请稍后重试');
            return textAccess.generate(data.messages, options, controller.signal);
          };
          value = globalThis.navigator?.locks
            ? await navigator.locks.request('linghuashi-tavern-text', { ifAvailable: true }, (lock) => {
              if (!lock) throw new Error('提示词助手正在其他页面使用酒馆文字模型');
              return generate();
            }) : await generate();
        } finally { textBusy = false; }
      } else throw new Error('未知助手操作');
      controller.signal.throwIfAborted();
      if (!destroyed) post('linghuashi:assistant-result', { requestId: data.requestId, value });
    } catch (error) {
      if (!destroyed) post('linghuashi:assistant-result', { requestId: data.requestId,
        error: controller.signal.aborted ? '提示词助手操作已取消' : data.action === 'text'
          ? '酒馆文字模型调用失败，请检查连接、额度，或等待当前文字任务结束后重试' : error.message });
    } finally { active.delete(data.requestId); }
  }
  return { receive, destroy() { destroyed = true; for (const controller of active.values()) controller.abort(); active.clear(); } };
}
