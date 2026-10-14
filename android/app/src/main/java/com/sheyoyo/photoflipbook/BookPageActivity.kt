package com.sheyoyo.photoflipbook

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import java.io.File
import java.io.FileInputStream
import java.io.InputStream

/**
 * 打开一本书（书页跑在 WebView 里）。
 *
 * ★ 为什么书页不 Compose 化（这条别再翻工）
 * ---------------------------------------------------------------------------
 * 佘先生要「**能导出 + App 内好看 + 两边观感一致**」。
 * 要能导出 ⇒ 书必须是独立 HTML；要两边一致 ⇒ **只能同一份 HTML 渲染**。
 * Compose 重画＝两套渲染 ⇒ 字距 / 断行 / 纸纹 / 翻页曲线永远对不齐。
 * 另：**效率上改书页是零收益** —— 出书快慢只取决于排版计算＋图片编码。
 *
 * ★ 为什么用虚拟域而不是 file:// （M2 的核心决策）
 * ---------------------------------------------------------------------------
 * 书里 30 个资源**全是相对路径** ⇒ 只要基准 URL 对，`styles.css`、`flipbook.js`、
 * `assets/photos` 下那批 jpg 自然都能找到。
 * 但如果基准是 `file://`：`fetch` 不可用、Canvas 会被判「污染」（书页用 canvas 处理封面）
 * ⇒ 必须开 `allowFileAccessFromFileURLs`，等于把整个文件系统暴露给页面。
 * 改成 `https://appassets.androidplatform.net/...` 这个**虚拟域**：
 *   · 页面是 https 源 ⇒ fetch / canvas 全正常
 *   · 资源由 `WebViewAssetLoader` 从 assets 或私有目录**流式喂给**它
 *   · **零权限、零文件系统暴露**
 *
 * 两类书的 URL
 *   · 内置书（打包在 assets）      `https://<域>/books/guide/index.html`
 *   · 用户出的书（私有目录）      `https://<域>/ubooks/<书名>/index.html`
 *
 * ★★★「绝不能出现系统『网页无法打开』」—— 四道闸（本文件的全部重点）
 * ---------------------------------------------------------------------------
 * 佘先生原话：「每次看看画册后返回书架，会弹出一个网页无法打开的显示，
 *   **一定要修复，不能出现**」。真机复现的根因（不是抓取过早、不是环境问题）：
 *
 *   ① 书页左上角那颗「返回书架」圆钮来自壳层 `_shell/layout.js`，它的 `goShelf()`：
 *        - `history.back()` —— 本 Activity 的 WebView 只 `loadUrl` 一次，
 *          `history.length == 1`，**这条路走不通**；
 *        - 兜底 `location.replace('../../_shelf/index.html')` ——
 *          但新工程是 **Kotlin 原生书架**（`MainActivity`，纯 Compose），
 *          assets 里**压根没有 `_shelf/index.html`**；而本 Activity 的 loader
 *          只注册了 `/books/` 与 `/ubooks/` 两个前缀 ⇒ `/_shelf/...` **不被拦截**
 *          ⇒ WebView 真的拿它去解析 `https://appassets.androidplatform.net/...`
 *          ⇒ DNS 失败 ⇒ **系统那张灰白的「网页无法打开」就是这么来的**。
 *      而旧工程没有 `shouldOverrideUrlLoading`，**拦都没拦**。
 *   ② WebView 自己的错误页在 `onReceivedError` 回调**之前**就已经渲染了，
 *      Compose 状态再画一层盖不住那一帧闪 ⇒ 光"画人话错误页"是不够的。
 *   ③ Compose 的 `AndroidView.update` 在 Activity 销毁时会再跑一次，
 *      `wv.url` 已被 `location.replace` 改掉 ⇒ 又 `loadUrl(url)` 重载一本正在退出的书
 *      ⇒ **"切换瞬间"最可疑的一次闪**。
 *   ④ WebView 从头到尾没 `destroy()`、退出前也没 `stopLoading()`，
 *      退场动画期间还在加载/渲染。
 *
 * 四道闸（逐条对应上面四点）：
 *   A. `shouldOverrideUrlLoading`：**书页只允许停在 `index.html`**，
 *      任何其它导航（`/_shelf/…`、外链、别的历史项）一律 `return true` 吞掉，
 *      并直接 `finish()` 回书架 ⇒ **那条死链永远不会被加载**。
 *   B. 失败一律把 WebView `visibility = GONE`（不是"盖一层"，是**让系统页不存在**），
 *      再由 Compose 画人话页。GONE 的 View 什么都不画。
 *   C. 加 `isClosing` 闸门：`update` 里一发现正在关闭就**不再 `loadUrl`**。
 *   D. 退出前 `stopLoading()` + `GONE`，`onDestroy` 里 `destroy()`；
 *      系统返回键与返回圆钮**走同一个 `closeSelf()`**，保证退场全程屏幕上没有网页内容。
 */
class BookPageActivity : ComponentActivity() {

