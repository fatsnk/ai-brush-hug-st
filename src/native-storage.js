import { currentDrawing, insertVersion, normalizeVersion, protectedVersionGroups, validImageId, versionGroupId, versionOrder } from '../server/linghuashi-storage/image-versions.mjs';
import { normalizeBackupChats, STORAGE_PROTOCOL } from '../server/linghuashi-storage/backup-records.mjs';
import { validBinding } from './chat.js';
import { sha256Hex } from './crypto-compat.js';

const FOLDER = 'linghuashi';
const THUMBS = 'linghuashi-thumbnails';
const LIMIT = 10000;
const CHUNK = 512 * 1024;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => structuredClone(value);
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
const bytes64 = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
function base64(bytes) {
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) value += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(value);
}
const hash = sha256Hex;
const metaName = (id) => `linghuashi-image-${id}.json`;
const chatName = (id) => `linghuashi-chat-${id}.json`;
const imagePath = (id, extension, thumb = false) => `user/images/${thumb ? THUMBS : FOLDER}/lh-${id}.${extension}`;
const filePath = (name) => `user/files/${name}`;
const validId = (id) => { if (!validImageId(id)) throw new Error('存储标识无效'); return id; };

export function safeImageSnapshot(value, depth = 0) {
  if (depth > 40) throw new Error('图片参数层级过深');
  if (typeof value === 'string') {
    let clean = value.replace(/\b(?:sk-|pst-|STD-)[A-Za-z0-9_-]{12,}/g, '[redacted]');
    if (/^https?:\/\//i.test(clean)) {
      try {
        const url = new URL(clean);
        url.username = ''; url.password = '';
        for (const key of [...url.searchParams.keys()]) if (/key|token|secret|password|auth/i.test(key)) url.searchParams.delete(key);
        clean = url.href;
      } catch {}
    }
    return clean;
  }
  if (Array.isArray(value)) return value.map((entry) => safeImageSnapshot(entry, depth + 1));
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(?:keyRef|.*(?:api[_-]?key|api[_-]?token)|authorization|password|access[_-]?token|headers|credentials|secret|token|__proto__|constructor|prototype)$/i.test(key))
    .map(([key, entry]) => {
      if (key === 'extra' && typeof entry === 'string' && entry.trim()) {
        return [key, JSON.stringify(safeImageSnapshot(JSON.parse(entry), depth + 1))];
      }
      return [key, safeImageSnapshot(entry, depth + 1)];
    }));
}

function binding(value) {
  return validBinding(value) ? { id: value.id, branch: value.branch, chatKey: value.chatKey,
    swipe: value.swipe, slot: value.slot, ...(value.kind === 'smart' ? { kind: 'smart' } : {}),
    characterName: text(value.characterName, 120), chatName: text(value.chatName, 120) } : null;
}

function imageData(value, limit) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > Math.ceil(limit / 3) * 4) throw new Error('图片数据无效或超过大小限制');
  const bytes = bytes64(value);
  const extension = [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) ? 'png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpg'
      : String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP' ? 'webp' : '';
  if (!bytes.length || bytes.length > limit || !extension) throw new Error('仅支持大小限制内的 PNG、JPG 和 WebP');
  return { bytes, extension, mime: `image/${extension === 'jpg' ? 'jpeg' : extension}` };
}

async function mapLimit(values, operation) {
  let next = 0;
  const result = new Array(values.length);
  await Promise.all(Array.from({ length: Math.min(8, values.length) }, async () => {
    while (next < values.length) { const index = next++; result[index] = await operation(values[index]); }
  }));
  return result;
}

