# game-market-report

从飞书电子表格自动读取腾讯和字节的小游戏、手游广告消耗排名数据，生成可视化飞书卡片报告并发送。

## 功能

- 自动读取飞书电子表格最新一期数据（自动识别最新标签页）
- LLM 解析非结构化表格，提取 4 类报告数据：
  - **腾讯小游戏** — 腾讯微小消耗排名
  - **字节小游戏** — 字节微信系 + 抖音小游戏消耗排名
  - **腾讯手游** — 腾讯 APP 游戏消耗排名
  - **字节手游** — 字节 APP 游戏消耗排名
- 自动搜索游戏链接和类型标签，三级来源优先级：
  - 小游戏：应用宝（wx 前缀）
  - 手游：应用宝（com.xxx）→ TapTap → AppStore
- 手游类型标签通过 LLM 归一化为标准分类（角色扮演、策略、休闲等 16 类）
- 原始标签记录到数据库（game_tags 表），供模型学习优化
- 搜索时自动去标点匹配 + 用官方名称展示（如"次神光之觉醒"→"次神：光之觉醒"）
- 生成包含饼图、分页表格、总结分析的飞书卡片消息
- 定时任务（默认每周五 10:00）+ 手动触发 + HTTP API 触发
- Web Dashboard 查看发送记录、管理发送目标、多维度筛选、重发卡片
- SQLite 持久化所有发送记录和游戏标签历史

## 项目结构

```
├── index.js            # 入口：启动 Web 服务 + 定时任务
├── cli.js              # CLI 手动触发
├── config.js           # 配置（从 .env 加载凭证）
├── feishu-api.js       # 飞书 HTTP 客户端（tenant_access_token 自动管理）
├── feishu-reader.js    # 飞书表格读取（wiki 解析、标签页列表、读取数据）
├── llm-parser.js       # Claude LLM 解析表格数据（腾讯/字节 × 小游戏/手游）
├── game-cache.js       # 游戏信息缓存 + 应用宝/TapTap/AppStore 搜索 + 标签归一化
├── card-generator.js   # 调用卡片生成脚本
├── card-sender.js      # 飞书卡片发送（支持多目标）
├── send-targets.js     # 发送目标管理
├── report-pipeline.js  # 完整 pipeline 编排
├── scheduler.js        # node-cron 定时任务
├── server.js           # Express API + 静态页面
├── db.js               # SQLite 数据库（sql.js）— 发送记录 + 游戏标签历史
├── scripts/
│   ├── generate_tencent_card.js      # 腾讯小游戏卡片生成
│   ├── generate_bytedance_card.js    # 字节小游戏卡片生成
│   ├── generate_tencent_app_card.js  # 腾讯手游卡片生成
│   └── generate_bytedance_app_card.js # 字节手游卡片生成
├── .env                # 飞书应用凭证（不提交）
└── game-cache.json     # 游戏链接/类型缓存（按 _minigame/_app 分类）
```

## 配置

创建 `.env` 文件：

```env
FEISHU_APP_ID=your_app_id
FEISHU_APP_SECRET=your_app_secret
```

飞书应用需要以下权限：
- `wiki:node:read` — 读取 Wiki 节点
- `sheets:spreadsheet:read` — 读取电子表格
- `sheets:spreadsheet.meta:read` — 读取表格元信息
- `im:message` — 发送消息

还需要设置 `ANTHROPIC_API_KEY` 环境变量供 Claude API 使用。如果使用代理，还需设置 `ANTHROPIC_BASE_URL`：

```env
ANTHROPIC_API_KEY=sk-xxx
ANTHROPIC_BASE_URL=https://your-proxy.com/
```

## 启动服务

```bash
npm install
npm start
```

启动后：
- 管理页面：http://localhost:3456
- API 基地址：http://localhost:3456/api
- 定时任务：每周五 10:00 自动执行（可在 `.env` 中通过 `CRON_SCHEDULE` 修改）

## CLI 手动触发

```bash
# 全部报告（4 类）
node cli.js --type all

# 默认（全部 4 类报告）
npm run trigger

# 单个报告类型
node cli.js --type tencent          # 腾讯小游戏
node cli.js --type bytedance        # 字节小游戏
node cli.js --type tencent_app      # 腾讯手游
node cli.js --type bytedance_app    # 字节手游

# 指定标签页（默认自动读取最新）
node cli.js --type all --sheet "4.6-4.12"

# 指定发送给个人
node cli.js --type all --user-id ou_xxx

# 指定发送到群聊
node cli.js --type tencent --chat-id oc_xxx

# 组合使用
node cli.js --type tencent_app --sheet "4.6-4.12" --user-id ou_xxx

# 从历史报告初始化游戏缓存
npm run init-cache
```

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/records` | 发送记录列表（支持 type/status/dateFrom/dateTo/dateRange/targetType/target/page 筛选） |
| GET | `/api/records/:id` | 记录详情 |
| POST | `/api/records/:id/resend` | 重发卡片 |
| POST | `/api/trigger` | 触发 pipeline（body: `{types, userId, chatId}`） |
| GET | `/api/cache` | 游戏缓存列表 |
| PUT | `/api/cache/:name` | 更新缓存条目（body: `{link, type, category}`） |
| GET | `/api/targets` | 发送目标列表 |
| POST | `/api/targets` | 添加发送目标（body: `{type, target, name}`） |
| PUT | `/api/targets/:id` | 更新发送目标 |
| DELETE | `/api/targets/:id` | 删除发送目标 |

## 数据库

使用 sql.js（WASM SQLite），数据文件位于 `data/reports.db`。

### send_records — 发送记录

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 自增主键 |
| created_at | TEXT | 创建时间 |
| date_range | TEXT | 数据日期范围 |
| report_type | TEXT | 报告类型（tencent/bytedance/tencent_app/bytedance_app） |
| status | TEXT | 发送状态（success/failure） |
| error_msg | TEXT | 错误信息 |
| card_json | TEXT | 卡片 JSON |
| input_json | TEXT | 输入数据 JSON |
| message_id | TEXT | 飞书消息 ID |
| send_target | TEXT | 发送目标 JSON |

### game_tags — 游戏标签历史

记录每次搜索获取的原始标签，供模型学习优化归一化能力。

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 自增主键 |
| created_at | TEXT | 创建时间 |
| game_name | TEXT | 游戏名称 |
| category | TEXT | 类别（app/minigame） |
| source | TEXT | 来源（yyb/taptap/appstore） |
| link | TEXT | 游戏链接 |
| raw_type | TEXT | 原始类型标签 |
| norm_type | TEXT | 归一化后的标签 |

## 技术栈

- Node.js + Express
- Claude API (`claude-sonnet-4-6`) — 表格数据解析 + 游戏类型标签归一化
- 飞书 Open API — 读表格、发卡片
- sql.js (WASM SQLite) — 发送记录 + 游戏标签历史持久化
- node-cron — 定时调度
- 应用宝 / TapTap / AppStore iTunes API — 游戏链接和类型搜索
