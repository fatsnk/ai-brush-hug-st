const BASE = '/api/plugins/linghuashi-storage';
import { TASK_ACTIONS } from '../server/linghuashi-storage/task-ledger.mjs';
import { REFERENCE_ACTIONS } from '../server/linghuashi-storage/reference-actions.mjs';
import { BACKUP_ACTIONS } from '../server/linghuashi-storage/backup-records.mjs';
export const STORAGE_ACTIONS = new Set(['list', 'image/get', 'version/select', 'policy', 'cleanup', 'add', 'favorite', 'remove', 'audit',
  'chat/list', 'chat/get', 'chat/reserve', 'chat/update', ...TASK_ACTIONS, ...REFERENCE_ACTIONS, ...BACKUP_ACTIONS]);

export function createStorageRequest(getHeaders) {
  return async (action, body = {}) => {
    if (!STORAGE_ACTIONS.has(action)) throw new Error('未知服务器存储操作');
    const headers = getHeaders();
    if (!headers) throw new Error('酒馆请求验证尚未就绪');
    const response = await fetch(`${BASE}/${action}`, {
      method: 'POST', headers, body: JSON.stringify(body), credentials: 'same-origin',
      cache: 'no-store', signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || (response.status === 404
        ? '酒馆服务器存图组件尚未安装或启用' : '酒馆服务器存图失败，请重试'));
    }
    return response.json();
  };
}

export function serverImageURL(id, account, thumbnail = false) {
  return `${BASE}/image/${encodeURIComponent(id)}?account=${encodeURIComponent(account)}${thumbnail ? '&thumbnail=1' : ''}`;
}

export function serverDrawing(row, account) {
  return { ...row, storageLocation: 'server', blob: { size: row.bytes, type: row.mime },
    thumbnail: { size: row.thumbBytes, type: row.thumbMime },
    srcURL: serverImageURL(row.id, account), thumbnailURL: serverImageURL(row.id, account, true) };
}

async function base64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('图片数据读取失败'));
    reader.readAsDataURL(blob);
  });
}

export class ServerDrawingLibrary {
  constructor(request, account) { this.request = request; this.account = account; }
  async list() {
    const result = await this.request('list');
    this.stats = result;
    return result.rows.map((row) => serverDrawing(row, this.account));
  }
  async add(rows, options = {}) {
    for (const row of rows) {
      const { blob, thumbnail, src, thumbSrc, srcURL, thumbnailURL, ...metadata } = row;
      await this.request('add', { row: metadata, image: await base64(blob), thumbnail: await base64(thumbnail),
        requestId: options.requestId, batchSize: rows.length });
    }
  }
  remove(ids, allowReferenced) { return this.request('remove', { ids, allowReferenced }); }
  setFavorite(id, favorite) { return this.request('favorite', { id, favorite }); }
  selectVersion(id) { return this.request('version/select', { id }); }
  cleanup() { return this.request('cleanup'); }
  policy(settings) {
    return this.request('policy', { active: settings.enabled !== false && settings.cacheLocation === 'server',
      cleanupMode: settings.cleanupMode, cleanupInterval: settings.cleanupInterval, cleanupUnit: settings.cleanupUnit,
      cleanupMaxImages: settings.cleanupMaxImages, cleanupOlderThanDays: settings.cleanupOlderThanDays });
  }
  async materialize(row) {
    if (row.blob instanceof Blob) return row;
    const load = async (url) => {
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(response.status === 404 ? '服务器图片已删除或文件缺失' : '服务器原图下载失败，请重试');
      return response.blob();
    };
    return { ...row, blob: await load(row.srcURL), thumbnail: await load(row.thumbnailURL) };
  }
}
