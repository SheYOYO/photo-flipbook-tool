package com.sheyoyo.photoflipbook

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 跨页预览（M4b）—— 工作台右边那一栏，**用真书页渲染**。
 *
 * ★ 核心：**界面是原生的，算法还是那四颗 JS**
 *   这个 WebView 加载 `_engine/preview.html`，它 `<script>` 引入
 *   `probe.js` / `rules.js` / `template.js` / `artwork.js` —— 与电脑端**逐字节对账过**的那四颗。
 *   ⇒ 换界面不改算法：工作台是 Compose，而排版结果仍与电脑端一致。
 *
 * ★ 为什么用虚拟域（`https://appassets.androidplatform.net/...`）而不是 `file://`
 *   引擎要用 **canvas 读像素**（`getImageData`）—— `file://` 下 canvas 会被判"污染"、
 *   `getImageData` 直接抛异常。虚拟域是 https 源，同源之下一切正常。
 *
 * ★ 传参方向：Kotlin → JS 用 `evaluateJavascript`；JS → Kotlin 用 `addJavascriptInterface`。
 *   （书页那边反过来不需要回传，所以没挂桥。）
 */
/** 虚拟域 —— 书页、预览、四颗引擎都挂在这个域下（https 源，canvas 才不被判"污染"）。 */
internal const val PREVIEW_DOMAIN = "appassets.androidplatform.net"

private const val PREVIEW_URL = "https://$PREVIEW_DOMAIN/engine/preview.html"

/** ★ 第十五轮：**只画封面**模式（竖屏封面编辑页）—— 多带一个 。 */
private const val PREVIEW_URL_COVER = "$PREVIEW_URL?cover=1"

/** 给 JS 用的基址（照片 URL 都挂在这个域下）。 */
internal fun previewBase(): String = "https://$PREVIEW_DOMAIN"

/**
 * 一张照片在预览 WebView 里的 URL。
 * · 相册选的（私有目录） ⇒ `/picked/<文件名>`
 * · 内置素材            ⇒ `/books/<书>/assets/photos/<文件名>`
 */
internal fun previewUrlOf(p: PhotoRef): String =
    if (p.builtin) {
        "${previewBase()}/books/${p.bookKey}/${p.relPath}"
    } else {
        "${previewBase()}/picked/${Uri.encode(p.file?.name ?: p.relPath)}"
    }

internal fun previewNameOf(p: PhotoRef): String =
    p.file?.name ?: p.relPath.substringAfterLast('/')

