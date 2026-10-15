export const RELEASE = Object.freeze({
  version: '0.21.2',
  build: '20261015-chat-sync-r1',
  repository: 'ibome/ai-brush-hug-st',
  url: 'https://github.com/ibome/ai-brush-hug-st',
  storageProtocol: 2,
});

export function compareVersions(a, b) {
  const parse = (value) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value));
  const left = parse(a), right = parse(b);
  if (!left || !right) throw new Error('版本号格式无效');
  for (let index = 1; index < 4; index++) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export async function checkRelease() {
  const response = await fetch(`https://api.github.com/repos/${RELEASE.repository}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000),
    cache: 'no-store', credentials: 'omit',
  });
  if (response.status === 404) return { message: '尚无正式发布版本', version: '', notes: '', url: `${RELEASE.url}/releases` };
  if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? '版本查询次数受限，请稍后重试' : '版本信息读取失败');
  const data = await response.json(), version = String(data.tag_name || '').replace(/^v/, '');
  const newer = compareVersions(version, RELEASE.version) > 0;
  return { message: newer ? `发现新版本 ${version}` : '当前已是最新版本', version,
    notes: String(data.body || '').slice(0, 12000), url: `${RELEASE.url}/releases/tag/v${version}` };
}
