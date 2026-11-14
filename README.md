# 见微 · AI 可见度监测

基于 **DeepSeek 官方联网 API** 的本地监测工具：围绕关键词收集回答，提取公司名称，追踪检索、读取与引用来源，并用历史样本计算任意公司的出现率。

**一次查询，多次分析。** 更换公司或别名时直接复用已保存的回答，不必重新调用联网 API。

## 快速开始

安装 [Node.js](https://nodejs.org/) **22.13 或更高版本**，然后运行：

```bash
git clone https://github.com/bbykl/ai-visibility-monitor.git
cd ai-visibility-monitor
npm ci
npm start
```

打开 [http://127.0.0.1:5180](http://127.0.0.1:5180)：

1. 进入 **设置 → 连接你的 DeepSeek**，填写自己的 API Key，保存并验证连接。
2. 在 **关键词管理** 添加关键词，例如 `上海装修公司推荐`。
3. 点击 **新建查询**，选择关键词并开始查询。
4. 在 **查询记录** 阅读 Markdown 回答、查看公司名称和来源。
5. 在 **公司洞察** 输入公司名称，按关键词计算历史出现率；在 **来源洞察** 筛选检索、读取或引用记录。

可在 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 创建 API Key。需要账号可访问支持联网工具的 `deepseek-flash` 模型，调用费用由你自己的 DeepSeek 账户承担。项目不会自动执行首次查询，定时默认关闭。

## 功能

- **关键词独立采集**：相同关键词在同一任务中仅查询一次，无需绑定公司。
- **公司动态统计**：保存正文中出现的名称，支持别名合并与按关键词计算出现率。
- **来源追踪**：区分搜索召回、成功抓取、回答引用，保留引用片段和原始 SSE。
- **阅读体验**：Markdown 渲染、回答详情页签、桌面与窄屏布局。
- **本地运行**：SQLite 存储、串行队列、任务取消、可选定时、设置页配置密钥。

出现率 = 包含公司或别名的有效回答数 ÷ 有效回答数。只有回答完整结束且公司提取成功的样本进入分母；没有有效样本显示 `—`。名称使用完整名称或明确填写的别名匹配，每份回答最多计一次。正面、负面和中性提及均可记录，出现不代表推荐。

网页检索与读取由 DeepSeek 官方服务端执行，本项目保存工具响应；召回或引用不等于成功读取全文。公司提取是独立的模型请求，可能遗漏名称，可对照原始回答核实。重新提取使用已有回答，但会产生模型用量。

## 技术栈

| 部分 | 技术 |
| --- | --- |
| 运行环境 | Node.js 22.13+、ES Modules |
| HTTP 服务 | Express 5 |
| 数据库 | Node 内置 SQLite，WAL 模式 |
| AI 接入 | DeepSeek 官方 Messages API、原生 fetch、SSE |
| 前端 | 原生 JavaScript、HTML、CSS |
| Markdown | Marked、DOMPurify |
| 定时与测试 | node-cron、node:test |

无需 MySQL、Docker、浏览器登录或邮件配置。

## 目录

```text
public/                    前端页面、样式与 Markdown 渲染
src/
  server.js                HTTP 接口与本机访问校验
  config.js                运行配置
  credentials.js           本地密钥保存与状态管理
  providers/               DeepSeek API、SSE 解析
  jobs/                    队列、取消、定时
  analysis/                公司名称验证与来源整理
  storage/                 SQLite、迁移、动态统计
scripts/
  check-api.js             验证当前密钥
  backup.js                SQLite 在线备份
test/                      自动测试
.env.example               可选环境变量模板
data/                      本机数据与密钥，自动创建，不提交 Git
```

数据流程：**关键词 → 官方联网回答 → 公司名称提取与来源整理 → SQLite → 按关键词和公司计算统计**。公司选择只影响统计，不影响采集。

## 配置

直接启动后在设置页填写 API Key 即可，不需要创建 `.env`。也可以复制 `.env.example` 为 `.env`，或配置环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| DEEPSEEK_API_KEY | 空 | 可选，支持在设置页配置 |
| PORT | 5180 | 本机端口 |
| DATA_DIR | ./data | 数据目录 |
| QUERY_TIMEOUT_MS | 300000 | 单次 API 请求超时，毫秒 |

设置页保存的密钥优先于环境变量，保存后立即生效；移除后不会自动回退使用旧密钥。密钥以明文保存在本机 `data/credentials.json`，接口仅返回配置状态，不回显密钥。`.env`、`data/`、数据库及日志均已加入 `.gitignore`。使用自定义 `DATA_DIR` 时，请将它放在仓库外，或自行加入忽略规则。

本项目面向**单机本地使用**，仅监听 `127.0.0.1`，没有多用户登录与公网部署权限系统。备份和分享文件时请单独保管自己的密钥。

## 开发与维护

```bash
npm run dev         # 监听源码变化
npm test            # 运行测试，不产生真实 API 查询
npm run check-api   # 验证已配置的密钥
node scripts/backup.js
```

定时可以先保存。未配置 API Key 或没有启用的关键词时，页面显示等待配置，到点跳过，不创建失败任务，也不发起 API 请求。补齐配置后，从下一个计划时间自动执行，不补跑错过的轮次。本机服务需要保持运行。

任务串行执行，繁忙时跳过定时轮次；重启后不自动重放中断任务。删除关键词配置不会删除历史样本。`backup.js` 使用 SQLite 在线备份；运行中不要只复制 `.sqlite` 文件而忽略 WAL。

## 参考与许可证

- [DeepSeek Messages API](https://api-docs.deepseek.com/zh-cn/api/create-message/)
- [DeepSeek 联网工具](https://api-docs.deepseek.com/zh-cn/guides/web_tools/)

项目采用 [MIT License](LICENSE)。
