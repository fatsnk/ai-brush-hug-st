import { escapeHtml as esc } from '../config.js';
import { icon } from '../icons.js';
import { ASSISTANT_TEMPLATES } from '../prompt-assistant.js';
import { currentChat } from '../runtime.js';
import { renderCharacterSelection } from './characters.js';

const field = (label, control) => `<label class="ui-field"><span>${label}</span>${control}</label>`;
const options = (key, value, items) => `<select data-assistant="${key}" aria-label="${esc({
  source: '文字模型来源', template: '提示词模板', format: '输出格式', frequency: '配图频率', composition: '画面偏好', aspect: '配图画幅',
}[key])}">${items.map(([id, name]) => `<option value="${id}" ${id === value ? 'selected' : ''}>${name}</option>`).join('')}</select>`;
const number = (key, label, value, min, max, step = 1) => field(label,
  `<input type="number" data-assistant="${key}" aria-label="${label}" min="${min}" max="${max}" step="${step}" value="${value}" />`);
const toggle = (key, label, value) => `<label class="setting-switch-row"><span class="setting-switch-title">${label}</span><span class="ui-toggle"><input type="checkbox" data-assistant="${key}" aria-label="${label}" ${value ? 'checked' : ''} /><span></span></span></label>`;
const command = (action, glyph, label, disabled = false, primary = false) => `<button type="button" data-action="${action}" class="ui-button ${primary ? 'primary' : 'secondary'}" ${disabled ? 'disabled' : ''}>${icon(glyph)}<span>${label}</span></button>`;

