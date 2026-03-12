# 🎧 云端听书 (Cloud Audiobook Platform)

基于 Cloudflare 全家桶 (Workers + R2 + D1 / Durable Objects SQLite + KV) 和 Vue 3 构建的轻量级、无服务器在线有声小说/播客平台。**纯静态页面驱动 + 零服务器运维成本**。

最新版本全面升级了数据访问层，支持通过配置文件在 **Cloudflare D1 (Serverless SQL)** 和 **Durable Objects (SQLite)** 之间无缝、自由切换！

## 📋 项目概览

* **无服务器架构**：基于 Cloudflare Workers，全球边缘节点极速响应。
* **高效存储**：利用 R2 对象存储实现低成本、高可用的音频流服务。
* **双数据库引擎**：独创数据库适配器模式，一行配置即可在 D1 数据库与 DO (SQLite) 之间热切换。
* **安全可靠**：前后台分离设计，独立管理员入口，极其严格的 Token API 鉴权机制。

## ✨ 核心特性

* **☁️ 纯 Serverless 架构**：后端零服务器运维，依托 Cloudflare 全局网络。
* **📦 R2 流式对象存储**：支持大文件音频边下边播的流式缓冲。
* **🔀 双数据库热切换 (New\!)**：通过 wrangler.toml 中的 DB\_TYPE 环境变量，自由选择最适合你业务体量的数据库引擎 (D1 或 DO)。
* **🔐 严格的前后台分离与鉴权**：
  * 前台纯读者模式，专注听书体验。
  * 独立超管后台（KV 存储凭证 \+ 密码 MD5 单向加密），采用 Bearer Token 全局 API 拦截校验。
* **🚀 海量章节自动分页与动态排序**：后端智能 LIMIT/OFFSET 分页加载，独创**智能断点定位算法**，十万集也不卡顿。
* **📂 文件夹自动序号化断点续传**：后台支持选中本地文件夹批量上传音频，基于"时间戳自然序号"算法，即使网络中断，再次点击即可**无缝断点续传**剩余文件，绝不乱序。
* **⏭️ 本地记忆自定义跳过**：用户可单独自定义每本书的「跳过片头/跳过片尾」时长并持久化保存在浏览器，实现沉浸式无缝连播。

## 🛠️ 技术栈

| 分类 | 技术 | 说明 |
| :---- | :---- | :---- |
| **前端** | Vue 3 (Composition API) \+ Tailwind CSS | 双文件结构：public/index.html (读者) 和 public/admin.html (后台) |
| **后端** | Cloudflare Workers | 核心 API 路由、Token 鉴权与业务逻辑 |
| **数据库** | Cloudflare D1 / Durable Objects | 存储播放历史、用户数据和书籍元信息 (双擎可选) |
| **存储** | Cloudflare R2 | 音频文件存储，支持跨域流式访问 |
| **键值对** | Cloudflare KV | 存储超管凭证 |

## 🚀 部署指南

请确保您已安装 Node.js，并全局安装了 Cloudflare 的命令行工具 wrangler (npm i \-g wrangler)。

### 1. 克隆项目并安装依赖

```bash
git clone <你的仓库地址>
cd <你的仓库目录>
npm install
```

### 2. 创建所需资源 (R2 & KV)

```bash
# 创建 R2 存储桶
npx wrangler r2 bucket create audiobooks

# 创建 KV 命名空间用于存储超管账号
npx wrangler kv namespace create ADMIN_KV
```

*请将终端输出的 KV id 复制到 wrangler.toml 对应的配置中。*

### 3. 配置超级管理员账号

为了安全，请为超管设置密码（**必须存入密码的 MD5 小写哈希值**）。

*(例如：密码 admin123 的 MD5 值是 0192023a7bbd73250516f069df18b500)*

```bash
npx wrangler kv key put --binding=ADMIN_KV "admin_password" "0192023a7bbd73250516f069df18b500"
# (可选) 设置超管用户名，默认是 admin
# npx wrangler kv key put --binding=ADMIN_KV "admin_username" "你的超管用户名"
```

### 4. 数据库设置 (以 D1 为例)

本项目推荐使用全新的 D1 数据库：

```bash
# 1. 创建 D1 数据库
npx wrangler d1 create audiobooks-db
```

*请将终端输出的 database\_id 复制到 wrangler.toml 中的 \[\[d1\_databases\]\] 配置下。*

```bash
# 2. 初始化数据库表结构 (请确保项目根目录下有 schema.sql 文件)
npx wrangler d1 execute audiobooks-db --remote --file=./schema.sql
```

**如何切换回 Durable Objects？**

打开 wrangler.toml，将 \[vars\] 下的 DB\_TYPE 值改为 "DO"，并确保底部解开了 Durable Objects 和 migrations 的相关注释配置即可。

### 5. 一键发布到线上

```bash
npx wrangler deploy
```

发布成功后，访问 Wrangler 提供的 .workers.dev 域名即可进入读者前台；在链接后加上 /admin.html 即可进入超管管理后台。

## 💻 本地开发调试

进行全栈联调：

```bash
# 本地模拟 Worker、R2、D1、KV 和 SQLite 完整运行环境
npx wrangler dev
```

*(注意：首次本地调试时，建议先执行 `npx wrangler d1 execute audiobooks-db --local --file=./schema.sql` 初始化本地 D1 数据库。本地超管默认账号密码为 admin / admin123)*

## 📁 目录结构

```
.
├── public/
│   ├── index.html        # 读者前台应用 (书架、播放器、分页、排序)
│   └── admin.html        # 超管后台应用 (批量上传、账号管理、单集管理)
├── src/
│   ├── db/
│   │   ├── d1.js         # D1 数据库操作适配器
│   │   └── do.js         # Durable Objects 数据库操作类
│   └── worker.js         # 主入口文件，动态数据库路由拦截
├── schema.sql            # D1 数据库初始化表结构脚本
├── wrangler.toml         # Cloudflare 核心环境绑定与环境变量配置
└── package.json          # Node 依赖配置
```

## 📜 许可证

本项目采用 [MIT License](https://opensource.org/licenses/MIT) 开源协议。
