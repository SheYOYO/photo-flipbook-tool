package com.sheyoyo.photoflipbook

import android.content.Context
import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import kotlin.math.roundToInt

/**
 * 一次最多能勾几张（系统照片选择器 / 老系统的多选上限）。
 *
 * ⚠ 必须 > 1（`PickMultipleVisualMedia` 的构造要求），且要 ≤ 系统的
 *   `MediaStore.getPickImagesMaxLimit()`（默认 150）—— 取 100，两头都安全。
 * ⚠ 2026-10-08（第八轮①）`internal` 而不是 `private`：竖屏代理页 [PickProxyActivity]
 *   也要用它构造同一个契约 ⇒ **单一真相源**，两个页的上限永远一致，
 *   免得哪天只改一处，出现"工作台能选 100、代理页只让选 10"这种怪事。
 */
internal const val MAX_PICK = 100

/**
 * 工作台里的一张照片。
 *
 * @param key   缓存键（全局唯一）—— [Thumbs] 用它做内存缓存的键
 * @param builtin `true` = 打包在 assets 里；`false` = 私有目录里的文件
 * @param plate **版面档位**（小/中/大/竖）——`null` = 听引擎的（`assignPlates` 按清晰度名次定）。
 *              用户逐张改过就存这里 —— Kotlin 是这份改动的**唯一真相源**，
 *              预览页每次重算（拖过顺序、换过照片）都会把它盖回去。
 * @param position 版面位置：`center` / `high` / `low` / `aside` —— `null` = 听引擎的。
 * @param cover 封面文案（书名/副标题/页脚 + 自定义文字框）的样式覆盖，见 [CoverConf]。
 */
data class PhotoRef(
    val key: String,
    val bookKey: String,
    val relPath: String,
    val file: File?,
    val builtin: Boolean,
    val order: Int,
    val plate: String? = null,
    val position: String? = null,
    val cover: Map<String, CoverConf> = emptyMap(),
) {
    fun open(context: Context): InputStream? = try {
        if (builtin) context.assets.open("books/$bookKey/$relPath") else file?.inputStream()
    } catch (t: Throwable) {
        Log.w("PhotoRef", "打不开 $key", t)
        null
    }
}

/**
 * 封面一个文字元素的样式覆盖（M4c）。
 *
 * ⚠ 全部字段可空 = 「没动过就不写进配置」。
 *   为什么必须这样：控件显示的"当前值"其实来自 CSS 默认值
 *   （`--ct-title-size: 2.1cqw` 那些），一旦把控件读到的值写进配置，
 *   就等于把默认值**冻进**用户的书里 —— 以后引擎改默认值，老书不会跟着变。
 *   （旧工程 app.js 的注释里记着这条，我照抄口径。）
 */
data class CoverConf(
    val hide: Boolean? = null,
    val x: Float? = null,
    val y: Float? = null,
    val size: Float? = null,
    val w: Float? = null,
    val color: String? = null,
    val font: String? = null,
    val align: String? = null,
    val italic: Boolean? = null,
    /**
     * ★ 2026-10-08（第六轮）：**文字框的文字**（引擎 extras 的 `text`）。
     *
     * ⚠ 引擎的 `normalizeCoverText` 只对 **extras**（`x1`..`x8`）认 `text`，
     *   内置三处（title/subtitle/foot）走的是 `payload` —— 所以这三个的文字**不在这里**：
     *   书名/副标题是工作台的 `title`/`subtitle`，页脚是单独的 `footText` 通路。
     */
    val text: String? = null,
) {
    /** 这条配置有没有实质内容 —— 全空就不放进 JSON，免得污染引擎的 `normalizeCoverText`。 */
    fun isEmpty(): Boolean = hide == null && x == null && y == null && size == null &&
        w == null && color == null && font == null && align == null && italic == null &&
        (text == null || text.isEmpty())
}

/**
 * 工作台 —— **做一本新画册**（M3：先只做「照片网格」这一块）。
 *
 * 布局（横屏；照旧工程的三栏紧凑版）
 * ```
 * ┌──────────────────────────────────────────────┐
 * │ ← 返回   书名 [已选 N 张]      清空  输出…  出书 │  ← 顶栏
 * ├──────────┬───────────────────────────────────┤
 * │ 照片网格  │  跨页预览（M4 接）                 │
 * │          │                                   │
 * └──────────┴───────────────────────────────────┘
 * ```
 *
 * M3 做的事：**照片网格 + 降采样缩略图 + 内存缓存 + 长按多选 + 批量删**。
 * ⚠ 拖拽排序（"拖拽跟手"）留到 M3 的第二轮 —— 它要在网格里自己算落点与位移，
 *   是个独立的小工程，不跟这一轮混着做。
 */
class WorkbenchActivity : ComponentActivity() {

    companion object {
        /** 从哪本书的素材起步（M3 先用内置演示书的 14 张）。 */
        const val EXTRA_SOURCE_BOOK = "source_book"

        /**
         * ★ 2026-10-08（第六轮）：出书成功时**带给书架**的那句提示。
         *
         * 佘先生：「我点击生成画册成功后退出生成工具界面」⇒ 这页 `finish()` 直接退，
         * 那句"已出书：17 页"就跟着这页一起没了 ⇒ 用户一点也看不出成功没成功。
         * ⇒ 用它带过去，书架读完立刻 `removeExtra`（不会重复弹）。
         */
        const val EXTRA_DONE_TIP = "done_tip"
        private const val TAG = "Workbench"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val src = intent.getStringExtra(EXTRA_SOURCE_BOOK) ?: "book1"
        val appCtx = applicationContext
        val initial = PhotoStore.currentPhotos(appCtx, src)
        Log.i("Workbench", "工作台起步照片：${initial.size} 张" +
            "（用户选的 ${PhotoStore.scanPicked(appCtx).size} 张 / 清空过=${PhotoStore.isCleared(appCtx)}）")

        setContent {
            PhotoFlipbookTheme {
                // ★ 第十轮②：加系统栏安全内边距（透明状态栏 + 刘海 ⇒ 内容必须往里让）
                // ⚠ 工作台**恒定横屏**（清单里 `sensorLandscape`）⇒ 不需要转屏后重算。
                Surface(Modifier.fillMaxSize(), color = Paper) {
                    Box(Modifier.fillMaxSize().sysBars()) {
                        WorkbenchScreen(initial, src, onBack = { finish() })
                    }
                }
            }
        }
    }
}