/**
 * 预览面板。照片/书名一变就重算（`LaunchedEffect` 的 key 就是"照片清单指纹"）。
 *
 * [onPlan] 把引擎算完的结果（张数/页数/失败数）回传给工作台，用来做验收判据与提示。
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun PreviewPane(
    photos: List<PhotoRef>,
    title: String,
    subtitle: String,
    coverText: Map<String, CoverConf> = emptyMap(),
    /**
     * ★ R30b：封面照片取景（序号 1 那张）—— 从草稿带过来，**进 payload**。
     *
     * 为什么进 payload 而不只靠 `setCoverPhoto` 推：推一次是"页面已加载"才好用的快路，
     * 而**冷启动恢复草稿**时页面还没就绪（推了也丢）⇒ 跟着 payload 走才万无一失。
     * （返回封面编辑页那条路照旧推一次，页面已在，立刻见效。）
     */
    coverPhoto: DraftStore.Draft.CoverPhoto? = null,
    controller: PreviewController? = null,
    modifier: Modifier = Modifier,
    onPlan: (String) -> Unit = {},
    onProgress: (String) -> Unit = {},
    /**
     * ★ 2026-10-08（第六轮）：预览页回报「用户点了封面哪处文字」。
     * 传的是 JSON：`{"el":"title|subtitle|foot|x1..x8","text":"那处当前的文字"}`。
     * 工作台据此把**左栏那一个输入框**切到对应位置。
     */
    onCoverPick: (String) -> Unit = {},
    /**
     * ★★ 第十一轮（2026-10-09）：用户在预览里**把某个文字框拖到了新位置**。
     * JSON：`{"el":"title|subtitle|foot|x1..x8","x":12.345,"y":20.5}`（**百分比**，与引擎同口径）。
     *
     * ⚠ 拖动过程中 JS 只改 `.art-page` 上的 `--ct-<key>-x/y`（本地即时反馈），
     *   **松手才回报一次** —— 每移一像素过一次桥的话，一次拖动要几百次往返。
     * ⚠ 回报之后由工作台写进 `cover` 草稿并 `setCover` 重推一次，
     *   这样**翻页/出书**拿到的都是新位置（跟手动的「左右/上下」滑块同一条通路）。
     */
    onCoverMove: (String) -> Unit = {},
    /** ★ R30：封面照片取景（序号 1 那张）被拖动/缩放过 ⇒ 回传 {x,y,z}。 */
    onCoverPhoto: (String) -> Unit = {},
    /**
     * ★★ 第十五轮（2026-10-09）：**只画封面**模式 —— 给竖屏封面编辑页用。
     *
     * 打开 `preview.html?cover=1`：单页占满 + 页面锁在第 1 页（详见那份 HTML 里的注释）。
     * ⚠ 用 URL 参数、**不在加载后补一句 JS**：compat.js 一上来就要按「单页」算尺寸，
     *   晚一步会先按跨页算一次 ⇒ 进页面**闪一下**。
     */
    coverOnly: Boolean = false,
    /**
     * ★ 第十五轮：页面**第一次加载完成**的回调（`onPageFinished`）。
     *
     * 为什么需要它：改封面/改文字都是走 `PreviewController` 的快路（`evaluateJavascript`），
     * 而**页面还没加载完时 `evaluateJavascript` 是丢的**（没有 `window.__preview`）。
     * 封面编辑页只有"进来就推一次"这一个时机 ⇒ 必须有个"好了"的通知。
     * ⚠ 与 `onPlan` 的区别：`onPlan` 是**渲染完一页**才回，本回调是**页面壳加载完**就回。
     */
    onReady: () -> Unit = {},
) {
    val ctx = LocalContext.current
    var webRef by remember { mutableStateOf<WebView?>(null) }
    var ready by remember { mutableStateOf(false) }
    /** ★ 第十五轮：本页是不是「只画封面」模式（URL 上加 `?cover=1`）。 */
    val pageUrl = if (coverOnly) PREVIEW_URL_COVER else PREVIEW_URL
    /** 预览页加载失败（只在主框架失败时置位）—— 用它把人话提示顶上来。 */
    var previewFailed by remember { mutableStateOf<String?>(null) }

    AndroidView(
        modifier = modifier.fillMaxSize(),
        factory = { c ->
            val pickedDir = PhotoStore.pickedDir(c)
            val loader = WebViewAssetLoader.Builder()
                .setDomain(PREVIEW_DOMAIN)
                .addPathHandler("/engine/", AssetsDirHandler(c, "_engine"))
                .addPathHandler("/shell/", AssetsDirHandler(c, "_shell"))
                .addPathHandler("/books/", AssetsDirHandler(c, "books"))
                .addPathHandler("/picked/", FilesPathHandler(pickedDir))
                // ★ 2026-10-11：用户字体库（全局 `files/user_fonts`）—— 预览页的 @font-face 指到这儿。
                //   与 `/picked/` 同一种做法（都映射 App 私有目录），**只增不改**，不影响任何旧行为。
                .addPathHandler("/fonts/", FilesPathHandler(FontStore.dir(c)))
                .build()

            WebView(c).apply {
                setBackgroundColor(Color.parseColor("#ECEBE4"))
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.allowFileAccess = false          // 虚拟域就够，不必开文件访问

                webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(
                        view: WebView, request: WebResourceRequest
                    ): WebResourceResponse? = loader.shouldInterceptRequest(request.url)

                    // ★★ 2026-10-08：预览页**只允许停在 preview.html**。
                    //   与书页同一个根因（系统「网页无法打开」）：任何离开它的导航
                    //   （引擎里的一句 `location.…`、一条失效重定向）一旦去解析
                    //   `https://appassets.androidplatform.net/...`，就是 DNS 失败 ⇒ 系统页。
                    //   这里 `return true` 吞掉，不加载、不 finish（预览不是页面）。
                    override fun shouldOverrideUrlLoading(
                        view: WebView, request: WebResourceRequest
                    ): Boolean = blockOrAllow(request.url?.toString())

                    @Deprecated("Deprecated in Java")
                    override fun shouldOverrideUrlLoading(view: WebView, url: String?): Boolean =
                        blockOrAllow(url)

                    fun blockOrAllow(target: String?): Boolean {
                        val t = target ?: return false
                        if (t == "about:blank") return false
                        if (t.substringBefore('#').substringBefore('?') == PREVIEW_URL) return false
                        Log.w("Preview", "拦下离开预览页的导航：$t")
                        return true
                    }

                    override fun onPageFinished(view: WebView, url: String) {
                        super.onPageFinished(view, url)
                        Log.i("Preview", "预览页加载完成：$url")
                        ready = true
                        // ★ 第十五轮：页面壳就绪 ⇒ 通知调用方可以推配置了
                        //   （封面编辑页只有"进来就推一次"这一个时机，见 onReady 注释）
                        onReady()
                    }

                    override fun onReceivedError(
                        view: WebView, request: WebResourceRequest, error: WebResourceError
                    ) {
                        super.onReceivedError(view, request, error)
                        // ★ 只认主框架；子资源失败不判整页死。
                        if (!request.isForMainFrame) return
                        Log.e("Preview", "预览页加载失败：${error.errorCode} ${error.description}")
                        // ★★ 一定要自己画错误页：**别让系统的"网页无法打开"留在屏幕上**。
                        //    这不是假想 —— 我验收时反复 dump 到过它出现在预览区。
                        //    做法：把这个 WebView 的可见性关掉（预览就空着），
                        //    由外层显示人话提示。
                        //    ⚠ GONE 是关键：系统的错误页是 WebView **自己**渲染的、
                        //      且**先于**本回调；只靠 Compose 盖一层，中间那一帧照样闪。
                        previewFailed = "${error.errorCode} ${error.description}"
                        view.stopLoading()
                        view.visibility = android.view.View.GONE
                    }

                    /**
                     * ★ HTTP 层失败（404/500）**不走 `onReceivedError`** —— 只接前一个会漏。
                     */
                    override fun onReceivedHttpError(
                        view: WebView, request: WebResourceRequest,
                        errorResponse: WebResourceResponse
                    ) {
                        super.onReceivedHttpError(view, request, errorResponse)
                        if (!request.isForMainFrame) return
                        Log.e("Preview", "预览页 HTTP 失败：${errorResponse.statusCode}")
                        previewFailed = "HTTP ${errorResponse.statusCode}"
                        view.stopLoading()
                        view.visibility = android.view.View.GONE
                    }

                    /**
                     * ★ 渲染进程退出（低内存回收）—— 必须 `return true`，
                     *   否则整个 App 跟着崩（铁律：不许崩溃）。
                     */
                    override fun onRenderProcessGone(
                        view: WebView, detail: android.webkit.RenderProcessGoneDetail?
                    ): Boolean {
                        Log.e("Preview", "预览渲染进程退出")
                        previewFailed = "预览渲染进程退出了"
                        view.visibility = android.view.View.GONE
                        return true
                    }
                }

                addJavascriptInterface(object {
                    @JavascriptInterface
                    fun onPlan(json: String) {
                        // ⚠ JS 线程回调 ⇒ 必须搬回主线程再动 Compose 状态
                        Handler(Looper.getMainLooper()).post { onPlan(json) }
                    }

                    /**
                     * ★ 2026-10-08（第六轮）：用户**点了封面上的哪处文字**（预览页事件委托回报）。
                     * 身份是引擎自带的标记反查出来的：`title` / `subtitle` / `foot` / `x1`..`x8`。
                     * ⚠ 同样搬回主线程；⚠ 桥没挂上时预览页那边已 try 住，不会崩。
                     */
                    @JavascriptInterface
                    fun onCoverPick(json: String) {
                        Handler(Looper.getMainLooper()).post { onCoverPick(json) }
                    }

                    /**
                     * ★★ 第十一轮：拖完文字框，回报**最终位置**（百分比）。
                     * ⚠ 与 `onCoverPick` 一样必须搬回主线程 —— 里面要动 Compose 状态。
                     */
                    @JavascriptInterface
                    fun onCoverMove(json: String) {
                        Handler(Looper.getMainLooper()).post { onCoverMove(json) }
                    }

                    /**
                     * ★★ R30（2026-10-13）：**封面照片取景**松手回报 `{x,y,z}`
                     *   （x/y = 取景中心百分比、z = 缩放 1~4）。
                     * ⚠ 与 `onCoverMove` 一样必须搬回主线程 —— 里面要动 Compose 状态。
                     */
                    @JavascriptInterface
                    fun onCoverPhoto(json: String) {
                        Handler(Looper.getMainLooper()).post { onCoverPhoto(json) }
                    }
                }, "PreviewBridge")

                // ★ 出书（M5）要写文件 ⇒ 单独的桥。
                //   ⚠ 这两个**故意不搬主线程**：JS 会**同步等返回值**（书目录路径 / 是否写成），
                //     若丢到主线程排队就成了"调用方等自己"⇒ 死锁。
                //     写文件在 JS 线程上做是安全的（不碰任何 View）。
                addJavascriptInterface(object {
                    @JavascriptInterface
                    fun publishBook(dirId: String, html: String, planJson: String): String =
                        BookWriter.writeBook(c, dirId, html, planJson)?.absolutePath ?: ""

                    /**
                     * ★★ 2026-10-12（F164）：**写真**—— 传文件名 + 源路径 + 成品尺寸，
                     *   由 Kotlin 解码/转正/缩放/压 JPEG 落盘（**不再过 base64 大桥**，
                     *   实测那套路子 90 张要 6.6 s 编码 + 37.5 MB 字符串，见 BookWriter.writeArtwork）。
                     *   [srcPath] 形如 `/picked/<文件名>` 或 `/books/<书>/assets/photos/<文件名>`。
                     */
                    @JavascriptInterface
                    fun addBookPhoto(
                        dirPath: String, fileName: String, srcPath: String, w: Int, h: Int
                    ): Boolean = BookWriter.writeArtwork(c, File(dirPath), fileName, srcPath, w, h)

                    @JavascriptInterface
                    fun progress(text: String) {
                        Handler(Looper.getMainLooper()).post { onProgress(text) }
                    }
                }, "BookBridge")

                loadUrl(pageUrl)
                webRef = this
                controller?.wv = this          // 交给工作台当"遥控器"（改档位/改封面走快路）
            }
        },
        // ★ AndroidView 的 factory 只跑一次 ⇒ url 不对时要补一次重载。
        //   （同 BookPageActivity 那个坑：系统错误页会一直留着。）
        update = { wv ->
            if (wv.url != pageUrl && previewFailed == null) wv.loadUrl(pageUrl)
        }
    )

    // ★ 预览失败 ⇒ 显示人话 + 一个「重试」，绝不把系统的「网页无法打开」留在屏幕上
    if (previewFailed != null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("预览暂时打不开", color = Ink, fontSize = 14.sp)
                Spacer(Modifier.height(4.dp))
                Text("重试一下就好", color = Ink.copy(alpha = 0.55f), fontSize = 12.sp)
                Spacer(Modifier.height(12.dp))
                Text("重试", color = Accent, fontSize = 13.sp,
                    modifier = Modifier
                        .clip(RoundedCornerShape(14.dp))
                        .clickable {
                            previewFailed = null
                            webRef?.apply {
                                visibility = android.view.View.VISIBLE
                                loadUrl(pageUrl)
                            }
                        }
                        .padding(horizontal = 22.dp, vertical = 8.dp))
            }
        }
    }

    // 照片清单"指纹"变了就重算 —— key 用位置+名字，顺序变了也会触发（拖拽排序要的）
    // ⚠ 指纹里**不含档位/封面/文字**：那几样走 `PreviewController` 的快路，
    //   否则每点一次"大/中/小"、每敲一个字都要把全部照片重新解码一遍（十几秒）。
    val fingerprint = photos.joinToString("|") { "${it.key}#${it.order}" }
    // ① 重算（**会重新解码全部照片**）—— 只在"照片集合/顺序变了"或"页刚就绪"时跑。
    //    ★ 2026-10-08（第四轮）：键里**去掉了 title/subtitle**。它们在键里的话，
    //      封面的书名/副标题输入框每敲一个字就触发一次全量重解码（十几秒/次）⇒
    //      输入框根本没法用。文字改走下面的 ② 快路（只覆盖 state.payload 再重画当前页）。
    LaunchedEffect(ready, fingerprint) {
        val wv = webRef ?: return@LaunchedEffect
        if (!ready) return@LaunchedEffect
        val payload = buildPayloadJson(ctx, photos, title, subtitle, coverText, coverPhoto)
        Log.i("Preview", "送去预览：${photos.size} 张 · ${payload.length} 字符")
        wv.evaluateJavascript(
            "window.__preview && window.__preview.render($payload)", null)
    }
    // ② 封面文字（书名 / 副标题）—— 快路，**不重新解码照片**。
    //    进度：输入框 onValueChange → 工作台 state → 这里 → 预览页 setText → showPage。
    //    ⚠ 空串也照传：预览页会按 `pay.title || 默认` 兜底，与"清空=回默认"的口径一致。
    LaunchedEffect(ready, title, subtitle) {
        val wv = webRef ?: return@LaunchedEffect
        if (!ready) return@LaunchedEffect
        val o = JSONObject().apply {
            put("title", title)
            put("subtitle", subtitle)
        }
        castJsonString(o.toString())?.let {
            // ★ 第十五轮：「只画封面」时走**静默**那条 —— 就地改文字节点，**不重建页面**
            //   （重画会让封面的 <img> 重新解码 ⇒ 打字时一闪一闪）。
            //   ⚠ 跨页预览**不能**用静默：书名还出现在扉页/版权页/封底（template.js）
            //     ⇒ 那边必须 `showPage()` 重画，翻到哪页都是新字。
            val fn = if (coverOnly) "setTextSilent" else "setText"
            wv.evaluateJavascript("window.__preview && window.__preview.$fn($it)", null)
        }
    }
}

