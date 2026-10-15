# 安装、更新和回退

## 前端

在 SillyTavern 扩展管理中安装仓库 `https://github.com/ibome/ai-brush-hug-st`。仓库根目录含 `manifest.json`，入口为 `dist/index.js`，无需编译。

希望全部账号使用时由管理员选择所有用户安装；希望仅一个账号使用时安装到该账号。账号间设置、秘钥和图片保持独立。

## 后端

下载 Releases 中独立的服务器 ZIP，解压至：

```text
SillyTavern/
  plugins/
    linghuashi-storage/
      index.mjs
      task-ledger.mjs
      image-versions.mjs
      reference-assets.mjs
      reference-actions.mjs
      backup-records.mjs
```

也可从源码目录执行：

```sh
node scripts/install-server.mjs --st-root /绝对路径/SillyTavern
```

脚本会备份已有模块后更新，保留已有 `allowed-accounts.json`。在酒馆 `config.yaml` 中设置 `enableServerPlugins: true` 后，使用自己的启动方式重启酒馆。

宝塔用户可在文件管理中解压 ZIP，再在配置编辑器启用该选项；通过自己的 PM2、systemd 或 Node 项目管理入口重启。

没有启用组件时，版本检查会显示未安装、未启用或较旧。接口的跨域限制、反向代理鉴权和 ComfyUI 节点仍由使用者的服务配置决定。

## 更新

1. 等待当前生图和助手任务结束。
2. 导出个人配置备份，需要搬迁图片时导出完整备份。
3. 更新前端；服务器组件有变化或当前组件过旧时，安装本次配套的服务器 ZIP。
4. 更新过服务器组件时重启酒馆，然后刷新页面，通过「版本与更新」核对版本与协议。

当前前端为 **0.21.2**，服务器组件自身为 **0.21.0／协议 2**。0.21.2 的服务器 ZIP 按发行版本命名，内部组件仍显示 0.21.0，这是正常组合。已安装 0.21.0 组件时，本次前端修复无需重启；从 0.11.1 等旧版升级仍需更新组件。

完整新手步骤见 [新手入门](quickstart.md)，各功能教程见 [仓库首页](../README.md)。侧边栏「更新日志」可离线查看版本记录。

## 回退

从 Releases 选择此前版本，下载前端包覆盖对应扩展目录；后端也使用对应版本的 ZIP。保留扩展目录中的 `.git`（若有），避免丢失仓库更新入口。

回退后重启、刷新，再恢复该版本升级前的配置备份。新版导出的备份不保证能由旧版读取；插件会拒绝比自身更新的备份。

安装脚本的代码备份保存在酒馆的 `backups/linghuashi/`。它不含完整账号数据，也不能替代作品备份。