    companion object {
        const val EXTRA_KEY = "book_key"          // 目录名（URL 段）
        const val EXTRA_BUILTIN = "book_builtin"  // true = assets 内置书
        private const val DOMAIN = "appassets.androidplatform.net"
        private const val TAG = "BookPage"
    }

    /**
     * 本书页自己的 WebView 引用 —— Activity 必须握住它，否则：
     *   · 没法在**退出前**先 `stopLoading()` + `visibility = GONE`（闸 D）；
     *   · 没法 `destroy()`（白泄漏一个 Chromium 句柄）。
     */
    private var bookWeb: WebView? = null

    /** 正在退出：置位后一切"重新加载"都被拒绝（闸 C）。 */
    private var isClosing = false

    /**
     * 当前是否处于「沉浸式全屏」（隐藏状态栏 + 导航栏）。
     *
     * ★★ 2026-10-08（第四轮）改：**默认 false** —— **开书不再自动全屏**。
     *   佘先生：「不能自动进入全屏模式，要求用户手动进入」。
     *   手动入口 = **书里那颗「全屏」钮**（`#page-full`，书自带；壳层此前把它
     *   `display:none` 砍掉了，本轮恢复出来）。它点下去经 `FlipbookShell.toggleFullscreen()`
     *   叫回原生，由 [applyFullscreen] 真去 hide/show 系统栏。
     */
    private var fullscreen = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val key = intent.getStringExtra(EXTRA_KEY)
        val builtin = intent.getBooleanExtra(EXTRA_BUILTIN, false)
        if (key.isNullOrBlank()) {
            Log.e(TAG, "没给书名，退出")
            finish(); return
        }

        val userBooks = File(getExternalFilesDir(null) ?: filesDir, "books")
        val loader = WebViewAssetLoader.Builder()
            .setDomain(DOMAIN)
            // 两类书各挂一个前缀。⚠ 两个 handler 都不是想当然的那个：
            //   · 内置书：**不能用自带的 `AssetsPathHandler`** —— 它把我注册的前缀
            //     （`/books/`）**去掉之后**再当路径用 ⇒ 它会去 **assets 根下**找
            //     `guide/index.html`，而我的书在 `assets/books/guide/` ⇒
            //     内置书报 `ERR_INVALID_RESPONSE`（日志：`Error opening asset path: guide/index.html`）。
            //   · 用户书：自带的 `InternalStoragePathHandler` 只认内部 `dataDir`/`cacheDir`，
            //     **外置私有目录用不了** ⇒ 也得自己写。
            //   结论：两个都自己写，都带一个"base 目录"概念。
            .addPathHandler("/books/", AssetsDirHandler(this, "books"))
            .addPathHandler("/ubooks/", FilesPathHandler(userBooks))
            // ★ 二十一轮：翻页音效（`assets/sfx/flip.mp3`）走这个前缀给页面。
            //   ⚠ 没有它 ⇒ 页面里 `/sfx/flip.mp3` 直接 404 ⇒ new Audio() 永远出错
            //     ⇒ 翻页没声（而翻页本身照常，所以是个"安静的失败"，必须靠日志发现）。
            .addPathHandler("/sfx/", AssetsDirHandler(this, "sfx"))
            .build()

        val url = if (builtin)
            "https://$DOMAIN/books/${Uri.encode(key)}/index.html"
        else
            "https://$DOMAIN/ubooks/${Uri.encode(key)}/index.html"

        applyFullscreen(false)      // ★ 不自动全屏：系统栏正常显示（这一条是本轮改的）
        Log.i(TAG, "打开书：$url（内置=$builtin；全屏=否 —— 等用户点书里那颗「全屏」钮）")