/**
 * 封面文字的出厂默认（书名 / 副标题）。
 *
 * ⚠ **第二十轮口径统一**：空标题 = 空标题，三处（本处、工作台输入框初值、预览页 JS）
 *   都不再把空串兜底成某个默认字。用户一旦清空/删除，谁都不许再自动塞回默认字
 *   （这正是他报"死板固定/删不掉"的根因）。
 *
 * ★★ **R31（2026-10-14，他 2026-10-14 报）**：默认字**必须中性、规范**。
 *   原来出厂默认是 `我的小狗` / `Photographs` ⇒ 他新做的每一本画册封面都顶着
 *   "我的小狗"，看着像**残留的样板文字**而不是他自己的书名。
 *   ⇒ 改成规范占位：标题 `画册 N`（**按已有本地书数递增**），副标题 `副标题`。
 *
 * ⚠ 为什么标题**不能是常量**：编号得看当前已有几本 ⇒ 必须是 [defaultBookTitle] 函数。
 *   常量 `DEFAULT_TITLE` 已删除（它唯一的用途就是给 Compose 当初值）。
 *   ⚠ 判据 [isDefaultText] 因此改成**认编号形态**（`画册 1` / `画册 12` 都算默认），
 *   否则用户把自动名原样留着时会被当成"改过了"，草稿永远清不掉。
 */
