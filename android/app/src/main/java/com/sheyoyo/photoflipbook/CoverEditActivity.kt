package com.sheyoyo.photoflipbook

import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

/* ============================================================================
 * ★★ 第十五轮（2026-10-09）：**竖屏封面编辑页**（`CoverEditActivity`）
 * ============================================================================
 *
 * 佘先生的原话：
 *   「封面编辑功能的布局不适合操作，要求工作流程是**用户点击封面后进入封面编辑界面**，
 *     封面编辑界面设计成**竖屏的封面图片**，封面图**占据屏幕大部分**，
 *     顶部留一定的空间放**新增文字框**，**点击图片上的相应文字就显示文字框**并在
 *     下方弹出修改的**功能条**，注意**功能条的大小不要设计的太大**，要以预览图为核心，
 *     那些什么**字号，字体等功能折叠**，不要一次性全部展开」
 *
 * —— 为什么要**新开一页**、而不是在工作台里转屏（`F146` 的血账）：
 *   第十轮③ 我曾在 `WorkbenchActivity` 里按页签转竖屏，结果工作台版面（左栏 + 预览）
 *   是为横屏设计的，一转就挤坏，他判「效果太差」整体回滚。
 *   ⇒ 这次是**独立的 Activity**，它自己声明 `screenOrientation="portrait"`，
 *     **工作台一个方向字节都不动**。
 *
 * —— 与旧面板的关系（为什么不两处都能改封面）：
 *   旧的就地编辑（左栏「封面文案」面板 + 底部 156dp 抽屉）**已从工作台撤掉**
 *   （工作台的「封面」页签现在只负责**进这一页**）——同一份东西有两个入口迟早打架。
 *
 * —— 状态口径（一个字都没新造）：
 *   读/写的是同一份 `DraftStore` 草稿（`title`/`subtitle`/`footText`/`cover`），
 *   预览走的是同一份 `preview.html`（只是加了 `?cover=1` 的"只画封面"模式）。
 *   ⇒ 出书 / 成品书那条路**一个字节都不用改**。
 *
 * —— 保存时机（他 2026-10-09 拍板）：
 *   「完成」和「返回」**都保存**（跟草稿的行为一致，免得白干）；
 *   另外 `onDispose` 再兜一次（系统返回键 / 被系统杀掉时也不丢）。
 */
class CoverEditActivity : ComponentActivity() {

    companion object {
        /** 从哪本书的素材起步（与 [WorkbenchActivity.EXTRA_SOURCE_BOOK] 同口径）。 */
        const val EXTRA_SOURCE_BOOK = "source_book"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val src = intent.getStringExtra(EXTRA_SOURCE_BOOK) ?: "book1"
        val appCtx = applicationContext
        // ★ 与工作台同一个取照片入口 ⇒ 封面用的那张、页序都一致
        val initial = PhotoStore.currentPhotos(appCtx, src)

        setContent {
            PhotoFlipbookTheme {
                Surface(Modifier.fillMaxSize(), color = Paper) {
                    // ★ 与其它页同一个系统栏安全内边距（竖屏下状态栏/手势条都在）
                    Box(Modifier.fillMaxSize().sysBars()) {
                        CoverEditScreen(initial, onClose = { finish() })
                    }
                }
            }
        }
    }
}

/** 日志标签（**文件级**：Activity 与顶层 Composable 共用）。 */
private const val TAG = "CoverEdit"

/** 功能条上那 5 组（手风琴的键 → 图标 → 提示）。**同时只展开一组**。 */
private val CE_GROUPS: List<Triple<String, String, String>> = listOf(
    Triple("size", "A+", "字号"),
    Triple("font", "Aa", "字体"),
    Triple("color", "◐", "颜色"),
    Triple("align", "≡", "对齐"),
    Triple("pos", "↕", "位置"),
)

/** 一个元素的显示名（人话 —— 提示语那条命门）。 */
internal fun ceLabel(el: String): String = when (el) {
    "title" -> "书名"
    "subtitle" -> "副标题"
    "foot" -> "页脚"
    else -> "文字框 " + el.drop(1)
}