export function renderAssistant(state, ui) {
  const a = state.assistant;
  const plan = state.assistantDraft;
  const busy = ui.busy;
  return `<div class="page-heading"><div><h1>提示词助手</h1><p>${state.provider === 'novelai' ? 'NovelAI' : state.provider === 'comfyui' ? 'ComfyUI' : state.provider === 'sdwebui' ? 'SDWebUI' : 'OpenAI兼容'}</p></div>
    <span class="ui-status ${busy ? 'warning' : 'neutral'}" role="status">${icon(busy ? 'loader-circle' : 'sparkles', busy ? 'spin' : '')}${busy ? '正在处理' : '就绪'}</span></div>
    <div class="assistant-workspace">
      <section class="settings-band assistant-editor" aria-label="提示词编辑">
        <div class="settings-band-heading"><h2>${icon('pencil')}画面描述</h2>${ui.binding ? '<span class="settings-label">已关联聊天消息</span>' : ''}</div>
        ${field('输入描述或提示词', `<textarea rows="5" data-assistant-input maxlength="32000" aria-label="输入描述或提示词">${esc(state.assistantInput || '')}</textarea>`)}
        <div class="assistant-grid">
          ${field('提示词模板', options('template', a.template, ASSISTANT_TEMPLATES))}
          ${field('输出格式', options('format', a.format, [['auto', '跟随生图模型'], ['tags', '英文标签'], ['natural', '英文自然语言']]))}
        </div>
        ${a.template === 'custom' ? field('自定义模板', `<textarea rows="3" data-assistant="customTemplate" maxlength="8000">${esc(a.customTemplate)}</textarea>`) : ''}
        <div class="assistant-actions">
          ${command('assistant-generate', 'sparkles', '生成提示词', busy || !state.enabled, true)}
          ${command('assistant-translate', 'arrow-left-right', '翻译', busy || !state.enabled)}
          ${command('assistant-polish', 'wand-sparkles', '润色', busy || !state.enabled)}
          ${command('assistant-use-current', 'copy', '读取当前提示词', busy)}
          ${command('assistant-illustrate', 'message-square', '当前消息配图', busy || !state.enabled)}
          ${busy ? command('assistant-cancel', 'x', '取消') : ''}
        </div>
        ${ui.error ? `<p class="assistant-error" role="alert">${esc(ui.error)}</p>` : ''}
        ${ui.summary ? `<p class="assistant-context">上下文 ${ui.summary.messages} 条 · 角色 ${ui.summary.characters} 个 · 世界书 ${ui.summary.worldCharacters} 字</p>` : ''}
        ${renderCharacterSelection(state, currentChat(), { compact: true })}
        ${plan ? `<div class="assistant-result">
          <div class="settings-band-heading"><h2>${icon('image')}画面与提示词</h2><span class="settings-label">${plan.shouldDraw ? '可生成' : '无需配图'}</span></div>
          ${field('画面', `<textarea rows="2" data-assistant-result="scene" maxlength="2000" aria-label="画面">${esc(plan.scene || '')}</textarea>`)}
          ${field('正向提示词', `<textarea rows="5" data-assistant-result="positive" maxlength="32000" aria-label="助手正向提示词">${esc(plan.positive || '')}</textarea>`)}
          ${field('负面提示词', `<textarea rows="3" data-assistant-result="negative" maxlength="32000" aria-label="助手负面提示词">${esc(plan.negative || '')}</textarea>`)}
          ${(plan.characters || []).map((entry) => {
            const sceneEntry = plan.characterScene?.entries?.find((item) => item.profileId === entry.profileId);
            const profile = sceneEntry?.profile;
            const name = profile?.name || entry.profileId;
            const appearance = profile?.lockAppearance ? [profile.tags, profile.hair, profile.eyes, profile.body, profile.features].filter(Boolean).join(', ') : entry.appearance;
            const outfit = profile?.lockOutfit ? profile.outfits.find((item) => item.id === sceneEntry.outfitId)?.prompt || '' : entry.outfit;
            return `<div class="character-scene-row"><strong>${esc(name)}</strong><div class="assistant-grid">
              ${field('角色动作', `<input data-assistant-character="${entry.profileId}" data-character-result="action" aria-label="${esc(name)}助手动作" maxlength="1000" value="${esc(entry.action)}" />`)}
              ${field('角色表情', `<input data-assistant-character="${entry.profileId}" data-character-result="expression" aria-label="${esc(name)}助手表情" maxlength="500" value="${esc(entry.expression)}" />`)}
            </div><details><summary>角色外貌与服装</summary>
              ${field('角色外貌', `<textarea data-assistant-character="${entry.profileId}" data-character-result="appearance" aria-label="${esc(name)}助手外貌" rows="2" maxlength="4000" ${profile?.lockAppearance ? 'readonly' : ''}>${esc(appearance)}</textarea>`)}
              ${field('角色服装', `<textarea data-assistant-character="${entry.profileId}" data-character-result="outfit" aria-label="${esc(name)}助手服装" rows="2" maxlength="4000" ${profile?.lockOutfit ? 'readonly' : ''}>${esc(outfit)}</textarea>`)}
              ${field('角色负面词', `<input data-assistant-character="${entry.profileId}" data-character-result="negative" aria-label="${esc(name)}助手负面词" maxlength="1000" value="${esc(entry.negative)}" />`)}
            </details></div>`;
          }).join('')}
          ${plan.reason ? `<p class="assistant-context">${esc(plan.reason)}</p>` : ''}
          <div class="assistant-actions">${command('assistant-apply', 'replace', '载入生图参数', busy || !plan.positive)}
            ${command('assistant-draw', 'image-plus', '生成图片', busy || !plan.positive || !state.enabled, true)}
            ${command('assistant-copy', 'copy', '复制提示词', !plan.positive)}
            ${ui.binding ? command('assistant-save-draft', 'save', '保存聊天草稿', busy) : ''}
          </div>
        </div>` : ''}
      </section>
      <section class="settings-band assistant-configuration" aria-label="助手配置">
        <div class="settings-band-heading"><h2>${icon('plug')}文字模型</h2></div>
        ${field('文字模型来源', options('source', a.source, [['tavern', '跟随酒馆'], ['api', '独立 API']]))}
        ${a.source === 'api' ? `
          ${field('文字接口地址', `<input type="url" data-assistant="endpoint" aria-label="文字接口地址" maxlength="512" placeholder="https://你的域名/v1" value="${esc(a.endpoint)}" />`)}
          ${field('API Key', `<div class="input-with-button"><input type="${ui.keyVisible ? 'text' : 'password'}" data-assistant-key aria-label="助手 API Key" autocomplete="off" maxlength="4096" value="${esc(ui.key)}" /><button type="button" class="ui-icon-button" data-action="assistant-toggle-key" title="${ui.keyVisible ? '隐藏秘钥' : '显示秘钥'}" aria-label="${ui.keyVisible ? '隐藏助手秘钥' : '显示助手秘钥'}">${icon(ui.keyVisible ? 'eye-off' : 'eye')}</button></div>`)}
          <p class="assistant-context" data-assistant-key-status>${esc(ui.keyStatus || '')}</p>
          ${number('temperature', '温度', a.temperature, 0, 2, 0.1)}
          ` : ''}
        ${field('文字模型', `<div class="input-with-button"><input data-assistant="${a.source === 'api' ? 'model' : 'tavernModel'}" aria-label="助手文字模型" maxlength="200" list="assistant-model-list" placeholder="${esc(a.source === 'api' ? '输入或选择模型' : ui.tavernCurrent ? `跟随当前模型：${ui.tavernCurrent}` : '跟随酒馆当前模型')}" value="${esc(a.source === 'api' ? a.model : a.tavernModel)}" /><button type="button" class="ui-icon-button" data-action="assistant-models" title="获取文字模型列表" aria-label="获取文字模型列表" ${ui.modelsBusy ? 'disabled' : ''}>${icon('refresh-cw')}</button></div><datalist id="assistant-model-list">${ui.models.map((id) => `<option value="${esc(id)}"></option>`).join('')}</datalist>`)}
        <p class="assistant-context" data-assistant-model-status role="status">${esc(ui.modelsStatus || '')}</p>
        <div class="assistant-grid">${number('maxTokens', '最大输出 Token', a.maxTokens, 256, 8192)}${number('timeout', '超时（秒）', a.timeout, 15, 300)}</div>
        <div class="settings-band-heading"><h2>${icon('message-square')}上下文</h2></div>
        <div class="assistant-grid">${number('contextMessages', '最近消息数', a.contextMessages, 1, 40)}${number('contextCharacters', '聊天字符上限', a.contextCharacters, 2000, 60000)}</div>
        ${toggle('includeCharacters', '参考角色卡', a.includeCharacters)}
        ${toggle('includeWorld', '参考世界书', a.includeWorld)}
        ${field('补充固定外貌', `<textarea rows="3" data-assistant="appearance" maxlength="4000">${esc(a.appearance)}</textarea>`)}
        <div class="settings-band-heading"><h2>${icon('wand-sparkles')}智能配图</h2></div>
        ${toggle('autoPrompt', '自动准备配图提示词', a.autoPrompt)}
        ${toggle('autoImage', '准备后自动生图', a.autoImage)}
        ${field('配图频率', options('frequency', a.frequency, [['scene', '仅有适合画面的剧情'], ['each', '每条新回复'], ['interval', '每隔指定回复数']]))}
        ${a.frequency === 'interval' ? number('every', '回复间隔', a.every, 1, 50) : ''}
        ${field('画面偏好', options('composition', a.composition, [['balanced', '剧情构图'], ['closeup', '人物特写'], ['fullbody', '人物全身'], ['environment', '环境全景']]))}
        <div class="assistant-grid">${number('count', '每次生图张数', a.count, 1, 4)}
          ${field('配图画幅', options('aspect', a.aspect, [['keep', '保留接口尺寸'], ['auto', '由助手规划'], ['portrait', '竖图'], ['landscape', '横图'], ['square', '方图']]))}</div>
      </section>
    </div>`;
}
