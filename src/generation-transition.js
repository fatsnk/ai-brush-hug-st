const pending = new Set(['preparing', 'confirming', 'queued', 'running']);
const phases = {
  preparing: ['准备绘图素材', '正在读取参考图片与参数'],
  submitting: ['正在绘制画面', '等待生图接口返回结果'],
  generating: ['正在绘制画面', 'SDWebUI 正在生成'],
  retrieving: ['正在取回图片', '正在读取生成结果'],
  downloading: ['正在下载图片', '正在接收图片文件'],
  saving: ['正在保存图片', '正在存入绘图管理'],
};

export function generationTransitionState(task, { remote = false } = {}) {
  if (!task || !pending.has(task.status)) return null;
  let stage = task.status;
  let title, detail;
  if (remote) {
    title = '等待任务状态同步'; detail = '任务仍在执行，正在同步进度';
  } else if (stage === 'queued') {
    title = '正在排队'; detail = '等待调度，轮到后开始绘制';
  } else if (stage === 'confirming') {
    title = '等待确认提示词'; detail = '确认后开始绘制';
  } else if (stage === 'preparing') {
    title = '准备生图'; detail = '正在准备提示词与绘图参数';
  } else {
    stage = Object.hasOwn(phases, task.phase) ? task.phase : 'submitting';
    [title, detail] = phases[stage];
  }
  const value = task.progress?.value, max = task.progress?.max;
  const progress = !remote && task.status === 'running' && ['retrieving', 'generating'].includes(stage)
    && Number.isFinite(value) && value >= 0 && Number.isFinite(max) && max > 0
    ? { value: Math.min(value, max), max, percent: Math.min(100, value / max * 100) } : null;
  const node = task.progress?.node;
  if (progress) detail = `${detail} · ${progress.value} / ${progress.max}`;
  if (!remote && task.status === 'running' && typeof node === 'string' && /^[\w.-]{1,40}$/.test(node)) {
    if (node !== 'SDWebUI') detail += ` · 节点 #${node}`;
  }
  return {
    stage, title, detail, progress,
    animated: !remote && task.status !== 'confirming',
    cancellable: !remote && stage !== 'saving',
  };
}
