package com.sheyoyo.photoflipbook

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.sp
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 第八轮①：**竖屏的相册选择代理页**（2026-10-08）
 *
 * 佘先生：「制作画册的选照片后切换的手机的相册时要求是竖屏的」。
 *
 * ## 为什么要多这一页（而不是直接把工作台锁竖屏）
 *
 * 系统照片选择器（`PickMultipleVisualMedia` → `MediaStore.ACTION_PICK_IMAGES`）是
 * **另一个进程里的 Activity**，它会**继承发起方的请求方向** ⇒ 工作台是横屏时，
 * 弹出的相册也是横屏的。
 *
 * 直觉做法是给工作台加一行 `requestedOrientation = PORTRAIT`，但**那是错的**：
 * 工作台的版面是**为横屏设计的**（左栏照片/封面 + 右侧放大预览，见 `WorkbenchScreen`），
 * 锁成竖屏会把整个做书界面挤坏。⇒ 只让**相册那一段**竖屏。
 *
 * ⇒ 本页 = 一个**透明、锁定竖屏、不显示任何界面**的壳：
 * 1. 工作台（横屏）启动本页；
 * 2. 本页立刻拉起系统相册（继承本页的**竖屏**方向 ⇒ 相册竖着弹）；
 * 3. 用户选完 / 取消 ⇒ 本页把 URI 原样 `setResult` 回去，然后 `finish()`；
 * 4. 工作台回到横屏，版面**一个像素都没动**。
 *
 * ⚠ 清单里本页 `screenOrientation="portrait"`（**不是** `sensorLandscape`），
 *   且 `configChanges` 带 `orientation|screenSize` ⇒ 切向不重建、结果不丢。
 * ⚠ ⛔ **不要**给本页加 `noHistory` —— 那样相册一弹出来本页就被销毁，
 *   用户选完没人接结果（就是那种"点了没反应、也不报错"的鬼打墙）。
 *
 * ## ★★ 第八轮①**甲案**（2026-10-08，佘先生拍板）：选照片这段**临时锁系统旋转**
 *
 * 上面的 `portrait` 只解决「本页自己竖不竖」，解决不了**选择器**竖不竖 ——
 * 因为这台Android 10 上弹的是 DocumentsUI，它是 `fillxfill` + **只跟随系统旋转**
 * （真机正对照：`user_rotation 0` ⇒ 选择器立刻变1080×2340；代理页声明 portrait 它纹丝不动）。
 *
 * ⇒ 于是：进本页时 [SystemRotation.lockPortrait] 锁竖 → 选完/取消 [restoreIfNeeded] 交还。
 * 完整代价与边界见 [SystemRotation]（一句话：**这是系统级设置，必须用户手动授权，
 * 我们只做检测+引导，绝不静默改；锁不上也照常让用户选照片**）。
 */
class PickProxyActivity : ComponentActivity() {

    companion object {
        private const val TAG = "PickProxy"

        /**
         * ⚠ 2026-10-12（F163）：**这个键已经不再用了** —— 见 [finishWith]。
         *   留着只是因为 `onCreate` 里要用它认"极端情况下被系统重建的旧 Intent"。
         */
        const val EXTRA_URIS = "picked_uris"

        /**
         * ★★ 2026-10-12（F163）：回传的是**导入结果**，不再是 URI 列表。
         *
         * 为什么改：以前本页只做"把 URI 原样传回工作台"，拷贝在工作台里做 ——
         * 而**读授权是授给本页的**，本页一 `finish()` 系统就开始撤销，
         * 工作台那些 `openInputStream` 是在跟撤销**赛跑** ⇒ 见 [finishWith] 的注释。
         */
        const val EXTRA_ADDED = "picked_added"
        const val EXTRA_FAILED = "picked_failed"
        const val EXTRA_TOTAL = "picked_total"

        /**
         * 回给工作台的另一个键：**这一段有没有真的锁成竖屏**。
         *
         * 为什么要有它：甲案（[SystemRotation]）要 `WRITE_SETTINGS`，而那是**特殊权限**，
         * 没授权时锁不上 ⇒ 工作台得知道"这次相册是横的"才能对用户说人话，
         * 而不是让他对着一个横着的选择器莫名其妙。
         */
        const val EXTRA_PORTRAIT_LOCKED = "portrait_locked"

        /**
         * [selfHealIfStuck] 要**直接读**那两个系统键，而 Android 10 上
         * `Settings.System.getInt(…)` 在没权限时是**抛异常**的（不是返回默认值）
         * ⇒ 读取一律包在 try 里（那边已经兜住了）。
         *
         * ⚠ 这两个常量只是**键名字符串**（Android 内部就是这么拼的），**不是权限绕过**：
         * 真正取值靠 `Settings.System.getInt` ⇒ 没权限照样抛异常，我们已经兜住了。
         */
        private const val K_ACCEL = "accelerometer_rotation"
        private const val K_ROT = "user_rotation"

        /** 工作台用这个便捷方法启动本页。 */
        fun start(from: Activity) {
            from.startActivity(Intent(from, PickProxyActivity::class.java))
        }
    }

