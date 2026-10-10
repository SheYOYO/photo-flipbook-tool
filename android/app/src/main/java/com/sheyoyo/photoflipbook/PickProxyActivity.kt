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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier

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

        /** 回给工作台的键（[android.app.Activity.setResult] 的那个 Intent 里）。 */
        const val EXTRA_URIS = "picked_uris"

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

    private val picker = registerForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(MAX_PICK)
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
            Surface(Modifier.fillMaxSize(), color = Paper) { }
        }

        // 清单里若被别的 App 塞了别的 intent（正常不会），直接关门，别乱弹。
        if (intent != null && intent.hasExtra(EXTRA_URIS)) {
            // 已经带过结果了（极端情况下被系统重建）：照原样回给工作台。
            val pre = intent.getParcelableArrayListExtra<Uri>(EXTRA_URIS)
            finishWith(pre)
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

    /** 把结果原样传回工作台，然后关掉自己。 */
    private fun finishWith(uris: List<Uri>?) {
        // ⚠⚠ 顺序：**先把标记存下来**再恢复。
        //   [restoreIfNeeded] 会把 `portraitLocked` 置回 false（"已经还过了"的意思），
        //   若先恢复再读标记，回传给工作台的就**永远是 false**
        //   ⇒ 工作台会一直说"相册是横的"，哪怕这次其实锁成功了（判据写歪的又一种）。
        val wasPortrait = portraitLocked
        // ★ 走之前先交还系统旋转 —— 选完/取消都要还，**不能只还成功那一次**。
        restoreIfNeeded()
        val data = Intent()
        if (!uris.isNullOrEmpty()) {
            data.putParcelableArrayListExtra(EXTRA_URIS, ArrayList(uris))
        }
        data.putExtra(EXTRA_PORTRAIT_LOCKED, wasPortrait)
        setResult(if (!uris.isNullOrEmpty()) Activity.RESULT_OK else Activity.RESULT_CANCELED, data)
        finish()
    }

    override fun onDestroy() {
        // 兜底：用户在这一页按了返回键/被系统回收 ⇒ 这里也还一次。
        restoreIfNeeded()
        super.onDestroy()
    }
}