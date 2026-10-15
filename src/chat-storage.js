import { serverDrawing } from './server-storage.js';
import { currentDrawing, groupVersions, selectVersion } from '../server/linghuashi-storage/image-versions.mjs';

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
  const changeImages = (change) => new Promise((resolve, reject) => {
    const transaction = db.transaction('drawings', 'readwrite'), store = transaction.objectStore('drawings');
    const read = store.getAll();
    let failure;
    read.onsuccess = () => {
      try { change(read.result).forEach((row) => store.put(row)); }
      catch (error) { failure = error; transaction.abort(); }
    };
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(failure || transaction.error || new Error('图片记录保存失败'));
    transaction.onerror = () => {};
  });
  const locations = new Map();
  const records = new Map();
  const serverImages = new Set();
  let syncedChat;
  let syncedRecords = new Map();
  let taskRecords = new Map();
  let allTasks = [];
  let browserRows;
  let serverRows;
  const imageRows = (location) => {
    if (location === 'server' && serverRequest) {
      serverRows ||= serverRequest('list').then((result) => result.rows.map((row) => serverDrawing(row, account)));
      return serverRows;
    }
    browserRows ||= requestResult(db.transaction('drawings', 'readonly').objectStore('drawings').getAll());
    return browserRows;
  };
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
      browserRows = null; serverRows = null;
      if (serverRequest && chatKey) {
        const tasks = await serverRequest('task/list');
        allTasks = tasks.rows.filter((task) => task.plan.chatBinding?.chatKey === chatKey);
        taskRecords = new Map(allTasks
          .filter((task) => !task.plan.imageEdit).map((task) => [task.plan.chatBinding.id, task]));
      } else { allTasks = []; taskRecords.clear(); }
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
    async image(id, location = serverImages.has(id) ? 'server' : 'browser') {
      const row = currentDrawing(await imageRows(location), id);
      return row ? { ...row, storageLocation: location } : null;
    },
    async versions(id, location) {
      return groupVersions(await imageRows(location), id).map((row) => ({ ...row, storageLocation: location }));
    },
    imageTask(bindingId, groupId, location) {
      return allTasks.filter((task) => task.plan.chatBinding?.id === bindingId && task.plan.imageEdit?.groupId === groupId
        && task.plan.storageLocation === location).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0];
    },
    hasImageRequest(bindingId, requestId) {
      return allTasks.some((task) => task.plan.chatBinding?.id === bindingId && task.plan.imageEdit && task.plan.chatRequestId === requestId);
    },
    async favorite(id, favorite, location) {
      if (location === 'server') await serverRequest('favorite', { id, favorite });
      else await changeImages((rows) => {
        if (!rows.some((row) => row.id === id)) throw new Error('图片已经删除，请刷新聊天');
        return rows.map((row) => row.id === id ? { ...row, favorite } : row);
      });
      browserRows = null; serverRows = null;
    },
    async selectVersion(id, location) {
      if (location === 'server') await serverRequest('version/select', { id });
      else await changeImages((rows) => selectVersion(rows, id));
      browserRows = null; serverRows = null;
    },
    close: local.close,
  };
}