        // ★ 系统返回键 = 回书架 ⇒ 必须和返回圆钮走**同一个** closeSelf()，
        //   否则闸 D（退场前隐藏 WebView）在按返回键那条路上是空的。
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                Log.i(TAG, "系统返回键 ⇒ 回书架")
                closeSelf()
            }
        })

        setContent {
            PhotoFlipbookTheme {
                BookPage(
                    url = url,
                    loader = loader,
                    onWebReady = { w ->
                        bookWeb = w
                        if (isClosing) w.visibility = View.GONE
                        injectSafeTop(fullscreen)   // ★ 二十一轮：WebView 一就位就写安全区
                    },
                    onExit = { closeSelf() },
                    // ★ 书里那颗「全屏」钮的落点（2026-10-08 第四轮）
                    onToggleFullscreen = { applyFullscreen(!fullscreen) },
                    isFullscreenNow = { fullscreen },
                )
            }
        }
    }

    /**
     * ★ 闸 D：**回书架的唯一出口**。
     *
     * 先让 WebView 闭嘴（停加载 + `GONE`），再 `finish()` —— 于是**退场动画全程屏幕上
     * 一行网页内容都没有**，从物理上杜绝"切换瞬间闪出网页无法打开"。
     * 返回圆钮（`layout.js` 的死链导航被 `shouldOverrideUrlLoading` 拦下）与系统返回键
     * 都在这里汇合 ⇒ 无论用户怎么点，退出路径只有这一条。
     */
    private fun closeSelf() {
        if (isClosing) return
        isClosing = true
        try {
            bookWeb?.let { w ->
                w.stopLoading()               // 不要再发请求
                w.visibility = View.GONE      // 别再绘制（退场动画里也是 GONE）
            }
        } catch (t: Throwable) {
            Log.w(TAG, "退出前停 WebView 失败（无害）", t)
        }
        Log.i(TAG, "关掉书页 ⇒ 回书架")
        finish()
    }

    override fun onDestroy() {
        // ★ WebView 必须 destroy：不释放的话 Chromium 句柄一直挂着，
        //   下次开书会多一个引擎实例（用户手机上表现为越用越卡）。
        try {
            bookWeb?.let { w ->
                w.stopLoading()
                w.webViewClient = android.webkit.WebViewClient()
                (w.parent as? ViewGroup)?.removeView(w)
                w.removeAllViews()
                w.destroy()
            }
        } catch (t: Throwable) {
            Log.w(TAG, "销毁 WebView 失败（无害）", t)
        }
        bookWeb = null
        super.onDestroy()
    }

    /**
     * 应用「全屏 / 非全屏」。
     *
     * ★ 2026-10-08（第四轮）：**开书不再自动全屏**（[fullscreen] 默认 false）。
     *   佘先生：「不能自动进入全屏模式，要求用户手动进入」。入口 = 书里那颗「全屏」钮
     *   （`#page-full`）⇒ `FlipbookShell.toggleFullscreen()` ⇒ 这里。
     *
     * 两条路要**同时**切，少一条都不对：
     *   · `setDecorFitsSystemWindows(window, !on)` —— 非全屏时把内容**让到系统栏下面**
     *     （不让的话书会被状态栏/导航条压住；全屏时才 `false` 顶满）；
     *   · `hide / show(systemBars)` —— 真正把栏收起来 / 放出来。
     * 切完竖栏尺寸会变（视口高度变了）⇒ 书页自己会重排；壳层 `nudge()` 也会补一次 resize。
     *
     * ⚠ 之后还要把状态**回报给壳层**（`window.__shellFullscreen`）：书里那颗钮的文案
     *   原本靠 `document.fullscreenElement` 同步，走原生后它永远是 null ⇒ 不回报的话
     *   按钮会一直写着「全屏」（哪怕已经在全屏里）。
     */
    private fun applyFullscreen(on: Boolean) {
        fullscreen = on
        try {
            // ★★ 2026-10-10（二十一轮）：**恒 false** —— 内容铺满整块屏幕，不再让开系统栏。
            //
            //   为什么改：非全屏（= 开书后的**默认**态）时这里传 `true`，系统会把内容区
            //   压到 `x[73..2339] y[84..1079]`，而整块屏幕是 `x[0..2339] y[0..1079]`
            //   ⇒ 左留 73px、上留 84px、**右下贴边** ⇒ 佘先生报的「整个软件偏右下方」。
            //   （真机 vivo Z5 像素级实测，见 `tools/_ui_shift_probe.py`。）
            //
            //   ⚠ 铺满 ≠ 让书被状态栏压住：顶部该让开的那 28 CSS px 由壳层补
            //     `--shell-safe-top`（见 [injectSafeTop] / `layout.js`）⇒ 可用高仍是 332
            //     ⇒ **书的大小与位置一个像素不变**，只是木桌背景铺满、白边消失。
            WindowCompat.setDecorFitsSystemWindows(window, false)
            val c = WindowInsetsControllerCompat(window, window.decorView)
            if (on) {
                c.hide(WindowInsetsCompat.Type.systemBars())
                c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            } else {
                c.show(WindowInsetsCompat.Type.systemBars())
                // 系统栏透明 + 不强加对比度底色 ⇒ 内容铺到它下面，视觉上不出现两条实心色块
                window.statusBarColor = android.graphics.Color.TRANSPARENT
                window.navigationBarColor = android.graphics.Color.TRANSPARENT
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                    window.isStatusBarContrastEnforced = false
                    window.isNavigationBarContrastEnforced = false
                }
            }
            Log.i(TAG, "全屏 = $on（内容恒铺满）")
        } catch (t: Throwable) {
            Log.w(TAG, "切全屏没成功（不影响看书）", t)
        }
        injectSafeTop(on)
        try {
            bookWeb?.post {
                bookWeb?.evaluateJavascript(
                    "window.__shellFullscreen && window.__shellFullscreen($on)", null)
            }
        } catch (t: Throwable) { /* 壳层没在也无所谓 */ }
    }

    /**
     * ★ 2026-10-10（二十一轮）：把「系统栏占了顶部多少」告诉页面（CSS 变量
     * `--shell-safe-top`，单位 **CSS px**）。
     *
     * 铺满之后 WebView 视口 = 780×360（真机），但**顶部 28 CSS px 压着状态栏** ⇒
     * 书必须避开它，否则书名/封面会被压住。壳层 `layout.js` 读这个变量给 `.stage` 补
     * `padding-top`；`compat.js` 量可用高时会扣掉 padding ⇒ **仍是 332** ⇒ 书一个像素不变。
     *
     * ⚠ 单位换算：insets 给的是**物理 px**，页面要的是 CSS px ⇒ 除以 density（本机 3）。
     * ⚠ 只写 `documentElement` 的内联样式，不碰书的 DOM 与结构；出错只打日志。
     * ⚠ 全屏态下系统栏收起 ⇒ inset 变 0 ⇒ 变量随之变 0，书自动顶满（与原来全屏行为一致）。
     */
    private fun injectSafeTop(fullscreen: Boolean) {
        val w = bookWeb ?: return

        // ★★ 为什么不能只用 insets（2026-10-10 真机实测踩到）：
        //   `c.hide(systemBars())` 之后**立刻**读 `getRootWindowInsets` 拿到的还是**旧值**
        //   （实测仍是 28）—— insets 是**异步**更新的。照它算 ⇒ 进了全屏、系统栏都收起了，
        //   书却还缩着 28px（实测：全屏后 `--shell-safe-top` 仍是 28px、书仍是 332 高）。
        //   ⇒ 全屏态**直接置 0**（系统栏收起了，安全区本来就是 0），不依赖时序；
        //     非全屏态读实量 insets，并**补一次 400ms 后重读**（覆盖"刚退全屏、insets 还没回来"）。
        try {
            // 立刻推一次（全屏态直接就是 0，不等 insets）；400ms 后再推一次 ——
            // 覆盖"刚退全屏、insets 还没回来"那一拍。⚠ 值没变时 pushSafeTop 内部会跳过。
            w.post { pushSafeTop(w, fullscreen) }
            w.postDelayed({ pushSafeTop(w, fullscreen) }, 400)
        } catch (t: Throwable) {
            Log.w(TAG, "注入安全区失败（不影响看书）", t)
        }
    }
}

