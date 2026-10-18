# 手机端 APK（android/）

同一套「照片变画册」的手机壳：**Kotlin + Jetpack Compose** 做工作台/书架，
**WebView** 渲染书页。书页用的 HTML/CSS/JS 与桌面版同源，保证
「电脑上看到的」和「手机上翻开的」是同一本书。

## 目录

```
android/
├── app/src/main/
│   ├── java/com/sheyoyo/photoflipbook/   # 工作台、书架、封面编辑、导入导出
│   │   ├── MainActivity.kt               # 书架（入口）
│   │   ├── WorkbenchActivity.kt          # 工作台：选照片、排版、出书
│   │   ├── CoverEditActivity.kt          # 封面编辑（拖动/双指缩放）
│   │   ├── BookPageActivity.kt           # 书页（WebView）
│   │   ├── BookWriter.kt                 # 出书：写 index.html + 拷贝资产
│   │   ├── PhotoStore.kt                 # 导入照片、EXIF 转正、HEIC 转码
│   │   ├── LibraryStore.kt               # 书架存储
│   │   ├── DraftStore.kt / FontStore.kt  # 草稿、用户字体
│   │   └── ...
│   ├── assets/_engine/                   # 书页引擎（与桌面版同源）
│   ├── assets/_shell/                    # 手机壳补丁（版式/手势/音效/兼容）
│   └── assets/books/guide/               # 内置教学画册
└── build.gradle / settings.gradle        # AGP 8.1.4 · Kotlin 1.9.22 · compileSdk 34
```

## 构建

要求：JDK 17、Android SDK 34（platform-tools 可选）。

```bash
cd android
./gradlew assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

> 注意：`app/build.gradle` 里覆盖了 AAPT 的 `ignoreAssetsPattern`。
> 默认规则会丢掉所有以 `_` 开头的目录（`_engine/`、`_shell/`），
> 构建照样成功、APK 里却一个文件都没有，运行时才报 `FileNotFoundException`。
> 这一行不要删。

## 与桌面版的分工

| 部件 | 桌面版 | 手机版 |
|---|---|---|
| 选照片 / 调版式 | 网页工作台（Python 起服务） | 原生 Compose 工作台 |
| 书页渲染 | 同一套 HTML/CSS/JS | 同一套 HTML/CSS/JS（WebView） |
| 出书 | 生成到本地文件夹 | 生成到应用私有目录，可导出 |

## 兼容性

- 目标机：Android 14 新机（荣耀 400 Pro）。
- 另有一台旧测试机 vivo Z5（Android 10 / Chrome 83 内核），
  专门用来兜底老 WebView 的兼容问题（例如 `inset-inline` 等逻辑属性、
  `aspect-ratio`、`cqw` 单位都不支持，壳层有对应补丁）。

## 隐私说明

仓库**不包含任何私人照片**：

- 内置教学画册的封面 `assets/photos/01-01.jpg` 是**中性占位图**（深色渐变 +「示例封面」），
  不是作者的个人照片；
- 其余 `assets/photos/0x-0x.jpg` 是程序渲染的**说明文字卡**（白底文字），不含照片
  （其中一张印着作者公开的联系邮箱，属于对外说明的一部分）；
- App 图标（`res/mipmap-*/ic_launcher*.png`）是随包发布的软件图标，按作者要求保留。

## 已知问题

见 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)。