@Composable
private fun WorkbenchScreen(
    initial: List<PhotoRef>,
    sourceBook: String,
    onBack: () -> Unit,
) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    /**
     * ★ 第六轮：出书成功后要 `startActivity` 回书架 + `finish()` 退掉这页，
     *   而 [handlePlan] 是 Composable 里的局部函数、**拿不到 Activity** ⇒ 这里取一次传下去。
     */
    val act = ctx as? Activity
    val photos = remember { mutableStateListOf<PhotoRef>().also { it.addAll(initial) } }
    val selected = remember { mutableStateListOf<String>() }
    var tip by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf("") }
    // 预览引擎（四颗 JS）回报的东西：张数 / 页数 / 有几张读不出来
    var planInfo by remember { mutableStateOf("") }
    // ---- M4c：左栏两个页签（照片排版 / 封面文案）----
    var tab by remember { mutableStateOf("photos") }
    // ★ 2026-10-08（第四轮）：这两个**现在是可编辑的**（之前只有样式控件、文字写死）。
    var title by remember { mutableStateOf(DEFAULT_TITLE) }
    var subtitle by remember { mutableStateOf(DEFAULT_SUBTITLE) }
    /**
     * ★ 2026-10-08（第六轮）：**页脚那一行的文字**。
     *
     * ⚠ 它不能存在 `cover` map 里 —— 引擎的 `pageHtml(..., photoCount, coverText)` 把页脚
     *   写成 `photoCount + ' PHOTOGRAPHS'`（**引擎现算**），而 `normalizeCoverText` 的 `text`
     *   字段**只对 extras 生效** ⇒ 想让它可改只能走预览页那条"渲染后替换"的独立通路。
     * 空串 ⇒ 保持引擎原样。
     */
    var footText by remember { mutableStateOf("") }
    /** 已有文字框的数量（`x1`..`xN`；引擎上限 8）—— 面板上显示「N / 8」。 */
    var coverExtras by remember { mutableStateOf(0) }
    /**
     * ★ 第七轮：**待确认删除**的那个文字框编号（两段式删除的第一下）。
     * null = 没在待删状态；非 null = 面板钮显示「● 再点删除」且预览里那个框**发亮**。
     */
    var delArmed by remember { mutableStateOf<Int?>(null) }
    /** 封面文案的样式覆盖 —— ★ 只有用户**真动过**的那几项才在 map 里（见 [CoverConf] 的注释）。 */
    val cover = remember { mutableStateMapOf<String, CoverConf>() }

    // ---- 草稿：进屏先恢复，之后每次改动都自动存 ----
    // ★ 为什么需要：照片本身在私有目录里（重进还在），但**档位/位置/封面文案**
    //   原本全在内存里，退出去就丢 ⇒ 挑半天一按返回全没。
    var restored by remember { mutableStateOf(false) }
    var draftHit by remember { mutableStateOf(0) }
    remember {
        val d = DraftStore.load(ctx)
        if (d != null) {
            // ★★ 第二十轮：直接吃进草稿的标题（含空串）—— 不再 `isNotBlank` 兜底成默认。
            //   否则用户清空/删除书名后重进，又变回"我的小狗"（他报的"死板固定"在恢复路径也中招）。
            title = d.title
            subtitle = d.subtitle
            footText = d.footText
            cover.putAll(d.cover)
            coverExtras = countExtras(cover)      // ★ 第六轮：文字框数量跟着草稿回来
            // 把档位/位置贴回对应的照片（照片不在了就跳过 —— 照片被清掉/换了一批）
            var n = 0
            d.perPhoto.forEach { (key, e) ->
                val i = photos.indexOfFirst { it.key == key }
                if (i >= 0) {
                    photos[i] = photos[i].copy(plate = e.plate, position = e.position)
                    n++
                }
            }
            draftHit = n
        }
        restored = true
        true
    }
    /** 预览 WebView 的遥控器：改档位/改封面走快路（不重新解码照片）。 */
    val preview = remember { PreviewController() }
    /** 封面正在编辑哪个元素（书名 / 副标题 / 页脚）。 */
    var coverEl by remember { mutableStateOf("title") }
    /**
     * ★ 2026-10-08（第四轮）：有输入框拿着焦点 ⇒ **顶栏让位**。
     *
     * 真机实测的账（vivo Z5 横屏，屏高 1080）：键盘一弹，窗口可用区从 996px
     * 掉到 **216px（72dp）**，而**顶栏自己就占 144px（48dp）** ⇒ 左栏拿到的高度是 **0**
     * ⇒ 输入框整块被挤出可见区（uiautomator 里直接查不到那个节点），
     * 用户"看不见自己在打什么"。让顶栏在编辑期间不占位，左栏就拿到整 216px：
     * 面板头（24dp）+ 书名行（30dp）稳稳落在键盘上方。
     * 出口放在**面板自己的头部**（那颗「✓ 完成」），不额外占高度。
     */
    var textEditing by remember { mutableStateOf(false) }
    /** 放大预览：左栏收起，书占满整屏（横屏下预览区只有 ~1/3 屏宽，书显得很小）。 */
    var widePreview by remember { mutableStateOf(false) }
    val focusManager = LocalFocusManager.current

    // ---- 草稿自动保存：所有编辑都从 pushCover / pushPlate 这两个入口走，
//   在这里统一存一次，就不会漏掉某条路径。防抖 400ms（拖滑块时不会写爆）。
//   ⚠ 这个函数**必须定义在 pushCover/pushPlate 之前** —— 局部函数互相调用是
//   前向引用，写在后面会编不过（我为此连编错两次：Unresolved reference）。
var saveJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }
    fun saveDraftSoon() {
        if (!restored) return
        saveJob?.cancel()
        saveJob = scope.launch {
            kotlinx.coroutines.delay(400)
            val edits = HashMap<String, DraftStore.Draft.PhotoEdit>()
            photos.forEach { p ->
                if (p.plate != null || p.position != null) {
                    edits[p.key] = DraftStore.Draft.PhotoEdit(p.plate, p.position)
                }
            }
            // 全是默认值 ⇒ 没什么可存的，清掉旧草稿收工
            // ★ 2026-10-08（第四轮）：判据必须**把书名/副标题也算进来** ——
            //   只改了书名、档位和样式都没动的话（edits/cover 都空），旧判据会把草稿
            //   直接 `clear` ⇒ **用户改的书名一退出就没了**（真缺陷，本轮补上）。
            val textDefault = isDefaultText(title, subtitle)
            if (edits.isEmpty() && cover.isEmpty() && textDefault && footText.isBlank()) {
                DraftStore.clear(ctx)
            } else {
                DraftStore.save(ctx, title, subtitle, photos.map { it.key }, edits, cover, footText)
            }
        }
    }