/**
 * 壳补丁（照旧工程顺序注入，缺一不可）
 *
 * | 补丁 | 干什么 |
 * |---|---|
 * | `layout.js`  | 把翻页控制条从画面底部挪到屏幕内（电脑版是按桌面排的）+ 返回圆钮 + 收起开关 |
 * | `compat.js`  | 老内核版式补丁 —— ★ **它自带判断**，新内核（认识 `1cqh`）直接 return，一个像素不动 |
 * | `gesture.js` | 把四条在手机上失联的手势接回来（双击换头、边缘滑动翻页…） |
 * | `speed.js`   | ★ 翻页速度 + 自动翻页速度 两颗下拉（2026-10-08） |
 *
 * ⚠ 顺序要紧：`layout.js` 要排在 `speed.js` **之前** ——
 *   它建的控制条是 `speed.js` 插控件的容器（`.status`），
 *   反了就找不到挂载点 ⇒ 这颗下拉不会出现（且不报错，最难查的那种"没反应"）。
 *
 * ⚠ 书（成品）一个字不改，链① 一个字不改 —— 全在壳这一层。
 */
/**
 * 第八轮③（2026-10-08）：查看画册时**页面底色** = **B 浅橡木磨砂**（佘先生点的 B）。
 *
 * ⚠ 为什么 Compose 这层也要跟：书页是 WebView，它自己的底色由壳 `layout.js` 第 21) 条
 *   压成木纹（压的是冻结 `styles.css` 里的 `#fff`）。但**这三处 Compose 底色**
 *   在书页 WebView 之上/之外，是**加载瞬间**和**打不开书的失败页**会露出来的底。
 *   不同步的话 ⇒ 点开书先闪一下米白、书打不开时整屏米白，和木桌书页对不上。
 *
 * ⚠ 这里**画不出** CSS 那套多层渐变 + `feTurbulence` 噪点（Compose 没有等价物，硬凑
 *   只会多一套难维护的画法）⇒ 只用**同色系的竖向渐变**近似，取 B 的三个主色
 *   `#d8b183 / #c39a67 / #b1895a`，肉眼看是同一块木头。
 * ★ 真正的木纹与磨砂在 WebView 那层（壳 21) 条），两边**主色一致** ⇒ 过渡不违和。
 */
private val DeskTop = Color(0xFFD8B183)
private val DeskMid = Color(0xFFC39A67)
private val DeskLow = Color(0xFFB1895A)

/** B 浅橡木的竖向渐变（三档主色，与壳 `layout.js` 第 21) 条同一套值） */
private fun deskBrush(): Brush = Brush.verticalGradient(listOf(DeskTop, DeskMid, DeskLow))

