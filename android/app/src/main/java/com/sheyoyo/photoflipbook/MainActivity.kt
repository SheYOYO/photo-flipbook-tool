package com.sheyoyo.photoflipbook

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import android.util.Log
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.WindowCompat
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File

/**
 * 一本书（书架列表用）。
 *
 * @param key     目录名 —— 也是书页 URL 里的那一段
 * @param builtin `true` = 打包在 assets 里的内置演示书；`false` = 用户出的书（私有目录）
 * @param dir     非内置时有效（删书、导出要用）
 * @param coverKey `book-plan.json` 里 `photos[0].artwork`（**相对书目录**的路径）——
 *                 书架封面就用它；取不到就退回占位色块
 * @param external `true` = **书库文件夹里的书**（还没拷进私有目录）——
 *                 点开时才导入，读书那条路一行都不用改
 * @param docId    书库书在 SAF 里的 document id（导入与按需读封面用）
 */
data class Book(
    val key: String,
    val builtin: Boolean,
    val dir: File?,
    val title: String,
    val subtitle: String,
    val photoCount: Int,
    val coverKey: String?,
    val external: Boolean = false,
    val docId: String? = null,
)

/** 从 `book-plan.json` 的正文里抽书名/副标题/张数/封面（两处扫描共用一份逻辑）。 */
private class PlanInfo {
    var title = ""
    var subtitle = ""
    var photos = 0
    var cover: String? = null

    fun fillFromJson(text: String) {
        val o = JSONObject(text)
        title = o.optString("title", "")
        subtitle = o.optString("subtitle", "")
        val arr = o.optJSONArray("photos")
        photos = arr?.length() ?: 0
        if (arr != null && arr.length() > 0) {
            val a = arr.optJSONObject(0)?.optString("artwork", "") ?: ""
            cover = a.ifBlank { null }
        }
    }
}

/**
 * 书架 = 「内置演示书」+「`files/books` 下每本用户书」。
 *
 * ⚠ 判定规则照旧工程：**有 `index.html` 就算一本书**，不靠任何登记表。
 * ⚠ 书名优先级照旧工程：`book-plan.json` 的 `title` → 页面 `<title>` → 目录名。
 *   为什么不是"目录名优先"：目录名是 `book-20261006-112744` 这种时间戳，用户看不懂。
 *
 * ⚠ 块注释里**不要出现开注释的那两个字符**（斜杠＋星号），哪怕只想表示"通配"——
 *   Kotlin 的块注释**支持嵌套**：正文里多一个开标记就多一层，最外层少一个闭标记
 *   ⇒ 注释一直吞到文件尾 ⇒ 编译报 `Unclosed comment`。我这次连栽两回。
 */
fun scanBooks(context: Context, root: File): List<Book> {
    val out = ArrayList<Book>()

    // ① 内置演示书（assets/books/<名>/index.html）—— 让 App 一装上就有书可翻
    try {
        for (name in context.assets.list("books").orEmpty()) {
            val files = context.assets.list("books/$name").orEmpty()
            if (name.isBlank() || !files.contains("index.html")) continue
            val info = PlanInfo()
            try {
                info.fillFromJson(context.assets.open("books/$name/book-plan.json")
                    .bufferedReader().use { it.readText() })
            } catch (t: Throwable) {
                Log.w("Shelf", "内置书 $name 的 book-plan.json 读不了，退回目录名", t)
            }
            out += Book(name, true, null,
                info.title.ifBlank { name }, info.subtitle, info.photos, info.cover)
        }
    } catch (t: Throwable) {
        Log.w("Shelf", "列内置书失败", t)
    }

    // ② 用户出的书
    if (root.isDirectory) {
        for (dir in (root.listFiles() ?: emptyArray())) {
            if (!dir.isDirectory || !File(dir, "index.html").isFile) continue
            val info = PlanInfo()
            val plan = File(dir, "book-plan.json")
            if (plan.isFile) {
                try {
                    info.fillFromJson(plan.readText())
                } catch (_: Throwable) {
                    // 清单坏了不该让书架崩 —— 退回目录名
                }
            }
            if (info.photos == 0) {
                info.photos = File(dir, "assets/photos").listFiles()
                    ?.count { it.isFile && it.name.lowercase().endsWith(".jpg") } ?: 0
            }
            out += Book(dir.name, false, dir,
                info.title.ifBlank { dir.name }, info.subtitle, info.photos, info.cover)
        }
        // 用户书排前面（新的在前），内置演示书垫底
        out.sortWith(compareByDescending<Book> { it.builtin == false }
            .thenByDescending { it.dir?.lastModified() ?: 0L })
    }
    return out
}

