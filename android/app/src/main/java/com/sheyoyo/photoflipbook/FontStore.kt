package com.sheyoyo.photoflipbook

import android.content.Context
import android.net.Uri
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/**
 * 用户字体库（**全局**，App 私有目录）。
 * ============================================================================
 * 佘先生 2026-10-11 的需求（封面编辑 · 字体组块）：
 *   ① 字体组块里能**引入外部字体**（点开选文件）；
 *   ② 认得出是字体就**导入到本机字体库**，全局可用；认不出就**给提示**；
 *   ③ 用户后期加的字体**只留在本机**（不进 APK、别人装了也没有）；
 *   ④ 但如果**自己的画册用了外部字体**，那份画册要**把字体带上** ——
 *      不然传播出去别人打开就是回落字体（`BookWriter` 负责拷）。
 *
 * 目录布局（`files/user_fonts/`）：
 * ```
 *   registry.json      ← [{"key":"uf1","name":"字体显示名","file":"xxx.ttf"}]
 *   <file>.ttf/.otf/…  ← 原样存下来的字体文件
 * ```
 *
 * ⚠ 为什么用 `filesDir`（私有、不进 assets）：字体是**用户资产**，
 *   不能编进 APK —— 他明确要「别人下载软件是没有那些字体的」。
 */
object FontStore {
    private const val TAG = "FontStore"
    private const val DIR_NAME = "user_fonts"
    private const val REG = "registry.json"

    /** 一条用户字体：`key` 是引擎 `font` 字段存的键（`ufN`），`name` 是显示名与 CSS family。 */
    data class UserFont(val key: String, val name: String, val file: String)

    /** 校验结果：成功带上新字体，失败带一句人话原因。 */
    sealed class AddResult {
        data class Ok(val font: UserFont) : AddResult()
        data class Fail(val reason: String) : AddResult()
    }

    fun dir(context: Context): File =
        File(context.filesDir, DIR_NAME).also { if (!it.isDirectory) it.mkdirs() }

    fun fileOf(context: Context, f: UserFont): File = File(dir(context), f.file)

    /** 读注册表（读不出来就当空库，不抛）。 */
    fun list(context: Context): List<UserFont> {
        val f = File(dir(context), REG)
        if (!f.isFile) return emptyList()
        return try {
            val arr = JSONArray(f.readText(Charsets.UTF_8))
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                val key = o.optString("key")
                val file = o.optString("file")
                if (key.isBlank() || file.isBlank()) null
                else UserFont(key, o.optString("name").ifBlank { file }, file)
            }.filter { File(dir(context), it.file).isFile }
        } catch (t: Throwable) {
            Log.w(TAG, "读字体注册表失败（当空库）", t)
            emptyList()
        }
    }

    /** 引擎 `font` 白名单：`{内置键…} + {ufN: 字体名}`（CSS family）。 */
    fun familiesJson(context: Context): JSONObject {
        val o = JSONObject()
        list(context).forEach { o.put(it.key, it.name) }
        return o
    }

    /**
     * 从系统选择器给的 Uri 导入一个字体文件。
     *
     * 步骤：读头部判类型 → 认不出就失败 → 按类型定扩展名 → 拷进字体库 → 登记。
     */
    fun addFromUri(context: Context, uri: Uri, displayName: String?): AddResult {
        return try {
            val header = context.contentResolver.openInputStream(uri)?.use { ins ->
                val buf = ByteArray(4)
                val n = ins.read(buf)
                if (n < 4) null else buf
            }
            val kind = header?.let { sniff(it) }
                ?: return AddResult.Fail("这个文件不是有效的字体（认不出 ttf/otf/woff/woff2 头）")

            val base = (displayName ?: uri.lastPathSegment ?: "font")
                .substringAfterLast('/')
                .substringBeforeLast('.')
                .ifBlank { "font" }
            // 显示名：取文件名（去扩展名），再做一次轻清洗
            val name = cleanFontName(base)
            val ext = when (kind) { "ttf" -> "ttf"; "otf" -> "otf"; "woff" -> "woff"; else -> "woff2" }

            val fonts = list(context)
            // key：uf1..ufN，取当前最大值 +1（删过的号不复用，避免和草稿里旧引用撞车）
            var maxN = 0
            fonts.forEach { it.key.removePrefix("uf").toIntOrNull()?.let { n -> if (n > maxN) maxN = n } }
            val key = "uf" + (maxN + 1)

            val fileName = "uf" + (maxN + 1) + "-" + sanitize(base) + "." + ext
            val out = File(dir(context), fileName)
            context.contentResolver.openInputStream(uri)?.use { ins ->
                FileOutputStream(out).use { os -> ins.copyTo(os, 64 * 1024) }
            } ?: return AddResult.Fail("读不到所选文件（可能没有访问权限）")

            val nf = UserFont(key, name, fileName)
            writeRegistry(context, fonts + nf)
            Log.i(TAG, "引入字体成功：$name → $fileName（$key）")
            AddResult.Ok(nf)
        } catch (t: Throwable) {
            Log.w(TAG, "引入字体失败", t)
            AddResult.Fail("导入失败：${t.message ?: t.javaClass.simpleName}")
        }
    }

    fun remove(context: Context, key: String) {
        val fonts = list(context)
        val f = fonts.firstOrNull { it.key == key } ?: return
        try { File(dir(context), f.file).delete() } catch (t: Throwable) { Log.w(TAG, "删字体文件失败", t) }
        writeRegistry(context, fonts.filterNot { it.key == key })
    }

    // ------------------------------------------------------------------

    private fun writeRegistry(context: Context, fonts: List<UserFont>) {
        val arr = JSONArray()
        fonts.forEach { f ->
            arr.put(JSONObject().apply {
                put("key", f.key); put("name", f.name); put("file", f.file)
            })
        }
        File(dir(context), REG).writeText(arr.toString(), Charsets.UTF_8)
    }

    /** 认字体文件头（magic bytes）。认不出返回 null。 */
    private fun sniff(h: ByteArray): String? {
        if (h.size < 4) return null
        val hex = h.take(4).joinToString("") { "%02X".format(it) }
        return when (hex) {
            "00010000" -> "ttf"     // TrueType
            "74727565" -> "ttf"     // 'true'
            "4F54544F" -> "otf"     // 'OTTO'
            "774F4646" -> "woff"    // 'wOFF'
            "774F4632" -> "woff2"   // 'wOF2'
            else -> null
        }
    }

    private fun cleanFontName(s: String): String =
        s.replace(Regex("[\\r\\n\\t]"), " ").trim().take(40).ifBlank { "用户字体" }

    private fun sanitize(s: String): String =
        s.replace(Regex("[^\\w\\u4e00-\\u9fff-]"), "_").take(24).ifBlank { "font" }
}