internal const val DEFAULT_SUBTITLE = "副标题"

/** 规范书名的形态：`画册 1`、`画册 2`…（编号只认阿拉伯数字，空格可有可无）。 */
private val AUTO_TITLE_RE = Regex("^画册\\s*\\d+$")

/**
 * 自动书名 = `画册 (已有本地书数 + 1)`。
 *
 * 口径（佘先生 2026-10-14 定的）：
 * · 只数**用户自己出的书**（`files/books/` 下带 `index.html` 的目录）；
 * · **内置教学画册不计号** —— 它是说明书，不该占掉"画册 1"这个序号；
 * · **历史书不回溯改名** —— 已出的书名字不动，只有**新出的书**才走规范名。
 *
 * ⚠ 这也是他要求"新出的书一定要规范"里"新"字的那一半：老书一律不碰。
 */
internal fun defaultBookTitle(context: Context): String {
    val n = try {
        BookWriter.booksRoot(context).listFiles()
            ?.count { it.isDirectory && File(it, "index.html").isFile } ?: 0
    } catch (t: Throwable) {
        Log.w("Preview", "数已有画册失败，退回「画册 1」", t)
        0
    }
    return "画册 ${n + 1}"
}

/**
 * ★ 第十九轮（代码优化）：书名/副标题是否还是「出厂默认」—— **三处重复的判据合一**。
 *
 * 原本 `Draft.isEmpty` / `DraftStore.saveNow` / `WorkbenchActivity.saveDraftSoon` 三处
 * 各写了一遍 `(title.isBlank() || title == 默认字) && (subtitle… )`。
 * 语义 = 「书名和副标题都还是默认/空」⇒ 才算"文字没动过"。
 *
 * ★★ **R31**：默认书名不再是一个常量，而是 [defaultBookTitle] 每次按已有书数算出来的
 *   ⇒ 判据必须**认形态**（[AUTO_TITLE_RE]）而不是认某一个固定字符串，
 *   否则「画册 1」和「画册 2」会一个算默认、一个不算。
 */