/** 用户动了封面 ⇒ 立刻推给预览（快路）+ 存草稿。 */
    fun pushCover() {
        preview.setCover(coverTextJson(cover).toString())
        saveDraftSoon()
    }

    /**
     * 用户改了封面**文字**（书名 / 副标题）⇒ 推给预览 + 存草稿（2026-10-08 第四轮）。
     *
     * ★ 必须走 `setText` 快路：走 `render()` 的话每敲一个字要把全部照片重新解码一遍
     *   （十几张 = 十几秒），输入框会卡到没法用。判据见 `PreviewController.setText`。
     */
    fun pushText() {
        preview.setText(
            JSONObject().apply { put("title", title); put("subtitle", subtitle) }.toString()
        )
        saveDraftSoon()
    }

    /**
     * 用户改了**页脚文字**（第六轮）⇒ 走预览页那条"渲染后替换"的独立通路。
     * ⚠ 与 `pushText` 分开：页脚文字不在 payload 里（引擎现算），得单独送。
     */
    fun pushFoot() {
        preview.setFootText(footText)
        saveDraftSoon()
    }

    /**
     * ★ 第七轮：告诉预览页「哪一个文字框正在发亮」（两段式删除的第一下）。
     *
     * ⚠ 走**独立**一条通路而不是塞进 `setCover`：发亮是**编辑态**的临时状态，
     *   不该进草稿、也不该影响出书（成品书上没有描边，见 F134 §⑤）。
     */
    fun pushActive() {
        preview.setActiveExtra(delArmed?.let { "x$it" } ?: "")
        if (delArmed != null) saveDraftSoon()
    }

    /** 把第 [i] 张（0 起）的档位/位置推给预览（快路）+ 存草稿。 */
    fun pushPlate(i: Int) {
        val p = photos.getOrNull(i) ?: return
        preview.applyEdit(i + 1, p.plate ?: "auto", p.position ?: "auto")
        saveDraftSoon()
    }

    /**
     * ★★ 第十五轮（2026-10-09）：「封面」页签 ⇒ 进**独立的竖屏封面编辑页**。
     *
     * ★ 为什么回来必须**重读草稿**：那一页改的是**同一份草稿文件**（`DraftStore`，
     *   两页共享），而工作台的状态在内存里 ⇒ 不重读就看不到那边的改动
     *   （"在那边改了字号，回来看还是老的"）。
     * ⚠ 草稿被清（他在那边把所有东西都恢复默认）⇒ 这里把状态也还原成默认，
     *   不能留着旧的（否则工作台会和草稿"各说各话"）。
     */
    val coverEdit = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        val d = DraftStore.load(ctx)
        cover.clear()
        if (d != null) {
            // ★★ 第二十轮：从封面编辑页回来，标题原样恢复（空就空，不再回填默认）。
            title = d.title
            subtitle = d.subtitle
            footText = d.footText
            cover.putAll(d.cover)
            coverExtras = countExtras(cover)
            var n = 0
            d.perPhoto.forEach { (key, e) ->
                val i = photos.indexOfFirst { it.key == key }
                if (i >= 0) {
                    photos[i] = photos[i].copy(plate = e.plate, position = e.position)
                    n++
                }
            }
            draftHit = n
            tip = "封面已更新"
        } else {
            title = DEFAULT_TITLE
            subtitle = DEFAULT_SUBTITLE
            footText = ""
            coverExtras = 0
            tip = "封面已恢复默认"
        }
        coverEl = "title"
        delArmed = null
        // 推给预览（那三个函数走的是快路 + 幂等，多推一次无害）
        pushCover(); pushText(); pushFoot()
    }

    // 恢复完之后，把草稿里的内容推给预览引擎（否则预览还是默认档）
    // ★ 2026-10-08（第四轮）修：旧判据是 `restored && draftHit > 0`，而 `draftHit` 只数
    //   **逐张的档位/位置** ⇒ 只改了书名（没动任何档位）的草稿会被整块跳过，连
    //   `pushCover()` 都不执行。现在拆开：档位按 draftHit 推，封面（样式 + 文字）只要
    //   `restored` 就推 —— 两条都幂等，多推一次无害。
    LaunchedEffect(draftHit, restored) {
        if (!restored) return@LaunchedEffect
        if (draftHit > 0) { photos.forEachIndexed { i, _ -> pushPlate(i) } }
        pushCover()
        pushText()
    }

    // ---- M5：输出目录 + 出书 ----
    var outputLabel by remember { mutableStateOf(LibraryStore.outputName(ctx)) }
    // ★ 优化一：输出目录菜单的展开状态（**必须在顶层** —— 声明在 Row 里的话，
    //   下面那个 `if (showOutputMenu)` 的菜单区在 Row 外面，根本看不到它 ⇒ 编不过）
    var showOutputMenu by remember { mutableStateOf(false) }
    var publishing by remember { mutableStateOf(false) }

    /** 用户挑输出目录（系统目录选择器，**不限于图片文件夹**）。 */
    val outputPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { uri ->
        if (uri == null) {
            tip = "没选输出目录"
            return@rememberLauncherForActivityResult
        }
        try {
            // ⚠ 必须 take 持久授权 —— 否则重启 App 后那个 Uri 就失效了
            ctx.contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
        } catch (t: Throwable) {
            Log.w("Workbench", "拿不到持久授权（本次仍可用）", t)
        }
        // 取一个好看的目录名：SAF 的 tree id 形如 `primary:Download` ⇒ 取冒号后面的真目录名
        val label = try {
            val docId = android.provider.DocumentsContract.getTreeDocumentId(uri)
            docId.substringAfterLast(':').ifBlank { docId }
        } catch (t: Throwable) {
            uri.lastPathSegment ?: "已选目录"
        }
        LibraryStore.setOutput(ctx, uri, label)
        outputLabel = label
        tip = "输出目录：$label"
    }

    /** 预览页回报的东西：排版结果 / 出书结果 / 错误。 */
    fun handlePlan(json: String, act: Activity?) {
        planInfo = json
        Log.i("Workbench", "预览引擎回报：$json")
        try {
            val o = JSONObject(json)
            val pub = o.optJSONObject("publish")
            if (pub != null) {
                publishing = false
                busy = ""
                // ★ 出书成功 ⇒ 草稿作废（书已经生成，档位"固化"进书里了）。
                //   不清的话，下次做新画册会把上次的档位莫名其妙恢复出来。
                DraftStore.clear(ctx)
                val dir = pub.optString("dir")
                val wrote = pub.optInt("photos")
                val pages = pub.optInt("pages")
                val tree = LibraryStore.outputTree(ctx)?.let { u -> u to LibraryStore.outputName(ctx) }
                // ★★ 2026-10-08（第六轮）：出书成功 ⇒ **退出工作台回书架**。
                //   佘先生：「我点击生成画册成功后退出生成工具界面」——
                //   「生成工具」= 这页工作台，他要的是**回到书架**（新书就在那儿）。
                //   ⇒ 导出到用户选的目录**继续在后台跑**（那是 IO 线程，不依赖这页活着），
                //     跑完的结果通过 MainActivity 的下一屏显示；这页立刻退掉。
                //   ⚠ 失败向**不动**：仍留在工作台并给提示（要能重试 / 看错在哪）。
                val doneTip = if (tree != null && dir.isNotBlank()) {
                    "已出书：$wrote 张 / $pages 页，正在导出到「${tree.second}」…"
                } else {
                    "已出书：$wrote 张 / $pages 页 —— 回书架就能翻"
                }
                if (tree != null && dir.isNotBlank()) {
                    scope.launch {
                        busy = "正在导出到「${tree.second}」…"
                        val msg = withContext(Dispatchers.IO) {
                            BookWriter.exportTo(ctx, tree.first, File(dir), tree.second)
                        }
                        Log.i("Workbench", "导出完成：$msg")
                    }
                }
                tip = doneTip
                // ★ 第六轮：把成功提示**带去书架**（这页马上 finish，tip 就没了）。
                //   ⚠ `handlePlan` 是 Composable 里的局部函数、**拿不到 Activity** ⇒
                //     活动实例由调用方当参数传进来（`act`）。
                //   REORDER_TO_FRONT 保证书架是**回退**到前台，而不是压一个新实例。
                runCatching {
                    act?.startActivity(Intent(act, MainActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                        .putExtra(WorkbenchActivity.EXTRA_DONE_TIP, doneTip))
                }
                Handler(Looper.getMainLooper()).postDelayed({ act?.finish() }, 450)
                return
            }
            if (publishing && o.has("error")) {
                publishing = false
                busy = ""
                tip = "出书失败：" + o.optString("error")
            }
        } catch (t: Throwable) {
            Log.w("Workbench", "解析预览回报失败", t)
        }
    }

    // ★ 相册多选：Compose 里**直接拿结果**，不用像旧工程那样轮询"选完了没"
    //   （旧工程是因为 `@JavascriptInterface` 不能接 JS 回调，只能靠轮询 stamp。）
    //
    // ★★ 2026-10-08（第四轮）改：**走系统「照片选择器」（相册），不再是文件管理器**。
    //   佘先生：「制作画册时选择照片时不要跳转文件管理器，要求跳转手机相册」。
    //   旧版是 `OpenMultipleDocuments`（= `ACTION_OPEN_DOCUMENT`）⇒ 安卓 13+ 上
    //   系统直接把它交给「文件」App（就是那颗 Files/DocumentsUI），**看着就是文件管理器**。
    //   换成 `PickMultipleVisualMedia`：
    //     · Android 13+（含目标机荣耀；本机模拟器 fp_avd=Android 14）⇒
    //       走 `MediaStore.ACTION_PICK_IMAGES` = **系统「照片」选择器**（数据源就是相册）；
    //     · 更老系统（本机真机 vivo Z5 = Android 10，系统**没有**照片选择器，
    //       `ACTION_PICK_IMAGES` 查无此 Activity —— 已用 `cmd package query-activities` 实测）
    //       ⇒ AndroidX 自动退回 `ACTION_GET_CONTENT`，行为与旧版接近（会弹应用选择/文件选择器）。
    //   ⚠ **不需要任何权限**：选择器按 URI 临时授权，我们只读一次就拷进私有目录
    //     （见 [PhotoStore.importPhotos]），所以清单里一条权限都不用加。
    // ★★ 2026-10-08（第八轮①）改：**不再由本页直接拉相册**，改成启动竖屏代理页。
    //   佘先生：「选照片后切换的手机的相册时要求是竖屏的」。
    //   系统照片选择器在**另一个进程**里、**继承发起方的请求方向** ⇒ 本页是横屏时它也横屏。
    //   ⛔ 不能给本页（工作台）加 `requestedOrientation = PORTRAIT`：工作台版面是**为横屏设计的**
    //     （左栏照片/封面 + 右侧放大预览）⇒ 一锁竖屏整个做书界面就挤坏了。
    //   ⇒ 只让**相册那一段**竖屏：透明页 [PickProxyActivity]（portrait）去拉相册，
    //     结果原样传回本页。**工作台自始至终横屏，版面一像素没动。**
    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { res ->
        // ★ 第八轮①甲案：这一段相册有没有真的锁成竖屏（代理页回传的）。
        //   没锁上时**必须对用户说人话**（而不是让他对着横屏选择器莫名其妙），
        //   并**顺手指路**去开那个特殊权限 —— 只在这次真的需要授权时才提示。
        val wasPortrait = res.data?.getBooleanExtra(PickProxyActivity.EXTRA_PORTRAIT_LOCKED, false)
            ?: false

        val uris = res.data?.getParcelableArrayListExtra<android.net.Uri>(
            PickProxyActivity.EXTRA_URIS
        )
        if (uris.isNullOrEmpty()) {
            tip = "没选照片（取消或没勾）"
            return@rememberLauncherForActivityResult
        }
        scope.launch {
            busy = "正在读取 ${uris.size} 张…"
            val added = withContext(Dispatchers.IO) { PhotoStore.importPhotos(ctx, uris) }
            val all = withContext(Dispatchers.IO) { PhotoStore.scanPicked(ctx) }
            photos.clear()
            photos.addAll(all)
            selected.clear()
            busy = ""
            saveDraftSoon()      // 照片集合变了 ⇒ 草稿要跟着更新
            tip = if (added == uris.size) "新增 $added 张，现在共 ${photos.size} 张"
                  else "新增 $added 张（有 ${uris.size - added} 张读不出来），共 ${photos.size} 张"
            //方向没成就在末尾**追加**一句提示，绝不覆盖掉上面这条"新增 N 张"
            //（用户最关心的信息是"选进去几张"，不能被方向的事挤掉）。
            if (!wasPortrait) tip = "$tip｜相册是横的，点「选照片」旁的「竖屏相册」可开启"
        }
    }

    // ★ 第八轮①甲案：跳系统设置页让用户自己开「修改系统设置」。
    //   ⛔ App **不能**代替用户点那个开关（那是系统级授权）⇒ 只负责把人送到那一页。
    val permLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { tip = "设置里把「修改系统设置」打开后，再点「选照片」就会竖着弹相册" }

    // ★ 让 Compose 的 testTag 变成 uiautomator 看得见的 `resource-id`。
    //   为什么必须做：**Compose 的文本默认不进无障碍树**（`uiautomator dump` 一个字都看不到），
    //   所以自动化验收只有两条路 —— 纯像素判据，或加 testTag。
    //   加了之后验收脚本能像查 DOM 那样拿到控件的**真实坐标**（不用猜）。
    Column(
        Modifier.fillMaxSize()
            .semantics { testTagsAsResourceId = true }
    ) {
        // ---------- 顶栏 ----------
        // ★ 2026-10-08（第四轮）：**正在编辑封面文字时整条顶栏不占位**（见 textEditing 注释）。
        //   不隐藏的话，横屏键盘一弹，48dp 的顶栏会把左栏挤成 0 高 ⇒ 输入框看不见。
        //   编辑的出口在面板头部那颗「✓ 完成」（`cv-done`），不需要顶栏。
        if (!textEditing) {
        Row(verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp)) {
            Text("← 返回", color = Ink.copy(alpha = 0.7f), fontSize = 13.sp,
                modifier = Modifier.testTag("wb-back").clickable { onBack() })
            Spacer(Modifier.width(14.dp))
            Text("做一本新画册", color = Ink, fontSize = 16.sp, fontWeight = FontWeight.Medium,
                modifier = Modifier.testTag("wb-title"))
            Spacer(Modifier.width(12.dp))
            // 左栏页签：照片排版 / 封面文案
            TabChip("照片", tab == "photos", "wb-tab-photos") { tab = "photos" }
            Spacer(Modifier.width(6.dp))
            // ★★★ 第十五轮（2026-10-09）：**「封面」不再是就地编辑**，而是**进独立的竖屏封面编辑页**。
            //   佘先生：「用户点击封面后进入封面编辑界面…竖屏的封面图片…封面图占据屏幕大部分」。
            //   ⚠ 为什么必须另开一页：这一页（工作台）是**横屏**版面，第十轮③ 试过在工作台里
            //     按页签转竖屏 ⇒ 版面被挤坏、他判「效果太差」整体回滚（F146）。
            //   ⚠ testTag 仍是 `wb-tab-cover`（验收脚本的契约），但**点它的后果变了**：
            //     以前是切页签，现在是开新页 ⇒ 老脚本里"点完找 cv-* 控件"那几条会失效（预期内）。
            TabChip("封面", false, "wb-tab-cover") {
                try {
                    coverEdit.launch(
                        Intent(ctx, CoverEditActivity::class.java)
                            .putExtra(CoverEditActivity.EXTRA_SOURCE_BOOK, sourceBook)
                    )
                } catch (t: Throwable) {
                    tip = "打不开封面编辑页：${t.javaClass.simpleName}"
                }
            }
            Spacer(Modifier.width(10.dp))
            // 放大预览：把左栏收起来，让书占满整屏（横屏下预览区只有 1/3 屏宽，书太小）
            TabChip(if (widePreview) "⤡" else "⤢", widePreview, "wb-wide") {
                widePreview = !widePreview
                // ★ 左栏收起/展开 ⇒ WebView 宽度变了 ⇒ 必须让它重新量一次尺寸
                //   （不通知的话 window resize 事件不一定触发，compat.js 就不重算 ⇒ 书还是老大小）
                preview.relayout()
            }
            Spacer(Modifier.width(12.dp))
            Text(
                if (busy.isNotEmpty()) busy
                else if (selected.isEmpty()) "${photos.size} 张照片"
                else "已选 ${selected.size} 张",
                color = Ink.copy(alpha = 0.55f), fontSize = 13.sp,
                modifier = Modifier.testTag("wb-count")
            )
            Spacer(Modifier.weight(1f))
            Text("选照片", color = Accent, fontSize = 13.sp, fontWeight = FontWeight.Medium,
                modifier = Modifier.testTag("wb-pick").clickable {
                    // 多选、**追加**（选完自动接着排到后面）
                    // ★ 第八轮①：经**竖屏代理页**去拉相册（`PickProxyActivity` 是 portrait）
                    //   ⇒ 弹出的系统相册是竖的，工作台自己仍是横屏。
                    picker.launch(Intent(ctx, PickProxyActivity::class.java))
                })
            // ★ 第八轮①甲案（2026-10-08）：**只在还没那个权限时才出现**这颗。
            //   为什么平时不显示：它解决的是"这台 Android 10 上选择器只跟随系统旋转"，
            //   而目标机（Android 13+ 有真选择器）本来就能竖 ⇒ 不该天天占版面提醒。
            //   ⛔ 不做成弹窗打断：用户正要选照片，一弹窗就是打扰 ⇒ 只在**选完**时
            //     用 tip 追加一句（见 [picker]），这里给一个可点的入口。
            if (!SystemRotation.canWrite(ctx)) {
                Spacer(Modifier.width(8.dp))
                Text("竖屏相册", color = Ink.copy(alpha = 0.55f), fontSize = 13.sp,
                    modifier = Modifier.testTag("wb-portrait").clickable {
                        val i = SystemRotation.settingsIntent(ctx)
                        if (i != null) {
                            try {
                                permLauncher.launch(i)
                            } catch (t: Throwable) {
                                tip = "这台手机打不开设置页，相册只能横着弹"
                            }
                        } else {
                            tip = "这台手机打不开设置页，相册只能横着弹"
                        }
                    })
            }
            Spacer(Modifier.width(14.dp))
            Text("自动排版", color = Ink.copy(alpha = 0.7f), fontSize = 13.sp,
                modifier = Modifier.testTag("wb-auto").clickable {
                    // 清掉所有人工改过的档位，回到引擎自动分档
                    for (i in photos.indices) photos[i] = photos[i].copy(plate = null, position = null)
                    preview.autoArrange()
                    tip = "已按清晰度重新自动排版"
                })
            Spacer(Modifier.width(14.dp))
            // ★ 顶栏**宽度恒定**：选中态的那些操作（删除所选/取消选择）搬到左栏去。
            //   为什么非这样不可（真机实测踩到的）：选中照片时顶栏多出两个按钮 ⇒
            //   「输出…」「生成画册」被**挤出屏幕**、用户根本点不到；
            //   而我的验收脚本 dump 到的是旧布局 ⇒ "校验通过"却点到了隔壁按钮上，
            //   把系统目录选择器打开了，整条端到端全乱。（"元素出屏"这条铁律，第 N 次现身。）
            Text("清空", color = Ink.copy(alpha = 0.7f), fontSize = 13.sp,
                modifier = Modifier.testTag("wb-clear").clickable {
                    scope.launch {
                        val n = withContext(Dispatchers.IO) { PhotoStore.clearPicked(ctx) }
                        photos.clear()          // 也清掉手上的（含内置素材）
                        selected.clear()
                        DraftStore.clear(ctx)   // 照片都没了，档位草稿也没用了
                        tip = if (n > 0) "已清空 $n 张。下次进来是空的，直到你再选照片"
                              else "已清空。下次进来是空的，直到你再选照片"
                    }
                })
            Spacer(Modifier.width(14.dp))
            // ★ 优化一（2026-10-07）：**输出默认就是书库，顶栏不再常驻一个"输出…"入口**。
            //   他的原话：「输出的时候给选项，使用默认路径或者是自定义路径，
            //   注意一般来说用户不会改地址」⇒ 默认路径 = 零操作能出书；
            //   偶尔要改的，放到**顶栏「…」里**（藏起来而不是占位）。
            //   顶栏文案恒定宽度，点了弹两个选项。
            Text("⋯",
                color = Ink.copy(alpha = 0.7f), fontSize = 15.sp,
                modifier = Modifier.testTag("wb-more").clickable {
                    showOutputMenu = !showOutputMenu
                })
            Spacer(Modifier.width(14.dp))
            Text(
                if (publishing) "出书中…" else "生成画册",
                color = if (publishing) Ink.copy(alpha = 0.4f) else Ink,
                fontSize = 13.sp, fontWeight = FontWeight.Medium,
                modifier = Modifier.testTag("wb-publish").clickable {
                    if (publishing) return@clickable
                    if (photos.isEmpty()) { tip = "还没有照片，出不了书"; return@clickable }
                    publishing = true
                    busy = "正在出书…"
                    preview.publish()
                })
        }
        }   // ← if (!textEditing)

        // 输出目录菜单（只有点了「⋯」才出现）—— 默认路径排第一，且注明推荐
        if (showOutputMenu) {
            Box(Modifier.fillMaxWidth().background(Paper).padding(horizontal = 16.dp, vertical = 8.dp)) {
                Column {
                    val dflt = LibraryStore.libraryName(ctx)
                    Text("默认：书库「${dflt.ifBlank { "（还没绑书库）" }}」",
                        color = Ink.copy(alpha = 0.55f), fontSize = 11.sp)
                    Spacer(Modifier.height(6.dp))
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                        // 「用默认」= 清掉手动指定的输出目录，回到书库
                        Text("用默认路径",
                            color = Accent, fontSize = 13.sp,
                            modifier = Modifier.testTag("wb-out-default").clickable {
                                LibraryStore.resetOutput(ctx)
                                outputLabel = ""
                                showOutputMenu = false
                                tip = "出书会放到书库「${dflt.ifBlank { "（还没绑书库）" }}」"
                            })
                        Spacer(Modifier.width(18.dp))
                        Text("自定义路径…",
                            color = Ink, fontSize = 13.sp,
                            modifier = Modifier.testTag("wb-out-custom").clickable {
                                showOutputMenu = false
                                outputPicker.launch(null)
                            })
                    }
                    if (outputLabel.isNotBlank()) {
                        Spacer(Modifier.height(4.dp))
                        Text("当前输出：$outputLabel",
                            color = Ink.copy(alpha = 0.5f), fontSize = 11.sp)
                    }
                }
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(Line))

        // ---------- 主体：左栏（照片/封面）· 右栏跨页预览 ----------
        Row(Modifier.weight(1f).fillMaxWidth()) {
            if (!widePreview) {
            // ★ 2026-10-08（第四轮）：**编辑封面文字时上边距收到 2dp**。
            //   实测账：键盘弹起后可用区只有 216px；12dp 的上边距白白吃掉 36px，
            //   会让第二行输入（副标题）被裁掉下缘。收紧后两行都完整落在键盘上方。
            Column(Modifier.width(360.dp).fillMaxHeight().padding(
                start = 12.dp, end = 12.dp,
                top = if (textEditing) 2.dp else 12.dp,
                bottom = 12.dp,
            )) {
                if (tab == "photos") {
                    // 只选中一张时，底部露出"这张的版面"（档位 + 位置）
                    val selIdx = if (selected.size == 1)
                        photos.indexOfFirst { it.key == selected[0] } else -1
                    Box(Modifier.weight(1f).fillMaxWidth()) {
                        if (photos.isEmpty()) {
                            Box(Modifier.fillMaxSize().testTag("wb-empty"),
                                contentAlignment = Alignment.Center) {
                                Text("还没有照片。\n点右上角「选照片」从相册里选。",
                                    color = Ink.copy(alpha = 0.45f), fontSize = 13.sp,
                                    lineHeight = 22.sp, textAlign = TextAlign.Center)
                            }
                        } else {
                            PhotoGrid(
                                photos, selected,
                                onTip = { tip = it },
                                // 拖完顺序变了 ⇒ 存草稿（直接存，不用防抖：
                                //   拖拽换位是低频动作，拖一下存一次无所谓）
                                onReordered = { DraftStore.saveNow(ctx, photos, title, subtitle, cover, footText) },
                            )
                        }
                    }
                    if (selected.isNotEmpty()) {
                        // 选中操作放在**照片旁边**（比挤在顶栏既好找、又不会把顶栏撑爆）
                        Row(verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) {
                            Text("已选 ${selected.size} 张", color = Accent, fontSize = 12.sp,
                                modifier = Modifier.testTag("wb-selcount"))
                            Spacer(Modifier.weight(1f))
                            TabChip("删除所选", false, "wb-delete") {
                                val n = selected.size
                                photos.removeAll { it.key in selected }
                                selected.clear()
                                saveDraftSoon()
                                tip = "删掉 $n 张（只从作品里移除；可重新选回来）"
                            }
                            Spacer(Modifier.width(6.dp))
                            TabChip("取消选择", false, "wb-unselect") { selected.clear() }
                        }
                    }
                    if (selIdx >= 0) {
                        PlatePanel(
                            pos = selIdx + 1,
                            plate = photos[selIdx].plate,
                            position = photos[selIdx].position,
                            onPlate = { v ->
                                photos[selIdx] = photos[selIdx].copy(plate = v)
                                pushPlate(selIdx)
                            },
                            onPos = { v ->
                                photos[selIdx] = photos[selIdx].copy(position = v)
                                pushPlate(selIdx)
                            },
                            onAuto = {
                                photos[selIdx] = photos[selIdx].copy(plate = null, position = null)
                                pushPlate(selIdx)
                                tip = "第 ${selIdx + 1} 张已恢复自动档位"
                            },
                        )
                    } else if (selected.isEmpty() && photos.isNotEmpty()) {
                        Text(
                            "点一张照片可单独改它的版面；长按可拖着排序"
                                + if (outputLabel.isBlank()) ""
                                  else "　输出目录：$outputLabel",
                            color = Ink.copy(alpha = 0.4f), fontSize = 11.sp,
                            modifier = Modifier.padding(top = 8.dp).testTag("wb-hint"))
                    }
                }
            }
            Box(Modifier.width(1.dp).fillMaxHeight().background(Line))
            }
            // ★ 跨页预览：真书页，由四颗引擎在 WebView 里算出来（M4b）
            PreviewPane(
                photos = photos,
                title = title,
                subtitle = subtitle,
                coverText = cover,
                controller = preview,
                modifier = Modifier.weight(1f).fillMaxHeight(),
                onPlan = { json -> handlePlan(json, act) },
                onProgress = { text -> busy = text },
                /**
                 * ★ 第六轮：用户**点了封面上的哪处文字** ⇒ 把左栏那个输入框切到它。
                 *
                 * 只切**选中态**，不动文字内容（内容由面板里的输入框负责改）——
                 * 点一下就换输入框焦点，用户接着就能打字。
                 * ⚠ 若点的那个文字框还没建（引擎里不存在）⇒ 先补一个空的再选中，
                 *   否则面板会指向一个不存在的身份。
                 */
                onCoverPick = { json ->
                    try {
                        val o = JSONObject(json)
                        val el = o.optString("el")
                        if (el.isNotBlank()) {
                            if (el.startsWith("x")) {
                                val n = el.drop(1).toIntOrNull() ?: 0
                                if (n in 1..COVER_EXTRA_MAX && !cover.containsKey(el)) {
                                    cover[el] = CoverConf(text = "")
                                }
                                coverExtras = countExtras(cover)
                            }
                            coverEl = el
                        }
                    } catch (t: Throwable) {
                        Log.w("Workbench", "封面拾取解析失败", t)
                    }
                },
                /**
                 * ★★ 第十一轮（2026-10-09）：他在预览里**把文字框拖到了新位置**。
                 *
                 * 口径与「左右/上下」两颗 ＋/－ 完全一致（都是 `cover[el].x/y`，**百分比**）
                 * ⇒ 拖动只是把原来要按很多次加减的事变成一次性拖动，
                 *   **不新增任何状态**，草稿与出书那条路一个字不用改。
                 *
                 * ⚠ 必须 `pushCover()` 重推一次：JS 那边的即时位置只写在 DOM 上，
                 *   翻页/出书都从 `state.payload` 现读 ⇒ 不回流就等于"看着动了、其实没动"。
                 */
                onCoverMove = { json ->
                    try {
                        val o = JSONObject(json)
                        val el = o.optString("el")
                        val x = o.optDouble("x", Double.NaN)
                        val y = o.optDouble("y", Double.NaN)
                        if (el.isNotBlank() && !x.isNaN() && !y.isNaN()) {
                            val c0 = cover[el] ?: CoverConf()
                            cover[el] = c0.copy(x = x.toFloat(), y = y.toFloat())
                            if (el.startsWith("x")) coverExtras = countExtras(cover)
                            coverEl = el
                            delArmed = null
                            // ★★ 第十六轮（他报的「移动文字会闪烁或排版错误」）：改成**静默**推送。
                            //   旧路 pushCover() ⇒ setCover() ⇒ showPage() ⇒ 整页 innerHTML 重建
                            //   （封面图重新解码 = 闪）+ 末尾重算 .book-rig（整本书跳一下）。
                            //   拖动本来就把 --ct-*-x/y 改在 DOM 上了 ⇒ 屏幕不用再动，
                            //   只要让 state 对齐（翻页/出书读的就是它）。
                            preview.setCoverSilent(coverTextJson(cover).toString())
                            saveDraftSoon()
                            tip = "已挪动「${ceLabel(el)}」—— 想精确调可以用下面的「上下 / 左右」"
                        }
                    } catch (t2: Throwable) {
                        Log.w("Workbench", "封面拖动解析失败", t2)
                    }
                },
            )
        }

        // ★★★ 第十五轮（2026-10-09）：这里的**底部抽屉（156dp）已撤**。
        //   佘先生判「封面编辑功能的布局不适合操作」⇒ 封面编辑整体搬到
        //   **独立的竖屏页 `CoverEditActivity`**（工作台的「封面」页签现在只负责**进那一页**）。
        //   ⚠ 为什么不是"两处都能改"：同一份封面草稿两个入口迟早打架。
        //   ⚠ `CoverDrawer` / `CoverPanel` 两个 Composable 的**定义**还留在本文件里
        //     （没有删，怕连累别的引用）——它们是**死代码**，别再把调用点接回来；
        //     真要清理，请单独一轮、改前先备份（教训见 L0「按行号批改」那条）
    }

    if (tip.isNotEmpty()) {
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.BottomCenter) {
            Text(tip, color = Color.White, fontSize = 13.sp,
                modifier = Modifier.background(Ink.copy(alpha = 0.9f), RoundedCornerShape(8.dp))
                    .padding(horizontal = 14.dp, vertical = 10.dp)
                    .clickable { tip = "" })
        }
    }
}