private val SHELL_PATCHES = listOf(
    // ★ 第九轮②（F140）：`cqwfix` 必须排在**最前面** ——
    //   它把封面文字的 `font-size` 从失效的 `cqw` 换算成 px 并写内联样式。
    //   排最前 = 后面几个补丁（layout/compat/gesture/speed）动 DOM 时它已经在盯了。
    //   ⚠ 它自带版本闸门：新内核（认 `cqw`）自己什么都不做 ⇒ 零行为变化。
    "_shell/cqwfix.js" to "cqw 兜底换算",
    "_shell/layout.js" to "控制条布局",
    "_shell/compat.js" to "版式补丁",
    "_shell/gesture.js" to "触屏手势",
    "_shell/speed.js" to "翻页速度",
    // ★ 二十一轮：翻页音效。**排最后** —— 它要读 speed.js 挂的 `__shellSpeed`
    //   （靠它区分手动/自动翻页），排在前面会拿不到那两个函数。
    "_shell/sfx.js" to "翻页音效",
)

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun BookPage(
    url: String,
    loader: WebViewAssetLoader,
    onWebReady: (WebView) -> Unit,
    onExit: () -> Unit,
    onToggleFullscreen: () -> Unit,
    /** 当前全屏状态（注入壳补丁后要回报给壳层，让那颗「全屏」钮的文案与真实状态一致）。 */
    isFullscreenNow: () -> Boolean,
) {
    var failed by remember { mutableStateOf<String?>(null) }
    var webRef by remember { mutableStateOf<WebView?>(null) }

    /** 本书自己的规范 URL（去掉 query/fragment 之后比较）。 */
    val pageKey = remember(url) { url.substringBefore('#').substringBefore('?') }

    fun hideWeb(w: WebView) {
        try { w.visibility = View.GONE } catch (t: Throwable) { /* 忽略 */ }
    }

    Column(Modifier.fillMaxSize().background(deskBrush())) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    WebView(ctx).apply {
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                        setBackgroundColor(android.graphics.Color.parseColor("#F4F2EA"))     // 纸感底色，避免白闪
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        settings.mediaPlaybackRequiresUserGesture = false
                        settings.cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
                        // 书页按电脑视口排的，别让 WebView 自作主张改缩放
                        settings.useWideViewPort = true
                        settings.loadWithOverviewMode = false
                        settings.builtInZoomControls = false
                        settings.displayZoomControls = false

                        webChromeClient = WebChromeClient()

                        webViewClient = object : WebViewClient() {

                            // ------------------------------------------------------------------
                            // ★ 闸 A（本次修复的核心）：**除本书 index.html 以外，一律不许导航**。
                            //
                            // 死路就在这里：`layout.js` 的返回圆钮在 `history.length == 1` 时会
                            // `location.replace('../../_shelf/index.html')`，而新工程**没有那个文件**
                            // （书架是 Kotlin 原生 Activity）⇒ 不拦的话 WebView 真去解析
                            // `https://appassets.androidplatform.net/_shelf/index.html` ⇒ DNS 失败
                            // ⇒ **系统的「网页无法打开」**。
                            //
                            // 现在策略：**书页只允许停在 `index.html`**。
                            //   · 指向 index.html（含锚点）→ 放行（书内锚点是合法的）；
                            //   · 指向别的任何东西（死链 / 外链 / 别的历史项）→ `return true` 吞掉，
                            //     **一个字节都不去加载**，并直接回书架。
                            // ⇒ 用户点那颗圆钮的体感 = 「回到书架」（正是它本来的意图），
                            //   但走的是**原生 finish**，零网络、零死链。
                            // ------------------------------------------------------------------
                            override fun shouldOverrideUrlLoading(
                                view: WebView, request: WebResourceRequest
                            ): Boolean = blockOrAllow(request.url?.toString())

                            /** API 24 以下的老签名；本工程 minSdk 24，但它可能仍被回调，一并拦住。 */
                            @Deprecated("Deprecated in Java")
                            override fun shouldOverrideUrlLoading(view: WebView, url: String?): Boolean =
                                blockOrAllow(url)

                            fun blockOrAllow(target: String?): Boolean {
                                val t = target ?: return false
                                // `about:blank` 是 WebView 自己会走的地方（无内容）⇒ 放行
                                if (t == "about:blank") return false
                                if (t.substringBefore('#').substringBefore('?') == pageKey) return false
                                Log.i(TAG_BOOK, "拦下离开本书的导航：$t ⇒ 直接回书架")
                                onExit()
                                return true     // ★ 吞掉 ⇒ WebView 永远不去加载它 ⇒ 不会有错误页
                            }

                            override fun shouldInterceptRequest(
                                view: WebView, request: WebResourceRequest
                            ): WebResourceResponse? = loader.shouldInterceptRequest(request.url)

                            override fun onPageFinished(view: WebView, u: String) {
                                super.onPageFinished(view, u)
                                Log.i(TAG_BOOK, "页面加载完成：$u")
                                failed = null                      // 成功了就撤掉错误页
                                view.visibility = View.VISIBLE
                                injectShellPatches(view, isFullscreenNow())
                            }

                            // ------------------------------------------------------------------
                            // ★ 闸 B：**失败时把 WebView 整个 GONE**，而不是"在它上面盖一层"。
                            //   系统的错误页是 WebView **自己**渲染的，而且**先于**本回调；
                            //   只靠 Compose 状态去盖，中间那一帧照样闪。
                            //   `GONE` 的 View 一个像素都不画 ⇒ 系统页**物理上不可能出现**。
                            // ------------------------------------------------------------------
                            override fun onReceivedError(
                                view: WebView, request: WebResourceRequest, error: WebResourceError
                            ) {
                                super.onReceivedError(view, request, error)
                                // ★ 只认**主框架**失败；子资源（某张图）失败不该把整页判死。
                                if (!request.isForMainFrame) return
                                Log.e(TAG_BOOK, "主框架加载失败：${error.errorCode} ${error.description}")
                                view.stopLoading()
                                hideWeb(view)
                                failed = "${error.errorCode} ${error.description}"
                            }

                            /**
                             * ★ HTTP 层失败（404 / 500 …）**不走 `onReceivedError`** ——
                             *   只接前一个的话，这类失败会漏过去、系统页照样闪。
                             */
                            override fun onReceivedHttpError(
                                view: WebView, request: WebResourceRequest,
                                errorResponse: WebResourceResponse
                            ) {
                                super.onReceivedHttpError(view, request, errorResponse)
                                if (!request.isForMainFrame) return
                                Log.e(TAG_BOOK, "主框架 HTTP 失败：${errorResponse.statusCode}")
                                view.stopLoading()
                                hideWeb(view)
                                failed = "HTTP ${errorResponse.statusCode}"
                            }

                            /**
                             * ★ 渲染进程崩了（低内存回收）是"网页无法打开"的另一个来源。
                             *   **必须 `return true`**，否则整个 App 跟着崩（铁律：不许崩溃）。
                             */
                            override fun onRenderProcessGone(
                                view: WebView, detail: RenderProcessGoneDetail?
                            ): Boolean {
                                Log.e(TAG_BOOK, "渲染进程退出：${if (detail?.didCrash() == true) "崩溃" else "被杀"}")
                                hideWeb(view)
                                failed = "页面渲染进程退出了"
                                return true
                            }
                        }

                        // ★ 原生桥（2026-10-08）：壳层 `layout.js` 的返回圆钮会**先问它**
                        //   「原生能不能回书架」。能 ⇒ `closeSelf()`（先 stopLoading + GONE 再 finish），
                        //   那条指向 `_shelf/index.html` 的**死链根本不会被走** ⇒ 绝无「网页无法打开」。
                        //   ⚠ 方法名要与 layout.js 里的 `goToShelf` **一字不差**（WebView 桥按名字找）。
                        //   ⚠ 桥方法**必须**加 @JavascriptInterface，否则 JS 里压根看不到它。
                        addJavascriptInterface(object {
                            @android.webkit.JavascriptInterface
                            fun goToShelf() {
                                // JS 线程回调 ⇒ 搬回主线程再动 Activity
                                Handler(Looper.getMainLooper()).post { onExit() }
                            }

                            /**
                             * ★ 书里那颗「全屏」钮（`#page-full`）⇒ 原生沉浸式切换
                             *   （2026-10-08 第四轮）。
                             *
                             * 书原本点它走 Fullscreen API（`documentElement.requestFullscreen`），
                             * 而 WebView 那条路要 `WebChromeClient.onShowCustomView` —— 我们没实现，
                             * 点了什么也不会发生（正是「手动进不了全屏」的成因）。
                             * 壳层 `layout.js` 现在**接管了它的 click**（document capture 阶段），
                             * 改叫这个名字 ⇒ 由 Activity 真去 hide/show 系统栏。
                             */
                            @android.webkit.JavascriptInterface
                            fun toggleFullscreen() {
                                Handler(Looper.getMainLooper()).post { onToggleFullscreen() }
                            }
                        }, "FlipbookShell")

                        webRef = this
                        onWebReady(this)
                        loadUrl(url)
                    }
                },
                // ★ 闸 C：url 变了要补一次重载（`factory` 只跑一次）。
                //   ⚠ 但**正在关闭时绝不能再 loadUrl** —— 那会让一本正要退出去的书
                //   在退场动画里重新加载一遍，正是"切换瞬间"最可疑的一次闪。
                update = { wv ->
                    if (failed == null && wv.url != url && wv.visibility == View.VISIBLE) {
                        Log.i(TAG_BOOK, "url 变了，重新加载：$url")
                        wv.loadUrl(url)
                    }
                }
            )

            // ★ 人话错误页（**WebView 此时是 GONE**，屏幕上只有这一层）
            //   ⚠ 用 Compose 的 Color，不是 android.graphics.Color —— 那个是 Int，
            //   两个都 import 了会歧义（`Color(0xFF…)` 和 `Color.parseColor`）。
            failed?.let { msg ->
                Box(Modifier.fillMaxSize().background(deskBrush()),
                    contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("这本书暂时打不开", color = Color(0xFF2A2A28), fontSize = 15.sp)
                        Spacer(Modifier.height(8.dp))
                        Text(msg.take(60), color = Color(0xFF6B6B66), fontSize = 11.sp)
                        Spacer(Modifier.height(14.dp))
                        androidx.compose.foundation.layout.Row(
                            horizontalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            Text("重试", color = Color(0xFF4A6FA5), fontSize = 13.sp,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(14.dp))
                                    .clickable {
                                        failed = null
                                        webRef?.let { w ->
                                            w.visibility = View.VISIBLE   // ★ 重试要先让它回来
                                            w.loadUrl(url)
                                        }
                                    }
                                    .padding(horizontal = 18.dp, vertical = 8.dp))
                            // 错误页上也能回书架 —— 不让用户卡在这
                            Text("回书架", color = Color(0xFF6B6B66), fontSize = 13.sp,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(14.dp))
                                    .clickable { onExit() }
                                    .padding(horizontal = 18.dp, vertical = 8.dp))
                        }
                    }
                }
            }
        }
    }
}

