package com.sheyoyo.photoflipbook

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Base64
import android.util.Log
import java.io.File
import java.io.FileOutputStream

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

    /** 模板书：内置演示书的样式/运行时就是链① 那一套（我们一个字没改）。 */
    private const val TEMPLATE = "books/book1"
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

    /** 写真的一张照片（`data:image/jpeg;base64,...`）。单张失败返回 false，不中断整本。 */
    fun addPhoto(dir: File, fileName: String, dataUrl: String): Boolean {
        return try {
            val comma = dataUrl.indexOf(',')
            if (comma < 0) return false
            val bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT)
            val photos = File(dir, "assets/photos").also { if (!it.isDirectory) it.mkdirs() }
            FileOutputStream(File(photos, safeFileName(fileName))).use { it.write(bytes) }
            true
        } catch (t: Throwable) {
            Log.w(TAG, "这张写真失败：$fileName", t)
            false
        }
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
