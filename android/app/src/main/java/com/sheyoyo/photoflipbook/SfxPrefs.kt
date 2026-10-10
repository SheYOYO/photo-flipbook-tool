package com.sheyoyo.photoflipbook

import android.content.Context

/**
 * ★ 2026-10-10（二十一轮）：**翻页声开关**（书架页那个控件控制它）。
 *
 * ⚠ 为什么必须存在原生这一层，而不放在 WebView 的 `localStorage`：
 *   开关在**书架**（Kotlin 原生，没有 WebView），而发声在**书页**（WebView）。
 *   两边不共享存储 ⇒ 原生 `SharedPreferences` 是唯一的公共真相源；
 *   书页每次打开时由 `BookPageActivity` 把它注入成 `window.__shellSfxOn`（见 sfx.js）。
 *
 * ⚠ 默认值 = **开**（true）：新增功能不应该默认是"没反应"，否则用户会以为没做。
 */
object SfxPrefs {
    private const val PREF = "shell"
    private const val KEY_SFX_ON = "sfxOn"

    /** 翻页声是否开启（默认开）。 */
    fun isOn(ctx: Context): Boolean =
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getBoolean(KEY_SFX_ON, true)

    /** 写入开关。⚠ 用 `apply()`（异步落盘）—— 这是 UI 线程上的点击回调，别用 `commit()`。 */
    fun setOn(ctx: Context, on: Boolean) {
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .edit().putBoolean(KEY_SFX_ON, on).apply()
    }
}