/**
 * 照片网格。
 *
 * ★ 性能三件事（清单第 3 节的「性能打底」）
 *   1. **降采样**：每格只解到 ~200px（原图 750×1692 ⇒ 省 30 倍内存）
 *   2. **内存缓存**：`Thumbs` 的 LruCache（滚动回去不重解）
 *   3. **后台解码**：主线程一帧都不等 IO（走到 `rememberThumb` 里）
 * ★ 交互：单击选中/取消、长按进入多选（跟手机相册的手感一致）。
 */
/**
 * 照片网格：**拖拽排序（跟手）+ 点选多选**。
 *
 * ★ 交互分工（两条手势不打架）
 *   · **单击** = 选中 / 取消（多选）
 *   · **长按后拖动** = 拖拽排序（跟手；松手落位）
 *   · 长按不动 = 什么也不做（想多选就直接点）
 *
 * ★ 性能三件事（清单第 3 节的「性能打底」）
 *   1. **降采样**：每格只解到 ~200px（原图 750×1692 ⇒ 省 30 倍内存）
 *   2. **内存缓存**：`Thumbs` 的 LruCache（滚动回去不重解）
 *   3. **后台解码**：主线程一帧都不等 IO（走到 `rememberThumb` 里）
 *
 * ★ 拖拽怎么做到"跟手"（LazyVerticalGrid 不原生支持排序，得自己算）
 *   网格是**规则**的（固定列数、格子等宽）⇒ 位移可以直接换算成"跨了几格"：
 *   ```
 *   被拖项手指下的位移 dragOffset  ÷  (格宽 + 间距)  ⇒  跨了几列 / 几行
 *   ⇒ 目标槽位 → 数据实时换位（`photos.add(to, photos.removeAt(from))`）
 *   ⇒ 换位后**把 dragOffset 减去跨过的那几格**，视觉上就还是"黏在手指下"（不跳）
 *   ```
 *   其它格子带 `animateItemPlacement()` ⇒ 自动"让位"动画。
 *   被拖的那格用 `graphicsLayer` 位移 + 放大 + `zIndex` 浮到最上层。
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun PhotoGrid(
    photos: MutableList<PhotoRef>,
    selected: MutableList<String>,
    onTip: (String) -> Unit,
    /**
     * 拖拽换位完成后回调一次（上层在这里存草稿 —— **顺序是身份的一部分**）。
     *
     * ★ 为什么用回调而不是在网格里直接存：这个 Composable 只拿到 `photos`，
     *   拿不到 `title`/`cover` 这些上层状态（Compose 的作用域边界）。
     *   顺带一提，`title`/`subtitle` 是 `by remember` 委托，在 lambda 里得写
     *   `.value` 才拿得到 —— 我为这个连编错三次。
     */
    onReordered: () -> Unit,
) {
    val ctx = LocalContext.current
    val cols = 3
    val gap = 8.dp
    var draggingKey by remember { mutableStateOf<String?>(null) }
    var dragOffset by remember { mutableStateOf(Offset.Zero) }
    var movedFar by remember { mutableStateOf(false) }

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val density = LocalDensity.current
        val cellW = (maxWidth - gap * (cols - 1)) / cols
        // "跨一格"的步长（格宽 + 间距），拖拽换算全靠它
        val stepPx = with(density) { (cellW + gap).toPx() }

        LazyVerticalGrid(
            columns = GridCells.Fixed(cols),
            horizontalArrangement = Arrangement.spacedBy(gap),
            verticalArrangement = Arrangement.spacedBy(gap),
            modifier = Modifier.fillMaxSize()
        ) {
            itemsIndexed(photos, key = { _, p -> p.key }) { index, p ->
                val isDragging = draggingKey == p.key
                val isSel = p.key in selected
                Box(
                    Modifier.aspectRatio(1f)
                        .testTag("wb-photo-${index + 1}")
                        // ★ contentDescription = 照片文件名 —— 这是**给验收用的**：
                        //   Compose 的文本不进无障碍树，但 content-desc 会进
                        //   ⇒ 于是"拖完之后第 3 格是原来哪张照片"可以被 dump 验证出来。
                        .semantics { contentDescription = p.relPath.substringAfterLast('/') }
                        .zIndex(if (isDragging) 1f else 0f)
                        .graphicsLayer {
                            if (isDragging) {
                                translationX = dragOffset.x
                                translationY = dragOffset.y
                                scaleX = 1.07f
                                scaleY = 1.07f
                            }
                        }
                        .animateItemPlacement()
                        .clip(RoundedCornerShape(6.dp))
                        .background(Ink.copy(alpha = 0.06f))
                        .then(
                            if (isSel) Modifier.border(2.dp, Accent, RoundedCornerShape(6.dp))
                            else Modifier
                        )
                        .pointerInput(p.key) {
                            detectDragGesturesAfterLongPress(
                                onDragStart = {
                                    draggingKey = p.key
                                    dragOffset = Offset.Zero
                                    movedFar = false
                                },
                                onDrag = { change, delta ->
                                    change.consume()
                                    dragOffset += delta
                                    if (dragOffset.getDistance() > 14f) movedFar = true
                                    val key = draggingKey ?: return@detectDragGesturesAfterLongPress
                                    val from = photos.indexOfFirst { it.key == key }
                                    if (from < 0) return@detectDragGesturesAfterLongPress
                                    val curCol = from % cols
                                    val curRow = from / cols
                                    val dCol = (dragOffset.x / stepPx).roundToInt()
                                    val dRow = (dragOffset.y / stepPx).roundToInt()
                                    val nCol = (curCol + dCol).coerceIn(0, cols - 1)
                                    val nRow = (curRow + dRow).coerceAtLeast(0)
                                    val to = (nRow * cols + nCol).coerceIn(0, photos.size - 1)
                                    if (to != from) {
                                        photos.add(to, photos.removeAt(from))
                                        // ★ 顺序改了 ⇒ 让上层存草稿
                                        onReordered()
                                        // ★ 关键一行：换位后把它"跨过的那几格"从偏移里扣掉
                                        //   ⇒ 视觉上仍黏在手指下（不跳）。漏了这句就会闪。
                                        dragOffset -= Offset(
                                            (nCol - curCol) * stepPx,
                                            (nRow - curRow) * stepPx
                                        )
                                    }
                                },
                                onDragEnd = {
                                    val key = draggingKey
                                    if (key != null && movedFar) {
                                        // 落位后重编号（order 就是最终页序）
                                        for (i in photos.indices) {
                                            photos[i] = photos[i].copy(order = i + 1)
                                        }
                                        val at = photos.indexOfFirst { it.key == key } + 1
                                        onTip("已挪到第 $at 位")
                                    }
                                    draggingKey = null
                                    dragOffset = Offset.Zero
                                    movedFar = false
                                },
                                onDragCancel = {
                                    draggingKey = null
                                    dragOffset = Offset.Zero
                                    movedFar = false
                                }
                            )
                        }
                        .clickable {
                            if (isSel) selected.remove(p.key) else selected.add(p.key)
                        }
                ) {
                    val bmp = rememberThumb(p.key, 200) { p.open(ctx) }
                    if (bmp != null) {
                        Image(bmp, contentDescription = null,
                            modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                    } else {
                        // 还没解出来 / 解失败 —— 留底色，别闪、别崩
                        Text("…", color = Ink.copy(alpha = 0.3f), fontSize = 14.sp,
                            modifier = Modifier.align(Alignment.Center))
                    }
                    // 序号角标 —— ★ 用 index+1（不是 p.order）：拖拽时即时跟着新位置走
                    Box(Modifier.align(Alignment.BottomStart).padding(4.dp)
                        .background(Ink.copy(alpha = 0.65f), CircleShape)
                        .padding(horizontal = 6.dp, vertical = 1.dp)) {
                        Text("${index + 1}", color = Color.White, fontSize = 10.sp,
                            maxLines = 1, overflow = TextOverflow.Clip)
                    }
                    if (isSel) {
                        Box(Modifier.align(Alignment.TopEnd).padding(4.dp)
                            .size(18.dp).background(Accent, CircleShape),
                            contentAlignment = Alignment.Center) {
                            Text("✓", color = Color.White, fontSize = 11.sp)
                        }
                    }
                }
            }
        }
    }
}

