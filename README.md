# Nai2API

Nai2API 是一个 Docker-ready 的 NovelAI 图片生成网关。它把 NovelAI 账号池封装成一个可管理的 Web/API 服务：管理员在后台添加 NovelAI Persistent API Token，发放 `STA1N-...` 用户密钥，用户可以在网页中生成图片，也可以把 `/generate` 图片直链接嵌入到脚本、网页或论坛模板里。

项目重点是“好部署、好管理、好嵌入”：支持卡密/密钥额度、账号负载、账号并发限制、排队、缓存、后台监控、迁移包导入导出，以及 `/data` 持久化。

## 功能

- 用户前台：`/`
- 管理后台：`/admin`
- 用户密钥：管理员直接生成 `STA1N-...`，无需用户二次开通
- 额度扣费：真实生成每次固定扣 `1` 点，失败会自动退回
- NovelAI 账号池：支持多个 Persistent API Token，按可用并发自动分配
- 并发控制：每个账号默认最多同时生成 `2` 个，可在系统设置调整
- 排队机制：网页生图可排队并显示状态；图片 URL 请求会等待，超过 60 秒返回“服务器繁忙”
- 图片缓存：同参数可命中缓存，避免重复扣费；后台可设置最大缓存数量、预览、搜索、清理
- 生成尺寸：仅保留横图、竖图、方图三种常用规格
- 步数策略：网页生成支持较高步数；`/generate` 图片 URL 请求会把步数限制到最高 `28`
- 嵌入代码：前台可一键复制完整 HTML 代码，适合通用 AI 插图脚本
- 数据迁移：后台一键导出/导入配置包；迁移包不包含任务记录和图片缓存
- 持久化：所有数据写入 `DATA_DIR`，Docker/Zeabur 推荐挂载到 `/data`

## 目录结构

```text
.
├─ public/              # 前台和后台静态页面
├─ server/              # Node.js 后端接口、NovelAI 适配、数据存储
├─ data/                # 本地持久化数据目录
├─ Dockerfile           # Zeabur / Docker 部署入口
├─ docker-compose.yml   # 本地 Docker Compose
├─ .env.example         # 环境变量示例
└─ README.md
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 服务监听端口。Zeabur 会注入 `PORT`，本项目默认也使用 8080。 |
| `HOST` | `0.0.0.0` | 服务监听地址。容器部署时需要监听 `0.0.0.0`。 |
| `ADMIN_TOKEN` | `123456` | 管理后台密码。正式部署必须改成强密码。 |
| `DATA_DIR` | `/data` | 数据存储目录。Docker/Zeabur 持久化时挂载这个目录。 |
| `NOVELAI_API_URL` | `https://image.novelai.net` | NovelAI 图片接口地址，通常不用改。 |
| `MOCK_WHEN_NO_ACCOUNT` | `true` | 没有账号时是否返回 mock 预览图。生产环境建议 `false`。 |
| `DIRECT_GENERATE_TIMEOUT_MS` | `60000` | `/generate` 图片 URL 请求最长等待时间，默认 60 秒。 |
| `ACCOUNT_INFLIGHT_TIMEOUT_MS` | `600000` | 账号并发占用超时保护，默认 10 分钟。 |

## 本地运行

### 方式一：Docker Compose

```bash
cp .env.example .env
docker compose up -d --build
```

访问：

```text
用户前台：http://localhost:8080/
管理后台：http://localhost:8080/admin
```

停止：

```bash
docker compose down
```

### 方式二：Node.js

需要 Node.js 20 或更高版本。

```bash
npm install
npm start
```

Windows 本地也可以直接运行：

```powershell
.\run-server.cmd
```

## 首次使用流程

1. 打开 `/admin`。
2. 输入 `ADMIN_TOKEN`，默认是 `123456`。
3. 在“NovelAI 账号池”中添加一个或多个 NovelAI Persistent API Token。
4. 在“发放 STA1N 密钥”里生成用户密钥，并设置额度。
5. 打开 `/`，填入 `STA1N-...` 用户密钥，点击“加载密钥”查看可用点数。
6. 填提示词和参数后生成图片。
7. 需要嵌入脚本时，复制前台生成的 HTML 嵌入代码。

## NovelAI 账号池

每个 NovelAI 账号都有自己的并发计数。系统会优先选择当前负载最低、最近使用时间更早的可用账号。

后台支持：

- 添加账号
- 启用/禁用账号
- 批量删除账号
- 导入/导出账号 token
- 查看成功/失败统计
- 重置监控数据
- 调整每个账号最高并发数

如果所有账号都达到并发上限：

- 网页生成会进入排队状态，并显示排队人数
- `/generate` 图片 URL 请求会挂起等待
- 图片 URL 请求超过 60 秒仍未生成，会返回“服务器繁忙，请稍后再试”的图片

## 尺寸

