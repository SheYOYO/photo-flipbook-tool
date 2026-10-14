package com.sheyoyo.photoflipbook

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream

/**
 * 出书（M5）—— 把工作台里排好的这一本落成**一个能独立打开、能翻**的书目录。
 *
 * ★ 书目录长什么样（与电脑端链① 完全一致；`BookStore` 扫目录就认它）：
 * ```
 * books/<book-id>/
 *   index.html            ← 四颗引擎 buildIndexHtml 的产物（34 KB 上下）
 *   book-plan.json        ← 书名/副标题/封面文案/每张的档位 —— 书架靠它取书名与封面
 *   styles.css  style/  vendor/  flipbook.js   ← 从内置书模板整份拷（观感是链① 的资产）
 *   assets/photos/        ← 按 artwork 尺寸缩放、Q86（与电脑端一致）的 .jpg 全放这儿
 * ```
 *
 * ⚠ 书里那 30 个文件**全是相对路径** ⇒ 少拷一样，书就少一层样子（或干脆翻不动）。
 *   旧工程为此专门记过一条：**光写 index.html 没用**。
 *
 * ⚠ 有意**不拷** `style/fonts/` 里的用户字体（3.1 MB）—— 每本书省 3 MB，
 *   字体缺失时会回落到 `--book-serif`／`--book-sans` 的系统衬线，观感差异很小。
 *   （旧工程也是这么取舍的；要带字体时再加。）
 */
object BookWriter {
    private const val TAG = "BookWriter"

    /** 模板书：内置教学画册的样式/运行时就是链① 那一套（我们一个字没改）。
     *  ★ R30（2026-10-13）：原 `books/book1` 已删（内置书只剩 `guide`）——
     *    漏改这行的症状是「出的书没有 styles.css/flipbook.js，封面照片不按 cover 裁」。 */
    private const val TEMPLATE = "books/guide"
    private val COPY_DIRS = listOf("style", "vendor")
    private val COPY_FILES = listOf("styles.css", "flipbook.js")

    fun booksRoot(context: Context): File =
        File(context.getExternalFilesDir(null) ?: context.filesDir, "books")

