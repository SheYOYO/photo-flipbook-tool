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

---

## ★ R32（2026-10-14）换音：改用 0164，并做时间拉伸

### 他怎么选的（过程记下来，免得下次从头再来）

1. 第一批给了 A–E（都是"真实翻书声"：2215 现用 / 0363 慢翻厚纸 / 2213 / 2216 / 2211）
   ⇒ **全部否决**。
2. 第二批换方向，给 F–J（**不再限定真实翻书声**：柔whoosh 1799/1800/1802、
   轻软纸 2214、极轻纸响 **0164**）⇒ 他选 **J（0164）**：
   「声音可以，音高也可以，但是**时间太短**」。
3. I 也做了合成版（N/O/P，滤波噪声+包络+简易混响），他听完明确否掉：
   「不要合成的，效果太差了」。⇒ **合成路线作废，别再试**。
4. 把 0164 拉伸成 K/L/M（1.0 / 1.15 / 1.44s，**音高不变**）⇒ 他选 **K（1.0s）**。

### 入库文件

| 文件 | 原始名 / 编号 | 原时长 | 处理后 | 大小 |
|---|---|---|---|---|
| `flip.mp3` | turned-page / **0164** | **0.63 s** | **0.97 s**（拉伸 ×0.63，音高不变） | 24 KB / 192 kbps |

旧文件留档：`flip.mp3.bak-before-r32`（2215 原版，1.55s / 46KB）。

### 拉伸是怎么做的（本机没 ffmpeg，装了 `imageio-ffmpeg`）

```bash
# atempo 单级下限 0.5 倍速，0.63/1.0 = 0.63 倍 ⇒ 拆成两级相同的 sqrt
ffmpeg -i 0164.mp3 -filter:a "atempo=0.794,atempo=0.794" -ar 44100 -b:a 192k out.mp3
```

⚠ 为什么必须拆两级：`atempo` 单级只接受 0.5–2.0，直接给 0.63 看似合法，但
**0.63 是合法范围内**——这里拆两级是为了**降失真**（每级拉伸幅度小，WSOLA 伪影少）。
若目标更慢（如 1.5s ⇒ 0.42 倍），**必须**拆两级，单级会直接报错。

### ⛔ 换音频时唯一要改的地方

`assets/_shell/sfx.js:61` 的 `var LEN_MS = 970;`
—— 它只是 `loadedmetadata` 到手**之前**的初值（之后会被实际 `duration` 覆盖），
填个接近的数就行，但**不填会按旧数截断慢翻的长度**。

### 下载直链（同站，免署名可商用）

```
https://bigsoundbank.com/UPLOAD/mp3/<编号>.mp3
```
已试过的编号（供下次参考，避免重复下载）：
- 纸类 PAPRHndl：0164(0.36s) 2209(~25s 太长) 2210(1.7s) 2211(2s) 2212(2.6s)
  2213(1s) 2214(1.8s) 2215(1.55s 旧版) 2216(1s) 0362(2.6s) 0363(2s)
  0493(18s 太长) 1413(55s 太长)
- 空气声 SWSH：1799(0.9s) 1800(1.4s) 1801(1.3s) 1802(0.7s)
⚠ `?CatID=SWSH` 分类页是 **JS 渲染**，curl 抓不到编号 ⇒ 只能按已知编号直接下。