// Each image has its own atomic account file, so two devices adding different images
// never overwrite a shared index. The image directory is the discovery index.
export function createNativeStorage({ api, read, account, now = Date.now, locks = globalThis.navigator?.locks }) {
  const cache = new Map(), chats = new Map(), uploads = new Map();
  let queue = Promise.resolve(), snapshot, lastList = 0, pendingFiles = 0;
  let originals = new Set(), thumbnails = new Set();
  async function readJSON(name, limit = 2500000) {
    const response = await read(filePath(name));
    if (response.status === 404) return null;
    if (!response.ok) throw Object.assign(new Error('账号存储文件读取失败，请重试'), { status: response.status, scope: 'tavern-storage' });
    const raw = await response.text();
    if (raw.length > limit) throw new Error('账号存储文件超过大小限制');
    try { return JSON.parse(raw); } catch { throw new Error('账号存储文件损坏，请从备份恢复'); }
  }
  async function writeJSON(name, value) {
    const data = base64(new TextEncoder().encode(JSON.stringify(value)));
    const result = await api('/api/files/upload', { name, data });
    if (String(result.path).replace(/^\//, '') !== filePath(name)) throw new Error('酒馆返回的账号文件路径不正确');
  }
  async function metadata(id) {
    const old = cache.get(id);
    if (old && now() - old.at < 5000) return clone(old.row);
    const row = await readJSON(metaName(id));
    if (!row) return null;
    if (row.id !== id || row.nativeStorage !== 1 || !['png', 'jpg', 'webp'].includes(row.extension)
      || !['png', 'jpg', 'webp'].includes(row.thumbExtension)) throw new Error('图片参数文件格式无效');
    row.nativePath = imagePath(id, row.extension);
    row.nativeThumbPath = imagePath(id, row.thumbExtension, true);
    row.chatBinding = binding(row.chatBinding);
    cache.set(id, { at: now(), row: clone(row) });
    return row;
  }
  async function saveRow(row) {
    await writeJSON(metaName(row.id), row);
    cache.set(row.id, { at: now(), row: clone(row) });
    snapshot = null;
  }
  function resolveVersions(rows) {
    const groups = new Map();
    for (const row of rows) {
      const id = versionGroupId(row);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(row);
    }
    for (const group of groups.values()) {
      const selected = group.slice().sort((a, b) => (a.selectionAt || 0) - (b.selectionAt || 0) || versionOrder(a, b)).at(-1);
      for (const row of group) row.versionCurrent = row.id === selected.id;
    }
    return rows;
  }
  async function list(force = false) {
    if (snapshot && !force && now() - lastList < 1500) return clone(snapshot);
    const [names, thumbs] = await Promise.all([FOLDER, THUMBS].map((folder) => api('/api/images/list', { folder, sortField: 'name' })));
    if (!Array.isArray(names) || !Array.isArray(thumbs)) throw new Error('酒馆图片列表格式无效');
    originals = new Set(names); thumbnails = new Set(thumbs);
    const discovered = [...new Set([...names, ...thumbs].map((name) => /^lh-([A-Za-z0-9_-]{1,80})\.(?:png|jpg|webp)$/i.exec(name)?.[1]).filter((id) => validImageId(id)))];
    if (discovered.length > LIMIT) throw new Error('账号图片超过 10000 张，请先分批备份整理');
    const rows = await mapLimit(discovered, (id) => metadata(id));
    pendingFiles = rows.filter((row) => !row).length;
    snapshot = resolveVersions(rows.filter(Boolean)); lastList = now();
    return clone(snapshot);
  }
  async function getChat(id, rows) {
    validId(id);
    let row = await readJSON(chatName(id));
    if (row && !binding(row.binding)) throw new Error('聊天关联文件格式无效');
    const pictures = (rows || await list()).filter((item) => item.chatBinding?.id === id && !item.version?.parentId)
      .sort((a, b) => a.createdAt - b.createdAt);
    const latest = pictures.at(-1);
    if (latest && (!row || row.requestId === latest.chatRequestId || row.updatedAt <= latest.createdAt)) {
      const saved = pictures.filter((item) => item.chatRequestId === latest.chatRequestId);
      const completed = saved.length >= (latest.chatBatchSize || 1);
      row = { ...row, binding: latest.chatBinding, requestId: latest.chatRequestId, savedIds: saved.map((item) => item.id),
        status: completed ? 'completed' : row?.status || 'failed', updatedAt: Math.max(row?.updatedAt || 0, latest.createdAt),
        phase: completed ? '' : row?.phase || '', error: completed ? '' : row?.error || '图片尚未保存完整，可在原设备继续取图' };
    }
    if (row) chats.set(id, row);
    return row;
  }
  async function remove(ids, allowReferenced, automatic = false) {
    if (!Array.isArray(ids) || ids.length > LIMIT || !ids.every(validImageId)) throw new Error('删除列表无效');
    const rows = await list(true);
    const protectedGroups = protectedVersionGroups(rows);
    const selected = rows.filter((row) => ids.includes(row.id) && (!automatic || !protectedGroups.has(versionGroupId(row))));
    if (!allowReferenced && selected.some((row) => row.chatBinding)) throw new Error('所选图片包含聊天配图，请确认后删除');
    const deleted = [];
    for (const row of selected) {
      await api('/api/images/delete', { path: row.nativePath }, { missing: true });
      await api('/api/images/delete', { path: row.nativeThumbPath }, { missing: true });
      await api('/api/files/delete', { path: filePath(metaName(row.id)) }, { missing: true });
      deleted.push(row.id); cache.delete(row.id); snapshot = null;
    }
    return { ids: deleted, pendingFiles };
  }
  async function reference(action, body) {
    if (action === 'reference/list') throw new Error('内置存储按引用读取素材，完整素材清单需服务器增强组件');
    if (!/^[a-f0-9]{64}$/.test(body.id)) throw new Error('参考素材标识无效');
    const name = `linghuashi-reference-${body.id}`;
    const row = await readJSON(`${name}.json`);
    if (action === 'reference/get') {
      if (!row) throw Object.assign(new Error('参考素材不存在，请重新上传'), { status: 404 });
      const response = await read(filePath(`${name}.bin`));
      if (!response.ok) throw Object.assign(new Error('参考素材读取失败'), { status: response.status, scope: 'tavern-storage' });
      const bytes = new Uint8Array(await response.arrayBuffer()), offset = body.offset || 0;
      if (bytes.length > 4 * 1024 * 1024 || bytes.length !== row.size || !Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length
        || await hash(bytes) !== body.id) throw new Error('参考素材校验失败');
      return { row, data: base64(bytes.subarray(offset, offset + CHUNK)) };
    }
    if (action !== 'reference/put') throw new Error('未知素材操作');
    if (row) return { row, complete: true, offset: row.size };
    const { offset, total, data } = body;
    if (!Number.isSafeInteger(total) || total < 1 || total > 4 * 1024 * 1024 || !Number.isSafeInteger(offset) || offset < 0
      || typeof data !== 'string' || data.length > Math.ceil(CHUNK / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('参考素材块无效');
    const bytes = bytes64(data);
    if (!bytes.length || bytes.length > CHUNK || offset + bytes.length > total) throw new Error('参考素材块大小无效');
    for (const [id, upload] of uploads) if (now() - upload.at > 120000) uploads.delete(id);
    if (!uploads.has(body.id)) {
      if (offset !== 0 || uploads.size >= 4) throw new Error('请重新上传参考素材');
      uploads.set(body.id, { bytes: new Uint8Array(total), size: 0, at: now() });
    }
    const upload = uploads.get(body.id);
    if (upload.bytes.length !== total || offset > upload.size) throw new Error('素材块不连续');
    if (offset < upload.size && !bytes.every((value, index) => upload.bytes[offset + index] === value)) throw new Error('重传素材内容不同');
    upload.bytes.set(bytes, offset); upload.size = Math.max(upload.size, offset + bytes.length); upload.at = now();
    if (upload.size !== total) return { complete: false, offset: upload.size };
    if (await hash(upload.bytes) !== body.id) throw new Error('参考素材校验失败');
    if (!['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'].includes(body.mime)) throw new Error('素材格式不支持');
    if (body.mime.startsWith('image/') && imageData(base64(upload.bytes), 4 * 1024 * 1024).mime !== body.mime) throw new Error('素材内容与图片格式不一致');
    const result = await api('/api/files/upload', { name: `${name}.bin`, data: base64(upload.bytes) });
    if (String(result.path).replace(/^\//, '') !== filePath(`${name}.bin`)) throw new Error('素材路径不正确');
    const saved = { id: body.id, size: total, mime: body.mime, name: text(body.name, 120),
      width: Math.max(0, Math.min(4096, Math.round(Number(body.width) || 0))),
      height: Math.max(0, Math.min(4096, Math.round(Number(body.height) || 0))), createdAt: now() };
    await writeJSON(`${name}.json`, saved); uploads.delete(body.id);
    return { row: saved, complete: true, offset: total };
  }
  async function dispatch(action, body = {}) {
    if (action === 'diagnostics/status') {
      const [originals, thumbs] = await Promise.all([FOLDER, THUMBS].map((folder) => api('/api/images/list', { folder, sortField: 'name' })));
      if (!Array.isArray(originals) || !Array.isArray(thumbs)) throw new Error('酒馆图片列表格式无效');
      const ids = (names) => new Set(names.map((name) => /^lh-([A-Za-z0-9_-]{1,80})\.(?:png|jpg|webp)$/i.exec(name)?.[1]).filter(Boolean));
      const images = ids(originals), thumbnails = ids(thumbs);
      return { readable: true, originals: images.size, thumbnails: thumbnails.size, maxRecords: LIMIT, diskFree: null,
        unmatched: [...images].filter((id) => !thumbnails.has(id)).length + [...thumbnails].filter((id) => !images.has(id)).length };
    }
    if (action === 'backup/status') return { version: 'native', protocol: STORAGE_PROTOCOL, account, native: true };
    if (action === 'list') {
      const rows = await list(body.refresh === true);
      return { rows, native: true, directory: 'user/images/linghuashi', maxRecords: LIMIT, pendingFiles,
        bytes: rows.reduce((sum, row) => sum + row.bytes + row.thumbBytes, 0) };
    }
    if (action === 'add') {
      const value = body.row;
      validId(value?.id);
      const original = imageData(body.image, 20 * 1024 * 1024), thumb = imageData(body.thumbnail, 1024 * 1024);
      const digest = await hash(original.bytes), existing = await metadata(value.id);
      if (existing) {
        if (existing.digest !== digest) throw new Error('同 ID 图片内容不同，请重新导入');
        return { row: existing, existing: true };
      }
      if (!Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) || value.width < 1 || value.height < 1
        || value.width * value.height > 40000000) throw new Error('图片尺寸无效');
      if (value.snapshot != null && (!object(value.snapshot) || !['novelai', 'comfyui', 'openai', 'sdwebui'].includes(value.snapshot.provider)
        || JSON.stringify(value.snapshot).length > 2000000)) throw new Error('图片参数格式无效或超过限制');
      const rows = await list(true);
      if (rows.length >= LIMIT) throw new Error('服务器最多保存 10000 张图片，请先导出并清理');
      const snapshot = safeImageSnapshot(value.snapshot ?? null);
      const row = insertVersion(rows, { id: value.id, nativeStorage: 1, title: text(value.title, 100) || '未命名图片',
        createdAt: Number.isFinite(value.createdAt) && value.createdAt > 0 && value.createdAt < now() + 86400000 ? value.createdAt : now(),
        source: snapshot?.provider || 'unknown', snapshot, favorite: value.favorite === true, demo: false,
        batchId: text(value.batchId, 80), chatBinding: binding(value.chatBinding), version: normalizeVersion(value.version, value.id),
        versionCurrent: value.versionCurrent !== false, selectionAt: value.versionCurrent !== false
          ? Math.max(now(), ...rows.filter((item) => versionGroupId(item) === normalizeVersion(value.version, value.id).groupId).map((item) => (item.selectionAt || 0) + 1)) : 0,
        chatRequestId: validImageId(body.requestId) ? body.requestId : value.batchId || value.id,
        chatBatchSize: Math.max(1, Math.min(32, Number(body.batchSize) || 1)),
        width: value.width, height: value.height, bytes: original.bytes.length, thumbBytes: thumb.bytes.length,
        mime: original.mime, thumbMime: thumb.mime, extension: original.extension, thumbExtension: thumb.extension, digest }).at(-1);
      for (const [image, folder] of [[original, FOLDER], [thumb, THUMBS]]) {
        const result = await api('/api/images/upload', { image: base64(image.bytes), format: image.extension, ch_name: folder, filename: `lh-${row.id}.${image.extension}` });
        if (String(result.path).replace(/^\//, '') !== imagePath(row.id, image.extension, folder === THUMBS)) throw new Error('酒馆返回的图片路径不正确');
      }
      row.nativePath = imagePath(row.id, row.extension); row.nativeThumbPath = imagePath(row.id, row.thumbExtension, true);
      await saveRow(row);
      return { row };
    }
    if (action === 'image/get') {
      validId(body.id); const rows = await list();
      return body.current ? currentDrawing(rows, body.id) : rows.find((row) => row.id === body.id) || null;
    }
    if (action === 'favorite' || action === 'version/select') {
      validId(body.id);
      const row = await metadata(body.id);
      if (!row) throw new Error('图片已经删除');
      if (action === 'favorite') {
        if (typeof body.favorite !== 'boolean') throw new Error('收藏参数无效');
        row.favorite = body.favorite;
      } else {
        const group = (await list()).filter((item) => versionGroupId(item) === versionGroupId(row));
        row.selectionAt = Math.max(now(), ...group.map((item) => (item.selectionAt || 0) + 1));
      }
      await saveRow(row);
      return action === 'favorite' ? { saved: true } : { selected: row.id };
    }
    if (action === 'remove') return remove(body.ids, body.allowReferenced === true);
    if (action === 'policy') {
      const number = (key, min, max, fallback) => Math.max(min, Math.min(max, Math.round(Number(body[key]) || fallback)));
      const next = { active: body.active === true, cleanupMode: ['manual', 'time', 'count'].includes(body.cleanupMode) ? body.cleanupMode : 'manual',
        cleanupUnit: body.cleanupUnit === 'hours' ? 'hours' : 'days', cleanupInterval: number('cleanupInterval', 1, 365, 7),
        cleanupMaxImages: number('cleanupMaxImages', 1, LIMIT, 200), cleanupOlderThanDays: number('cleanupOlderThanDays', 1, 3650, 7) };
      const previous = await readJSON('linghuashi-storage-policy.json');
      if (JSON.stringify(previous?.settings) !== JSON.stringify(next)) await writeJSON('linghuashi-storage-policy.json', { settings: next, lastCleanup: now() });
      return { saved: true, background: false };
    }
    if (action === 'cleanup') {
      const policy = await readJSON('linghuashi-storage-policy.json'), settings = policy?.settings;
      if (!settings?.active || settings.cleanupMode === 'manual') return { ids: [], due: false };
      const rows = await list(), period = settings.cleanupInterval * (settings.cleanupUnit === 'hours' ? 3600000 : 86400000);
      const due = settings.cleanupMode === 'time' ? now() - policy.lastCleanup >= period : rows.length >= settings.cleanupMaxImages;
      if (!due) return { ids: [], due: false };
      const cutoff = now() - settings.cleanupOlderThanDays * 86400000;
      const result = await remove(rows.filter((row) => settings.cleanupMode === 'time' || row.createdAt < cutoff).map((row) => row.id), true, true);
      await writeJSON('linghuashi-storage-policy.json', { settings, lastCleanup: now() });
      return { ...result, due: true };
    }
    if (action === 'audit') {
      const rows = await list(true), missing = [];
      for (const row of rows) if (!thumbnails.has(row.nativeThumbPath.split('/').at(-1))
        || !originals.has(row.nativePath.split('/').at(-1))) missing.push(row.id);
      return { missing, orphans: pendingFiles, pendingFiles };
    }
    if (action === 'chat/get') return getChat(body.id);
    if (action === 'chat/list' || action === 'backup/chats') {
      const rows = await list(), ids = new Set([...chats.keys(), ...rows.map((row) => row.chatBinding?.id).filter(Boolean)]);
      const found = await mapLimit([...ids], (id) => getChat(id, rows));
      const result = found.filter((row) => row && (action === 'backup/chats' || row.binding.chatKey === body.chatKey));
      return action === 'backup/chats' ? { rows: result } : result;
    }
    if (action === 'chat/reserve') {
      const bound = binding(body.binding);
      if (!bound || !validImageId(body.requestId)) throw new Error('聊天任务参数无效');
      const previous = await getChat(bound.id);
      if (previous && (body.force !== true || previous.requestId !== body.previousRequestId)) return null;
      const row = { binding: bound, requestId: body.requestId, status: 'preparing', savedIds: [], updatedAt: now() };
      await writeJSON(chatName(bound.id), row); chats.set(bound.id, row); return row;
    }
    if (action === 'chat/update') {
      const previous = await getChat(body.id), value = body.value;
      if (!previous || previous.requestId !== body.requestId) return null;
      if (!object(value) || !['preparing', 'confirming', 'queued', 'running', 'completed', 'failed', 'cancelled', 'drafted', 'skipped'].includes(value.status)) throw new Error('聊天任务状态无效');
      if (previous.status === 'completed' && ['preparing', 'confirming', 'queued', 'running'].includes(value.status)) return previous;
      const row = { ...previous, status: value.status, phase: text(value.phase, 30), error: text(value.error, 500),
        recoverable: value.recoverable === true, savedIds: [...new Set([...previous.savedIds, ...(value.savedIds || []).filter(validImageId).slice(0, 32)])],
        ...(object(value.assistant) ? { assistant: safeImageSnapshot(value.assistant) } : {}), updatedAt: now() };
      await writeJSON(chatName(body.id), row); chats.set(body.id, row); return row;
    }
    if (action === 'backup/chats-merge') {
      const rows = normalizeBackupChats(body.rows, new Set((await list()).map((row) => row.id)));
      let imported = 0;
      for (const row of rows) if (!await getChat(row.binding.id)) {
        await writeJSON(chatName(row.binding.id), row); chats.set(row.binding.id, row); imported++;
      }
      return { imported };
    }
    if (action.startsWith('reference/')) return reference(action, body);
    throw new Error('未知账号存储操作');
  }
  return (action, body = {}) => {
    const run = () => dispatch(action, body);
    const locked = () => locks ? locks.request(`linghuashi-native:${account}`, run) : run();
    queue = queue.catch(() => {}).then(locked);
    return queue;
  };
}
