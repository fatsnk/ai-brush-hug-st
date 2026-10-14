import { serverDrawing } from './server-storage.js';
import { currentDrawing } from '../server/linghuashi-storage/image-versions.mjs';

const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export async function openChatStore(account, { mode = () => 'browser', request: serverRequest, ownsRequest = () => false } = {}) {
  const request = indexedDB.open(`linghuashi-drawings-v1:st:${encodeURIComponent(account)}`, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('drawings', { keyPath: 'id' });
    request.result.createObjectStore('meta', { keyPath: 'key' });
  };
  const db = await requestResult(request);
  db.onversionchange = () => db.close();
  const key = (id) => `chat-slot:${id}`;
  const mutate = (id, change) => new Promise((resolve, reject) => {
    const transaction = db.transaction('meta', 'readwrite');
    const store = transaction.objectStore('meta');
    let result;
    const read = store.get(key(id));
    read.onsuccess = () => {
      result = change(read.result);
      if (result) store.put({ ...result, key: key(id) });
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error || new Error('聊天任务记录保存失败'));
    transaction.onerror = () => {};
  });
  const local = {
    get: (id) => requestResult(db.transaction('meta', 'readonly').objectStore('meta').get(key(id))),
    reserve: (binding, requestId, force) => mutate(binding.id, (previous) => {
      if (previous && !force) return null;
      return { binding, requestId, status: 'preparing', savedIds: [], updatedAt: Date.now() };
    }),
    update: (id, requestId, value) => mutate(id, (previous) => {
      if (!previous || previous.requestId !== requestId) return null;
      return { ...previous, ...value, updatedAt: Date.now() };
    }),
    image: async (id) => currentDrawing(await requestResult(db.transaction('drawings', 'readonly').objectStore('drawings').getAll()), id),
    close: () => db.close(),
  };
  const locations = new Map();
  const records = new Map();
  const serverImages = new Set();
  let syncedChat;
  let syncedRecords = new Map();
  let taskRecords = new Map();
  const withTask = (row, id) => {
    const task = taskRecords.get(id);
    if (!task || row && row.requestId !== task.plan.chatRequestId && row.updatedAt > task.createdAt) return row;
    const queuedHere = task.status === 'paused' && task.stage === 'waiting' && ownsRequest(task.plan.chatRequestId);
    return { ...row, binding: task.plan.chatBinding, requestId: task.plan.chatRequestId, taskId: task.id,
      status: queuedHere ? 'queued' : ['paused', 'uncertain'].includes(task.status) ? 'failed' : task.status,
      phase: task.phase, updatedAt: task.updatedAt,
      error: queuedHere ? '' : task.status === 'paused' ? '任务已恢复，等待手动继续' : task.error,
      recoverable: ['paused', 'failed'].includes(task.status) && (Boolean(task.execution) || task.stage === 'waiting'),
      assistant: row?.assistant || task.plan.snapshot?.assistant,
      savedIds: [...new Set([...(row?.savedIds || []), ...task.savedIds])] };
  };
  const remember = (row, location) => {
    if (!row) return row;
    locations.set(row.binding.id, location);
    records.set(row.binding.id, row);
    if (location === 'server') for (const id of row.savedIds || []) serverImages.add(id);
    return { ...row, storageLocation: location };
  };
  return {
    async sync(chatKey) {
      if (serverRequest && chatKey) {
        const tasks = await serverRequest('task/list');
        taskRecords = new Map(tasks.rows.filter((task) => task.plan.chatBinding?.chatKey === chatKey)
          .filter((task) => !task.plan.imageEdit).map((task) => [task.plan.chatBinding.id, task]));
      }
      if (mode() !== 'server' || !serverRequest || !chatKey) { syncedChat = null; return; }
      const rows = await serverRequest('chat/list', { chatKey });
      syncedChat = chatKey;
      syncedRecords = new Map(rows.map((row) => [row.binding.id, row]));
    },
    async get(id) {
      if (mode() === 'server' && serverRequest) {
        const row = syncedChat ? syncedRecords.get(id) : await serverRequest('chat/get', { id });
        if (row) return remember(withTask(row, id), 'server');
      }
      const row = withTask(await local.get(id), id);
      const task = taskRecords.get(id);
      return remember(row, task && row?.taskId === task.id ? task.plan.storageLocation : 'browser');
    },
    async reserve(binding, requestId, force) {
      const location = mode() === 'server' && serverRequest ? 'server' : 'browser';
      const row = location === 'server'
        ? await serverRequest('chat/reserve', { binding, requestId, force, previousRequestId: records.get(binding.id)?.requestId })
        : await local.reserve(binding, requestId, force);
      if (row && location === 'server') syncedRecords.set(binding.id, row);
      return remember(row, location);
    },
    async update(id, requestId, value) {
      const location = locations.get(id) || mode();
      const row = location === 'server' && serverRequest
        ? await serverRequest('chat/update', { id, requestId, value }) : await local.update(id, requestId, value);
      if (row && location === 'server') syncedRecords.set(id, row);
      return remember(row, location);
    },
    async image(id) {
      if (serverImages.has(id) && serverRequest) {
        const row = await serverRequest('image/get', { id, current: true });
        return row ? serverDrawing(row, account) : null;
      }
      return local.image(id);
    },
    close: local.close,
  };
}