internal fun isDefaultText(title: String, subtitle: String): Boolean =
    (title.isBlank() || AUTO_TITLE_RE.matches(title.trim())) &&
        (subtitle.isBlank() || subtitle == DEFAULT_SUBTITLE)

/** 拼 payload（照片 URL 必须是虚拟域的**绝对**地址，否则引擎读不到图）。 */
private fun buildPayloadJson(
    context: Context, photos: List<PhotoRef>, title: String, subtitle: String,
    coverText: Map<String, CoverConf>,
    coverPhoto: DraftStore.Draft.CoverPhoto? = null,
): String {
    val arr = JSONArray()
    photos.forEachIndexed { i, p ->
        arr.put(JSONObject().apply {
            // ⚠ `order` 用**下标+1**：拖拽排序后它就是新的页序（见 PhotoGrid.toPlateArgs）
            put("order", i + 1)
            put("name", previewNameOf(p))
            put("url", previewUrlOf(p))
            // ★ F166：照片指纹（长度+最后修改时间）—— 预览页拿它当**探针缓存的失效键**。
            //   照片被替换/改过 ⇒ 指纹变 ⇒ 缓存键失效 ⇒ 自动回退重新解码，绝不用旧数据冒充新图。
            //   ⚠ 内置素材 `file` 为 null ⇒ 用 key（随包不变，恒命中缓存，正合适）。
            put("stamp", photoStampOf(p))
            // 用户改过的档位 —— 预览页会在 `assignPlates` 之后把它们盖上去
            p.plate?.let { put("plate", it) }
            p.position?.let { put("position", it) }
        })
    }
    return JSONObject().apply {
        put("photos", arr)
        // ★★ 第二十轮：不再回落默认 —— 空标题就是空标题（用户要求封面文字不"死板固定"、
        //   能真正删空）。默认初值仍由 Compose 的 `title = defaultBookTitle(ctx)` 提供首屏观感，
        //   但一旦用户清空/删除，绝不再自动塞回默认字（R31 起默认字 = `画册 N` / `副标题`）。
        put("title", title)
        put("subtitle", subtitle)
        put("coverText", coverTextJson(coverText))
        // ★ R30b：封面照片取景 —— **只带非默认值**（默认就不写这个字段，
        //   老书/没调过的场景 payload 与从前逐字节一致，页面那边也不会动 CP）。
        if (coverPhoto != null && !coverPhoto.isDefault) {
            put("coverPhotoView", JSONObject().apply {
                put("x", coverPhoto.x.toDouble())
                put("y", coverPhoto.y.toDouble())
                put("z", coverPhoto.z.toDouble())
            })
        }
        // ★ 2026-10-11：用户字体（全局库）—— 预览页据此注入 @font-face 并喂给引擎的
        //   `setFontFamilies`（内置四项照旧由引擎兜底，这里只补 `ufN` 那几条）。
        put("userFonts", userFontsJson(context))
    }.toString()
}