@Composable
private fun CoverEditScreen(initial: List<PhotoRef>, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    val tagOn = Modifier.semantics { testTagsAsResourceId = true }

    val photos = remember { mutableStateListOf<PhotoRef>().also { it.addAll(initial) } }
    var title by remember { mutableStateOf(DEFAULT_TITLE) }
    var subtitle by remember { mutableStateOf(DEFAULT_SUBTITLE) }
    var footText by remember { mutableStateOf("") }
    /** 封面样式覆盖（**只放用户真动过的项**，口径见 [CoverConf] 的注释）。 */
    val cover = remember { mutableStateMapOf<String, CoverConf>() }

    /** 当前选中哪一处（预览里点、或新增之后自动选中）。 */
    var sel by remember { mutableStateOf("title") }
    /** 手风琴：当前展开的功能组（null = 只显示一行图标）。 */
    var open by remember { mutableStateOf<String?>(null) }
    /**
     * ★ 他要求「**点击**封面上的文字才弹出功能条」⇒ 这一页刚进来时**不显示图标行**，
     *   只给一句"点封面上的文字就能改"的提示。点过任意一处（或新增了文字框）之后才亮出工具。
     *   ⚠ 默认选中是「书名」——没点过就不该假定他想改书名。
     */
    var picked by remember { mutableStateOf(false) }
    /**
     * ★ 第十五轮：**待确认删除**的那一项（两段式删除的第一下）。
     *
     * ⚠ 第十五轮从 `Int?`（文字框编号）改成 **`String?`（元素 key）** ——
     *   因为「删除」现在**对书名/副标题/页脚也生效**（它们没有编号）。
     * ❌ 早先是 `Int?` 编号：想删书名只能靠"隐藏"那个开关，而他这次明确要求
     *   「**书名和其他的文字都可以删除**」⇒ 统一成 key。
     * ⚠ 同时它也是"哪一项正在等着确认"的唯一真相 —— 面板上那颗钮的文案/颜色都看它。
     */
    var delArmed by remember { mutableStateOf<String?>(null) }
    var tip by remember { mutableStateOf("") }

    // ══════════════════ ★ 第十八轮：撤回（他要求「所有封面的操作都允许撤回」）══════════
    /**
     * 撤回栈 = **进页面时的初始快照** + 一串"每步改动前"的历史。
     *
     * ⚠ 为什么存**整份**而不是"反向操作"（字号 +0.5 的反向是 −0.5）：
     *   反向操作要求每处改动都成对写一遍撤销逻辑，**漏一处就永久损坏**；
     *   整份快照没有"漏"这种可能 —— 覆盖样式、打字、删除、新增、拖动，**一律照抄**。
     *   代价只是内存（一本画册最多几十步，每步几 KB），换来"撤回永远是对的"。
     * ⚠ 打字也压栈（他选的"全部操作含打字"）⇒ 连敲十个字要撤十次才回得去，
     *   这是他自己选的语义，不是 bug。
     */
    val preview = remember { PreviewController() }

    // ---- 草稿：进屏先恢复（与工作台同一份文件） ----
    var restored by remember { mutableStateOf(false) }

    data class Snap(
        val title: String,
        val subtitle: String,
        val footText: String,
        val cover: Map<String, CoverConf>,
    )

    fun snap() = Snap(title, subtitle, footText, LinkedHashMap(cover))
    val undoStack = remember { mutableStateListOf<Snap>() }
    /** 初始快照单独存一份 ⇒ 「↺ 回到初始」不必靠撤到底（撤到底 = 一样，但要多按几次）。 */
    var initialSnap by remember { mutableStateOf<Snap?>(null) }

    /**
     * ★ 草稿**恢复完之后**再拍初始快照（下面那个 `remember { … }` 里）——
     *   ⚠ 顺序很要紧：先进页面就拍 ⇒ 快照是空默认值，"回到初始"会把他的草稿**清空**。
     *   正确口径：**他看到的第一屏就是初始状态**（含上次没做完的草稿）。
     */
    fun takeInitial() {
        initialSnap = snap()
        undoStack.clear()
    }

    // ---- 存草稿：改动防抖 350ms；「完成/返回/离开」走立即存 ----
    var saveJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }
    fun saveNow() {
        if (!restored) return
        try {
            DraftStore.saveNow(ctx, photos, title, subtitle, cover, footText)
        } catch (t: Throwable) {
            Log.w(TAG, "存草稿失败（不影响使用）", t)
        }
    }
    fun saveSoon() {
        if (!restored) return
        saveJob?.cancel()
        saveJob = scope.launch {
            delay(350)
            saveNow()
        }
    }

    /**
     * ★ 第十八轮（他要求「标题/副标题/页脚选中时也要有矩形框」）：把"当前选中"告诉预览页。
     *
     * ⚠ 走的是**已有的** `setActiveExtra` 通道（第七轮为两段式删除建的）——
     *   本轮只是把它的覆盖范围从"只管用户自加的文字框"扩到"四类元素都管"
     *   （改在 `preview.html` 的 `markActiveExtra`，引擎四颗 JS 一字未动）。
     * ⚠ 传**空串** = 都不选中。
     */
    fun pushSel() {
        preview.setActiveExtra(if (sel.isBlank()) "" else sel)
    }

    /** 用户动了封面 ⇒ 立刻推给预览（快路）。 */
    fun pushCover() {
        preview.setCover(coverTextJson(cover).toString())
        pushSel()
        saveSoon()
    }

    /**
     * ★★ 第十八轮（他报「增大封面文字大小时画面会闪烁」）：**样式类**改动走这条。
     *
     * ⚠ 成因（不是错觉，是真 bug）：旧路 `pushCover()` ⇒ `setCover()` ⇒ 页面 `showPage()`
     *   ⇒ `innerHTML` **整页重建 + 封面图重新解码** ⇒ 每按一次 A+ 就闪一下。
     *   （`PreviewPane.setCover` 的注释里就写着这句后果。）
     * ⛔ 拖动在第十五轮已经修过同一个毛病（走 `setCoverSilent`），**字号/字体/颜色没跟上**。
     *
     * ★ 为什么样式改动**可以**静默：那一行 `setCoverSilent` 的注释已经论证过 ——
     *   拖动时 DOM 上的 `--ct-<key>-x/y` 已经被手指拖到位；字号/颜色/字体同理，
     *   页面 JS 那边只要把新值**就地写进 CSS 变量**就够了，不必重建 DOM。
     * ⛔ 但「删除/隐藏/新增」**必须**走 [pushCover] 重画 —— 那些是"节点要不要存在"变了，
     *   静默通道不会让节点消失/出现（第十五轮踩过：`hide:false` ≠ 取消隐藏）。
     */
    fun pushCoverSilent() {
        preview.setCoverSilent(coverTextJson(cover).toString())
        pushSel()
        saveSoon()
    }

    /**
     * 每一步改动**之前**先调它压栈。
     * ⚠ 只在**真要改**的时候才压（调用点自己判断），否则"点了个没用的钮"也能撤，
     *   栈里全是噪声（撤的时候看着莫名其妙）。
     */
    fun pushUndo() {
        if (!restored) return
        undoStack.add(snap())
    }

    /** 回退一步；栈空 = 已经退到初始 ⇒ 提示他，别静默。 */
    fun undo() {
        val s = undoStack.removeLastOrNull()
        if (s == null) {
            tip = "已经回到最初的样子了，没什么可撤的"
            return
        }
        title = s.title; subtitle = s.subtitle; footText = s.footText
        cover.clear(); cover.putAll(s.cover)
        // ★ 撤回走**重画**通道：撤回本来就该"看得见整页回到上一步"（走静默会让人怀疑没生效）
        preview.setCover(coverTextJson(cover).toString())
        preview.setFootText(footText)
        pushSel()
        saveSoon()
        tip = "已撤回一步（还能撤 ${undoStack.size} 步）"
    }

    /** 一次清空所有改动，直奔进页面那一刻。 */
    fun undoAll() {
        val s0 = initialSnap ?: return
        undoStack.clear()
        title = s0.title; subtitle = s0.subtitle; footText = s0.footText
        cover.clear(); cover.putAll(s0.cover)
        preview.setCover(coverTextJson(cover).toString())
        preview.setFootText(footText)
        pushSel()
        saveSoon()
        tip = "已回到最初的样子"
    }


    remember {
        val d = DraftStore.load(ctx)
        if (d != null) {
            if (d.title.isNotBlank()) title = d.title
            if (d.subtitle.isNotBlank()) subtitle = d.subtitle
            footText = d.footText
            cover.putAll(d.cover)
            // 档位/位置也贴回去 —— 它决定页序，而"封面用哪张照片"是引擎按页序算的
            d.perPhoto.forEach { (key, e) ->
                val i = photos.indexOfFirst { it.key == key }
                if (i >= 0) photos[i] = photos[i].copy(plate = e.plate, position = e.position)
            }
        }
restored = true
            true
    }
    // ★ 第十八轮：草稿恢复了才能拍"初始快照"（顺序反了会把他的草稿当成"改动"撤掉）
    remember(restored) {
        if (restored && initialSnap == null) { takeInitial() }
        true
    }

    /**
     * 书页不需要文字（他 2026-10-09 明确）⇒ 这一页**只管封面**，页脚走独立那条通路。
     * ★ 第十五轮：走**静默**那条（`setFootTextSilent`）——
     *   这一页屏幕上只有封面，就地改那一个文字节点就够，不必整页重画（打字不闪）。
     * ⚠ 书名/副标题的静默由 `PreviewPane` 内部按 `coverOnly` 自己选（见那边的注释）。
     */
    LaunchedEffect(footText) {
        if (restored) preview.setFootTextSilent(footText)
    }

    // 离开这一页（系统返回键 / 被回收）时再兜一次
    DisposableEffect(Unit) {
        onDispose { saveNow() }
    }

    Column(Modifier.fillMaxSize().then(tagOn)) {

        // ══════════════════ ① 顶栏 ══════════════════
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 6.dp)
                .height(40.dp)
        ) {
            Text(
                "← 返回", color = Ink.copy(alpha = 0.7f), fontSize = 14.sp,
                modifier = Modifier.testTag("ce-back")
                    .clickable { saveNow(); onClose() }
                    .padding(6.dp)
            )
            Spacer(Modifier.width(10.dp))
            Text("封面编辑", color = Ink, fontSize = 16.sp, fontWeight = FontWeight.Medium,
                modifier = Modifier.testTag("ce-title"))
            Spacer(Modifier.weight(1f))
            // ══════════════════════════════════════════════════════════════
            // ★★ 第十八轮（他要求「新增一个撤回功能，所有封面的操作都允许撤回」）
            //   放**顶栏**是他选的：常驻可见，在任何功能组展开时都能一键撤回，
            //   不用先去折叠面板找。
            //   ⚠「↩ 撤回」按**能不能撤**变灰 —— 不能撤的时候点了会有人话提示，
            //     但看着就该是灰的（不然永远有人试着点它）。
            //   ⚠「↺ 初始」是**一键回到进页面那一刻**（不必一路撤到底），
            //     藏在这一颗的**长按**里：顶栏只放一颗，画面不挤。
            // ══════════════════════════════════════════════════════════════
            val canUndo = undoStack.isNotEmpty()
            // ★★“↩ 初始”能不能用：有可撤的步数，且现在的值还不等于进页面那一刻。
            val s0 = initialSnap
            val canUndoAll = canUndo && s0 != null &&
                (title != s0.title || subtitle != s0.subtitle ||
                    footText != s0.footText || cover != s0.cover)
            Text(
                "↩ 撤回",
                color = if (canUndo) Ink else Ink.copy(alpha = 0.3f),
                fontSize = 13.sp,
                modifier = Modifier
                    .testTag("ce-undo")
                    .clip(RoundedCornerShape(14.dp))
                    .border(
                        1.dp,
                        if (canUndo) Ink.copy(alpha = 0.25f) else Line,
                        RoundedCornerShape(14.dp)
                    )
                    .clickable { undo() }
                    .padding(horizontal = 12.dp, vertical = 7.dp)
            )
            Spacer(Modifier.width(8.dp))
            Text(
                "↺ 初始",
                color = if (canUndoAll) Accent else Ink.copy(alpha = 0.3f),
                fontSize = 13.sp,
                modifier = Modifier
                    .testTag("ce-undo-all")
                    .clip(RoundedCornerShape(14.dp))
                    .border(
                        1.dp,
                        if (canUndoAll) Accent else Line,
                        RoundedCornerShape(14.dp)
                    )
                    .clickable { undoAll() }
                    .padding(horizontal = 12.dp, vertical = 7.dp)
            )
            Spacer(Modifier.width(8.dp))
            Text(
                "✓ 完成", color = Color.White, fontSize = 14.sp,
                modifier = Modifier
                    .testTag("ce-done")
                    .clip(RoundedCornerShape(14.dp))
                    .background(Accent)
                    .clickable { saveNow(); onClose() }
                    .padding(horizontal = 14.dp, vertical = 7.dp)
            )
        }

        Box(Modifier.fillMaxWidth().height(1.dp).background(Line))

        // ══════════════════ ② 新增/删除文字框那一行（"顶部留一定的空间放新增文字框"）══════
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)
        ) {
            Text(
                "＋ 新增文字框", color = Color.White, fontSize = 13.sp,
                modifier = Modifier
                    .testTag("ce-add")
                    .clip(RoundedCornerShape(14.dp))
                    .background(Accent)
                    .clickable {
                        val n = nextExtraNum(cover)
                        if (n > COVER_EXTRA_MAX) {
                            tip = "文字框最多 $COVER_EXTRA_MAX 个"
                        } else {
                            pushUndo()                            // ★ 第十八轮：可撤回
                            cover["x$n"] = CoverConf(text = "文字 $n")
                            sel = "x$n"
                            picked = true
                            open = "text"        // 新增立刻就让他打字（不然还得再点一下）
                            delArmed = null
                            pushCover()
                            tip = "已加「文字框 $n」—— 下面直接打字就行"
                        }
                    }
                    .padding(horizontal = 12.dp, vertical = 7.dp)
            )
            Spacer(Modifier.width(8.dp))
            // ══════════════════════════════════════════════════════════════════
            // 删除 —— ★★ 第十五轮（他要求）：「**书名和其他的文字都可以删除**」
            //   规则（一颗钮干三件事，文案自己说话）：
            //     · 选中是「文字框 N」        ⇒ 两段式 → 真删（从配置里拿掉，不可逆 ⇒ 必须防误删）
            //     · 选中是内置三处**还看得见** ⇒ 两段式 → 置 `hide`（可从「恢复显示」放回来）
            //     · 选中是内置三处**已经删了** ⇒ 一下 → 放回封面（`hide=false`）
            //   ⚠ 为什么内置三处用 `hide` 而不是删掉：书名/副标题的文字**来自 `payload`**
            //     （`title`/`subtitle`），配置层管不着"有没有这段字"，只能让它**不画**
            //     —— 这正是引擎 `normalizeCoverText` 的 `hide` 干的（`template.js::coverTextHtml`）。
            //   ⚠ 必须先判"已经删了"再判 arm：否则删完再点一下会又 arm 一次，回不来。
            // ══════════════════════════════════════════════════════════════════
            val selIsExtra = sel.startsWith("x")
            val selHidden = !selIsExtra && ((cover[sel]?.hide) == true)
            Text(
                when {
                    selHidden -> "↺ 恢复显示"
                    delArmed == sel && selIsExtra -> "● 再点删除"
                    delArmed == sel -> "● 再点就删"
                    selIsExtra -> "删除文字框"
                    else -> "从封面删掉"
                },
                color = when {
                    delArmed == sel && !selHidden -> Danger
                    selHidden -> Accent
                    else -> Ink.copy(alpha = 0.6f)
                },
                fontSize = 13.sp,
                modifier = Modifier
                    .testTag("ce-del")
                    .clip(RoundedCornerShape(14.dp))
                    .border(
                        1.dp,
                        when {
                            delArmed == sel && !selHidden -> Danger
                            selHidden -> Accent
                            else -> Line
                        },
                        RoundedCornerShape(14.dp)
                    )
                    .clickable {
                        // ---- ① 已经删了 ⇒ 一下放回来 ----
                        if (selHidden) {
                            pushUndo()                        // ★ 第十八轮：可撤回
                            val c0 = cover[sel] ?: CoverConf()
                            // ★★★ 必须是 `hide = null`（**删掉这个字段**），绝不能写 `hide = false`。
                            //   真机实测（本轮踩到的）：引擎 `template.js` 里
                            //     · `coverTextHtml()`：`if (!(cover.title||{}).hide)` ⇒ 渲染
                            //     · `coverTextStyle()`：`else if (key === 'hide') 加 --ct-*-display:none`
                            //       —— **不看值**，字段在就加
                            //   ⇒ `hide:false` 的结果是"元素照样渲染、但 CSS 把它藏了"
                            //   ⇒ 「恢复显示」按了没反应，一层 `display:none` 永远摘不掉。
                            val c1 = c0.copy(hide = null)
                            if (c1.isEmpty()) cover.remove(sel) else cover[sel] = c1
                            delArmed = null
                            pushCover()                    // ★ 必须重画：节点要重新出现
                            tip = "已把「${ceLabel(sel)}」放回封面"
                            return@clickable
                        }
                        // ---- ② 第一下 ⇒ 只 arm ----
                        if (delArmed != sel) {
                            delArmed = sel
                            tip = if (selIsExtra) {
                                "再点一次「删除文字框」才真的删掉（防误删）"
                            } else {
                                "再点一次就把「${ceLabel(sel)}」从封面上拿掉（还能恢复显示）"
                            }
                            return@clickable
                        }
                        // ---- ③ 第二下 ⇒ 真删 ----
                        if (selIsExtra) {
                            pushUndo()                        // ★ 第十八轮：可撤回
                            cover.remove(sel)
                            sel = "title"
                            open = null
                            delArmed = null
                            pushCover()
                            tip = "已删掉那个文字框"
                        } else {
                            pushUndo()                        // ★ 第十八轮：可撤回
                            val c0 = cover[sel] ?: CoverConf()
                            cover[sel] = c0.copy(hide = true)
                            delArmed = null
                            pushCover()                        // ★ 必须重画：节点要消失
                            tip = "已把「${ceLabel(sel)}」从封面删掉 —— 想放回来点「↺ 恢复显示」"
                        }
                    }
                    .padding(horizontal = 12.dp, vertical = 7.dp)
            )
            Spacer(Modifier.weight(1f))
            Text(
                "已用 ${countExtras(cover)} / $COVER_EXTRA_MAX",
                color = Ink.copy(alpha = 0.45f), fontSize = 12.sp,
                modifier = Modifier.testTag("ce-count")
            )
        }

        // ══════════════════ ③ 封面预览（占屏幕大部分 —— 这一页的主角）══════════════
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (restored) {
                PreviewPane(
                    photos = photos,
                    title = title,
                    subtitle = subtitle,
                    coverText = cover,
                    controller = preview,
                    coverOnly = true,                       // ★ 只画封面（单页、锁第 1 页）
                    modifier = Modifier.fillMaxSize(),
                    onReady = {
                        // 页面壳就绪 ⇒ 把草稿里的封面配置推一次（**早了会被丢**，见 onReady 注释）。
                        // ⚠ 页脚文字也要在这里补一次：页脚那条 LaunchedEffect 只在 footText
                        //   **变化**时跑，而"进页面这一下"footText 没变过（那时页面还没就绪）⇒ 会漏。
                        preview.setCover(coverTextJson(cover).toString())
                        preview.setFootText(footText)
                    },
                    onCoverPick = { json ->
                        try {
                            val o = JSONObject(json)
                            val el = o.optString("el")
                            if (el.isNotBlank()) {
                                // ⚠ 引擎里还不存在的文字框先补一个空壳再选中，
                                //   否则界面会指向一个"不存在的身份"
                                if (el.startsWith("x") && !cover.containsKey(el)) {
                                    cover[el] = CoverConf(text = "")
                                }
                                sel = el
                                picked = true
                                delArmed = null
                                pushSel()                          // ★ 第十八轮：画布点谁选中谁
                                tip = "已选中「${ceLabel(el)}」—— 下面那一条改的就是它"
                            }
                        } catch (t: Throwable) {
                            Log.w(TAG, "封面拾取解析失败", t)
                        }
                    },
                    onCoverMove = { json ->
                        try {
                            val o = JSONObject(json)
                            val el = o.optString("el")
                            val x = o.optDouble("x", Double.NaN)
                            val y = o.optDouble("y", Double.NaN)
                            if (el.isNotBlank() && !x.isNaN() && !y.isNaN()) {
                                pushUndo()                        // ★ 第十八轮：可撤回
                                val c0 = cover[el] ?: CoverConf()
                                cover[el] = c0.copy(x = x.toFloat(), y = y.toFloat())
                                sel = el
                                picked = true
                                delArmed = null
                                // ★★ 第十五轮（他报的「移动文字会闪烁或排版错误」）：
                                //   **只同步 state，绝不重画**。旧路是 pushCover() ⇒ setCover()
                                //   ⇒ showPage() ⇒ ① 整页 innerHTML 重建、封面图重新解码（**闪**）
                                //   ② 末尾 fixStageSize()+resize ⇒ compat 重算 .book-rig（**整本书跳一下**）。
                                //   拖动本来就已经把 --ct-*-x/y 改在 DOM 上了 ⇒ 屏幕不用再动，
                                //   只要让 state 对齐（翻页/出书读的就是它）。
                                preview.setCoverSilent(coverTextJson(cover).toString())
                                pushSel()                          // ★ 第十八轮
                                saveSoon()
                                tip = "已把「${ceLabel(el)}」挪到 ${x.toInt()}% / ${y.toInt()}%"
                            }
                        } catch (t2: Throwable) {
                            Log.w(TAG, "封面拖动解析失败", t2)
                        }
                    },
                )
            } else {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("正在准备封面…", color = Ink.copy(alpha = 0.4f), fontSize = 13.sp)
                }
            }
        }

        // ══════════════════ ④ 底部功能条（默认一行 · 点图标才展开一行 · 手风琴）══════════
        CoverBar(
            picked = picked,
            sel = sel,
            conf = cover[sel] ?: CoverConf(),
            isExtra = sel.startsWith("x"),
            // ★ 已被删掉的内置三处（文字框删了就真没了，不会出现在这里）
            hiddenEls = cover.filterValues { it.hide == true }.keys.toSet(),
            open = open,
            delArmed = delArmed,
            textValue = when {
                sel == "title" -> title
                sel == "subtitle" -> subtitle
                sel == "foot" -> footText
                else -> cover[sel]?.text ?: ""
            },
            extraNums = cover.keys.filter { it.matches(Regex("^x[1-9]\\d?$")) }
                .mapNotNull { it.drop(1).toIntOrNull() }.sorted(),
            onTapSel = { open = if (open == "text") null else "text" },
            onToggle = { g -> open = if (open == g) null else g },
            onSelectEl = { k ->
                sel = k
                delArmed = null
                pushSel()                              // ★ 第十八轮：选中框跟着换
                tip = if (k in cover.filterValues { it.hide == true }.keys) {
                    "「${ceLabel(k)}」现在是**已删**状态 —— 点上面的「↺ 恢复显示」放回来"
                } else {
                    "已切到「${ceLabel(k)}」"
                }
            },
            onText = { v ->
                // ★ 第十八轮：打字也压栈（他选的"全部操作含打字"）。
                //   ⚠ 只在**字真变了**才压 —— IME 偶尔会回吐一次同样的值，那不该算一步。
                val cur = when (sel) {
                    "title" -> title
                    "subtitle" -> subtitle
                    "foot" -> footText
                    else -> cover[sel]?.text ?: ""
                }
                if (cur != v) {
                    pushUndo()
                    when (sel) {
                        "title" -> title = v
                        "subtitle" -> subtitle = v
                        "foot" -> footText = v
                        else -> {
                            val c0 = cover[sel] ?: CoverConf()
                            cover[sel] = c0.copy(text = v)
                        }
                    }
                    saveSoon()
                }
            },
            onChange = { c ->
                // ★ 空配置就从 map 里删掉 —— 别把"没动过"变成"写死默认值"
                // ⚠ 只在**值真变了**才压栈：点已经生效的"大"（size 已经 7）不该算一步
                //   （⚠ 不能用 `return@CoverBar` —— onChange 是函数类型参数，没有标签）
                val c0 = cover[sel]
                if (c0 != c) {
                    pushUndo()
                    if (c.isEmpty()) cover.remove(sel) else cover[sel] = c
                    // ★ 第十八轮：样式类改动走**静默**通道 ⇒ 不闪（删除/隐藏才走 pushCover 重画）
                    pushCoverSilent()
                }
            },
            onReset = {
                pushUndo()
                cover.clear()
                title = DEFAULT_TITLE
                subtitle = DEFAULT_SUBTITLE
                footText = ""
                sel = "title"
                open = null
                delArmed = null
                preview.setCover("{}")
                preview.setFootText("")
                saveSoon()
                tip = "封面文案已恢复默认（书名 / 副标题 / 页脚 / 文字框）"
            },
            onEditing = { editing -> if (!editing) focus.clearFocus() },
        )
    }

    // 人话提示（那条命门：出错也要看得见）
    //
    // ★ 第十五轮补两条（真机截图踩到的）：
    //   ① **气泡不许盖住功能条** —— 功能条最高到 **149dp**（52 行 + 96 「文字」组），
    //      而气泡原来只让开 96dp ⇒ 长一点的提示会**正好压在那一排图标上**
    //      （真机截图 `r16-diag-textopen.png` 实证：提示把「✎/字号/字体/颜色/对齐/位置」全盖了
    //       —— 用户点不到、验收也 dump 不到那一排 ⇒ 又是一次假红）。
    //      ⇒ 让开到 **168dp**。
    //   ② **4 秒自动消失** —— 他每次动一下都会出一句提示，攒着不散会一直挡着画面；
    //      点一下也能立刻消（下面那个 `clickable`）。
    LaunchedEffect(tip) {
        if (tip.isNotEmpty()) {
            delay(4000)
            tip = ""
        }
    }
    if (tip.isNotEmpty()) {
        Box(Modifier.fillMaxSize().padding(bottom = 168.dp), contentAlignment = Alignment.BottomCenter) {
            Text(
                tip, color = Color.White, fontSize = 13.sp,
                modifier = Modifier
                    .testTag("ce-tip")
                    .background(Ink.copy(alpha = 0.92f), RoundedCornerShape(8.dp))
                    .clickable { tip = "" }
                    .padding(horizontal = 14.dp, vertical = 10.dp)
            )
        }
    }
}