/**
 * 一个小胶囊按钮（页签 / 档位 / 字体 / 颜色都复用它）。
 * [tag] 会变成 `resource-id` —— 验收脚本靠它拿真实坐标（Compose 的文本不好定位）。
 *
 * ⚠ 尺寸刻意做**紧凑**：左栏底部要同时放下「已选 N 张」+ 档位一行 + 位置一行，
 *   做大了会把照片网格压得只剩一行（实测过：3 列 × 1 行）。
 */
@Composable
private fun TabChip(label: String, on: Boolean, tag: String, onClick: () -> Unit) {
    // ★ 第九轮丙案（F139）：**选中态不能只靠颜色**—— 色弱用户在浅色底上看不出深浅差。
    //   加一个 **✔ 勾**（只在选中时出现）⇒ 形状 + 颜色两条线索都能分辨。
    //   ⚠ 别改成设 `selected` 语义：判据脚本按 `selected` 抓会全false（F139 踩过），
    //     这里保留「只画不设」，判据一律走像素。
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        modifier = Modifier
            .testTag(tag)
            .clip(RoundedCornerShape(20.dp))
            .background(if (on) Accent else Ink.copy(alpha = 0.07f))
            .clickable { onClick() }
            .padding(horizontal = 8.dp, vertical = 3.dp),
    ) {
        if (on) {
            Text("✔", color = Color.White, fontSize = 10.sp)
        }
        Text(
            label,
            color = if (on) Color.White else Ink.copy(alpha = 0.75f),
            fontSize = 11.sp,
        )
    }
}

