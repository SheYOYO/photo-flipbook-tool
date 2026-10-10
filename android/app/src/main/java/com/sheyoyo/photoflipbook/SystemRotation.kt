package com.sheyoyo.photoflipbook

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.util.Log

/**
 * 第八轮①（**甲案**）：选照片期间**临时把系统旋转锁成竖屏**，选完恢复。
 *
 * ## 为什么需要它（Android 10 上唯一的解）
 *
 * 系统照片选择器在另一个进程里。这台 Android 10 **没有**系统照片选择器
 * （`MediaStore.ACTION_PICK_IMAGES` 查无此Activity）⇒ AndroidX 退回
 * `ACTION_GET_CONTENT` ⇒ 弹出来的是 **DocumentsUI**
 * （`com.android.documentsui/.picker.PickActivity`）。
 *
 * DocumentsUI 的窗口是 `mAttrs={(0,0)(fillxfill)}` ——
 * **自己填满整个 display、完全跟随系统旋转**，**不看发起方声明的方向**。
 * ★ 正对照实验（真机实测）：`settings put system user_rotation 0`
 *   ⇒ 选择器**立刻**变`1080×2340`；而代理页声明 `portrait` 它**纹丝不动**。
 *
 * ⇒ 所以要让这台机器上的相册竖屏，**只能让整个 display 转过来**。
 *
 * ## ⚠⚠ 必须先讲清的代价（佘先生2026-10-08 拍板甲案时已知情）
 *
 * 1. **这不是 App 私事，是系统级设置**。所以本类**绝不静默改**：
 *    没拿到授权就**原样退回去**（老样子弹横屏选择器），并在工作台提示一句。
 * 2. **必须用户手动授权**：`WRITE_SETTINGS` 属于「特殊权限」，
 *    清单里声明了也不生效，得跳系统设置页由用户自己开一下
 *    （`Settings.ACTION_MANAGE_WRITE_SETTINGS`）。本类只负责**检测 + 引导**。
 * 3. **只锁「选照片这一段」**：进代理页时锁竖 → 选完/取消**立刻恢复原样**。
 *    恢复走[restore]，它是本类里**唯一有资格写**系统设置的地方。
 * 4. ⛔ **进程被杀 = 恢复不了**（系统设置不会随进程死而回滚）。
 *    所以 [restore] 在三个地方都调了（正常结果 / `onDestroy` / 下次进代理页时自愈），
 *    并且**恢复失败只记日志、不弹窗、不崩**（命门"不许崩溃"）。
 *
 * ## 为什么改的是这两个键
 *
 * · `accelerometer_rotation = 0` 关掉「自动旋转」—— 否则下面那句会被它立刻顶回去；
 * · `user_rotation = 0` 才是真正的「转成竖屏」（0=portrait、1=landscape）。
 *   ⚠ 只写`user_rotation` 不够，**必须先关自动旋转**，这条实测踩过。
 */
internal object SystemRotation {

    private const val TAG = "SystemRotation"

    /** 系统「自动旋转」开关。关掉它，`user_rotation` 才算数。 */
    private const val K_ACCEL = Settings.System.ACCELEROMETER_ROTATION

    /** 系统「用户指定的旋转角」。`Surface.ROTATION_0` = 0 = 竖屏。 */
    private const val K_ROT = Settings.System.USER_ROTATION

    /**
     ★★ 锁之前把**原值**存这儿，[restore] 照原样写回去。
     *
     * 为什么必须存：锁的时候动了 `accelerometer_rotation` 与 `user_rotation` **两个**键
     * ⇒ 复原时也得两个一起复原。第一版只还了前者、把 `user_rotation` 留在 0
     * （真机实测 `1 → 0` 没回去，验收那条红了）⇒ **改 A 必须连 B 一起还原**。
     *
     * ⚠ 只在本进程内有效（`object` 的字段）⇒ 进程被杀就拿不到了，
     *   那时 [restore] 走「只还自动旋转、角度不碰」的兜底：
     *   **宁可少改一样，也别写死一个我们不知道原值的角度。**
     */
    private var lastSaved: Pair<Int, Int>? = null

    /**
     * 改设置要 `WRITE_SETTINGS`。**特殊权限**：清单里声明 ≠ 生效，
     * 必须用户去系统设置里手动开⇒ 所以每一处写入都要先问[canWrite]。
     */
    fun canWrite(context: Context): Boolean =
        try {
            // ⚠ 这里要**Context**，不是 `contentResolver` ——
            //   `Settings.System.canWrite` 的形参就是 Context（编译报错才发现，已修）。
            //   而且它在旧内核/无权限时是**抛异常**的，不是返回 false ⇒ 必须包 try。
            Settings.System.canWrite(context)
        } catch (t: Throwable) {
            Log.w(TAG, "canWrite 询问失败，按没权限处理", t)
            false
        }

