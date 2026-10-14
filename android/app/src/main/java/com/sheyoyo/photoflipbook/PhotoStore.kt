package com.sheyoyo.photoflipbook

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import java.io.File
import java.io.FileInputStream
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

    /** 认哪些扩展名 —— **单一真相源**：[isImageName] 与 [ensureImageExt] 都用它，免得两边走偏。 */
    private val IMAGE_EXT = setOf("jpg", "jpeg", "png", "webp", "heic", "bmp")

    private fun isImageName(n: String): Boolean = extOf(n) in IMAGE_EXT

    /** 名字里**真的**带图片扩展名吗。 */
    private fun hasImageExt(n: String): Boolean = extOf(n) in IMAGE_EXT

    /**
     * ★ F163：**扩展名兜底** —— 按**真实解码格式**补扩展名。
     *
     * 为什么非补不可：`outName` 的扩展名是 `displayName()` 给的，而**查不出名字**是常态
     * （Android 13+ 选择器的 URI 查 `OpenableColumns.DISPLAY_NAME` 查不到时，
     *  [displayName] 退回的是 `uri.lastPathSegment` —— **一个纯数字 id，没有扩展名**）。
     * 那种文件落盘叫 `001-12345`，[scanPicked] 的 [isImageName] 会**默默把它筛掉**
     * ⇒ 用户看到的是"照片没进来"，而**一条报错都没有**（最难的那种 bug）。
     *
     * 改成从 `BitmapFactory` 量出来的 `outMimeType` 反推 ⇒ 与相册给的名字**完全无关**。
     */
    private val MIME_EXT = mapOf(
        "image/jpeg" to "jpg", "image/png" to "png", "image/webp" to "webp",
        "image/bmp" to "bmp", "image/gif" to "gif",
        "image/heic" to "heic", "image/heif" to "heif", "image/avif" to "avif",
    )

    /** 拿不到真格式就按 jpeg —— 相册给的照片绝大多数是它（宁可猜对，也别丢照片）。 */
    private fun extForMime(mime: String?): String = MIME_EXT[(mime ?: "").lowercase()] ?: "jpg"

    private fun ensureImageExt(dir: File, f: File, mime: String?): File {
        // 已经有扩展名（哪怕是 .jfif 这种不在白名单里的）⇒ **换掉**它，别叠成 "a.jfif.jpg"
        val stem = if (f.name.contains('.')) f.name.substringBeforeLast('.') else f.name
        if (stem.isBlank()) return f
        val fixed = File(dir, "$stem." + extForMime(mime))
        return if (fixed.name == f.name || !f.renameTo(fixed)) f else fixed
    }

    /** 扫用户选的照片（按文件名排序 —— 前缀是序号）。
     *
     * ★ F163：**一个点都没有**的文件名（老流程导入留下的 `001-12345`）在这里**补回扩展名**
     *   再入列 —— 否则它们永远被筛在墙外：照片明明在磁盘上，用户却只看见"少了"。
     *   ⚠ 只补"连点都没有"的那批（那正是选择器退回数字 id 的形态）；
     *     带点却不认识的后缀（`.tmp` 之类）**不碰** —— 免得给临时文件安个假名，
     *     也免得每次扫盘都去解码一堆垃圾（扫盘是在主线程上跑的，见 `WorkbenchActivity.onCreate`）。 */
    fun scanPicked(context: Context): List<PhotoRef> {
        val dir = pickedDir(context)
        val named = (dir.listFiles() ?: emptyArray())
            .filter { it.isFile }
            .map { f -> if (isImageName(f.name) || f.name.contains('.')) f else repairExt(dir, f) }
        return named
            .filter { it.isFile && isImageName(it.name) }
            .sortedBy { it.name }
            .mapIndexed { i, f ->
                PhotoRef(key = "picked/${f.name}", bookKey = "", relPath = f.name,
                    file = f, builtin = false, order = i + 1)
            }
    }

    /** 量不出来（真不是图）就原样留着 —— 宁可它继续不显示，也别给它安个假扩展名。 */
    private fun repairExt(dir: File, f: File): File {
        val p = probeDecodable(f) ?: return f
        return ensureImageExt(dir, f, p.mime)
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
     * 一次导入的结果。
     *
     * ★★ 2026-10-12（F162）：**失败要带名字**，不再只给一个数。
     *   老接口只返回"新增几张"，用户看到的就只能是「有 N 张读不出来」——
     *   谁也不知道是哪 N 张 ⇒ 这次"一百张识别失败"最难定位的地方就在这。
     *   现在 [failed] 带上文件名，界面能直接列出「这 3 张：xxx、yyy」。
     */
    data class ImportResult(
        val added: Int,
        val total: Int,
        val failed: List<String>,
    )

    /**
     * ★ F162：**这几类格式要转码**。
     *
     * 为什么：系统相册给得出、原生 `BitmapFactory` 大多也解得开，
     * **但预览那颗 WebView 不保证能解**（解不开就归到"读不出来"那堆里）。
     * ⇒ 导入时就**转成 JPEG** 存进来，后面整条链（缩略图 / 预览 / 出书）一律只面对 JPEG。
     *
     * ⚠ 转码失败**不抛弃这张图**：退回"原样留着"，交给下面的 [probeDecodable] 判，
     *   判得过就留、判不过才跳过（不许因为转码这一步把用户的照片弄丢）。
     */
    private val TRANSCODE_EXT = setOf("heic", "heif", "avif", "hevc", "hif")

    private fun extOf(n: String): String = n.substringAfterLast('.', "").lowercase()

    private fun needsTranscode(name: String): Boolean = extOf(name) in TRANSCODE_EXT

    /** 只量尺寸、**不解像素**（`inJustDecodeBounds`）的结果。 */
    private data class Probe(val w: Int, val h: Int, val mime: String?)

    /**
     * 只量尺寸、**不解像素**（`inJustDecodeBounds`）—— 用它判"这到底是不是一张能解开的图"。
     * 落盘后验一次，解不开就跳过并**记名**，而不是"静默少几张"。
     *
     * ★ F163：连**真实格式**（`outMimeType`）一起带出来 —— 扩展名兜底与转码判定都要靠它
     *   （文件名说自己是 `.jpg` 未必真是 jpg，文件名没扩展名更不代表它不是图）。
     * ⚠ 返回 `null` = 量不出来（当解不开）。
     */
    private fun probeDecodable(file: File): Probe? {
        return try {
            val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            FileInputStream(file).use { BitmapFactory.decodeStream(it, null, o) }
            if (o.outWidth > 0 && o.outHeight > 0) Probe(o.outWidth, o.outHeight, o.outMimeType)
            else null
        } catch (t: Throwable) {
            Log.w(TAG, "验图失败（当解不开）：${file.name}", t)
            null
        }
    }

    /** `outMimeType` 判 HEIC 家族 —— 比只看文件名准（HEIC 被起名成 `.jpg` 的也躲不掉）。 */
    private fun isHeicLike(mime: String?): Boolean {
        val m = (mime ?: "").lowercase()
        return m.contains("heic") || m.contains("heif") || m.contains("avif") || m.contains("hevc")
    }

    /** heic / heif / avif ⇒ JPEG（q95）。⚠ 12MP 一张解码约 48MB，**一次只处理一张**。 */
    private fun transcodeToJpeg(src: File, dst: File): Boolean {
        return try {
            val bmp = FileInputStream(src).use { BitmapFactory.decodeStream(it) }
            if (bmp == null) return false
            // ⚠ 别写 `var ok = false` 再在 use{} 里赋值 —— Kotlin 会报
            //   "initializer is redundant"；`use` 本身就返回 lambda 的结果。
            val ok = FileOutputStream(dst).use { os ->
                bmp.compress(Bitmap.CompressFormat.JPEG, 95, os)
            }
            bmp.recycle()
            ok
        } catch (t: Throwable) {
            Log.w(TAG, "转码失败：${src.name}", t)
            false
        }
    }

    /**
     * 把相册选的 uri **追加**拷进私有目录。
     *
     * ⚠ 不做任何去重 —— 他要的就是"选两次存两份"。
     * ⚠ 单个文件失败只跳过它，不让整批失败（且不抛异常给界面）⇒ 失败进 [ImportResult.failed]。
     *
     * ★★ 2026-10-12（F162）两步加固（对应"一次输入一百张会失败"）：
     *   ① heic / heif / avif **转码成 JPEG** 再存（WebView 不保证能解这类格式）；
     *   ② 落盘后**验一次是不是真能解开的图**，解不开就删掉并记名
     *      ⇒ 界面能说清"少了哪几张"，不再静默丢。
     */
    fun importPhotos(context: Context, uris: List<Uri>): ImportResult {
        val dir = pickedDir(context)
        // 接着现有最大编号往下排
        var seq = (dir.listFiles() ?: emptyArray())
            .mapNotNull { it.name.substringBefore('-', "").toIntOrNull() }
            .maxOrNull() ?: 0
        var ok = 0
        val failed = ArrayList<String>()
        for (u in uris) {
            seq++
            val raw = safeName(displayName(context, u))
            // 转过码的**改名成 .jpg**：否则 scanPicked 的扩展名白名单会把它再筛掉一遍
            val outName = if (needsTranscode(raw)) {
                String.format("%03d-%s.jpg", seq, raw.substringBeforeLast('.').ifBlank { "photo" })
            } else {
                String.format("%03d-%s", seq, raw)
            }
            val dst = File(dir, outName)
            var ins: InputStream? = null
            try {
                ins = context.contentResolver.openInputStream(u)
                if (ins == null) {
                    Log.w(TAG, "读不出来：$u")
                    failed.add(raw)
                    continue                       // ⚠ 这句必须在 for 体内，不能塞进 run{}/let{}（inline lambda 里的 continue 要实验特性）
                }
                val stream = ins
                FileOutputStream(dst).use { os -> stream.copyTo(os, 64 * 1024) }

                // ① 先量一下：这张到底是什么图（顺带拿到**真实格式**）
                val probed = probeDecodable(dst)
                if (probed == null) {
                    Log.w(TAG, "这张不是能解开的图，跳过：$raw")
                    try { dst.delete() } catch (_: Throwable) { }
                    failed.add(raw)
                    continue
                }
                // ② 转码与否看**真实格式**，不再只看文件名（HEIC 被起名成 .jpg 的也能逮住）
                var asJpeg = false
                if (needsTranscode(raw) || isHeicLike(probed.mime)) {
                    val tmp = File(dir, dst.name + ".tmp")
                    if (dst.renameTo(tmp) && transcodeToJpeg(tmp, dst)) {
                        try { tmp.delete() } catch (_: Throwable) { }
                        asJpeg = true
                    } else {
                        // 转不动 ⇒ 原样放回去（不许因为这一步丢了照片）
                        try { tmp.renameTo(dst) } catch (_: Throwable) { }
                    }
                }
                // ③ 扩展名兜底：displayName 给不出扩展名时补一个
                //    ⇒ 否则这个真真切切落了盘的文件会被 scanPicked 默默筛掉。
                if (!hasImageExt(dst.name)) {
                    ensureImageExt(dir, dst, if (asJpeg) "image/jpeg" else probed.mime)
                }
                ok++
            } catch (t: Throwable) {
                Log.w(TAG, "这张跳过：$u", t)
                failed.add(raw)
                try { dst.delete() } catch (_: Throwable) { }
            } finally {
                try { ins?.close() } catch (_: Throwable) { }
            }
        }
        if (ok > 0) setCleared(context, false)      // 又选了照片 ⇒ 取消"清空"状态
        Log.i(TAG, "选照片：新增 $ok / 共 ${uris.size} 张；跳过 ${failed.size} 张：$failed")
        return ImportResult(ok, uris.size, failed)
    }

    /** 清空用户选的照片（删文件），返回删掉的张数。 */
    fun clearPicked(context: Context): Int {
        val dir = pickedDir(context)
        var n = 0
        (dir.listFiles() ?: emptyArray()).forEach {
            // ★ F165：`picked/.thumbs/` 是**缩略图磁盘缓存**（见 [Thumbs]）。
            //   老代码只 `if (it.isFile) it.delete()` ⇒ **子目录一个都不删**
            //   ⇒ 他"清空"之后磁盘上还压着几十张旧缩略图（白占空间、还让人以为没清干净）。
            //   ⇒ 目录**递归删**（里面全是可再生成的小图，删了不心疼）。
            if (it.isDirectory) {
                it.deleteRecursively()      // 计数不掺缓存张数，返回的还是照片数
            } else if (it.isFile) {
                if (it.delete()) n++
            }
        }
        setCleared(context, true)
        Log.i(TAG, "已清空所选的 $n 张")
        return n
    }

}