/**
 * 「这张的版面」—— 逐张改档位（小/中/大/竖）+ 位置（居中/上/下/偏右）。
 *
 * ★ 空值（[plate] / [position] 为 `null`）= **听引擎的**（`assignPlates` 按清晰度名次定）。
 *   界面显示"自动"，用户点了具体值才写进配置 —— 这样以后引擎改规则，没动过的照片会跟着变。
 */
@Composable
private fun PlatePanel(
    pos: Int,
    plate: String?,
    position: String?,
    onPlate: (String) -> Unit,
    onPos: (String) -> Unit,
    onAuto: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("第 $pos 张的版面", color = Ink.copy(alpha = 0.6f), fontSize = 12.sp,
                modifier = Modifier.testTag("wb-plate-title"))
            Spacer(Modifier.width(8.dp))
            Text(if (plate == null) "自动" else "已改", color = Accent, fontSize = 11.sp)
            Spacer(Modifier.weight(1f))
            Text("恢复自动", color = Ink.copy(alpha = 0.6f), fontSize = 12.sp,
                modifier = Modifier.testTag("wb-plate-auto").clickable { onAuto() })
        }
        Spacer(Modifier.height(6.dp))
        // 档位一行、位置一行 —— 挤一行会把「偏右」顶到第二行去（实测过）
        Row {
            listOf("small" to "小", "medium" to "中", "large" to "大", "portrait" to "竖")
                .forEachIndexed { i, (v, label) ->
                    if (i > 0) Spacer(Modifier.width(6.dp))
                    TabChip(label, plate == v, "wb-plate-$v") { onPlate(v) }
                }
        }
        Spacer(Modifier.height(6.dp))
        Row {
            listOf("center" to "居中", "high" to "上", "low" to "下", "aside" to "偏右")
                .forEachIndexed { i, (v, label) ->
                    if (i > 0) Spacer(Modifier.width(6.dp))
                    TabChip(label, position == v, "wb-pos-$v") { onPos(v) }
                }
        }
    }
}