class MainActivity : ComponentActivity() {
    /** 预热用的 WebView（见 [warmUpWebView]）—— 持有到 Activity 销毁，避免泄漏。 */
    private var warmWeb: WebView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // ★★ 2026-10-10（二十一轮）：**内容铺满整块屏幕**，与书页（BookPageActivity）同一口径。
        //
        //   不加这行时，window 会让开系统栏 ⇒ 内容区是 `[73,84][2267,1080]`，
        //   而整块屏幕是 `[0,0][2340,1080]` ⇒ **左、上各留一条白边**
        //   （真机 vivo Z5 像素级实测：`tools/_ui_shift_probe.py` + 书架态扫描）。
        //   这正是佘先生报的「整个软件偏右下方」在书架页的那一半。
        //
        //   ⚠ 铺满的是**背景**（`Surface(color = Paper)` 随之铺满全屏、状态栏透明地浮在上面）；
        //     **内容**仍靠下面的 `sysBars()`（`windowInsetsPadding(safeDrawing)`）避开系统栏
        //     ⇒ 标题与卡片的位置一个像素不变，只是白边没了。
        WindowCompat.setDecorFitsSystemWindows(window, false)

        // ★ 开着 WebView 调试 —— 否则验收时"看不见"书页里面发生了什么
        //   （书是网页，DOM 才是真相；只靠截图只能判到"像不像"）。
        //   ⚠ 只有 debug 包有意义；正式包要去掉。
        try {
            WebView.setWebContentsDebuggingEnabled(true)
        } catch (t: Throwable) {
            Log.w("Shelf", "开 WebView 调试失败（不影响功能）", t)
        }

        // ⚠ 目录必须在 Activity 里算好再传进 Composable ——
        //   `getExternalFilesDir` 是 Activity 的方法，Composable 里拿不到 `this`。
        val booksRoot = File(getExternalFilesDir(null) ?: filesDir, "books")
        val appCtx = applicationContext

        // ★ 预热 WebView：Chromium 是**进程级**初始化，先造一个空 WebView 把它拉起来
        //   ⇒ 点开书不再是白屏等（清单第 4 节第 2 条）。
        //   延迟一点，别拖慢第一帧。
        Handler(Looper.getMainLooper()).postDelayed({
            warmWeb = warmUpWebView(appCtx)
        }, 400)

        setContent {
            PhotoFlipbookTheme {
                // ★ 第十轮②：加系统栏安全内边距（透明状态栏 + 刘海 ⇒ 内容必须往里让）
                Surface(Modifier.fillMaxSize(), color = Paper) {
                    Box(Modifier.fillMaxSize().sysBars()) { ShelfScreen(booksRoot, appCtx) }
                }
            }
        }
    }

    override fun onDestroy() {
        try {
            warmWeb?.destroy()
        } catch (t: Throwable) {
            Log.w("Shelf", "销毁预热 WebView 失败（无害）", t)
        }
        warmWeb = null
        super.onDestroy()
    }
}

/**
 * 预热 WebView：造一个空白实例把 Chromium 引擎拉起来即销毁引用。
 * 失败不该影响任何功能 ⇒ 全程 try-catch。
 */
private fun warmUpWebView(context: Context): WebView? = try {
    WebView(context).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        loadUrl("about:blank")
    }
} catch (t: Throwable) {
    Log.w("Shelf", "WebView 预热失败（不影响功能）", t)
    null
}

// 观感沿用书页那套"纸感"：米底、深墨字、衬线感靠字重与间距拉开
internal val Paper = Color(0xFFF4F2EA)
internal val Ink = Color(0xFF2C2C2A)
internal val Line = Color(0x1F2C2C2A)

@Composable
internal fun PhotoFlipbookTheme(content: @Composable () -> Unit) {
    MaterialTheme(content = content)
}

/** 书库目录的显示名：SAF 的 tree id 形如 `primary:Download/照片画册`（vivo 上还会是 `raw:/storage/…`）
 *  ⇒ 取**最后一段**，界面上显示成「照片画册」而不是一长串路径。 */
private fun treeLabel(uri: Uri): String = try {
    DocumentsContract.getTreeDocumentId(uri)
        .substringAfterLast(':').trimEnd('/').substringAfterLast('/').ifBlank { "书库" }
} catch (t: Throwable) {
    uri.lastPathSegment ?: "书库"
}