private const val TAG_BOOK = "BookPage"

/**
 * 按顺序注入壳补丁，完了把**当前全屏状态**回报给壳层。
 *
 * ⚠ 顺序要紧：先摆布局（舞台撑高），再打版式补丁（按新尺寸回写）。
 * ⚠ 最后那一句是 2026-10-08（第四轮）加的：书里那颗「全屏」钮的文案原来是书自己
 *   按 `document.fullscreenElement` 写的，而全屏现在走**原生**（隐系统栏 ≠ Fullscreen API）
 *   ⇒ 那个变量永远是 null。不在注入后主动回报一次，按钮会一直停在「全屏」。
 *   （`window.__shellFullscreen` 由 layout.js 在 IIFE 里就挂好，注入顺序上它排第一，
 *     所以这句一定找得到它。）
 */
/** 上一次推给页面的安全区值（CSS px）。-1 = 还没推过。⚠ 只在**变化**时重推（避免反复重算）。 */
private var lastSafeCss = -1f

/**
 * 非全屏态量到的安全区高度（CSS px）。-1 = 还没量到。
 * ★ 为什么必须缓存：`hide()`/`show()` 之后 `getRootWindowInsets` 会**滞后一拍**
 *   —— 进全屏后立刻读还是 28，退全屏后立刻读又还是 0。每次都现读 ⇒ 变量一路错。
 *   非全屏态量到一次正值就存下来；之后全屏 ⇒ 0、退出 ⇒ 用这个存值恢复。
 */
