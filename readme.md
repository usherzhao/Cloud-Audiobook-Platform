# 🎧 云端听书 (Cloud Audiobook Platform)

基于 Cloudflare 全家桶 (Workers + R2 + Durable Objects SQLite + KV) 和 Vue 3 构建的轻量级、无服务器在线有声小说/播客平台。**纯静态页面驱动 + 零服务器运维成本**。

---

## 📋 项目概览

- **无服务器架构**：基于 Cloudflare Workers，全球边缘节点极速响应
- **高效存储**：利用 R2 对象存储实现低成本、高可用的音频流服务
- **完整功能**：从内容管理到用户体验，提供一站式有声书解决方案
- **安全可靠**：前后台分离设计，严格的 Token 鉴权机制

> ⚠️ 注意：由于本项目依赖 R2 存储桶、KV 命名空间和 Durable Objects，点击"一键部署"后，您仍需要在 Cloudflare 控制台中手动完成这些资源的创建和绑定。**强烈建议使用下方提供的「命令行部署」步骤进行完整部署。**

---

## ✨ 核心特性

- **☁️ 纯 Serverless 架构**：后端零服务器运维，依托 Cloudflare 全球边缘节点，极致极速响应
- **📦 R2 流式对象存储**：支持大文件音频边下边播的流式缓冲，便宜且高可用
- **🔐 严格的前后台分离与 Token 鉴权**：
  - 前台纯读者模式，专注听书体验
  - 独立超管后台（KV 存储凭证 + 密码 MD5 单向加密），采用 Bearer Token 全局 API 拦截校验，极其安全
- **🚀 海量章节自动分页与动态排序**：
  - 支持正序/倒序/默认等多种排序规则，后端智能 LIMIT/OFFSET 分页加载，十万集也不卡顿
  - 独创**智能断点定位算法**：恢复播放历史时，自动计算该集在当前排序下的页码并跳转
- **📂 文件夹自动序号化断点续传**：后台支持选中本地文件夹自动识别音频，基于"时间戳自然序号"上传。即使网络中断，再次点击即可**无缝断点续传**剩余文件，绝不乱序
- **⏭️ 本地记忆自定义跳过**：用户可单独自定义每本书的「跳过片头/跳过片尾」时长并持久化保存在浏览器，实现沉浸式无缝连播
- **🗄️ 强大的单集资源管理**：在后台可以轻松对某个单集章节进行标题重命名，或直接彻底删除指定的音频记录及 R2 实体文件

---

## 🛠️ 技术栈

| 分类 | 技术 | 说明 |
|------|------|------|
| 前端 | Vue 3 (Composition API) + Tailwind CSS | 双文件结构：public/index.html (读者前台) 和 public/admin.html (超管后台) |
| 后端 | Cloudflare Workers | 核心 API 路由、Token 鉴权与业务逻辑 |
| 数据库 | Cloudflare Durable Objects (内置 SQLite) | 存储播放历史、用户数据和书籍元信息 |
| 存储 | Cloudflare R2 | 音频文件存储，支持流式访问 |
| 键值对 | Cloudflare KV | 存储超管凭证和配置信息 |

---

## 🚀 命令行部署指南 (推荐)

请确保您已安装 Node.js，并全局安装了 Cloudflare 的命令行工具 wrangler (`npm i -g wrangler`)。

### 1. 克隆项目并安装依赖

```bash
git clone https://github.com/你的GitHub用户名/你的仓库名.git
cd 你的仓库名
npm install
```

### 2. 创建 R2 存储桶

```bash
npx wrangler r2 bucket create audiobooks
```

### 3. 创建 KV 命名空间

```bash
npx wrangler kv namespace create ADMIN_KV
```

执行完毕后，终端会输出一段类似 `[[kv_namespaces]]` 的配置，请将其**复制并替换项目根目录 wrangler.toml 文件末尾的对应部分**。

### 4. 设置超级管理员密码

超管账号默认用户名为 `admin`。请为超管设置密码。

> **注意：为了系统安全，必须存入密码的 MD5 小写哈希值**
> *(例如：密码 admin123 的 MD5 值是 0192023a7bbd73250516f069df18b500)*

```bash
# 设置超管密码 (请将下面最后的MD5值替换为你自己密码的MD5值)
npx wrangler kv key put --binding=ADMIN_KV "admin_password" "0192023a7bbd73250516f069df18b500"

# (可选) 如果想修改超管默认的用户名，也可以执行：
# npx wrangler kv key put --binding=ADMIN_KV "admin_username" "你的超管用户名"
```

### 5. 一键发布到线上

```bash
npx wrangler deploy
```

发布成功后，访问 Wrangler 提供的 .workers.dev 域名即可进入读者前台；在链接后加上 `/admin.html` 即可进入超管管理后台。

---

## 💻 本地开发调试

项目内置了极为强悍的 Mock 数据降级机制。即使未连接网络或后端出差错，也可打开前端页面预览 UI 和音频控制逻辑。

进行全栈联调：

```bash
# 本地模拟 Worker、R2、KV 和 SQLite 完整运行环境
npx wrangler dev
```

> 注意：本地调试环境超管登录时，若未在本地 KV 重新配置密码，系统默认校验的密码为 `admin123`

---

## 📁 目录结构

```
.
├── public/
│   ├── index.html        # 读者前台应用 (书架、播放器、分页、排序)
│   └── admin.html        # 超管后台应用 (断点续传、账号管理、单集删除/编辑)
├── src/
│   └── worker.js         # API 路由拦截、Token 鉴权与 DO SQLite 逻辑
├── wrangler.toml         # Cloudflare 核心环境绑定配置
├── package.json          # Node 依赖配置
└── README.md             # 说明文档
```

---

## 📜 许可证

本项目采用 [MIT License](https://opensource.org/licenses/MIT) 开源协议。