/**
 * ★ F166：一张照片的**内容指纹**（长度 + 最后修改时间）。
 *
 * 为什么需要它：预览页要给探针结果做缓存（换封面/拖排序时照片一张没变，
 * 不该把 90 张重新解码一遍）。缓存键若只用 url，文件被替换后就会**拿旧数据冒充新图**。
 * 加上长度+时间 ⇒ 内容一变键就变 ⇒ 自动回退重新解码。
 * ⚠ 内置素材没有 `file`（在 assets 里）⇒ 用 key 兜底：它随包不变，恒命中缓存正是我们要的。
 */
private fun photoStampOf(p: PhotoRef): String {
    val f = p.file
    if (f == null) return p.key
    return try { "${f.length()}_${f.lastModified()}" }
    catch (t: Throwable) { p.key }
}

/**
 * 用户字体清单：`[{key,name,url}]`。
 * `url` 是虚拟域下的 `/fonts/<文件>`（由 [FontStore.dir] 那个路径处理器提供）。
 */
internal fun userFontsJson(context: Context): JSONArray {
    val arr = JSONArray()
    try {
        FontStore.list(context).forEach { f ->
            arr.put(JSONObject().apply {
                put("key", f.key)
                put("name", f.name)
                put("url", previewBase() + "/fonts/" + Uri.encode(f.file))
            })
        }
    } catch (t: Throwable) {
        Log.w("Preview", "读用户字体清单失败（当没有）", t)
    }
    return arr
}