    /** `book-YYYYMMDD-HHmmss`（与旧工程同一命名，方便他对照）。 */
    fun newBookId(): String {
        val now = java.util.Date()
        val f = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.US)
        return "book-" + f.format(now)
    }

    /**
     * 建目录、拷观感资产、写 `index.html` 与 `book-plan.json`。
     * 返回书目录；失败返回 null（**不抛**，由调用方转成一句中文提示）。
     */
    fun writeBook(context: Context, id: String, html: String, planJson: String): File? {
        return try {
            val dir = File(booksRoot(context), safeId(id))
            if (!dir.isDirectory && !dir.mkdirs()) {
                Log.e(TAG, "建不了书目录：$dir")
                return null
            }
            COPY_DIRS.forEach { copyAssetDir(context, "$TEMPLATE/$it", File(dir, it)) }
            COPY_FILES.forEach { copyAssetFile(context, "$TEMPLATE/$it", File(dir, it)) }
            // ★ 2026-10-11：把这一本**用到的用户字体**带上（他要求：用了外部字体的画册，
            //   传给别人也要能直接翻 ⇒ 字体必须进书目录，不能只留在本机字体库）。
            carryUserFonts(context, dir, planJson)
            File(dir, "index.html").writeText(html, Charsets.UTF_8)
            File(dir, "book-plan.json").writeText(planJson, Charsets.UTF_8)
            File(dir, "assets/photos").mkdirs()
            Log.i(TAG, "书目录就绪：${dir.absolutePath}")
            dir
        } catch (t: Throwable) {
            Log.e(TAG, "出书落盘失败", t)
            null
        }
    }

    /**
     * ★ 2026-10-11：把 `plan.user_fonts` 里列到的「用户字体」拷进 `style/fonts/`，
     * 并把它们的 `@font-face` **追加**到 `style/user-fonts.css`（`index.html` 里那条
     * `<link …user-fonts.css>` 会读到它）⇒ 画册**自带字体**，传给别人也能直接翻。
     *
     * ⚠ 认不出/读不到就跳过 —— **不抛**，书照样能出（只是那几处回落系统字体）。
     */
    private fun carryUserFonts(context: Context, dir: File, planJson: String) {
        try {
            val used = JSONObject(planJson).optJSONArray("user_fonts") ?: return
            if (used.length() == 0) return
            val fontsDir = File(dir, "style/fonts").also { if (!it.isDirectory) it.mkdirs() }
            val cssFile = File(dir, "style/user-fonts.css")
            val css = StringBuilder(if (cssFile.isFile) cssFile.readText(Charsets.UTF_8) else "")
            var copied = 0
            for (i in 0 until used.length()) {
                val o = used.optJSONObject(i) ?: continue
                val file = o.optString("file")
                val name = o.optString("name")
                if (file.isBlank() || name.isBlank()) continue
                val src = File(FontStore.dir(context), file)
                if (!src.isFile) { Log.w(TAG, "用户字体源文件没了：$file"); continue }
                FileOutputStream(File(fontsDir, file)).use { os ->
                    src.inputStream().use { it.copyTo(os, 64 * 1024) }
                }
                // 模板自带的（如玄藏体）已经在 css 里，别重复写
                if (css.contains("font-family:'$name'")) { copied++; continue }
                val fmt = when (file.substringAfterLast('.').lowercase()) {
                    "ttf" -> "truetype"; "otf" -> "opentype"; "woff" -> "woff"; else -> "woff2"
                }
                css.append("@font-face{font-family:'").append(name)
                    .append("';src:url(\"fonts/").append(file)
                    .append("\") format(\"").append(fmt)
                    .append("\");font-weight:400;font-style:normal;font-display:swap}\n")
                copied++
            }
            if (copied > 0) cssFile.writeText(css.toString(), Charsets.UTF_8)
            Log.i(TAG, "携带用户字体：$copied 支")
        } catch (t: Throwable) {
            Log.w(TAG, "携带用户字体失败（书照出）", t)
        }
    }

    /**
     * ★★ 2026-10-12（F164）：**写真改由 Kotlin 做**（老路子是浏览器编码后过桥，慢且笨）。
     *
     * 为什么非改不可（实测，见 `tools/_line_check.mjs`，90 张 12MP）：
     *   老路子每张要做四件事 —— ① 浏览器**再解一遍 12MP 原图**（48MB 位图）
     *   ② canvas 重画 + `toDataURL('image/jpeg',0.86)`（**实测 6.6 s / 90 张，桌面**；
     *      手机上慢一个量级）③ 生成 ~400KB 的 **base64 字符串过 JNI 桥**
     *      （90 张共 **37.5 MB** 字符串）④ Kotlin 再 `Base64.decode` 一遍。
     *   ⇒ 出书总耗时里 90% 是这几步，而且**每一步都在跟设备内存赛跑**。
     *
     * 改成一个同步桥调用，Kotlin 侧直接做（与电脑端同一档参数：长边 ≤1280、JPEG Q86）：
     *   · `inSampleSize` 先降采样（12MP ⇒ 只解 1/4，**位图 48MB → 12MB**）
     *   · 按 EXIF 方向**转正**（浏览器会转、BitmapFactory 不会，不补就歪）
     *   · `createScaledBitmap` 到成品尺寸 → `compress(JPEG, 86)` 落盘
     *   · 落盘后**验一次真解不开**就删掉并报失败（记名，不把坏文件留在书里）
     *
     * @param srcPath 预览域里的相对路径：`/picked/<文件名>` 或 `/books/<书>/assets/photos/<文件名>`
     * @return true = 写成了；false = 这张失败（调用方记名，不中断整本）
     */
    fun writeArtwork(
        context: Context, dir: File, fileName: String, srcPath: String,
        targetW: Int, targetH: Int,
    ): Boolean {
        if (targetW <= 0 || targetH <= 0) {
            Log.w(TAG, "成品尺寸不对：${targetW}x$targetH（$srcPath）")
            return false
        }
        return try {
            val photos = File(dir, "assets/photos").also { if (!it.isDirectory) it.mkdirs() }
            val dst = File(photos, safeFileName(fileName))
            // 每次都要**新的流**（要读两遍：先量尺寸、再解码）
            fun open(): InputStream? = openSource(context, srcPath)

            // ① 只量尺寸（不解像素）
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            open()?.use { BitmapFactory.decodeStream(it, null, bounds) }
            val ow = bounds.outWidth
            val oh = bounds.outHeight
            if (ow <= 0 || oh <= 0) {
                Log.w(TAG, "量不出尺寸，跳过：$srcPath")
                return false
            }
            // ② EXIF 方向（浏览器显示 <img> 时会按它转，BitmapFactory 不转 ⇒ 必须在这补上）
            val orientation = exifOrientation(context, srcPath)
            val rotated = orientation == 6 || orientation == 8
            val vw = if (rotated) oh else ow        // 浏览器看到的（已转向的）尺寸
            val vh = if (rotated) ow else oh
            // ③ 采样率：解出来不超过成品的 2 倍（够缩放还省内存）
            var sample = 1
            while (vw / (sample * 2) >= targetW && vh / (sample * 2) >= targetH) sample *= 2
            val opts = BitmapFactory.Options().apply {
                inSampleSize = sample
                inPreferredConfig = Bitmap.Config.ARGB_8888   // 要重压缩，RGB_565 会掉色
            }
            var bmp = open()?.use { BitmapFactory.decodeStream(it, null, opts) }
            ?: run {
                Log.w(TAG, "解不开，跳过：$srcPath")
                return false
            }
            // ④ 转向
            if (rotated) {
                val m = android.graphics.Matrix().apply {
                    postRotate(if (orientation == 6) 90f else 270f)
                }
                val r = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
                if (r !== bmp) { bmp.recycle(); bmp = r }
            }
            // ⑤ 缩到成品尺寸
            if (bmp.width != targetW || bmp.height != targetH) {
                val s = Bitmap.createScaledBitmap(bmp, targetW, targetH, true)
                if (s !== bmp) { bmp.recycle(); bmp = s }
            }
            // ⑥ 压 JPEG Q86（与电脑端同一档）
            val ok = FileOutputStream(dst).use { os ->
                bmp.compress(Bitmap.CompressFormat.JPEG, 86, os)
            }
            bmp.recycle()
            if (!ok) {
                runCatching { dst.delete() }
                return false
            }
            // ⑦ 落盘后验一次：真解不开就删掉并报失败（记名），别把坏文件留在书里
            if (probeOk(dst)) true else {
                Log.w(TAG, "写完却解不开，删掉：$fileName")
                runCatching { dst.delete() }
                false
            }
        } catch (t: Throwable) {
            Log.w(TAG, "写真失败：$srcPath", t)
            false
        }
    }

    /** 只量尺寸、不解像素 —— 验"这到底是不是一张能解开的图"。 */
    private fun probeOk(file: File): Boolean = try {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        FileInputStream(file).use { BitmapFactory.decodeStream(it, null, o) }
        o.outWidth > 0 && o.outHeight > 0
    } catch (t: Throwable) {
        Log.w(TAG, "验图失败：${file.name}", t)
        false
    }

    /**
     * 预览域的相对路径 → 真输入流。
     * · `/picked/<文件名>`  ⇒ App 私有目录里用户选的那张
     * · `/books/<书>/assets/photos/<文件名>` ⇒ 内置素材（assets）
     * ⚠ 名字在 URL 里是 `Uri.encode` 过的 ⇒ 先 `Uri.decode` 再找文件。
     */
    private fun openSource(context: Context, srcPath: String): InputStream? {
        val p = Uri.decode(srcPath)
        return when {
            p.startsWith("/picked/") -> {
                val f = File(PhotoStore.pickedDir(context), p.removePrefix("/picked/"))
                if (f.isFile) f.inputStream() else null
            }
            p.startsWith("/books/") -> {
                val rel = p.removePrefix("/books/")     // <bookKey>/assets/photos/<文件名>
                if (rel.contains("..")) null            // 防目录穿越
                else runCatching { context.assets.open("books/$rel") }.getOrNull()
            }
            else -> null
        }
    }

    /** EXIF 方向（1=正常、6=顺90、8=逆90…）。读不到就当正常 —— 不因它丢照片。 */
    private fun exifOrientation(context: Context, srcPath: String): Int = try {
        openSource(context, srcPath)?.use { ins ->
            androidx.exifinterface.media.ExifInterface(ins)
                .getAttributeInt(
                    androidx.exifinterface.media.ExifInterface.TAG_ORIENTATION,
                    androidx.exifinterface.media.ExifInterface.ORIENTATION_NORMAL
                )
        } ?: androidx.exifinterface.media.ExifInterface.ORIENTATION_NORMAL
    } catch (t: Throwable) {
        Log.w(TAG, "读 EXIF 失败（当正常）：$srcPath", t)
        androidx.exifinterface.media.ExifInterface.ORIENTATION_NORMAL
    }

    // ------------------------------------------------------------------
    // M5-2：导出到用户选的目录（SAF 目录树）
    // ------------------------------------------------------------------

    /**
     * 把整本书**复制一份**到用户选的目录里。
     *
     * ★ 为什么书本体留在 App 私有目录、再复制一份出去：
     *   书要能上书架、能翻，就必须在 `files/books/` 下；
     *   而"能拿到手"（给别人、备份）要落到用户自己的目录 ⇒ 两个都要。
     *   （旧工程 B6.3 就是这么定的，他当时的要求是"输出文件夹需要选择目录"。）
     *
     * @return 一句给界面看的结果（成功或失败原因）
     */
    fun exportTo(context: Context, tree: Uri, srcDir: File, dirLabel: String): String {
        if (!srcDir.isDirectory) return "书还没生成"
        return try {
            val rootDoc = DocumentsContract.buildDocumentUriUsingTree(
                tree, DocumentsContract.getTreeDocumentId(tree)
            )
            val n = copyTree(context, srcDir, rootDoc)
            "已导出 $n 个文件到「$dirLabel」"
        } catch (t: Throwable) {
            Log.e(TAG, "导出失败", t)
            "导出失败：${t.message ?: t.javaClass.simpleName}"
        }
    }

    private fun copyTree(context: Context, src: File, dest: Uri): Int {
        val resolver = context.contentResolver
        val self = DocumentsContract.createDocument(
            resolver, dest, "vnd.android.document/directory", src.name
        ) ?: dest
        var n = 0
        for (f in (src.listFiles() ?: emptyArray())) {
            if (f.isDirectory) {
                n += copyTree(context, f, self)
            } else {
                val out = DocumentsContract.createDocument(
                    resolver, self, mimeOf(f.name), f.name
                ) ?: continue
                resolver.openOutputStream(out)?.use { os ->
                    f.inputStream().use { ins -> ins.copyTo(os, 64 * 1024) }
                    n++
                }
            }
        }
        return n
    }

    // ------------------------------------------------------------------

    private fun copyAssetDir(context: Context, assetDir: String, dest: File) {
        val kids = context.assets.list(assetDir).orEmpty()
        if (kids.isEmpty()) return
        if (!dest.isDirectory) dest.mkdirs()
        for (n in kids) {
            val path = "$assetDir/$n"
            val sub = context.assets.list(path).orEmpty()
            if (sub.isEmpty()) copyAssetFile(context, path, File(dest, n))
            else copyAssetDir(context, path, File(dest, n))
        }
    }

    private fun copyAssetFile(context: Context, assetPath: String, dest: File) {
        try {
            dest.parentFile?.mkdirs()
            context.assets.open(assetPath).use { ins ->
                FileOutputStream(dest).use { os -> ins.copyTo(os, 64 * 1024) }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "拷不了 $assetPath", t)
        }
    }

    private fun safeId(s: String): String = cleanName(s, 60, newBookId())

    private fun safeFileName(s: String): String = cleanName(s, 120, "photo.jpg")
}
