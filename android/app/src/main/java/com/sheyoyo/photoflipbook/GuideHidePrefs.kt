package com.sheyoyo.photoflipbook

import android.content.Context

/**
 * 内置教学画册的**隐藏开关**（R34，2026-10-15）。
 *
 * 他要的行为（原话）
 * ------------------
 *   「内置的教学画册可以隐藏，就是长摁书架上的画册后选择隐藏」
 *   「隐藏是直接从书架上消失，不要占着位置」
 *
 * ⛔ **隐藏 ≠ 删除**
 *   教学画册打在 APK 的 assets 里，本来就删不掉（长按只会提示"删不掉"）。
 *   本开关只让它**不进书架列表** —— 文件、资产、页码一个字节不动，
 *   关掉开关立刻回来。所以**没有不可逆风险**，也不需要二次确认"会不会丢"。
 *
 * ⚠ 为什么不用 `Book.hidden` 字段那套：
 *   隐藏是**全局**的（跟书本身无关，是这台机器上不想看见它），
 *   不是某一本书的属性 ⇒ 存偏好设置比在书目录里写标记更合适，
 *   也不会在书目录里留垃圾文件。
 *
 * ⚠ 默认**显示**（`true`）：新功能不该默认让东西消失，否则他会以为书没了。
 */
object GuideHidePrefs {

    private const val PREF = "shell"

    /** 与 [SfxPrefs] 用同一个 prefs 文件（同一份"壳层偏好"）。 */
    private const val KEY_GUIDE_HIDDEN = "guideHidden"

    /** 教学画册当前是否被隐藏（默认 false = 显示）。 */
    fun isHidden(ctx: Context): Boolean =
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .getBoolean(KEY_GUIDE_HIDDEN, false)

    /**
     * 写入开关。
     *
     * ⚠ 用 `apply()`（异步落盘）—— 调用点在 UI 线程的点击回调里，`commit()` 会卡一下。
     */
    fun setHidden(ctx: Context, hidden: Boolean) {
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .edit().putBoolean(KEY_GUIDE_HIDDEN, hidden).apply()
    }
}