/**
 * 封面文案 → 引擎要的 `cover_text` JSON。
 * 空配置整个是 `{}` —— 引擎的 `normalizeCoverText` 见到 `{}` 就什么都不改（保留 CSS 默认值）。
 */
internal fun coverTextJson(cover: Map<String, CoverConf>): JSONObject {
    val o = JSONObject()
    cover.forEach { (el, c) ->
        if (c.isEmpty()) return@forEach
        val e = JSONObject()
        c.hide?.let { e.put("hide", it) }
        c.x?.let { e.put("x", it.toDouble()) }
        c.y?.let { e.put("y", it.toDouble()) }
        c.size?.let { e.put("size", it.toDouble()) }
        c.w?.let { e.put("w", it.toDouble()) }
        c.color?.let { e.put("color", it) }
        c.font?.let { e.put("font", it) }
        c.align?.let { e.put("align", it) }
        c.italic?.let { e.put("italic", it) }
        // ★ 第六轮：文字框的 `text`（引擎只对 extras 认这个字段）
        c.text?.takeIf { it.isNotEmpty() }?.let { e.put("text", it) }
        o.put(el, e)
    }
    return o
}

/**
 * 预览 WebView 的"遥控器"（M4c）。
 *
 * ★ 为什么要有它：改档位/改封面是**快路**（只重排页序、不重新探测），
 *   不能让它们走 `LaunchedEffect` 的整包重算 —— 那个会重新解码全部照片（十几秒）。
 *   ⇒ 工作台直接拿这个对象朝 WebView 里 `evaluateJavascript`。
 */
class PreviewController {
    internal var wv: WebView? = null

    private fun call(js: String) {
        val w = wv ?: return
        w.post { w.evaluateJavascript(js, null) }
    }

    /** 改某一张的版面档位 / 位置（`auto` = 恢复自动）。 */
    fun applyEdit(order: Int, plate: String, position: String) {
        call("window.__preview && window.__preview.applyEdit($order,'$plate','$position')")
    }

    /** 重新自动排版（引擎按清晰度名次重算全部档位）。 */
    fun autoArrange() = call("window.__preview && window.__preview.autoArrange()")

    /**
     * ★ R30：推**封面照片取景**（`{x,y,z}`）—— 进页面恢复草稿时用。
     * 走快路（不重画）：那边只改 img 的 object-position / transform。
     */
    fun setCoverPhoto(json: String) {
        castJsonString(json)?.let { call("window.__preview && window.__preview.setCoverPhoto($it)") }
    }

    /** 改封面文案（传 [coverTextJson] 的 JSON 字符串）。 */
    fun setCover(json: String) {
        castJsonString(json)?.let { call("window.__preview && window.__preview.setCover($it)") }
    }

    /**
     * ★★ 第十五轮：改封面配置但**一个字节都不重画**。
     *
     * 给「拖动文字框」用（他报的「移动文字会闪烁或排版错误」）：
     * 旧路是 `setCover()` ⇒ 页面 `showPage()` ⇒ `innerHTML` 整页重建（图重新解码）+ 重算书尺寸
     * ⇒ 闪一下 + 整本书跳一下。拖动本来就已经把 `--ct-<key>-x/y` 改在 DOM 上了，
     * 这里只需把 state 对齐（翻页/出书读的就是 state）。
     * ⚠ **删除/隐藏/改样式仍然走 [setCover]** —— 那几件必须重画才看得出来。
     */
    fun setCoverSilent(json: String) {
        castJsonString(json)?.let {
            call("window.__preview && window.__preview.setCoverSilent($it)")
        }
    }

    /**
     * 改封面**文字**（书名 / 副标题）—— 2026-10-08（第四轮）。
     *
     * ★ 走 `setText` 快路，**不重新解码照片**。不能拿 `render()` 跟着输入框走：
     *   那个会把每张照片重新解码 + 跑探测（十几张 = 十几秒），敲一个字卡一次。
     * ⚠ 传的是 `{"title":…,"subtitle":…}` 的 JSON **字符串**（与 [setCover] 同一套转义）。
     */
    fun setText(json: String) {
        castJsonString(json)?.let { call("window.__preview && window.__preview.setText($it)") }
    }