/* ============================================================================
 * 底部功能条
 * ---------------------------------------------------------------------------
 * ★ 设计口径（照他 2026-10-09 的要求）：
 *   · **默认只有一行**（52dp）：左端是"当前选中谁"（点它就展开「文字」组）+ 5 个功能图标
 *   · 点某个图标 ⇒ 在下面**再长出一行选项**（48dp）；再点同一颗 ⇒ 收起
 *   · **手风琴**：同时只展开一组 —— 点第二组，上一组自动收
 *   · 所以最坏情况也只有 **~152dp**，而旧的那条底部抽屉是 **156dp**（且一次全摊开）
 * ★ 交互尺寸：每颗图标 56dp 宽、整条 52dp 高 —— 都 ≥ 30dp（手指点得到，不是细缝）
 *
 * ★★ 第十五轮补的两件：
 *   ① 「✎」那一组**多了一排"换选中"的小钮**（书名 / 副标题 / 页脚 / 文字框1..N）。
 *      ⚠ 不是锦上添花 —— 有了「删除」之后**必须有它**：
 *        内置三处删掉之后**封面上就没有那个节点了**，也就点不到它了；
 *        没有这一排的话"删掉书名就再也找不回来"（只能退出重进，因为重进默认选书名）。
 *        那一排还在隐藏项上标「（已删）」，一眼看得出谁被删了。
 *   ② 「对齐」组里原来那颗「显示中 / 已隐藏」**撤掉** —— 与顶部那颗「删除 / ↺ 恢复显示」
 *      是同一件事，两个入口迟早各说各话（§0.5 的"优先减法"）。
 * ==========================================================================*/
