import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeBackupChats, STORAGE_PROTOCOL } from './backup-records.mjs';
import { createStorageService } from './index.mjs';
const binding = { id: 'a'.repeat(64), branch: 'b'.repeat(64), chatKey: 'fixture-chat', swipe: 0, slot: 0 };

test('chat backup restores images only as terminal records without executable task IDs', () => {
  const rows = normalizeBackupChats([{ binding, requestId: 'original', status: 'running', taskId: 'original-task',
    savedIds: ['image-a', 'missing'], recoverable: true }], new Set(['image-a']));
  assert.equal(rows[0].status, 'completed'); assert.deepEqual(rows[0].savedIds, ['image-a']);
  assert.ok(!rows[0].taskId); assert.equal(rows[0].recoverable, false);
});
test('missing images remain failed records and are never queued automatically', () => {
  const rows = normalizeBackupChats([{ binding, status: 'queued', savedIds: [] }], new Set());
  assert.equal(rows[0].status, 'failed'); assert.equal(rows[0].recoverable, false);
});
test('invalid chat bindings and duplicate slot records are rejected', () => {
  assert.throws(() => normalizeBackupChats([{ binding: { ...binding, slot: -1 } }], new Set()));
  assert.throws(() => normalizeBackupChats([{ binding }, { binding }], new Set()));
});
test('backup service is account isolated and reports protocol without exposing secrets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linghuashi-backup-unit-'));
  const service = createStorageService({ allowedAccounts: ['fixture'] });
  const user = { profile: { handle: 'fixture' }, directories: { root, userImages: path.join(root, 'user/images') } };
  try {
    const status = await service.dispatch(user, 'backup/status');
    assert.equal(status.protocol, STORAGE_PROTOCOL); assert.equal(status.version, '0.11.0');
    assert.deepEqual((await service.dispatch(user, 'backup/chats')).rows, []);
    await service.dispatch(user, 'backup/chats-merge', { rows: [{ binding, savedIds: [] }] });
    const first = await service.dispatch(user, 'backup/chats');
    assert.equal(first.rows[0].status, 'failed');
    assert.equal((await service.dispatch(user, 'backup/chats-merge', { rows: [{ binding, savedIds: [] }] })).imported, 0);
    await assert.rejects(service.dispatch({ ...user, profile: { handle: 'other' } }, 'backup/status'), /安装/);
    await assert.rejects(service.dispatch({}, 'backup/chats'), /登录/);
  } finally {
    await service.drain();
    await fs.rm(root, { recursive: true, force: true });
  }
});
