# OpenAI 格式调用说明

这份文档教你用 OpenAI 兼容格式调用 Nai2API。会用复制粘贴就能上手。

## 1. 你需要准备

- 服务地址：例如 `https://your-domain.com`
- 用户密钥：后台发放的 `STA1N-...`
- 调用路径：`/v1/chat/completions`

请求头固定这样写：

```http
Authorization: Bearer STA1N-xxxxxx
Content-Type: application/json
```

`STA1N-xxxxxx` 换成你的真实用户密钥。

## 2. 支持的接口

### 查看模型

```http
GET /v1/models
```

会返回可用模型列表。模型名里可以带分辨率和采样器。

常用模型：

```text
nai-diffusion-4-5-full:k_dpmpp_2m_sde
[2K]nai-diffusion-4-5-full:k_dpmpp_2m_sde
[4K]nai-diffusion-4-5-full:k_dpmpp_2m_sde
```

### 生成图片

```http
POST /v1/chat/completions
```

返回内容是 Markdown 图片链接，可以直接展示或解析图片地址。

## 3. 扣费和尺寸

| 模型前缀 | 扣费 | 竖图 | 横图 | 方图 |
| --- | ---: | --- | --- | --- |
| 无前缀 | `1` 点 | `832x1216` | `1216x832` | `1024x1024` |
| `[2K]` | `15` 点 | `1088x1600` | `1600x1088` | `1344x1344` |
| `[4K]` | `25` 点 | `1344x1984` | `1984x1344` | `1728x1728` |

步数固定为 `28`，请求里写步数也不会改变实际步数。

## 4. 消息格式

最后一条 `user` 消息必须按下面格式写。

```text
提示词:1girl, silver hair, blue eyes
画师串:artist:ningen_mame,, noyu_(noyu23386566),,
尺寸:竖图
提示词引导值:6
缩放引导值:0
负面提示词:bad anatomy, bad hands, text, watermark
采样器:k_dpmpp_2m_sde
```

必须保留这些字段行：

| 字段 | 是否必填 | 说明 |
| --- | --- | --- |
| `提示词` | 是 | 你想画什么 |
| `画师串` | 否 | 可以留空，但这一行要保留 |
| `尺寸` | 是 | `竖图`、`横图`、`方图` |
| `提示词引导值` | 是 | 常用 `6` |
| `缩放引导值` | 是 | 常用 `0` |
| `负面提示词` | 否 | 可以留空，留空会用后台默认负面词 |
| `采样器` | 否 | 不写时用模型名或后台默认采样器 |

缺字段会返回 `400`：`请求格式错误，请参考群内使用指南`。

## 5. 非流式示例

```bash
curl https://your-domain.com/v1/chat/completions \
  -H "Authorization: Bearer STA1N-xxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "[2K]nai-diffusion-4-5-full:k_dpmpp_2m_sde",
    "messages": [
      {
        "role": "user",
        "content": "提示词:1girl, silver hair, blue eyes\n画师串:artist:ningen_mame,, noyu_(noyu23386566),,\n尺寸:竖图\n提示词引导值:6\n缩放引导值:0\n负面提示词:bad anatomy, bad hands, text, watermark\n采样器:k_dpmpp_2m_sde"
      }
    ]
  }'
```

成功后会得到类似：

```json
{
  "choices": [
    {
      "message": {
        "content": "![生成图片](https://your-domain.com/api/images/xxx/content)"
      }
    }
  ]
}
```

## 6. 流式示例

加上 `"stream": true`：

```bash
curl https://your-domain.com/v1/chat/completions \
  -H "Authorization: Bearer STA1N-xxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nai-diffusion-4-5-full:k_dpmpp_2m_sde",
    "stream": true,
    "messages": [
      {
        "role": "user",
        "content": "提示词:1girl, silver hair\n画师串:\n尺寸:竖图\n提示词引导值:6\n缩放引导值:0\n负面提示词:\n采样器:k_dpmpp_2m_sde"
      }
    ]
  }'
```

流式会先返回排队和生成进度文本，最后返回 Markdown 图片链接，并以 `data: [DONE]` 结束。

## 7. 用 `nai` 对象覆盖参数

`messages` 仍然要按格式写。`nai` 里的字段优先级更高，适合程序调用。

```json
{
  "model": "[4K]nai-diffusion-4-5-full:k_dpmpp_2m_sde",
  "messages": [
    {
      "role": "user",
      "content": "提示词:1girl\n画师串:\n尺寸:竖图\n提示词引导值:6\n缩放引导值:0\n负面提示词:\n采样器:k_dpmpp_2m_sde"
    }
  ],
  "nai": {
    "tag": "1girl, silver hair, blue eyes",
    "artist": "artist:ningen_mame,, noyu_(noyu23386566),,",
    "size": "竖图",
    "scale": 6,
    "cfg": 0,
    "negative": "bad anatomy, bad hands, text, watermark",
    "sampler": "k_dpmpp_2m_sde",
    "nocache": "1",
    "noise_schedule": "karras"
  }
}
```

## 8. 常见错误

| 错误 | 原因 | 解决 |
| --- | --- | --- |
| `401 missing API key` | 没写 Bearer 密钥 | 加上 `Authorization: Bearer STA1N-...` |
| `密钥无效或已被禁用` | 用户密钥不对或被禁用 | 换一个有效 `STA1N-...` |
| `请求格式错误` | `messages` 没按字段模板写 | 按第 4 节模板补齐字段 |
| `用户额度不足` | 用户密钥点数不够 | 充值或换密钥 |
| `NovelAI账号点数不足` | 后台账号池没有足够点数 | 补充可用 NovelAI 账号 |
| `all NovelAI accounts are busy` | 后台账号都在忙 | 稍后重试 |
| `direct generate timeout` | 生成超时 | 稍后重试，或检查代理/账号状态 |

## 9. 最小可用模板

把域名和密钥换掉即可：

```json
{
  "model": "nai-diffusion-4-5-full:k_dpmpp_2m_sde",
  "messages": [
    {
      "role": "user",
      "content": "提示词:1girl, cute face\n画师串:\n尺寸:竖图\n提示词引导值:6\n缩放引导值:0\n负面提示词:\n采样器:k_dpmpp_2m_sde"
    }
  ]
}
```

请求地址：

```text
https://your-domain.com/v1/chat/completions
```

请求头：

```text
Authorization: Bearer STA1N-xxxxxx
Content-Type: application/json
```