    /**
     * 「修改系统设置」的系统页。返回它让用户自己开开关——
     * ⛔ **App 不能代替用户点**（那是系统级授权，绕过它等于骗权限）。
     */
    fun settingsIntent(context: Context): Intent? = try {
        Intent(
            Settings.ACTION_MANAGE_WRITE_SETTINGS,
            Uri.parse("package:" + context.packageName)
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    } catch (t: Throwable) {
        Log.w(TAG, "拼「修改系统设置」页失败", t)
        null
    }

    /**
     * 锁竖屏。**只在选照片前调一次**。
     *
     * @return `true` = 已经锁成竖屏；`false` = 没权限/写失败 ⇒ **调用方必须走退路**
     *         （照常弹选择器，只是它是横的——绝不因为这个失败就不让用户选照片）。
     */
    fun lockPortrait(context: Context): Boolean {
        // ★★ 这里**必须留日志**（第一版直接 `return false` 一个字都没记，
        //   结果真机验收那条「锁竖屏动作有据可查」红了 —— 事后完全查不出是
        //   "没去试"还是"试了没成"。凡"因权限/环境而退让"的分支，**一律要出声**。
        if (!canWrite(context)) {
            Log.i(TAG, "未锁竖屏：还没有「修改系统设置」授权 ⇒ 走退路（选择器会是横的）")
            return false
        }
        return try {
            val cr: ContentResolver = context.contentResolver
            // ★ 先存原值再改（复原时要靠它，见 [lastSaved]）。
            // ⚠ 没权限/读失败时 getInt 在这台机器上**抛异常** ⇒ 包 try，存不下就 null。
            lastSaved = try {
                Pair(
                    Settings.System.getInt(cr, K_ACCEL, 1),
                    Settings.System.getInt(cr, K_ROT, 0)
                )
            } catch (t: Throwable) {
                Log.w(TAG, "读不到原旋转值（不致命），复原时走兜底", t)
                null
            }
            // 顺序要紧：先关自动旋转，再定角度。反了就互相打架。
            Settings.System.putInt(cr, K_ACCEL, 0)
            Settings.System.putInt(cr, K_ROT, 0)
            Log.i(TAG, "已锁竖屏（accelerometer_rotation=0, user_rotation=0），原值=$lastSaved")
            true
        } catch (t: Throwable) {
            // 不许崩：写不进去就当没锁成，调用方退回去（老样子横屏选择器）。
            lastSaved = null
            Log.w(TAG, "锁竖屏失败，退回默认行为", t)
            false
        }
    }

    /**
     * 恢复成**用户自己的**设置。选完/取消、以及 [PickProxyActivity] 被销毁时都要调。
     *
     * ★★ 恢复策略（2026-10-08 真机实测后改）：**两个键都精确复原**。
     *   第一版只还了 `accelerometer_rotation=1`、把 `user_rotation` 留在 `0`
     *   ⇒ 真机验收那条「user_rotation 还原」红了（实测 `1 → 0` 没回去）。
     *   根因：**锁的时候动了两处，还的时候只还了一处** —— 改 A 必须连 B 一起复原，
     *   不然用户原来自己设的角度就被我们"顺手改了"。
     *   ⇒ 现在 [lockPortrait] 先把两个原值存进 [lastSaved]，[restore] 照着原样写回。
     *   ⚠ 读原值要 try：没权限时 `Settings.System.getInt` 在这台机器上是**抛异常**的。
     *   ⚠ 存不下（进程被杀）时退回到「`accelerometer_rotation=1` + `user_rotation` 不碰」，
     *   也就是第一版的行为 —— 宁可少改一样，也别写死一个我们不知道原值的角度。
     *
     * @return `true` = 已复原；`false` = 没权限/写失败（**只记日志，绝不弹窗**）。
     */
    fun restore(context: Context): Boolean {
        // 同 [lockPortrait]：退让分支也要出声（否则"没恢复"和"不用恢复"分不清）。
        if (!canWrite(context)) {
            Log.w(TAG, "未能恢复：没有「修改系统设置」授权（本次也没锁成功，无需恢复）")
            return false
        }
        return try {
            val cr: ContentResolver = context.contentResolver
            val saved = lastSaved
            if (saved != null) {
                Settings.System.putInt(cr, K_ACCEL, saved.first)
                Settings.System.putInt(cr, K_ROT, saved.second)
                lastSaved = null
                Log.i(TAG, "已复原系统旋转（accelerometer_rotation=${saved.first}, user_rotation=${saved.second}）")
            } else {
                // 兜底：没有原值（跨进程被杀）⇒ 只交还自动旋转，角度不碰。
                Settings.System.putInt(cr, K_ACCEL, 1)
                Log.w(TAG, "没有原值可复原（进程可能被杀）⇒ 只交还自动旋转，角度留原样")
            }
            true
        } catch (t: Throwable) {
            Log.w(TAG, "恢复系统旋转失败（不影响选照片，静默）", t)
            false
        }
    }
}