    /**
     * ★ 2026-10-08（第六轮）：**只**改页脚那一行的文字。
     *
     * 为什么单列一个方法（不并进 [setText]）：面板里那个输入框是**一次只编一处**的，
     * 每次敲键都重发整包（title+subtitle+foot）是浪费；而且页脚文字**不在 payload 里**
     * （是引擎按张数现算的），得走预览页那条渲染后替换的路。
     * ⚠ 传空串 ⇒ 预览页保持引擎原样（N PHOTOGRAPHS）。
     * ⚠ 这里**不用** `castJsonString`：那函数是给 JSON 用的，页脚是**裸字符串**，
     *   必须自己转义引号与反斜杠，否则用户打个双引号就把 JS 拼坏了。
     * ⚠★ 本段注释里**一个双引号都不许出现**：`kt_lint` 的状态机见它就进字符串模式，
     *   随后的**注释结束标记**会被当成字符串内容 ⇒ 块注释提前不闭合 ⇒ 后面整段代码被当注释
     *   （★ 本轮真踩过：中文引号 `「」` 同样会被它当成普通双引号）。
     */
    fun setFootText(text: String) {
        jsStringLiteral(text)?.let {
            call("window.__preview && window.__preview.setFootText($it)")
        }
    }

    /**
     * ★★ 第十五轮：页脚文字的**静默**版（就地改节点、不重画）—— 给「只画封面」那一页打字用。
     * ⚠ 封面的页脚只出现在封面上 ⇒ 就地改就够；跨页预览仍然走 [setFootText]。
     */
    fun setFootTextSilent(text: String) {
        jsStringLiteral(text)?.let {
            call("window.__preview && window.__preview.setFootTextSilent($it)")
        }
    }

    /**
     * ★ 第七轮（第④条）：**哪一个文字框正在发亮**（两段式删除的第一下）。
     *
     * ⚠ 传**空串** = 全部不发亮（`markActiveExtra(null)`）。
     * ⚠ 这是**编辑态的临时状态**：不进草稿、不进 `coverText`、**成品书上不存在**
     *   （描边那段 CSS 只由 `preview.html` 注入，成品书走静态文件加载不到）。
     */
    fun setActiveExtra(ct: String) {
        jsStringLiteral(ct)?.let {
            call("window.__preview && window.__preview.setActiveExtra($it)")
        }
    }

    /** 出书（M5）—— 结果由预览页通过 `PreviewBridge.onPlan` 回传（见 [PreviewPane] 的 onPlan）。 */
    fun publish() = call("window.__preview && window.__preview.publish()")

    /** 重新量尺寸 —— 左栏收起/展开后 WebView 变宽，得让 compat.js 重算一次（否则书还是老大小）。 */
    fun relayout() = call("window.__preview && window.__preview.relayout()")
}

/**
 * 把一段 JSON 当成 **JS 字符串字面量**塞进 `evaluateJavascript`。
 * 用 `JSONObject.quote`（等价于标准 JSON 转义）—— 手工拼引号一定会漏掉
 * 反斜杠/换行/中文的转义（旧工程在封面预览那步就踩过）。
 */
internal fun castJsonString(json: String): String? = try {
    org.json.JSONObject.quote(json)
} catch (t: Throwable) {
    Log.e("Preview", "封面配置转义失败", t)
    null
}

/**
 * ★ 2026-10-08（第六轮）：把**一段普通文字**转成 JS 字符串字面量。
 *
 * 与 [castJsonString] 的区别：那个的入参是**整段 JSON**（引号外还要再包一层），
 * 这个直接把文字本身变成一个可拼进 JS 的字面量 —— 用于页脚那种用户随手打的东西。
 * ⚠ 同样走 `JSONObject.quote`：中文、引号、反斜杠、换行都会被正确转义
 *   （手工拼引号必然漏，旧工程在封面预览那步就踩过这个）。
 * ⚠ 与 [setFootText] 那段一样：**注释里一个双引号都不许有**（否则结束标记会被吞）。
 */
internal fun jsStringLiteral(text: String): String? = try {
    org.json.JSONObject.quote(text)
} catch (t: Throwable) {
    Log.e("Preview", "封面文字转义失败", t)
    null
}
