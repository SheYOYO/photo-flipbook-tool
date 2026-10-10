# 翻页音效来源与授权

## 来源

全部来自 **BigSoundBank**（https://bigsoundbank.com/），作者 **Joseph SARDIN**。

录音条件：**录音室**（SoundDevices MixPre-3 + Neumann KM184），48 kHz / 24 bit / 单声道，
"Realism: Realistic" —— 都是**真实纸页录音**，不是合成、不是 AI 生成。

## 授权

**CC0（public domain，公共领域等价）**：

- 免费、免版税、可商用
- 无需署名（署名只是礼貌，非义务）
- 可修改、可再分发
- 不需要注册账号、不需要申请许可

详见 https://bigsoundbank.com/licenses.html

## 入库文件

| 文件 | 原始名 / 编号 | 页面 | 时长 | 码率 | 大小 |
|---|---|---|---|---|---|
| `real_turn_short_0164.mp3` | turned-page / **0164** | https://bigsoundbank.com/detail-164-turned-page.html | **0.36 s** | 224 kbps | 10.9 KB |
| `real_turn_2215.mp3` | Pages that turn #8 / **2215** | https://bigsoundbank.com/detail-2215-pages-that-turn-8.html | **1.55 s** | 224 kbps | 46.2 KB |
| `real_turn_2211.mp3` | Pages that turn #4 / **2211** | https://bigsoundbank.com/pages-that-turn-4-s2211.html | 页面标 00:02 | 首帧 112 kbps（可能 VBR） | 75.2 KB |
| `real_turn_2212.mp3` | Pages that turn #5 / **2212** | — | 估 4.4 s | 128 kbps | 71.5 KB |

## 直链规律（以后要换音效直接拼）

```
https://bigsoundbank.com/UPLOAD/mp3/<编号>.mp3
https://bigsoundbank.com/UPLOAD/bwf-en/<编号>.wav     # BWF/WAV
https://bigsoundbank.com/UPLOAD/ogg/<编号>.ogg
https://bigsoundbank.com/UPLOAD/flac/<编号>.flac
```

按分类列出"纸/翻页"类：`https://bigsoundbank.com/search?CatID=PAPRHndl`
（UCS 分类 PAPRHndl。该分类里 `pages-that-turn-*` 系列的编号为 2209~2216、1413、0493、0362/0363、0164。）

## 下载注意事项（本机实测）

- 页面用 `?search=` 搜不准（返回的是全站随机编号）⇒ **要用 `?CatID=PAPRHndl` 分类页**再正则筛。
- 下载直链要带 `User-Agent`，且**先走环境里的 HTTP 代理、失败再直连**（本机沙箱代理 51889 可用）。
- 未下载的原格式还有 `bwf-en/*.wav`（24-bit）与 `ogg/`、`flac/`，需要无损时再取。