/**
 * 封面文案的默认值（**只用来当滑块的起点**）。
 *
 * ⚠ 抄自 `books/book1/style/book-style.css` 里那三条 `var(--ct-*, 回退值)`：
 *   `title` 7.2cqw/y15% · `subtitle` 2.1cqw/y33% · `foot` 1.6cqw/y7%。
 *   它**不会**被写进配置 —— 用户不动滑块，配置里就没有这一项（见 [CoverConf]）。
 */
internal val CoverDefaults = mapOf(
    "title" to CoverConf(x = 13.5f, y = 15f, size = 7.2f, font = "serif", align = "start"),
    "subtitle" to CoverConf(x = 13.5f, y = 33f, size = 2.1f, font = "serif", align = "start"),
    "foot" to CoverConf(x = 13.5f, y = 7f, size = 1.6f, font = "sans", align = "start"),
)

/** 颜色候选（够用就好；要别的颜色等 M4c 之后的调色板）。 */
internal val CoverPalette = listOf(
    "米白" to "#F7F6F0", "墨黑" to "#2B2B26", "暖褐" to "#6B4F2A",
    "灰" to "#8F8F85", "朱红" to "#A33B2A", "深蓝" to "#2E3B4E",
)

/** 引擎的文字框上限 —— `template.js` 的 `COVER_EXTRA_MAX = 8`（键是 `x1`..`x8`）。 */
internal const val COVER_EXTRA_MAX = 8