private var measuredSafeCss = -1f

/**
 * ★ 2026-10-10（二十一轮）：把「系统栏占了顶部多少」推给页面（CSS 变量
 * `--shell-safe-top`，单位 **CSS px**），并在**值变化时补派一次 `resize`**。
 *
 * 为什么还要派 resize（真机实测踩到）：
 *   铺满之后，非全屏与全屏的 **WebView 视口尺寸都一样是 780×360**
 *   ⇒ 切全屏时**没有任何尺寸变化** ⇒ 壳层 `compat.js` 那个 `resize` 监听不会被唤醒
 *   ⇒ 书仍按旧的可用高（332）算，**全屏里不顶满**（实测：全屏后书还是 332 高、被居中）。
 *   所以变量一变就主动 `dispatchEvent(new Event('resize'))`，
 *   让 `compat.js` 用新的 `padding-top` 重算一次（`kick()` → `apply()`）。
 *   ⚠ 只在**变化**时派发 —— 否则每次进出全屏都白重算两轮（会看到多余的重排）。
 *
 * @param fullscreen 全屏态 ⇒ 安全区就是 0（系统栏已收起），不等 insets。
 */
private fun pushSafeTop(view: WebView, fullscreen: Boolean) {
    try {
        val css = if (fullscreen) 0f else {
            if (measuredSafeCss <= 0f) {
                val density = view.resources.displayMetrics.density
                val ins = ViewCompat.getRootWindowInsets(view)
                    ?.getInsets(WindowInsetsCompat.Type.systemBars())
                val v = Math.max(0f, (ins?.top ?: 0) / density)
                if (v > 0f) measuredSafeCss = v     // 只缓存**正值**（0 可能是没量到）
            }
            if (measuredSafeCss > 0f) measuredSafeCss else 0f
        }
        if (css == lastSafeCss) {
            Log.i(TAG_BOOK, "安全区无变化（$css）⇒ 不重推")
            return
        }
        lastSafeCss = css
        view.evaluateJavascript(
            "document.documentElement.style.setProperty('--shell-safe-top','${css}px');" +
            "try{window.dispatchEvent(new Event('resize'))}catch(e){}", null)
        Log.i(TAG_BOOK, "安全区（上）= $css CSS px（全屏=$fullscreen）⇒ 已推给页面并触发重算")
    } catch (t: Throwable) {
        Log.w(TAG_BOOK, "注入安全区失败（无害）", t)
    }
}

