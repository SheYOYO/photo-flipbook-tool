package com.sheyoyo.photoflipbook

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream

/**
 * 工作台的照片源 —— **相册选的（私有目录）** 与 **内置素材** 两套，可切换。
 *
 * ★ 他明确要求过的两条口径（原样照搬，别自己"优化"掉）
 *   1. **追加，不覆盖**；**重复的不跳过** —— 同一张图选两次就存两份（他要的就是这个）
 *   2. **清空**要**跨启动保持** —— 所以"清空过"这件事得存进 `SharedPreferences`
 *      （旧工程存在 Java 字段里，进程一死就没，重新进又冒回内置素材）
 *
 * ★ 为什么要**拷进私有目录**
 *   相册给的 `content://` **读授权只在选中的那一刻有效**，App 之后要反复读这些图
 *   （出缩略图、探测、排版、出 artwork）⇒ 必须拷成普通文件，`file://` 才一直能读。
 *
 * ★ 命名规则
 *   `%03d-原名`（前缀就是**页序**，扫目录时按它排序）。
 *   追加时接着现有最大编号往下排 ⇒ 原有照片的序号永不变动（重要：序号是身份号）。
 */
object PhotoStore {
    private const val TAG = "PhotoStore"
    private const val PREF = "workbench"
    private const val KEY_CLEARED = "photos_cleared"

    /** 用户选的照片放这儿（外置私有目录，跟旧工程一致）。 */
    fun pickedDir(context: Context): File =
        File(context.getExternalFilesDir(null) ?: context.filesDir, "picked")
            .also { if (!it.isDirectory) it.mkdirs() }

    private fun isImageName(n: String): Boolean {
        val l = n.lowercase()
        return l.endsWith(".jpg") || l.endsWith(".jpeg") || l.endsWith(".png") ||
               l.endsWith(".webp") || l.endsWith(".heic") || l.endsWith(".bmp")
    }

    /** 扫用户选的照片（按文件名排序 —— 前缀是序号）。 */
    fun scanPicked(context: Context): List<PhotoRef> {
        val dir = pickedDir(context)
        return (dir.listFiles() ?: emptyArray())
            .filter { it.isFile && isImageName(it.name) }
            .sortedBy { it.name }
            .mapIndexed { i, f ->
                PhotoRef(key = "picked/${f.name}", bookKey = "", relPath = f.name,
                    file = f, builtin = false, order = i + 1)
            }
    }

    /** 内置演示书的照片（M3 的起步素材，也是"没选过照片"时的兜底）。 */
    fun builtinPhotos(context: Context, bookKey: String): List<PhotoRef> {
        val dir = "books/$bookKey/assets/photos"
        val names = try {
            context.assets.list(dir).orEmpty()
        } catch (t: Throwable) {
            Log.w(TAG, "列不出 $dir", t)
            return emptyList()
        }
        return names.filter { isImageName(it) }.sorted()
            .mapIndexed { i, n ->
                PhotoRef(key = "$bookKey/$n", bookKey = bookKey,
                    relPath = "assets/photos/$n", file = null, builtin = true, order = i + 1)
            }
    }

    /**
     * 当前该用哪一批：
     *   · 有用户选的照片 ⇒ **只用**用户的（选了就不再混内置素材）
     *   · 没有、且**没清空过** ⇒ 回落到内置素材
     *   · 没有、但**清空过** ⇒ **空**（否则他清完再进来又是 14 张，看着像"清空没生效"）
     */
    fun currentPhotos(context: Context, bookKey: String): List<PhotoRef> {
        val picked = scanPicked(context)
        if (picked.isNotEmpty()) return picked
        if (isCleared(context)) return emptyList()
        return builtinPhotos(context, bookKey)
    }

    fun isCleared(context: Context): Boolean =
        context.getSharedPreferences(PREF, Context.MODE_PRIVATE).getBoolean(KEY_CLEARED, false)

    fun setCleared(context: Context, v: Boolean) {
        context.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit()
            .putBoolean(KEY_CLEARED, v).apply()
    }

    private fun displayName(context: Context, uri: Uri): String {
        try {
            context.contentResolver.query(uri, null, null, null, null)?.use { c ->
                val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (i >= 0 && c.moveToFirst()) {
                    val n = c.getString(i)
                    if (!n.isNullOrBlank()) return n
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "问不到文件名，退回路径末段：$uri", t)
        }
        return uri.lastPathSegment?.substringAfterLast('/') ?: "photo.jpg"
    }

    private fun safeName(s: String): String = cleanName(s, 80, "photo.jpg")

    /**
     * 把相册选的 uri **追加**拷进私有目录，返回**实际新增**的张数。
     *
     * ⚠ 不做任何去重 —— 他要的就是"选两次存两份"。
     * ⚠ 单个文件失败只跳过它，不让整批失败（且不抛异常给界面）。
     */
    fun importPhotos(context: Context, uris: List<Uri>): Int {
        val dir = pickedDir(context)
        // 接着现有最大编号往下排
        var seq = (dir.listFiles() ?: emptyArray())
            .mapNotNull { it.name.substringBefore('-', "").toIntOrNull() }
            .maxOrNull() ?: 0
        var ok = 0
        for (u in uris) {
            seq++
            val dst = File(dir, String.format("%03d-%s", seq, safeName(displayName(context, u))))
            var ins: InputStream? = null
            try {
                ins = context.contentResolver.openInputStream(u)
                if (ins == null) {
                    Log.w(TAG, "读不出来：$u")
                    continue                       // ⚠ 这句必须在 for 体内，不能塞进 run{}/let{}（inline lambda 里的 continue 要实验特性）
                }
                val stream = ins
                FileOutputStream(dst).use { os -> stream.copyTo(os, 64 * 1024) }
                ok++
            } catch (t: Throwable) {
                Log.w(TAG, "这张跳过：$u", t)
                try { dst.delete() } catch (_: Throwable) { }
            } finally {
                try { ins?.close() } catch (_: Throwable) { }
            }
        }
        if (ok > 0) setCleared(context, false)      // 又选了照片 ⇒ 取消"清空"状态
        Log.i(TAG, "选照片：新增 $ok / 共 ${uris.size} 张")
        return ok
    }

    /** 清空用户选的照片（删文件），返回删掉的张数。 */
    fun clearPicked(context: Context): Int {
        val dir = pickedDir(context)
        var n = 0
        (dir.listFiles() ?: emptyArray()).forEach {
            if (it.isFile) {
                if (it.delete()) n++
            }
        }
        setCleared(context, true)
        Log.i(TAG, "已清空所选的 $n 张")
        return n
    }

}