// ============================================================================
// ★ 第十轮③（2026-10-09）**重建**：`sysBars` + `ShelfScreen`
//
// ⚠⚠⚠ **为什么要重建**（这一段是事故记录，别删）：
//   我在给 `sysBars` 加「转屏后重算」的能力时，用脚本按行号删「旧的重复定义」，
//   **行号算错了** —— `next(k for k,l if ...)` 找到的是**第一个**定义，
//   而后面的 `while lines[e] != "}"` 一直往下找**下一个**独立的 `}`，
//   结果一路扫到文件尾（605 行）⇒ **把 `sysBars` 之后的全部内容都删了**：
//   `ShelfScreen`（书架主体，约 250 行）与 SAF 授权那一段全没了。
//   ⚠ APK 里只有 dex（不能反编译回源码）、Gradle 缓存里也没有源快照
//   ⇒ **只能按契约重建**。
//   ★ 重建依据（不是猜）：① `Book`/`PlanInfo`/`scanBooks` 都还在文件里；
//     ② 验收脚本 `_m4c.py` 依赖的 **8 个 testTag** 是硬契约；
//     ③ 上一轮真机截图 `shots/r10-shelf-fixed.png` 给出了目标观感。
//
// ★★ **教训（已写进 L0/L1）**：
//   ⛔ **按行号批量改文件前必须先 `git commit` 或备份**，不能只靠"我记得内容"；
//   ⛔ 删多行的脚本**必须先打印待删范围让人确认**，不能一把梭；
//   ⛔ 改记忆层（`MEMORY.md`）时也要这样 —— 我今天已经因此截断过一次 L0。
// ============================================================================

/**
 * ★ 系统栏安全内边距（**第十轮② 新增**）。
 *
 * ⚠ 真机实测（vivo Z5 · 2340×1080 · dpr3）：清单主题声明了
 * `statusBarColor=#00000000` + `navigationBarColor=#00000000`
 * + `windowLayoutInDisplayCutoutMode=shortEdges` ⇒ 内容**该往里让**，
 * 而这两个界面都只写了 `Surface(Modifier.fillMaxSize())` ⇒ **内容被状态栏压住**
 * （截图实证：标题与系统时钟重叠）。
 *
 * ⚠⚠ **转屏后这个内边距不会自动更新**（第十轮③ 实测踩到）：
 *   横屏时顶栏让开了（`y=96`），一点封面页签转竖屏 ⇒ **又被压住了**（`y≈0`）。
 *   原因：`windowInsetsPadding()` 是普通 `Modifier`，读 insets 的时机是
 *   **组合时算一次并记进布局节点**；「窗口尺寸变了」不会让它失效。
 *   ⚠ 试过 `LocalConfiguration.current` —— **没用**：清单声明了
 *   `configChanges="orientation|screenSize|..."` ⇒ **配置变化被 Activity 自己吃掉**、
 *   不会重建 ⇒ 那个值永远不变。
 *
 * @param forceRecalc **每次转屏必变的值**（调用方传 `coverPortrait`）。
 *   ★ 它本身不参与 padding 计算，**只为了让这个 Modifier 在转屏时被重建**。
 */
@Composable
internal fun Modifier.sysBars(forceRecalc: Any? = null): Modifier =
    this.windowInsetsPadding(WindowInsets.safeDrawing)

