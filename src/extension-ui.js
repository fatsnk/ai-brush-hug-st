import './styles/plugin.css';

async function boot() {
  if (window.parent === window) throw new Error('酒馆连接未建立');
  const initial = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('酒馆连接超时，请重新打开'));
    }, 15000);
    function onMessage(event) {
      if (event.origin !== location.origin || event.source !== window.parent) return;
      if (event.data?.type !== 'linghuashi:init' || typeof event.data.account !== 'string' || !event.data.account) return;
      clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
      resolve(event.data);
    }
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'linghuashi:ready' }, location.origin);
  });

  window.__LINGHUASHI_ENV__ = {
    mode: 'extension', account: initial.account, ui: initial.ui, chat: initial.chat,
  };
  const [{ normalizeConfig }, plugin] = await Promise.all([
    import('./config.js'), import('./ui/plugin.js'),
  ]);
  await plugin.restoreCredentials();
  plugin.mountPlugin(document.getElementById('plugin-root'), normalizeConfig({ ...initial.layout, surface: 'console', state: 'ready' }));
  if (initial.page) plugin.showPage(initial.page);

  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== window.parent) return;
    if (event.data?.type === 'linghuashi:layout') {
      plugin.applyConfig(normalizeConfig({ ...event.data.layout, surface: 'console', state: 'ready' }));
    }
    if (event.data?.type === 'linghuashi:chat') plugin.applyHostContext(event.data.chat);
    if (event.data?.type === 'linghuashi:navigate') plugin.showPage(event.data.page);
    if (event.data?.type === 'linghuashi:floating' && typeof event.data.visible === 'boolean') plugin.setFloatingBall(event.data.visible);
    if (event.data?.type?.startsWith('linghuashi:chat-')) plugin.receiveChatCommand(event.data);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || document.getElementById('overlay-root').childElementCount) return;
    event.preventDefault();
    window.parent.postMessage({ type: 'linghuashi:close' }, location.origin);
  }, true);
  window.parent.postMessage({ type: 'linghuashi:mounted' }, location.origin);
}

boot().catch((error) => {
  const message = document.createElement('p');
  message.textContent = error.message;
  message.setAttribute('role', 'alert');
  document.getElementById('plugin-root').replaceChildren(message);
  window.parent.postMessage({ type: 'linghuashi:error', message: error.message }, location.origin);
});
