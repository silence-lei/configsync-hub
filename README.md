# ConfigSync — Obsidian 跨 Vault 配置同步插件

一次配置，多库生效。用一个**配置中枢（Hub）**保存 `.obsidian` 的权威副本，再分发到任意数量的 vault。

> 对应需求文档：《ConfigSync — Obsidian 跨 Vault 配置同步插件》需求文档 v1.0
> 当前实现范围：v0.1（MVP）+ 部分 v0.5 特性，见文末「实现范围」。

---

## 安装

**方式一：社区插件市场**（发布后可用）
`设置 → 第三方插件 → 社区插件市场 → 搜索 "ConfigSync Hub" → 安装并启用`。

**方式二：手动安装**
从 Releases 下载 `main.js`、`manifest.json`、`styles.css`，放进 `<vault>/.obsidian/plugins/configsync-hub/`，重启 Obsidian 后启用。

**方式三：BRAT**
装好 [BRAT](https://github.com/TfTHacker/obsidian42-brat)，用 `Add beta plugin` 填 `silence-lei/configsync-hub`。

> 注意：社区市场里另有一个同名插件 `config-sync`，与本插件无关。本插件的 id 是 `configsync-hub`。

---

## 快速开始（3 分钟）

1. **设置 Hub**：`设置 → ConfigSync → 中枢 Hub`，选择一个**不在任何 vault 内**的空目录（可放在网盘 / Syncthing 目录中）。
2. **初始化 Hub**：点「从当前库初始化 Hub」，把当前 vault 的配置（插件、主题、CSS 片段、快捷键等）推送到 Hub。
3. **添加目标库**：`目标库` Tab，从「本机 vault」里点「添加」，或手动指定路径；打开该行开关表示参与同步。
4. **同步**：命令面板执行 `ConfigSync: 同步配置到所有目标库`。

新 vault 想一键上车：装好本插件 → 设置 Hub 路径 → 命令 `ConfigSync: 从 Hub 拉取到当前库` → 重启 Obsidian。

---

## 同步模型

```
        ┌─────────────┐
        │  配置中枢 Hub │  manifest.json + config/ + backups/
        └──────┬──────┘
       push ↙   ↘ pull
   ┌────────┐  ┌────────┐  ┌────────┐
   │ Vault A│  │ Vault B│  │ Vault C│
```

- Hub 是唯一权威来源，vault 之间不直接互相同步；
- **单向分发**：Hub → Vault。双向同步与冲突处理不在 v0.1 范围内；
- **增量**：以 SHA-256 指纹比对，只复制变更文件；本地 `state.json` 缓存指纹，无变更时几乎不读文件内容。

---

## 同步内容（默认策略）

| 内容 | 默认 | 说明 |
| --- | --- | --- |
| 社区插件本体 `plugins/*/` | ✅ | 含 `main.js`、`manifest.json`、`styles.css` |
| 插件配置 `plugins/*/data.json` | ✅ | 可整类关闭，也可用排除规则单独处理 |
| 主题 `themes/*/` | ✅ | |
| CSS 片段 `snippets/*/` | ✅ | |
| 外观设置 `appearance.json` | ✅ | |
| 插件启用列表 `community-plugins.json` | ✅ | |
| 核心插件开关 `core-plugins.json` | ✅ | |
| 核心插件配置（根目录其余 `*.json`） | ✅ | 模板、日记、书签等 |
| 快捷键 `hotkeys.json` | ✅ | |
| 应用设置 `app.json` | ⬜ | 附件目录等可能因库而异 |
| 图谱样式 `graph.json` | ⬜ | |
| 工作区布局 `workspace*.json` | ❌ 永不 | 会导致窗口布局互相覆盖 |
| 本插件自身 `plugins/configsync-hub/` | ❌ 永不 | 各库同步目标不同 |

排除规则（同步内容 Tab）：

- **插件清单**：自动列出 Hub 与当前库里发现的全部插件，逐个开关，支持搜索与全选/全不选（默认全部同步）；
- **排除的插件**：填插件 id（如 `dataview`），整插件不参与同步（与上面的清单等效，任一处关闭都会排除）；
- **排除路径**：支持 `*` / `**` 通配，如 `plugins/*/data.json`、`themes/**/*.css`；
- **删除 Hub 中已不存在的目标文件**：默认关闭（只新增与覆盖，不删除）。

---

## 云同步（跨设备）

Hub 本身是本地目录，要在多台设备之间保持一致，就把它打包成快照 zip 放到云端：

```
设备 A：当前 vault → Hub → 云端快照      设备 B：云端快照 → Hub → 各个 vault
```

快照只有两个文件：`configsync-hub.zip`（Hub 的 `config/` + `manifest.json`）和同名 `.meta.json`（版本/时间/体积）。拉取前只比对 meta，版本一致就不下载。

| 平台 | 凭据 | 说明 |
| --- | --- | --- |
| GitHub | Personal Access Token（repo 权限） | 往私有仓库写文件，不需要本机装 git |
| GitLab | Access Token（api 权限） | 支持自托管实例 |
| Gitea | Access Token | 支持自建实例 |
| Google Drive | OAuth（自建 Client ID） | 默认放进 Drive 的隐藏应用数据空间 |
| OneDrive | OAuth（Azure 应用注册） | 存放在 OneDrive 应用根目录 |
| WebDAV | 账号 + 应用密码 | 坚果云、Nextcloud、ownCloud 等 |
| 本地目录 / 同步盘 | 无需凭据 | 网盘客户端的本地同步目录，由客户端上云 |

用法：`设置 → ConfigSync Hub → 云同步` → 新增远端 → 填凭据 → 「测试连接」→「推送到云端」。其他设备配置同一个远端，点「从云端拉取」即可。

- 可配置**多个远端**同时备份，也可以只启用其中一个；
- `启动时检查云端更新`、`推送到 Hub 后自动同步云端` 两个自动开关默认关闭；
- 拉取前会先把本地 Hub 打包备份到 `<Hub>/remote-backups/`（保留最近 5 份）；
- 版本一致时拉取是空操作；若本地 Hub 被改坏但版本号没变，用远端弹窗里的「强制拉取（忽略版本）」；
- ⚠️ 凭据以明文保存在插件的 `data.json` 里，不要在不受信任的设备上配置。

---

## 隐私与权限说明

### 文件系统访问（会读写 vault 之外的目录）

这是本插件的核心能力，也意味着它会**读写你 vault 之外的目录**，请知悉：

| 位置 | 行为 |
| --- | --- |
| 配置中枢 Hub 目录（你指定，通常在 vault 之外） | 读 + 写：存放 `config/` 权威副本、`backups/`、`exports/`、`remote-cache/`、`remote-backups/`、日志 |
| 其他 vault 的 `.obsidian/` | 读 + 写：按 Hub 内容覆盖（覆盖前自动备份） |
| 各个 vault 的 `.obsidian/configsync-hub-backups/` | 写：备份 zip |
| 各个 vault 的 `.obsidian/configsync-hub/state.json` | 写：增量同步指纹缓存 |
| Obsidian 全局注册表 `obsidian.json` | **只读**：用于自动发现本机已注册的 vault |

- **不会读取、复制或上传你的笔记正文**（`.md` 及附件），只处理 `.obsidian` 下的配置文件；
- 每次覆盖目标库之前都会先把它打包备份；
- 目录选择器会调用系统原生选择器（macOS `osascript` / Windows PowerShell / Linux `zenity`），仅在点击「浏览」时触发。

### 网络访问

**默认完全离线**：不配置云端远端时，本插件不发起任何网络请求，全部功能可用。

只有在「云同步」Tab 主动新增并启用远端后，才会向下列地址发起请求：

| 远端 | 会访问的地址 | 发送的内容 |
| --- | --- | --- |
| GitHub | `api.github.com` | PAT（Bearer）、快照 zip（base64）、meta |
| GitLab | `gitlab.com`（或你填的自建实例） | Access Token、快照 zip、meta |
| Gitea | `gitea.com`（或你填的自建实例） | Access Token、快照 zip、meta |
| Google Drive | `accounts.google.com`、`oauth2.googleapis.com`、`www.googleapis.com` | OAuth 授权码/token、快照 zip、meta |
| OneDrive | `login.microsoftonline.com`、`graph.microsoft.com` | OAuth 授权码/token、快照 zip、meta |
| WebDAV | **你自己填写的服务器地址** | 账号 + 应用密码（Basic）、快照 zip、meta |
| 本地目录 / 同步盘 | 无网络请求 | 仅本地文件写入 |

- 上传内容只有两个文件：`configsync-hub.zip`（Hub 的 `config/` + `manifest.json`）与 `configsync-hub.meta.json`，**不含笔记正文**；
- Google Drive / OneDrive 授权时会在本机 `127.0.0.1:53682`（可在远端配置里改）起一个**临时** HTTP 服务接收 OAuth 回调，拿到 token 后立即关闭；
- 凭据（token、WebDAV 密码、OAuth refresh token）以**明文**保存在插件的 `data.json` 里，请勿在不受信任的设备上配置；
- **没有遥测、没有统计、没有崩溃上报**；
- 想彻底断网：把「云同步」里的远端全部禁用或删除即可。

---

## 备份与恢复

- 每次覆盖目标库前，自动把它的 `.obsidian` 打包为 zip，存到 `<vault>/.obsidian/configsync-hub-backups/`；
- 默认保留最近 10 份，可在设置里调整；
- 一键恢复：恢复**前同样会先备份当前状态**；
- 恢复默认是「覆盖式」：只写回备份里的文件。若需要「时间点还原」（连备份之后新装的插件一起删除），打开 `备份与恢复 → 恢复时删除备份之后新增的文件`；
- 导出 / 导入 zip：用于分发配置或新库初始化（无 Hub 也能用）。

---

## 命令

| 命令 | 作用 |
| --- | --- |
| ConfigSync: 同步配置到所有目标库 | Hub → 所有已启用目标库 |
| ConfigSync: 从 Hub 拉取到当前库 | Hub → 当前打开的 vault |
| ConfigSync: 从当前库推送到 Hub | 当前 vault → Hub，配置版本号 +1 |
| ConfigSync: 预览与 Hub 的差异 | Dry-run，列出将写入的文件 |
| ConfigSync: 备份当前库配置 | 只备份，不同步 |
| ConfigSync: 从备份恢复当前库 | 选择历史备份 zip |
| ConfigSync: 把 Hub 推送到所有云端 | 快照上传到所有启用的远端 |
| ConfigSync: 从所有云端拉取 Hub | 从远端拉取快照覆盖本地 Hub |
| ConfigSync: 打开设置 | |

---

## 目录结构

**Hub**

```
<Hub>/
├── manifest.json      # 文件清单（路径 / sha256 / 大小 / mtime / 插件版本）
├── config/            # .obsidian 的权威副本
├── backups/           # 历次 manifest 归档
├── exports/           # 导出的配置 zip
├── remote-cache/      # 最近一次云端同步的 meta
├── remote-backups/    # 从云端拉取前的 Hub 备份
└── configsync-hub.log    # 同步日志
```

**每个 vault**

```
<vault>/.obsidian/
├── configsync-hub/state.json          # 上次同步版本与文件指纹
└── configsync-hub-backups/            # 带时间戳的备份 zip
```

---

## 开发

```bash
npm install
npm run dev        # esbuild watch，输出到 main.js
npm run build      # 类型检查 + 生产构建（minify）
npm run typecheck  # 仅类型检查
npm run lint       # 发布合规自检（Obsidian 红线 + 分层约束 + manifest 校验）
npm test           # 编译并运行单元测试（30 个用例）
```

发布（GitHub Actions 已配好 `.github/workflows/release.yml`）：

```bash
# 1. 同步三处版本号：manifest.json / package.json / versions.json
npm run lint && npm test && npm run build
git tag 0.2.3 && git push origin 0.2.3   # tag 必须与 manifest.json 的 version 完全一致，不带 v
```

Release 必须包含 `main.js`、`manifest.json`、`styles.css` 三个**独立**文件（源码压缩包不算）。首次提交社区市场时，仓库需为 public、含 README.md 与 LICENSE，且已发布（非草稿）Release。

安装到 vault 里实测：

```bash
npm run build && npm run install:vault -- "/path/to/vault"
# 不带参数执行会列出本机已注册的 vault 路径
```

代码分层：

| 目录 | 职责 | 是否依赖 Obsidian |
| --- | --- | --- |
| `src/core/` | 清单、规则、计划器、引擎、备份、zip、哈希 | ❌ 完全解耦，可单测 |
| `src/platform/` | Node fs、vault 注册表、日志、定时器、适配层 | 仅适配层 |
| `src/ui/` | 设置页六个 Tab、弹窗、目录选择器 | ✅ |
| `scripts/` | 安装脚本 `install:vault`、合规自检 `lint` | ❌ |
| `src/i18n/` | 中英文文案 | ❌ |

所有平台相关或内部 API（`FileSystemAdapter.getBasePath()`、`obsidian.json` 注册表、Electron 目录选择器）都集中在 `src/platform/`，内部 API 失效时只需改这一处。

**测试**覆盖：路径分类与排除规则、增量计划器、SHA-256（纯 TS 实现对拍 node crypto）、自研 zip 往返、以及用内存文件系统 + 真实文件系统跑的完整同步流程（对应验收用例 AC-01～AC-06）。

---

## 实现范围

### 已实现

- **FR-101~105** Hub 管理：任意目录设为 Hub、从当前库初始化、manifest（含插件版本）、原子写入、健康检查
- **FR-201~202/204** vault 发现（跨平台注册表 + 手动添加）、状态展示（一致 / 落后 / 不可用）
- **FR-301~303/308** 全量 / 单库同步、增量、失败隔离与汇总报告
- **FR-307** 同步前 Dry-run 预览
- **FR-501~505** 自动备份、保留策略、一键恢复、导出 / 导入 zip
- **FR-601~603** 类别开关、整插件排除、通配路径排除
- **FR-701~704** 六 Tab 设置页、9 条命令、结果通知与详情、同步日志
- **云同步** Hub 快照打包/解包、GitHub/GitLab/Gitea/Google Drive/OneDrive/WebDAV/本地目录、OAuth PKCE、启动检查
- **FR-304/305/306** 启动检查、自动推送（轮询 + 防抖）、定时同步
- **NFR** 原子写入、纯离线、i18n（中/英）、核心逻辑可单测

### 未实现（按需求文档的优先级排期）

- **FR-203** 目标库分组（P1）
- **FR-401~403** 双向同步与冲突处理（v1.x）
- **FR-604** 每库覆盖规则（P2）
- 移动端完整支持（v2.0）：移动端沙箱无法读写其他 vault，仅能用「导出 / 导入 zip」或把 Hub 放进同步文件夹后手动导入
- Hub 的版本树与任意版本回滚（开放问题 3）

### 已知限制

1. 若目标库正被另一个 Obsidian 窗口打开，Obsidian 可能缓存旧配置——同步后需重启该库；插件落地后会提示。
2. 部分插件的 `data.json` 含本机绝对路径，跨库后会失效，请用排除规则处理。
3. 自动发现注册表里的 vault 默认**不启用**，需手动打开开关，避免误写。
4. 插件文件（`main.js`）同步后不经过 Obsidian 自身的更新校验，建议配合 Obsidian 的插件更新机制使用。
5. 云端同步是**整包快照覆盖**，不是逐文件双向合并：两端都改过配置时，后拉取的一方会覆盖自己的 Hub。建议固定「一台设备改配置 → 推云端 → 其他设备拉取」的流程。

---

## 许可

[MIT](LICENSE) © silence-lei