/**
 * 书架：列出内置演示书 + `files/books` 下每本用户书，点一本进它。
 *
 * ⚠ **testTag 是硬契约** —— `C:/psb-build/tools/_m4c.py` 的 `enter_workbench()`
 *   就是靠 `shelf-new` 进工作台；验收脚本还依赖 `shelf-card-N` / `shelf-count` /
 *   `shelf-lib-*`。⚠⚠ **改名 = 所有验收脚本一起失效**（F139 已栽过一次：
 *   testTag 猜错 ⇒ 误判"控件不存在"）。
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ShelfScreen(root: File, appCtx: Context) {
    // ★★★ **testTag 必须挂上这个才暴露成 resource-id** —— uiautomator 只认 resource-id。
    //   ⚠⚠ 漏了它 ⇒ 界面上功能全都正常，但 `dump` 里**一个 testTag 都读不到**
    //   ⇒ 验收脚本全判"控件不存在"（我重建书架后踩了一次，症状与 F139 一模一样）。
    val tagOn = Modifier.semantics { testTagsAsResourceId = true }
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var refresh by remember { mutableStateOf(0) }
    var tip by remember { mutableStateOf("") }
    /** 书库（SAF 目录）里扫出来的书；未绑定/授权失效时是空表。 */
    var ext by remember { mutableStateOf<List<LibraryStore.ExtBook>>(emptyList()) }
    /**
     * ★ 第十七轮：**待确认删除**的那本（null = 没有对话框）。
     *
     * 存整个 [Book] 而不是 key：删的时候要同时用到 `builtin` / `external` / `docId` / `key`
     * （四种来源的删法不同），而且在对话框弹着的时候列表**可能刚被 ON_RESUME 重扫过**
     * ⇒ 按 key 回去查会查不到（对象已经换了一批新的）。
     */
    var delAsk by remember { mutableStateOf<Book?>(null) }
    /** 正在删（防止连点两下重复删同一本）。 */
    var deleting by remember { mutableStateOf(false) }

    val libName = remember(refresh) { LibraryStore.libraryName(ctx) }
    val local = remember(refresh) { scanBooks(appCtx, root) }

    // ★ 扫书库：**后台线程**，别卡第一帧。授权失效 ⇒ 当空表（人话提示留在书库条上）。
    LaunchedEffect(refresh) {
        val tree = LibraryStore.libraryTree(ctx)
        ext = if (tree == null) emptyList() else withContext(Dispatchers.IO) {
            try { LibraryStore.scan(ctx, tree) }
            catch (t: Throwable) { Log.w("Shelf", "扫书库失败", t); emptyList() }
        }
    }

    /**
     * ★★★ `F150`（2026-10-09）：**回到前台就重新扫一遍**。
     *
     * ⚠⚠ 他报「**画册都无法打开**」，根因就在这儿：
     *   工作台出书后是用 **`FLAG_ACTIVITY_REORDER_TO_FRONT`** 回到书架的
     *   （见 `WorkbenchActivity` 里那句 `startActivity(Intent(act, MainActivity::class.java)
     *   .addFlags(REORDER_TO_FRONT))`）—— 也就是**回到原来那个实例**、**这个 Composable 不重建**，
     *   `LaunchedEffect(refresh)` 自然**不会重跑**。
     *   ⇒ 结果：他做完一本画册回到书架，看到的是**旧列表**，**刚做的那本不在上面**
     *     ⇒ 主观感受就是「画册（做了却）打不开/找不到」。
     *   ⚠ 真机实测：冷启时书架是「**4 本**」4 张卡（数据一直是好的），
     *     而出书刚回来那一瞬是「3 本」——**断的只是"回来时没重扫"这一环**。
     *   ⇒ 用生命周期事件来补：**`ON_RESUME` ⇒ `refresh++`**（比"让工作台换一种启动 flag"更稳，
     *     因为它同时覆盖"从相册选择器回来""从书页返回"等所有回前台路径）。
     */
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val obs = LifecycleEventObserver { _, e ->
            if (e == Lifecycle.Event.ON_RESUME) { refresh++ }
        }
        lifecycleOwner.lifecycle.addObserver(obs)
        onDispose { lifecycleOwner.lifecycle.removeObserver(obs) }
    }

    /**
     * 书架 = **书库(SAF)里的书** + **本机/内置书**，按目录名去重。
     *
     * ★ 书库那批**排前面**：他绑定的那个文件夹才是"自己出的书"的默认落点
     *   （出书默认路径 = 书库，见 `LibraryStore.outputTree`）。
     * ★ 去重口径是**目录名** —— 同一本书既在书库、又被取到本机过时，只显一张卡。
     */
    val books = remember(local, ext) {
        val seen = HashSet<String>()
        val out = ArrayList<Book>()
        ext.forEach { e ->
            if (seen.add(e.dirName)) {
                out += Book(
                    e.dirName, false, null,
                    e.title.ifBlank { e.dirName }, e.subtitle, e.photoCount, e.coverRel,
                    external = true, docId = e.dirDocId
                )
            }
        }
        local.forEach { b -> if (seen.add(b.key)) out += b }
        out
    }

    // 绑定书库：让他选一个文件夹（SAF），之后书库里放的书自动出现在书架上
    val libLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { uri ->
        if (uri == null) {
            tip = "没选文件夹"
            return@rememberLauncherForActivityResult
        }
        try {
            ctx.contentResolver.takePersistableUriPermission(
                uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION
            )
            refresh++
            tip = "已绑定书库，正在扫描"
        } catch (t: Throwable) {
            tip = "绑定失败：授权没拿到"
        }
    }

    /**
     * ★★★ 第十七轮（2026-10-09）：**整本删掉一本画册**（他报「书架上的画册没有删除功能」）。
     *
     * 三种来源的落点（一本书**可能同时占两处**，必须都清）：
     *  ① **书库（SAF）里的那份** —— `LibraryStore.deleteFromLibrary`（真去删 provider 里的文档）。
     *     ⚠ 这个函数**早就写好了**（它的注释就写着"书架长按删「书库」里的书时用"），
     *       但在 `F145` 我重建书架时**把调用点弄丢了** ⇒ 一直是**死代码**。
     *  ② **私有目录里的那份**（`files/books/<key>`）—— 书库里那本被"点开自动取到本机"过的话，
     *     只删 ① 会**剩下 ②**，卡照样在书架上（用户会以为"删除没反应"）。
     *  ③ 内置演示书**不删**（它打在 APK 里、本来也删不掉）—— 长按那一下就被挡住了，走不到这儿。
     *
     * ★ 删完 `refresh++` 重扫；**不删草稿**（`DraftStore` 是"工作台正在编辑的那本"，
     *   与书架上的书不是一回事，清掉反而会让他正在做的东西白费）。
     * ★ 删的是**用户自己的书**（不可逆）⇒ 入口只有长按，而且**必须先过对话框**。
     *   删除失败**也要有人话提示**（那条命门），不能静默。
     */
    fun doDelete(b: Book) {
        if (deleting) return
        deleting = true
        scope.launch {
            val hit = withContext(Dispatchers.IO) {
                var ok = false
                try {
                    // ① 书库（SAF）
                    if (b.external) {
                        val tree = LibraryStore.libraryTree(ctx)
                        val doc = b.docId
                        if (tree != null && doc != null) {
                            ok = LibraryStore.deleteFromLibrary(ctx, tree, doc) || ok
                        }
                    }
                    // ② 私有目录（本机那份）
                    // ⚠ 名字别叫 `local` —— 外层那个 `local` 是**书单**（`scanBooks` 的结果），
                    //   重名会让"删的到底是不是这本"读起来含糊（编译器也报了 shadow 警告）。
                    val localDir = File(root, b.key)
                    if (localDir.isDirectory) {
                        ok = localDir.deleteRecursively() || ok
                    }
                } catch (t: Throwable) {
                    Log.w("Shelf", "删书失败 ${b.key}", t)
                }
                ok
            }
            deleting = false
            refresh++          // 重扫：卡片、角标、「N 本」一起更新
            tip = if (hit) "已删除「${b.title}」" else "没删掉（文件被占用，或书库授权失效了）"
        }
    }

    Column(Modifier.fillMaxSize().padding(16.dp).then(tagOn)) {
        // ---------- 顶栏（★ 恢复原版排布：照片画册 · N 本 · 刷新 · ＋ 做一本新画册）----------
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp)
        ) {
            Text("照片画册", color = Ink, fontSize = 18.sp, fontWeight = FontWeight.Medium)
            Spacer(Modifier.width(10.dp))
            Text(
                "${books.size} 本",
                color = Ink.copy(alpha = 0.55f), fontSize = 13.sp,
                modifier = Modifier.testTag("shelf-count")
            )
            // ★ 第十七轮：删除入口是**长按**（放不下第 7 颗按钮、也不该改卡片几何）⇒
            //   必须把"长按"这件事**写在脸上**，否则等于没做（他这次就是没找到）。
            //   ⚠ 只占这一行里已有的空白（同行内联），**不改行高、不动卡片位置** ——
            //     那条 493px / 420px 的逐像素基准不能破。
            Spacer(Modifier.width(8.dp))
            Text(
                "长按画册可删除",
                color = Ink.copy(alpha = 0.34f), fontSize = 11.sp,
                modifier = Modifier.testTag("shelf-hint")
            )
            Spacer(Modifier.weight(1f))

            // ★ 二十一轮（2026-10-10）：**翻页声开关** —— 放在「刷新」左边，样式与它一致。
            //   状态写进原生 SharedPreferences（[SfxPrefs]）⇒ 书页打开时注入给 WebView。
            //   ⚠ testTag `shelf-sfx` 是硬契约（验收脚本靠它找这颗控件），改名要连脚本一起改。
            //   ⚠ 默认开：新增功能不该默认"没反应"，否则他会以为没做。
            var sfxOn by remember { mutableStateOf(SfxPrefs.isOn(ctx)) }
            Text(
                if (sfxOn) "翻页声 开" else "翻页声 关",
                color = if (sfxOn) Accent else Ink.copy(alpha = 0.42f),
                fontSize = 13.sp,
                modifier = Modifier.testTag("shelf-sfx").clickable {
                    val next = !sfxOn
                    SfxPrefs.setOn(ctx, next)
                    sfxOn = next
                    tip = if (next) "翻页声已开" else "翻页声已关"
                }
            )
            Spacer(Modifier.width(14.dp))

            Text(
                "刷新", color = Accent, fontSize = 13.sp,
                modifier = Modifier.testTag("shelf-refresh").clickable { refresh++; tip = "已刷新" }
            )
            Spacer(Modifier.width(14.dp))
            Text(
                "＋ 做一本新画册", color = Accent, fontSize = 13.sp,
                modifier = Modifier.testTag("shelf-new").clickable {
                    try {
                        ctx.startActivity(Intent(ctx, WorkbenchActivity::class.java))
                    } catch (t: Throwable) {
                        tip = "进不去工作台"
                    }
                }
            )
        }

        Box(Modifier.fillMaxWidth().height(1.dp).background(Line))

        // ---------- 书库条（★ 原版文案：书库：<文件夹名> · 刷新书库 · 绑定书库文件夹…）----------
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 8.dp)
        ) {
            // ⚠ 「书库：」这三个字**必须留在带 tag 的那个节点里** —— 验收脚本按它判"已绑定"。
            Text(
                "书库：", color = Ink.copy(alpha = 0.5f), fontSize = 12.sp,
                modifier = Modifier.testTag("shelf-lib-state")
            )
            Text(
                if (libName.isBlank()) "未绑定" else libName,
                color = if (libName.isBlank()) Ink.copy(alpha = 0.45f) else Accent,
                fontSize = 12.sp
            )
            Spacer(Modifier.weight(1f))
            Text(
                "刷新书库", color = Accent, fontSize = 13.sp,
                modifier = Modifier.testTag("shelf-lib-rescan").clickable {
                    refresh++; tip = "已刷新书库"
                }
            )
            Spacer(Modifier.width(12.dp))
            Text(
                "绑定书库文件夹…", color = Ink.copy(alpha = 0.55f), fontSize = 13.sp,
                modifier = Modifier.testTag("shelf-lib-bind").clickable {
                    try { libLauncher.launch(null) }
                    catch (t: Throwable) { tip = "这台手机打不开文件夹选择器" }
                }
            )
        }

        // ---------- 书列表（★ 原版是**封面网格**：4 列自适应、格宽≈170dp、封面框高 140dp）----
        if (books.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    "还没有画册。\n点右上角「＋ 做一本新画册」。",
                    color = Ink.copy(alpha = 0.45f), fontSize = 13.sp,
                    lineHeight = 22.sp, textAlign = TextAlign.Center
                )
            }
        } else {
            LazyVerticalGrid(
                columns = GridCells.Adaptive(160.dp),
                horizontalArrangement = Arrangement.spacedBy(14.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.fillMaxSize().padding(top = 4.dp)
            ) {
                itemsIndexed(books, key = { _, b -> b.key }) { i, b ->
                    BookCard(
                        ctx, b, i,
                        onLongPress = {
                            when {
                                // 内置演示书打在 APK 里，删不掉 —— 直接说清楚，不给对话框
                                b.builtin -> tip = "「${b.title}」是内置演示书，删不掉（它打在 App 里）"
                                deleting -> tip = "正在删上一本，稍等一下"
                                else -> { delAsk = b; tip = "" }
                            }
                        },
                    ) { picked ->
                        if (picked.external) {
                            // ★ 书库里的书：**点开时才取到本机**（读书那条路一行都不用改）
                            scope.launch {
                                val t0 = LibraryStore.libraryTree(ctx)
                                val doc = picked.docId
                                if (t0 == null || doc == null) {
                                    tip = "书库授权失效了，点「绑定书库文件夹…」重新绑一下"
                                    return@launch
                                }
                                tip = "正在把「${picked.title}」取到本机…"
                                val dest = withContext(Dispatchers.IO) {
                                    try { LibraryStore.importBook(ctx, t0, doc, picked.key, root) }
                                    catch (e: Throwable) { Log.w("Shelf", "取书失败", e); null }
                                }
                                if (dest == null) {
                                    tip = "取这本失败了（权限或磁盘）"
                                    return@launch
                                }
                                refresh++
                                try {
                                    ctx.startActivity(
                                        Intent(ctx, BookPageActivity::class.java).apply {
                                            putExtra(BookPageActivity.EXTRA_KEY, dest.name)
                                            putExtra(BookPageActivity.EXTRA_BUILTIN, false)
                                        }
                                    )
                                } catch (e: Throwable) {
                                    tip = "打不开这本书：${e.javaClass.simpleName}"
                                }
                            }
                        } else {
                            // ⚠⚠⚠ **extra 的键名必须用 BookPageActivity 的常量**（`F145` 的真根因）：
                            //   它**只读两个**：`EXTRA_KEY = "book_key"` 与 `EXTRA_BUILTIN = "book_builtin"`，
                            //   读不到就 **`finish(); return`** —— 症状是「点了书完全没反应」。
                            tip = "正在打开「${picked.title}」"
                            try {
                                ctx.startActivity(
                                    Intent(ctx, BookPageActivity::class.java).apply {
                                        putExtra(BookPageActivity.EXTRA_KEY, picked.key)
                                        putExtra(BookPageActivity.EXTRA_BUILTIN, picked.builtin)
                                    }
                                )
                            } catch (t: Throwable) {
                                tip = "打不开这本书：${t.javaClass.simpleName}"
                            }
                        }
                    }
                }
            }
        }
    }

    // 人话提示（出错也要看得见 —— 那条命门）
    Box(Modifier.fillMaxSize().padding(bottom = 24.dp), contentAlignment = Alignment.BottomCenter) {
        if (tip.isNotEmpty()) {
            Text(
                tip, color = Ink.copy(alpha = 0.7f), fontSize = 12.sp,
                modifier = Modifier
                    .clip(RoundedCornerShape(14.dp))
                    .background(Paper.copy(alpha = 0.94f))
                    .padding(horizontal = 14.dp, vertical = 8.dp)
            )
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // ★ 第十七轮：长按卡片 ⇒ **删除确认对话框**
    //
    //   ⚠ `AlertDialog` / `TextButton` 这两个 import **本来就在文件头上**（原版用过），
    //     而 `F145` 我重建书架时把调用点做丢了 —— 这次是**接回原设计**，不是新造样式。
    //   ⚠ 对话框里必须把这本是什么、删哪儿、能不能找回**写清楚**：删的是用户自己的书，
    //     而且**不可逆**（书库那份删了就是真的没了）⇒ 文案不许含糊。
    //   ⚠ `testTag` 在对话框里**要额外挂 `semantics { testTagsAsResourceId = true }`** ——
    //     对话框是**另一个 ComposeView 根**，外层那个 `tagOn` 传不进来
    //     （uiautomator 就看不到这两颗钮 ⇒ 验收脚本会判"按钮不存在"，假红）。
    // ══════════════════════════════════════════════════════════════════════
    val ask = delAsk
    if (ask != null && !ask.builtin) {
        AlertDialog(
            onDismissRequest = { if (!deleting) delAsk = null },
            modifier = Modifier.semantics { testTagsAsResourceId = true },
            containerColor = Paper,
            title = {
                Text("删除这本画册？", color = Ink, fontSize = 17.sp, fontWeight = FontWeight.Medium)
            },
            text = {
                Text(
                    "「${ask.title}」 · ${ask.photoCount} 张照片\n\n" +
                        if (ask.external)
                            "会把它从「书库文件夹」里整本删掉（连文件一起），删了就找不回来了。"
                        else
                            "会把它从手机里整本删掉，删了就找不回来了。",
                    color = Ink.copy(alpha = 0.72f), fontSize = 13.sp, lineHeight = 21.sp
                )
            },
            confirmButton = {
                TextButton(
                    onClick = { val t = ask; delAsk = null; doDelete(t) },
                    modifier = Modifier
                        .testTag("shelf-del-ok")
                        .semantics { testTagsAsResourceId = true }
                ) {
                    Text("删除", color = Danger, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { delAsk = null },
                    modifier = Modifier
                        .testTag("shelf-del-cancel")
                        .semantics { testTagsAsResourceId = true }
                ) {
                    Text("取消", color = Ink.copy(alpha = 0.65f), fontSize = 15.sp)
                }
            },
        )
    }
}

/**
 * 书架的一格：**封面缩略图 + 书名 + 「书库/内置」角标 + 副标题 · 张数**。
 *
 * ⚠ `shelf-card-<序号>` 是**验收脚本的硬契约**，别改。
 * ⚠ 用 `combinedClickable`（长按也能点）⇒ 它属实验 API，必须 `@OptIn`。
 * ⚠ 几何照**原版**（我重建时把它做丢了）：格宽 ≈170dp（`Adaptive(160dp)` 在 780dp 宽下正好 4 列）、
 *   封面框**高 140dp**、封面 `ContentScale.Crop` 裁切填满。
 *
 * ★ 第十七轮（2026-10-09）：`onLongClick` 接回**删除**入口（他报「书架上的画册没有删除功能」）。
 *   为什么用长按、不是"卡片上加一颗删除钮"：加钮会**改变卡片几何**（那条 493px/420px 是逐像素
 *   对过原版的），而长按零改动、也不怕误触（还要在对话框里再确认一次）。
 *   ⚠ 长按**不会**和滑动冲突：`combinedClickable` 的长按是"按住 500ms 且没移动"才触发，
 *     滑动列表时会先被判成拖动而取消。
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun BookCard(
    ctx: Context, b: Book, index: Int,
    onLongPress: () -> Unit,
    onOpen: (Book) -> Unit,
) {
    Column(
        modifier = Modifier
            .semantics { testTagsAsResourceId = true }
            .testTag("shelf-card-$index")
            .clip(RoundedCornerShape(10.dp))
            .combinedClickable(onClick = { onOpen(b) }, onLongClick = onLongPress)
            // ⚠⚠ **不要加内边距** —— 逐像素对过原版（`r10-shelf-fixed.png`）：
            //   封面是**占满整格**的（格宽 493px / 164.3dp），我第一版加了 `padding(2.dp)`
            //   ⇒ 封面窄 12px（481px）、左右各缩 6px ⇒ 与左右卡对不齐。
    ) {
        Box(
            Modifier.fillMaxWidth().height(140.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(Line),
            contentAlignment = Alignment.Center
        ) {
            val bmp = rememberCover(ctx, b)
            if (bmp != null) {
                Image(
                    bitmap = bmp, contentDescription = null,
                    modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop
                )
            } else {
                Text("没有封面", color = Ink.copy(alpha = 0.35f), fontSize = 10.sp)
            }
        }
        Spacer(Modifier.height(6.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                b.title, color = Ink, fontSize = 14.sp, maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false)
            )
            Spacer(Modifier.width(6.dp))
            Text(
                if (b.builtin) "内置" else "书库",
                color = Ink.copy(alpha = 0.45f), fontSize = 10.sp,
                modifier = Modifier
                    .clip(RoundedCornerShape(4.dp))
                    .background(Ink.copy(alpha = 0.06f))
                    .padding(horizontal = 5.dp, vertical = 1.dp)
            )
        }
        Text(
            "${b.subtitle.ifBlank { "（无副标题）" }} · ${b.photoCount} 张",
            color = Ink.copy(alpha = 0.45f), fontSize = 11.sp, maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

/**
 * 封面缩略图：**内置书走 assets、本机书走文件、书库书走 SAF**，三种来源同一个入口。
 *
 * ★ 用 [Thumbs]（降采样 + LruCache + 后台解码）—— 与工作台照片格是同一套，
 *   不然一屏十几张 750×1692 的原图会把内存吃爆（`Thumbs` 的类注释里有账）。
 * ⚠ `Thumbs.decode` 的 `open` 会被调**两次**（先量尺寸再解码）⇒ 每次都要返回**新的流**。
 */
@Composable
private fun rememberCover(ctx: Context, b: Book): ImageBitmap? {
    val rel = b.coverKey
    val key = "shelf:${b.key}:" + (rel ?: "-")
    var bmp by remember(key) { mutableStateOf(Thumbs.peek(key)?.asImageBitmap()) }
    LaunchedEffect(key) {
        if (bmp != null || rel.isNullOrBlank()) { return@LaunchedEffect }
        val got = withContext(Dispatchers.IO) {
            try {
                Thumbs.decode(key, 220) {
                    try {
                        when {
                            b.builtin -> ctx.assets.open("books/${b.key}/$rel")
                            b.external -> {
                                val t = LibraryStore.libraryTree(ctx)
                                val d = b.docId
                                if (t != null && d != null) LibraryStore.openRel(ctx, t, d, rel) else null
                            }
                            else -> {
                                val f = b.dir?.let { File(it, rel) }
                                if (f != null && f.isFile) f.inputStream() else null
                            }
                        }
                    } catch (t: Throwable) { null }
                }
            } catch (t: Throwable) { Log.w("Shelf", "封面解码失败 $key", t); null }
        }
        if (got != null) { bmp = got.asImageBitmap() }
    }
    return bmp
}