| 名称 | 分辨率 |
| --- | --- |
| 竖图 | `832 x 1216` |
| 横图 | `1216 x 832` |
| 方图 | `1024 x 1024` |

## 生成接口

### 图片直链

```text
GET /generate?token=STA1N-xxx&tag=1girl&size=竖图&steps=28&scale=6&cfg=0&sampler=k_dpmpp_2m_sde&negative=bad anatomy&nocache=0&noise_schedule=karras
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `token` | 用户密钥，必须是后台生成的 `STA1N-...` |
| `tag` | 用户提示词 |
| `artist` | 质量前缀或画师前缀 |
| `size` | `竖图`、`横图`、`方图` |
| `steps` | 生成步数。图片 URL 请求最高按 28 路由。 |
| `scale` | Prompt guidance scale |
| `cfg` | NovelAI rescale/cfg 相关参数 |
| `sampler` | 采样器 |
| `negative` | 负面提示词 |
| `nocache` | `0` 命中缓存，`1` 强制重画 |
| `noise_schedule` | 噪声调度，例如 `karras` |

### 嵌入 HTML 示例

```html
<div style="width: auto; height: auto; max-width: 100%; border: 8px solid transparent; background-image: linear-gradient(45deg, #FFC9D9, #CCE5FF); position: relative; border-radius: 16px; overflow: hidden; display: flex; justify-content: center; align-items: center; animation: gradientBG 3s ease infinite; box-shadow: 0 4px 15px rgba(204,229,255,0.3);"><div style="background: rgba(255,255,255,0.85); backdrop-filter: blur(5px); width: 100%; height: 100%; position: absolute; top: 0; left: 0;"></div><img src="https://your-domain.com/generate?tag=$1&token=STA1N-xxxxxx&model=nai-diffusion-4-5-full&artist=artist:ningen_mame,, noyu_(noyu23386566),, toosaka asagi,, location,\n20::best quality, absurdres, very aesthetic, detailed, masterpiece::,:,, very aesthetic, masterpiece, no text,&size=竖图&steps=28&scale=6&cfg=0&sampler=k_dpmpp_2m_sde&negative={{{{bad anatomy}}}},{bad feet},bad hands,{{{bad proportions}}},{blurry},cloned face,cropped,{{{deformed}}},{{{disfigured}}},error,{{{extra arms}}},{extra digit},{{{extra legs}}},extra limbs,{{extra limbs}},{fewer digits},{{{fused fingers}}},gross proportions,jpeg artifacts,{{{{long neck}}}},low quality,{malformed limbs},{{missing arms}},{missing fingers},{{missing legs}},mutated hands,{{{mutation}}},normal quality,poorly drawn face,poorly drawn hands,signature,text,{{too many fingers}},{{{ugly}}},username,watermark,worst quality&nocache=0&noise_schedule=karras" alt="生成图片" style="max-width: 100%; height: auto; width: auto; display: block; object-fit: contain; transition: transform 0.3s ease; position: relative; z-index: 1;"></div><style>@keyframes gradientBG {0% {background-image: linear-gradient(45deg, #FFC9D9, #CCE5FF);}50% {background-image: linear-gradient(225deg, #FFC9D9, #CCE5FF);}100% {background-image: linear-gradient(45deg, #FFC9D9, #CCE5FF);}}</style>
```

把 `https://your-domain.com` 换成你的域名，把 `STA1N-xxxxxx` 换成用户密钥即可。

## 管理 API

所有管理接口都需要请求头：

```text
x-admin-token: ADMIN_TOKEN
```

常用接口：

```text
GET    /api/health
GET    /api/settings
PUT    /api/settings
GET    /api/admin/summary
POST   /api/admin/users
PATCH  /api/admin/users
DELETE /api/admin/users
POST   /api/admin/accounts
PATCH  /api/admin/accounts/:id
DELETE /api/admin/accounts
POST   /api/admin/accounts/reset-stats
GET    /api/admin/accounts/export
POST   /api/admin/accounts/import
GET    /api/admin/images
DELETE /api/admin/images
GET    /api/admin/export
POST   /api/admin/import
POST   /api/jobs
GET    /api/jobs/:id
```

## 数据存储

Nai2API 使用 JSON 元数据 + 图片文件的方式存储，默认路径：

```text
/data/library.json
/data/images/
```

`library.json` 包含：

- 系统设置
- 用户密钥和余额
- 卡密
- NovelAI 账号池
- 最近任务
- 图片缓存元数据
- 操作流水

真实图片文件存放在 `/data/images/`。这样高并发生成时不会把图片 base64 全部写进一个巨大的 JSON 文件，部署在 Zeabur 这类平台时更稳定。

Docker Compose 已经挂载：

```yaml
volumes:
  - ./data:/data
```

所以本地重建容器不会丢失数据。

## 数据迁移包

后台“一键打包导出”用于迁移配置，不用于备份图片缓存。

迁移包包含：

- 系统设置
- 卡密
- 用户密钥和余额
- NovelAI 账号池

迁移包不包含：

- 最近任务记录
- 图片缓存
- 操作流水

如果你要完整备份图片缓存，需要直接备份整个 `/data` 目录，或者在服务器层面对 `/data` Volume 做备份。

## 部署到 Zeabur

Zeabur 官方文档说明：GitHub 集成可以直接从 GitHub 部署代码，并且 push 后会自动重新部署；项目根目录存在 `Dockerfile` 时，Zeabur 会按 Dockerfile 构建；环境变量在服务的 Variables 页面设置；需要持久化数据时，在服务的 Volumes 页面挂载目录。

### 1. 准备仓库

把本项目推送到 GitHub。仓库根目录需要包含：

```text
Dockerfile
package.json
server/
public/
```

`data/` 可以保留空目录，也可以不上传真实生产数据。不要把你的 NovelAI token 或 `.env` 提交到 GitHub。

Docker 镜像不会复制本地 `data/` 目录。Zeabur 构建阶段只需要代码，运行阶段再把 Volume 挂载到 `/data`。

### 2. 创建 Zeabur 服务

1. 登录 Zeabur。
2. 创建 Project。
3. 添加 Service。
4. 选择 GitHub。
5. 授权并选择你的 Nai2API 仓库。
6. Zeabur 检测到 `Dockerfile` 后会用 Dockerfile 构建。
7. 等待构建完成。

### 3. 配置环境变量

进入服务的 Variables 页面，添加：

```env
ADMIN_TOKEN=换成强密码
DATA_DIR=/data
HOST=0.0.0.0
NOVELAI_API_URL=https://image.novelai.net
MOCK_WHEN_NO_ACCOUNT=false
DIRECT_GENERATE_TIMEOUT_MS=60000
```

`PORT` 通常不需要手动设置，Zeabur 会为服务注入端口变量；本项目 Dockerfile 默认暴露 `8080`。

### 4. 挂载持久化 Volume

进入服务的 Volumes 页面：

```text
Volume ID: data
Mount Directory: /data
```

这一步很重要。Nai2API 的数据库文件在 `/data/library.json`，图片缓存文件在 `/data/images/`，不挂载 Volume 的话，服务重启或重新部署后数据可能回到初始状态。

注意：Zeabur 官方文档提示，挂载 Volume 后服务会变成有状态服务，重启时不能使用零停机切换，会有短暂中断；另外，挂载时目标目录会被清空，所以如果里面已有重要数据，需要先导出或备份。

### 5. 绑定域名

在 Zeabur 服务的 Domains / Networking 页面添加域名。拿到域名后：

```text
用户前台：https://你的域名/
管理后台：https://你的域名/admin
图片接口：https://你的域名/generate
```

如果你在前台复制嵌入代码，记得确认生成 URL 使用的是公网域名，而不是 `localhost:8080`。

### 6. 迁移本地数据到 Zeabur

推荐方式：

1. 本地打开 `/admin`。
2. 点击“一键打包导出”。
3. Zeabur 部署完成后，打开线上 `/admin`。
4. 在数据迁移区域导入这个 JSON。

这种方式会迁移密钥、余额、卡密、账号池和设置，但不会迁移图片缓存。

如果你确实要迁移图片缓存：

1. 停止本地服务，确保 `data/` 不再写入。
2. 备份本地整个 `data/` 目录。
3. 通过 Zeabur 文件管理或其他服务器文件方式上传到 `/data/library.json` 和 `/data/images/`。
4. 重启服务。

### 7. 上线后检查

打开：

```text
https://你的域名/api/health
```

正常会返回类似：

```json
{
  "ok": true,
  "service": "Nai2API",
  "users": 0,
  "enabledAccounts": 0,
  "cards": 0,
  "adminConfigured": true
}
```

然后进入 `/admin` 添加 NovelAI 账号，生成 `STA1N-...` 用户密钥，再到前台测试生成。

## 安全建议

- 生产环境一定要修改 `ADMIN_TOKEN`。
- 不要把 `.env`、`data/library.json`、NovelAI token 提交到公开仓库。
- Zeabur 上把敏感配置放在 Variables，不写进代码。
- 定期导出迁移包，或备份整个 `/data` 目录。
- `MOCK_WHEN_NO_ACCOUNT=false`，避免线上没有账号时仍返回 mock 图。

## Zeabur 参考文档

- Dockerfile 部署：https://zeabur.com/docs/zh-CN/deploy/methods/dockerfile
- GitHub 集成：https://zeabur.com/docs/en-US/deploy/methods/github-integration
- 环境变量：https://zeabur.com/docs/en-US/deploy/config/environment-variables
- Volumes 持久化：https://zeabur.com/docs/en-US/data-management/volumes