@Composable
private fun CoverBar(
    picked: Boolean,
    sel: String,
    conf: CoverConf,
    isExtra: Boolean,
    /** ★ 已经被删掉的那些内置项（`hide=true`）—— 文字框删了就真没了，不会出现在这里。 */
    hiddenEls: Set<String>,
    open: String?,
    delArmed: String?,
    textValue: String,
    /** 现在有哪几个文字框（1..8，给"换选中"那一排用）。 */
    extraNums: List<Int>,
    onTapSel: () -> Unit,
    onToggle: (String) -> Unit,
    onSelectEl: (String) -> Unit,
    onText: (String) -> Unit,
    onChange: (CoverConf) -> Unit,
    onReset: () -> Unit,
    onEditing: (Boolean) -> Unit,
) {
    /** 当前选中项是不是"已删"（= 内置三处之一且 `hide=true`）。 */
    val hidden = sel in hiddenEls
    val d = CoverDefaults[sel] ?: CoverConf()
    val size = conf.size ?: d.size ?: 2f
    val y = conf.y ?: d.y ?: 15f
    val x = conf.x ?: d.x ?: 13.5f
    val w = conf.w ?: 72f

    Column(
        Modifier.fillMaxWidth()
            .background(Paper)
            .testTag("ce-bar")
            .semantics { testTagsAsResourceId = true }
    ) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(Line))

        if (!picked) {
            // ---- 还没点过封面上的字 ⇒ 只给一句提示（不摆一排用不上的工具）----
            //
            // ⚠⚠⚠ **这里绝不能写成"提示 + `return@Column` 提前返回"**（我真机上踩了）：
            //   `Column {}` 的 content 是一个 **@Composable lambda**，编译器会给它插一对
            //   `startRestartGroup/endRestartGroup` 标记；**提前 return 会把结束标记跳过** ⇒
            //   分组栈不配平 ⇒ 首次组合就炸：
            //     `ArrayIndexOutOfBoundsException: length=0; index=-5`
            //     at androidx.compose.runtime.ComposerImpl.endGroup / endRoot
            //   ⇒ 症状是**一点「封面」整个 App 进程直接挂掉、退到书架**
            //     （进程死了，系统按任务栈回到根 Activity = MainActivity）。
            //   ★ 教训：Compose 里**结构化地用 if/else 分流**，永远不要提前 return。
            Box(Modifier.fillMaxWidth().height(52.dp), contentAlignment = Alignment.Center) {
                Text(
                    "点封面上的文字，这里就能改它",
                    color = Ink.copy(alpha = 0.5f), fontSize = 13.sp,
                    modifier = Modifier.testTag("ce-hint")
                )
            }
        } else {

        // ---------- 第一行：选中谁 + 5 组图标 ----------
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 4.dp)
        ) {
            // 左端「选中谁」——点它展开「文字」组（打字 + 换选中都在那儿）
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
                modifier = Modifier
                    .width(64.dp).fillMaxHeight()
                    .testTag("ce-sel")
                    .clip(RoundedCornerShape(8.dp))
                    .clickable { onTapSel() }
            ) {
                Text("✎", color = if (hidden) Danger else Accent, fontSize = 15.sp)
                Text(
                    // ⚠ 标签单独挂一个 tag：`ce-sel` 挂在这一层**容器**上，
                    //   而容器节点在 uiautomator 里 `text=""`（字在子 TextView 上）
                    //   ⇒ 验收脚本读 `ce-sel` 的 text 永远是空串（**假红**，第十五轮踩过）。
                    if (hidden) "${ceLabel(sel)}（已删）" else ceLabel(sel),
                    color = if (hidden) Danger else Accent, fontSize = 10.sp, maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.testTag("ce-sel-name")
                )
            }
            CE_GROUPS.forEach { (key, icon, name) ->
                val on = open == key
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                    modifier = Modifier
                        .weight(1f).fillMaxHeight()
                        .testTag("ce-g-$key")
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (on) Accent.copy(alpha = 0.12f) else Color.Transparent)
                        .clickable { onToggle(key) }
                ) {
                    Text(icon, color = if (on) Accent else Ink.copy(alpha = 0.75f), fontSize = 15.sp)
                    Text(
                        name, color = if (on) Accent else Ink.copy(alpha = 0.55f), fontSize = 9.sp,
                        maxLines = 1
                    )
                }
            }
        }

        // ---------- 第二行：当前展开的那一组选项（**同时只有一组**）----------
        // ★「文字」那一组要**两行**（输入框 + 换选中），所以这里的高度按组给。
        if (open != null) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(Line))
            Column(
                Modifier.fillMaxWidth()
                    .height(if (open == "text") 96.dp else 48.dp)
                    .testTag("ce-xrow")
                    .padding(horizontal = 8.dp),
                verticalArrangement = Arrangement.Center,
            ) {
                when (open) {
                    // ---- 文字：就地打字 + 换选中（书名/副标题/页脚/文字框N）----
                    "text" -> {
                        BasicTextField(
                            value = textValue,
                            onValueChange = onText,
                            singleLine = true,
                            textStyle = TextStyle(color = Ink, fontSize = 14.sp),
                            cursorBrush = SolidColor(Accent),
                            modifier = Modifier
                                .fillMaxWidth().height(38.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .background(Color.White)
                                .onFocusChanged { onEditing(it.isFocused) }
                                .padding(horizontal = 10.dp)
                                .testTag("ce-text"),
                            decorationBox = { inner ->
                                Box(contentAlignment = Alignment.CenterStart) {
                                    if (textValue.isEmpty()) {
                                        Text(
                                            "${ceLabel(sel)}（点这里打字）",
                                            color = Ink.copy(alpha = 0.3f), fontSize = 13.sp
                                        )
                                    }
                                    inner()
                                }
                            }
                        )
                        Spacer(Modifier.height(4.dp))
                        // ★★ 换选中那一排（见文件头 ② 的账：删掉之后没有它就找不回来）
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.fillMaxWidth()
                                .horizontalScroll(rememberScrollState())
                                .testTag("ce-els")
                        ) {
                            listOf("title" to "书名", "subtitle" to "副标题", "foot" to "页脚")
                                .forEach { (k, t) ->
                                    val on = sel == k
                                    val hid = k in hiddenEls
                                    Text(
                                        if (hid) "$t（已删）" else t,
                                        color = when {
                                            hid -> Danger
                                            on -> Color.White
                                            else -> Ink.copy(alpha = 0.8f)
                                        },
                                        fontSize = 12.sp, maxLines = 1,
                                        modifier = Modifier
                                            .testTag("ce-el-$k")
                                            .padding(end = 5.dp)
                                            .clip(RoundedCornerShape(7.dp))
                                            .background(
                                                if (on) Accent else Ink.copy(alpha = 0.06f)
                                            )
                                            .clickable { onSelectEl(k) }
                                            .padding(horizontal = 9.dp, vertical = 6.dp)
                                    )
                                }
                            extraNums.forEach { nn ->
                                val k = "x$nn"
                                val on = sel == k
                                Text(
                                    "文字框$nn",
                                    color = if (on) Color.White else Ink.copy(alpha = 0.8f),
                                    fontSize = 12.sp, maxLines = 1,
                                    modifier = Modifier
                                        .testTag("ce-el-$k")
                                        .padding(end = 5.dp)
                                        .clip(RoundedCornerShape(7.dp))
                                        .background(if (on) Accent else Ink.copy(alpha = 0.06f))
                                        .clickable { onSelectEl(k) }
                                        .padding(horizontal = 9.dp, vertical = 6.dp)
                                )
                            }
                        }
                    }

                    // ---- 其它组：一行选项 ----
                    else -> Row(verticalAlignment = Alignment.CenterVertically) {
                        when (open) {
                            // ---- 字号：A− / 值 / A+（不用滑块 —— 小屏上拖不准，F139 老账）----
                            "size" -> {
                                BarLabel("字号")
                                BarChip("A−", false, "ce-size-dec") {
                                    onChange(conf.copy(size = (size - 0.5f).coerceIn(0.6f, 24f)))
                                }
                                Text(
                                    fmt1(size), color = Ink, fontSize = 13.sp,
                                    textAlign = TextAlign.Center,
                                    modifier = Modifier.width(52.dp).testTag("ce-size-val")
                                )
                                BarChip("A+", false, "ce-size-inc") {
                                    onChange(conf.copy(size = (size + 0.5f).coerceIn(0.6f, 24f)))
                                }
                                Spacer(Modifier.width(8.dp))
                                BarChip("小", size < 2.2f, "ce-size-s") { onChange(conf.copy(size = 1.5f)) }
                                BarChip("中", size >= 2.2f && size < 5f, "ce-size-m") { onChange(conf.copy(size = 3.2f)) }
                                BarChip("大", size >= 5f, "ce-size-l") { onChange(conf.copy(size = 7f)) }
                            }

                            // ---- 字体 ----
                            "font" -> {
                                BarLabel("字体")
                                listOf("serif" to "衬线", "hei" to "黑体", "song" to "宋体", "kai" to "楷体")
                                    .forEach { (v, t) ->
                                        BarChip(t, conf.font == v, "ce-font-$v") {
                                            onChange(conf.copy(font = v))
                                        }
                                    }
                                Spacer(Modifier.width(8.dp))
                                BarChip("斜体", conf.italic == true, "ce-italic") {
                                    onChange(conf.copy(italic = !(conf.italic ?: false)))
                                }
                            }

                            // ---- 颜色（引擎认任意 CSS 颜色；这里给够用的一组）----
                            "color" -> {
                                BarLabel("颜色")
                                CoverPalette.forEach { (nm, hx) ->
                                    val on = conf.color.equals(hx, ignoreCase = true)
                                    Box(
                                        Modifier.testTag("ce-color-$nm").size(28.dp)
                                            .clip(CircleShape)
                                            .background(parseHex(hx))
                                            .border(
                                                if (on) 3.dp else 1.dp,
                                                if (on) Accent else Ink.copy(alpha = 0.25f), CircleShape
                                            )
                                            .clickable { onChange(conf.copy(color = hx)) }
                                    )
                                    Spacer(Modifier.width(6.dp))
                                }
                            }

                            // ---- 对齐（"显示/隐藏"那颗已撤 —— 与顶部「删除」同一件事）----
                            "align" -> {
                                BarLabel("对齐")
                                BarChip("左", conf.align == "start", "ce-align-start") {
                                    onChange(conf.copy(align = "start"))
                                }
                                BarChip("中", conf.align == "center", "ce-align-center") {
                                    onChange(conf.copy(align = "center"))
                                }
                                BarChip("右", conf.align == "end", "ce-align-end") {
                                    onChange(conf.copy(align = "end"))
                                }
                            }

                            // ---- 位置：上下 / 左右（文字框另有"宽"）+ 恢复默认 ----
                            "pos" -> {
                                BarLabel("上下")
                                BarChip("↑", false, "ce-y-dec") { onChange(conf.copy(y = (y - 1f).coerceIn(0f, 100f))) }
                                BarChip("↓", false, "ce-y-inc") { onChange(conf.copy(y = (y + 1f).coerceIn(0f, 100f))) }
                                BarLabel("左右")
                                BarChip("←", false, "ce-x-dec") { onChange(conf.copy(x = (x - 1f).coerceIn(0f, 100f))) }
                                BarChip("→", false, "ce-x-inc") { onChange(conf.copy(x = (x + 1f).coerceIn(0f, 100f))) }
                                if (isExtra) {
                                    BarLabel("宽")
                                    BarChip("−", false, "ce-w-dec") { onChange(conf.copy(w = (w - 2f).coerceIn(20f, 95f))) }
                                    BarChip("＋", false, "ce-w-inc") { onChange(conf.copy(w = (w + 2f).coerceIn(20f, 95f))) }
                                }
                                Spacer(Modifier.weight(1f))
                                BarChip("恢复默认", false, "ce-reset", danger = true) { onReset() }
                            }
                        }
                    }
                }
            }
        }
        }   // ← 关闭 `if (!picked) { … } else {`（★ 结构化分流，见上面那段 Compose 崩溃记录）
    }
}

/** 展开行里的小标签。 */
@Composable
private fun BarLabel(t: String) {
    Text(t, color = Ink.copy(alpha = 0.5f), fontSize = 11.sp, modifier = Modifier.padding(end = 6.dp))
}

/** 展开行里的一颗选项钮（高 34dp ⇒ 手指点得到）。 */
@Composable
private fun BarChip(
    label: String,
    on: Boolean,
    tag: String,
    danger: Boolean = false,
    onClick: () -> Unit,
) {
    Text(
        label,
        color = when {
            danger -> Danger
            on -> Color.White
            else -> Ink.copy(alpha = 0.8f)
        },
        fontSize = 12.sp,
        modifier = Modifier
            .testTag(tag)
            .padding(end = 4.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (on) Accent else Ink.copy(alpha = 0.06f))
            .clickable { onClick() }
            .padding(horizontal = 10.dp, vertical = 9.dp)
    )
}