private fun injectShellPatches(view: WebView, fullscreen: Boolean) {
    // ★ 二十一轮：先告诉页面「顶部要让开多少」（`--shell-safe-top`，CSS px）。
    //   ⚠ 必须在 SHELL_PATCHES 循环**之前** —— layout.js 一注入就要读它给 .stage 补 padding。
    // ⚠ 新页面刚加载，`lastSafeCss` 是上一页的残留 ⇒ 先清掉，强制重推一次。
    lastSafeCss = -1f
    pushSafeTop(view, fullscreen)

    // ★ 二十一轮：把书架那个「翻页声」开关告诉页面。
    //   ⚠ 必须在 SHELL_PATCHES 循环**之前** —— sfx.js 一注入就会读 `window.__shellSfxOn`，
    //     晚一步就按默认值（开）走，开关就成了摆设。
    try {
        val on = SfxPrefs.isOn(view.context)
        view.evaluateJavascript("window.__shellSfxOn = $on", null)
        Log.i(TAG_BOOK, "翻页声开关 = $on ⇒ 已注入 __shellSfxOn")
    } catch (t: Throwable) {
        Log.w(TAG_BOOK, "注入翻页声开关失败（无害）", t)
    }

    for ((path, label) in SHELL_PATCHES) {
        try {
            val js = view.context.assets.open(path).bufferedReader().use { it.readText() }
            view.evaluateJavascript(js, null)
            Log.i(TAG_BOOK, "已注入 $label（$path，${js.length} 字符）")
        } catch (t: Throwable) {
            // 补丁注入失败不该让书打不开 —— 书页本身仍在
            Log.e(TAG_BOOK, "注入失败：$label（$path）", t)
        }
    }
    try {
        view.evaluateJavascript(
            "window.__shellFullscreen && window.__shellFullscreen($fullscreen)", null)
    } catch (t: Throwable) {
        Log.w(TAG_BOOK, "回报全屏状态失败（不影响看书）", t)
    }
}

/**
 * 把「assets 下的某个子目录」挂成一个 URL 前缀。
 *
 * ⚠ 为什么不用自带的 `WebViewAssetLoader.AssetsPathHandler`：
 *   它收到的是**已经把注册前缀去掉的**路径。注册 `/books/` 时，
 *   `…/books/guide/index.html` 传进 handler 就变成了 `guide/index.html`，
 *   它便去 **assets 根下**找 —— 而书实际在 `assets/books/guide/`。
 *   症状：内置书 `ERR_INVALID_RESPONSE`，日志 `Error opening asset path: guide/index.html`。
 *   （我这次就栽在这，一度以为是打包漏了文件。）
 */
internal class AssetsDirHandler(
    private val context: Context,
    private val baseDir: String,
) : WebViewAssetLoader.PathHandler {
    override fun handle(path: String): WebResourceResponse? {
        val rel = Uri.decode(path).removePrefix("/")
        if (rel.isEmpty() || rel.contains("..")) return null
        val full = "$baseDir/$rel"
        return try {
            WebResourceResponse(mimeOf(rel), null, context.assets.open(full))
        } catch (t: Throwable) {
            Log.w("AssetsDirHandler", "打不开 assets/$full", t)
            null
        }
    }
}

/**
 * 把「App 私有目录里的一个子目录」挂成一个 URL 前缀。
 *
 * ⚠ 必须自己给 MIME —— 给错（比如 css/js 给成 text/plain）浏览器会**拒绝执行**。
 */
internal class FilesPathHandler(private val base: File) : WebViewAssetLoader.PathHandler {
    override fun handle(path: String): WebResourceResponse? {
        val rel = Uri.decode(path).removePrefix("/")
        if (rel.isEmpty()) return null
        val f = File(base, rel)
        if (!f.isFile) return null
        // 防目录穿越：解析后的路径必须真的在 base 下
        try {
            val basePath = base.canonicalPath + File.separator
            if (!f.canonicalPath.startsWith(basePath)) {
                Log.w("FilesPathHandler", "拒绝越界路径：$path")
                return null
            }
        } catch (t: Throwable) {
            return null
        }
        val stream: InputStream = FileInputStream(f)
        return WebResourceResponse(mimeOf(f.name), null, stream)
    }
}

/** 扩展名 → MIME。给错类型浏览器会拒绝执行（css/js 尤其）。 */
internal fun mimeOf(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
    "html", "htm" -> "text/html"
    "css" -> "text/css"
    "js", "mjs" -> "application/javascript"
    "json" -> "application/json"
    "jpg", "jpeg" -> "image/jpeg"
    "png" -> "image/png"
    "gif" -> "image/gif"
    "webp" -> "image/webp"
    "svg" -> "image/svg+xml"
    "woff" -> "font/woff"
    "woff2" -> "font/woff2"
    "ttf" -> "font/ttf"
    "otf" -> "font/otf"
    "mp4" -> "video/mp4"
    // ★ 二十一轮：音频类型**必须有** —— 少了它们，`flip.mp3` 会退化成
    //   `application/octet-stream`，`new Audio()` 拿不到可解码的类型 ⇒ 翻页没声。
    "mp3" -> "audio/mpeg"
    "wav", "wave" -> "audio/wav"
    "ogg", "oga" -> "audio/ogg"
    "m4a" -> "audio/mp4"
    "aac" -> "audio/aac"
    "txt", "md" -> "text/plain"
    else -> "application/octet-stream"
}