/** 现有几个文字框（只数 `xN` 这种键；返回 0..8）。 */
internal fun countExtras(cover: Map<String, CoverConf>): Int =
    cover.keys.count { it.matches(Regex("^x[1-9]\\d?$")) }

/** 下一个可用的文字框编号（填了空号就复用，删过之后能补回来）；满了返回 9（> 上限）。 */
internal fun nextExtraNum(cover: Map<String, CoverConf>): Int {
    val used = HashSet<Int>()
    cover.keys.forEach { k ->
        if (k.matches(Regex("^x[1-9]\\d?$"))) k.drop(1).toIntOrNull()?.let { used.add(it) }
    }
    for (n in 1..COVER_EXTRA_MAX) { if (n !in used) return n }
    return COVER_EXTRA_MAX + 1
}

/**
 * 封面编辑面板（M4c）。
 *
 * ★ 为什么放在左栏而不是弹窗：**要能一边改一边看右边预览**。
 *   旧工程把封面塞进一个 iframe 弹窗里，结果预览与编辑器隔着两层文档、
 *   还多出一个 `window.__cve` 桥要复刻 —— 那正是"网页无法打开"那个老问题的根。
 *   原生这边直接把编辑面板和预览并排放，问题从结构上就没了。
 *
 * ⚠⚠ 第九轮①（2026-10-09）：**本面板已被 [CoverDrawer] 取代**（他拍板**方案 B · 底部抽屉**）。
 *   本函数**保留不删** —— 它是 `widePreview`（宽预览）那条老路子的唯一实现，
 *   删了万一抽屉在小屏上出问题，得有个能立刻退回去的地方。
 */

/** `%.1f`（字号显示用）。 */
internal fun fmt1(v: Float): String = "%.1f".format(v)

/** `#RRGGBB` → Color（面板上的色块用）。 */
internal fun parseHex(hex: String): Color = try {
    Color(android.graphics.Color.parseColor(hex))
} catch (t: Throwable) {
    Color.Gray
}

internal val Danger = Color(0xFFB3261E)
internal val Accent = Color(0xFF4A6FA5)