    /** 只拉起一次：透明页会经历 onResume，`launched` 挡住第二次。 */
    private var launched = false

    /**
     * ★ 第八轮①甲案（2026-10-08）：**选照片这一段有没有锁成竖屏**。
     *
     * · `true`  = 已锁 ⇒ 这一段系统是竖的，选择器跟着竖；
     * · `false` = 没权限/写失败 ⇒ 选择器会是横的（Android 10 的DocumentsUI 只跟随系统旋转），
     *   但**流程照常走完**（命门"不许崩溃"：绝不因为锁不上就不让用户选照片）。
     */
    private var portraitLocked = false

    /**
     * ★ F163：本页正在读照片时显示的一行字（**没有就是空白页**）。
     *
     * 为什么要它：导入从工作台搬到本页之后（见 [finishWith]），90 张要读十几秒，
     * 而这页原本是"和工作台同色的空白页" ⇒ 不给字的话用户就是盯着白屏发呆。
     * ⚠ 字色/大小随意但**必须能看清**（背景是 `Paper`，所以取深灰）。
     */
    private var busyText by mutableStateOf<String?>(null)

    /**
     * ⚠★ 2026-10-12（F162）：这里**不能直接用 `MAX_PICK`**，必须过 [pickLimit]。
     *   原因见 [pickLimit] —— 写死 100 就是"零余量顶在系统天花板上"，
     *   某些 ROM 上会整批变 `RESULT_CANCELED`（界面表现 = "没选照片"）。
     */
    private val picker = registerForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(pickLimit())
    ) { uris -> finishWith(uris) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // ★★ 2026-10-08 真机实测后改的（第一版透明页**没生效**，见下面「为什么不能用透明页」）：
        //   这一页**必须有实体内容**（不透明），否则系统不会为它旋转屏幕。
        //
        //   ⚠⚠ **为什么透明页不行**（Android 10 真机实测）：
        //     这台 Android 10 **没有系统照片选择器**（`ACTION_PICK_IMAGES` 查无此 Activity），
        //     AndroidX 退回 `ACTION_GET_CONTENT` ⇒ 弹出来的是 **DocumentsUI**
        //     （`com.android.documentsui/.picker.PickActivity`）。它的窗口是
        //     `mAttrs=(0,0)(fillxfill)` —— **自己填满整个 display、且不继承发起方方向**。
        //     实测：代理页声明了 `portrait`，选择器窗口**仍然是 2340×1080 横的**。
        //     ⇒ 光"声明方向"没用，得让**整个 display 转过来**。
        //     而"转 display"这件事，系统只在**top Activity 是不透明的有内容界面**时才做；
        //     透明页被当成"不参与方向决策" ⇒ 屏幕纹丝不动。
        //   ⇒ 修法：这一页画一层**和工作台同色**的不透明底 ⇒ 用户看着就像
        //     "工作台原地转了个方向"，**毫无违和感**（颜色一样，看不出换页）。
        //     ⚠ 底色必须和 `WorkbenchActivity` 的 `Paper` 一致（见 themes.xml 的 Paper）。
        setContent {
            Surface(Modifier.fillMaxSize(), color = Paper) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    busyText?.let { t -> Text(t, color = Color(0xFF4A463C), fontSize = 15.sp) }
                }
            }
        }

        // 清单里若被别的 App 塞了别的 intent（正常不会），直接关门，别乱弹。
        // ⚠ F163：现在回传的是**结果**（EXTRA_ADDED），URI 已经不再跨页传递 ⇒
        //   认到旧的就当"已经走过一次了"，直接关门（不会再有第二份结果）。
        if (intent != null && (intent.hasExtra(EXTRA_ADDED) || intent.hasExtra(EXTRA_URIS))) {
            finish()
        }
    }

    override fun onResume() {
        super.onResume()
        if (launched) return
        launched = true

        // ★★ 第八轮①**甲案**（2026-10-08，佘先生拍板）：选照片这一段**临时锁竖屏**。
        //
        //   机理见 [SystemRotation]：这台 Android 10 没有系统照片选择器 ⇒ 弹的是
        //   DocumentsUI，它是 `fillxfill` + **只跟随系统旋转** ⇒ 光声明 portrait 没用，
        //   必须让**整个 display 转过来**。真机正对照实验：`user_rotation 0`
        //   ⇒ 选择器立刻变 1080×2340。
        //
        //   ⚠ 锁不上也**照样往下走**（老样子弹横屏选择器，用户仍能选照片）
        //   ⇒ 这一段绝不会"因为方向搞不定就卡住用户"。
        //   ⚠ 必须在**拉起之前**锁：拉起之后再改就晚一步了。
        //   ⚠ 锁之前先自愈一次：万一上次是**进程被杀**进来的，系统可能还锁着竖屏
        //   ⇒ 这时若按"交还"处理，就得先交还再锁（顺序反了会跟系统打架）。
        restoreIfNeeded()
        selfHealIfStuck()
        portraitLocked = SystemRotation.lockPortrait(this)

        try {
            // ⚠ `ImageOnly`：只列图片。少传一个 request 就可能连视频一起列出来。
            picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
        } catch (t: Throwable) {
            // 不许崩：拉不起来就当"没选"，工作台会提示一句
            Log.w(TAG, "拉起系统相册失败", t)
            finishWith(null)
        }
    }

    /**
     * 只在**确实是我们锁的**时候才交还回去（`onDestroy` / 正常收尾都会走）。
     *
     * ⚠⛔ 顺序上的坑：`onResume` 里是「先自愈 → 再锁」，而正常收尾是「只交还」。
     *   若不判`portraitLocked`，一个**从没锁成功**的流程也会去写系统设置
     *   ⇒ 万一用户本来自己锁着竖屏，就被他锁的**我们**给覆盖掉了。
     */
    private fun restoreIfNeeded() {
        if (!portraitLocked) return
        SystemRotation.restore(this)
        portraitLocked = false
    }

    /**
     * 进程被杀时系统设置**不会**跟着回滚 ⇒ 用户可能发现手机莫名一直竖着。
     * 所以每次进来先看一眼「有没有我们留下的锁」：把[EXTRA_PORTRAIT_LOCKED] 当**进程内**标记，
     * 而系统里那两个键的真实值只作为**兜底判据**——只在"确实是 0/0（锁死竖屏）"时才交还。
     */
    private fun selfHealIfStuck() {
        try {
            val cr = contentResolver
            val accel = Settings.System.getInt(cr, K_ACCEL, 1)
            val rot = Settings.System.getInt(cr, K_ROT, 0)
            // 正好是我们锁的那一组值（自动旋转关 + 竖屏）⇒ 认定是上次留下的
            if (accel == 0 && rot == 0 && SystemRotation.canWrite(this)) {
                Log.i(TAG, "发现上次残留的锁竖屏设置，先交还（自愈）")
                SystemRotation.restore(this)
            }
        } catch (t: Throwable) {
            //读系统设置失败就什么都不做 ⇒ 最坏结果是用户自己再转一次。
            Log.w(TAG, "自愈检查失败（忽略）", t)
        }
    }

    /**
     * ★★ 2026-10-12（F163）：**拷贝必须在本页做完** —— 这就是「九十张里八十八张读不出来」的根因。
     *
     * ## 以前错在哪
     *
     *   系统相册把**读授权**授给**拉起它的那一页 = 本页**（`startActivityForResult` 的授权
     *   是按"发起方 Activity"记的）。而以前本页只干一件事：**把 URI 原样塞进 Intent 回传**，
     *   然后立刻 `finish()` —— 真正的拷贝是工作台拿到结果**之后**才开始的。
     *
     *   ⇒ 授权随着本页销毁被系统撤销，工作台那批 `openInputStream` 是在**跟撤销赛跑**：
     *     · 选三五张 —— 拷贝一两秒就完，**抢在撤销之前** ⇒ 一直正常（所以这病藏了二十几轮）
     *     · 选九十张 —— 拷贝十几秒 ⇒ **头 1~2 张成功、后面全 `SecurityException`**
     *       ⇒ 界面就是「这 88 张读不出来」（F162 那次报的"一百张识别失败"正是它）
     *
     * ## 怎么修
     *
     *   **谁持有授权，谁做拷贝**：`PhotoStore.importPhotos` 在本页 `finish()` **之前**跑完，
     *   本页**只回传结果**（新增几张 / 哪几张失败），不再传 URI。
     *   ⇒ 没有跨页授权、没有赛跑，**成功率与张数无关**。
     *
     * ⚠ 为什么不在工作台里"失败重试"：授权一旦撤销就**拿不回来**，重试只会次次失败。
     * ⚠ 导入期间本页是前台可见的（相册关掉后它就是栈顶）⇒ 用 `lifecycleScope` 不会被中途取消。
     */
    private fun finishWith(uris: List<Uri>?) {
        // ⚠⚠ 顺序：**先把标记存下来**再恢复。
        //   [restoreIfNeeded] 会把 `portraitLocked` 置回 false（"已经还过了"的意思），
        //   若先恢复再读标记，回传给工作台的就**永远是 false**
        //   ⇒ 工作台会一直说"相册是横的"，哪怕这次其实锁成功了（判据写歪的又一种）。
        val wasPortrait = portraitLocked
        // ★ 先交还系统旋转（选完/取消都要还，**不能只还成功那一次**）——
        //   ⚠ 而且要在导入**之前**：否则读十几秒照片的工夫，用户手机一直被锁着竖屏。
        restoreIfNeeded()

        if (uris.isNullOrEmpty()) { deliver(wasPortrait, null); return }

        val list = ArrayList(uris)
        val app = applicationContext                 // ⚠ 别把 Activity 交给后台线程
        busyText = "正在读取 ${list.size} 张…"
        lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) { PhotoStore.importPhotos(app, list) }
            deliver(wasPortrait, r)
        }
    }

    /** 导入完（或没选）才回传 —— 工作台拿到的永远是**已经落盘**的结果。 */
    private fun deliver(wasPortrait: Boolean, r: PhotoStore.ImportResult?) {
        val data = Intent()
        if (r != null) {
            data.putExtra(EXTRA_ADDED, r.added)
            data.putExtra(EXTRA_TOTAL, r.total)
            data.putStringArrayListExtra(EXTRA_FAILED, ArrayList(r.failed))
        }
        data.putExtra(EXTRA_PORTRAIT_LOCKED, wasPortrait)
        setResult(
            if (r != null && r.added > 0) Activity.RESULT_OK else Activity.RESULT_CANCELED,
            data
        )
        finish()
    }

    override fun onDestroy() {
        // 兜底：用户在这一页按了返回键/被系统回收 ⇒ 这里也还一次。
        restoreIfNeeded()
        super.onDestroy()
    }
}