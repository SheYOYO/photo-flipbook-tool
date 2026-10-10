package com.sheyoyo.photoflipbook

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream

/**
 * 书库（佘先生 2026-10-07 要的）—— **一个与书架绑定的文件夹**。
 *
 * 他原话：「新建一个和书架绑定的文件夹，命名为 downloads，输出的地址默认为此文件夹，
 * 但是我可以手动更改，就是说只要放在那个 downloads 的文件夹的文件，打开软件就可以看到和查看」。
 *
 * ⇒ 一个文件夹同时干三件事：
 *   1. **书架自动扫它** —— 里面每本（带 `index.html` 的子目录）都出现在书架上
 *   2. **出书默认导出到它** —— 不用每次挑目录
 *   3. **手动可以改** —— 改的是"输出目录"；书库本身只绑一次
 *
 * ★ 为什么用 SAF（系统目录选择器）而不是直接读写 `/sdcard/Download`
 *   Android 11+ 的分区存储：App **拿不到**公共目录里非媒体文件（`.html` 就不是媒体）
 *   的原始路径 —— 想要就得申请 `MANAGE_EXTERNAL_STORAGE`（"所有文件访问"，得去系统设置里开）。
 *   SAF 的做法是**用户选一次目录、授权长期有效**，之后我们用 `DocumentsContract` 正常读写。
 *   零敏感权限、也不上架（上架才需要担心 Play 对这套的限制）。
 *
 * ★ 为什么"点开时才导入到私有目录"
 *   书页要靠 `WebViewAssetLoader` 提供 URL（书里 30 个文件全是**相对路径**）。
 *   给 SAF 目录写一套 handler 也能做，但一本书要按路径逐层查 docId，慢且脆。
 *   书的体积才几 MB —— **要用的时候整本拷进私有目录**，读书那条路一行都不用改。
 *   ⇒ 顺带把"卸载丢书"也治了：真正躺在书库里，重装后再扫一遍就都回来了。
 */
object LibraryStore {
    private const val TAG = "LibraryStore"
    private const val PREF = "library"
    private const val K_LIB_URI = "lib_tree_uri"
    private const val K_LIB_NAME = "lib_tree_name"
    private const val K_OUT_URI = "out_tree_uri"
    private const val K_OUT_NAME = "out_tree_name"

    private const val MIME_DIR = DocumentsContract.Document.MIME_TYPE_DIR

    // ------------------------------------------------------------------
    // 绑定信息
    // ------------------------------------------------------------------

    /** 书库目录（书架绑定的那个）。没绑过返回 null。 */
    fun libraryTree(context: Context): Uri? = readUri(context, K_LIB_URI)

    fun libraryName(context: Context): String =
        prefs(context).getString(K_LIB_NAME, "") ?: ""

    fun setLibrary(context: Context, uri: Uri?, label: String) =
        write(context, K_LIB_URI, uri, K_LIB_NAME, label)

    /** 输出目录：**默认就是书库**（他要的），手动改过就以改的为准。 */
    fun outputTree(context: Context): Uri? = readUri(context, K_OUT_URI) ?: libraryTree(context)

    fun outputName(context: Context): String =
        if (readUri(context, K_OUT_URI) != null) prefs(context).getString(K_OUT_NAME, "") ?: ""
        else libraryName(context)

    fun setOutput(context: Context, uri: Uri?, label: String) =
        write(context, K_OUT_URI, uri, K_OUT_NAME, label)

    /** 清掉"手动改的输出目录"⇒ 回到默认（= 书库）。 */
    fun resetOutput(context: Context) = setOutput(context, null, "")

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREF, Context.MODE_PRIVATE)

    private fun readUri(context: Context, key: String): Uri? =
        prefs(context).getString(key, null)?.let {
            try {
                Uri.parse(it)
            } catch (t: Throwable) {
                Log.w(TAG, "存着的 $key 解不开", t); null
            }
        }

    private fun write(context: Context, uriKey: String, uri: Uri?, nameKey: String, label: String) {
        prefs(context).edit().apply {
            if (uri == null) remove(uriKey) else putString(uriKey, uri.toString())
            putString(nameKey, label)
        }.apply()
    }

    // ------------------------------------------------------------------
    // 扫书库（后台线程跑）
    // ------------------------------------------------------------------

    /** 书库里的一本书 —— 只带"能列出来"的信息；封面按需再读。 */
    data class ExtBook(
        val dirName: String,
        val dirDocId: String,
        val title: String,
        val subtitle: String,
        val photoCount: Int,
        val indexSize: Long,
        /** 封面在图里的相对路径（`assets/photos/xx.jpg`）—— 书架缩略图用；取不到就是 null。 */
        val coverRel: String?,
    )

    /**
     * 列书库里的书：**每个带 `index.html` 的子目录算一本**（与私有目录同一套规则）。
     * 书名优先级也照旧：`book-plan.json` 的 `title` → 目录名。
     */
    fun scan(context: Context, tree: Uri): List<ExtBook> {
        val out = ArrayList<ExtBook>()
        try {
            val rootId = DocumentsContract.getTreeDocumentId(tree)
            // ⚠ 用 Log.w 不用 Log.i —— 这台 ROM 默认不输出 Info 级日志（我白抓了两轮空日志）
            val roots = children(context, tree, rootId)
            // ★★ 而且这台 ROM 干脆把应用日志掐到只剩 4 行（连 Log.w 都看不到）⇒ 诊断信息
            //    一律**同时**落到私有目录的 diag.txt，用 `run-as … cat` 读。这招才抓得到真凶。
            diag(
                context, "扫书库 rootId=$rootId",
                "  根子项 " + roots.size + " 个：" + roots.joinToString("\n    ") {
                    "[${it.second}] docId=${it.first} isDir=${it.third}"
                }
            )
            for ((docId, rawName, isDir) in roots) {
                val name = nameOf(docId, rawName)
                if (!isDir || name.isBlank()) continue
                val kids = children(context, tree, docId).map { Triple(it.first, nameOf(it.first, it.second), it.third) }
                val hasIndex = kids.any { it.second == "index.html" && !it.third }
                Log.w(TAG, "  看 $name（docId=$docId）子项=" + kids.map { it.second } + " 有index=$hasIndex")
                diag(context, "  看 $name（docId=$docId）子项=" + kids.map {
                    "[${it.second}] dir=${it.third} docId=${it.first}"
                } + " 有index=$hasIndex")
                if (!hasIndex) continue

                // ★★★ **真能打开才收录**（幽灵书过滤）。
                //  这台 ROM 的 provider 有个恶心特性：**删掉的目录不会从它的元数据缓存里消失**。
                //  实测：磁盘上只剩 1 本书，provider 还能返回 14 个 docId（msd:176…msd:586），
                //  每个都"列得出" index.html，实际一读 **0 个字节**。
                //  不挡的话，书架上会挂十几本点开就"网页无法打开"的假书 ——
                //  比不显示更糟（用户会以为书库坏了）。
                //  判据：**真去读 index.html 的头几个字节**，读不出 ⇒ 这本书不存在。
                val idxId0 = kids.first { it.second == "index.html" && !it.third }.first
                if (!readable(context, tree, idxId0)) {
                    diag(context, "  跳过【$name】：读不出 index.html 的内容 ⇒ 幽灵书（provider 缓存里的僵尸目录）")
                    continue
                }
                val indexSize = kids.firstOrNull { it.second == "index.html" }?.let { childSize(context, tree, it.first) } ?: 0L
                var title = name
                var subtitle = ""
                var photos = 0
                val planId = kids.firstOrNull { it.second == "book-plan.json" && !it.third }?.first
                if (planId != null) {
                    try {
                        readText(context, tree, planId)?.let { txt ->
                            val o = JSONObject(txt)
                            title = o.optString("title", title).ifBlank { title }
                            subtitle = o.optString("subtitle", "")
                            photos = o.optJSONArray("photos")?.length() ?: 0
                        }
                    } catch (t: Throwable) {
                        Log.w(TAG, "【$name】的 book-plan.json 读不了，退回目录名", t)
                    }
                }
                // plan 里没有 photos 字段时数一下目录（与私有目录的退路一致）
                // ★ 顺便把**封面**找出来（`assets/photos/` 里的第一张）—— 书架缩略图要用。
                var coverRel: String? = null
                val assets = kids.firstOrNull { it.second == "assets" && it.third }?.first
                val photosDir = assets?.let { a ->
                    children(context, tree, a).firstOrNull { it.second == "photos" && it.third }?.first
                }
                if (photosDir != null) {
                    val imgs = children(context, tree, photosDir).filter { !it.third && isImage(it.second) }
                    if (photos == 0) photos = imgs.size
                    coverRel = imgs.minByOrNull { it.second }?.second?.let { "assets/photos/$it" }
                }
                Log.w(TAG, "  收录：dir=$name photos=$photos cover=$coverRel")
                diag(context, "  收录 dir=$name（docId=$docId）photos=$photos cover=$coverRel")
                // ★★ 必须用具名参数！字段声明顺序是 dirName→dirDocId（名字在前），
                //    而这里两个都是"能当目录名用的字符串"，按位置传极易对调 ——
                //    我就踩了：写成 ExtBook(docId, name, …) ⇒ dirName 拿到的是 `msd:176`
                //    这种内部 id ⇒ 导入私有目录时落成 `msd_176`，书架上凭空多出一本假书。
                out += ExtBook(
                    dirName = name,
                    dirDocId = docId,
                    title = title,
                    subtitle = subtitle,
                    photoCount = photos,
                    indexSize = indexSize,
                    coverRel = coverRel,
                )
            }
        } catch (t: Throwable) {
            Log.e(TAG, "扫书库失败", t)
        }
        Log.w(TAG, "扫书库结束：收藏 " + out.size + " 本 -> " + out.map { it.dirName })
        diag(context, "扫书库结束：收藏 " + out.size + " 本 -> " + out.joinToString(" | ") { it.dirName })
        return out
    }

    /**
     * 把诊断行写到 `filesDir/diag.txt`。
     *
     * ★ 为什么不用 logcat：这台 vivo ROM 上 `logcat -d` 只回 4 行（应用日志被系统掐掉，
     *   连 `Log.w` 都看不到）⇒ 我连抓两轮都是空的，白排查半天。真凶是靠 `run-as` 读这个
     *   文件才看见的。**排查这台机子的任何 SAF/渲染问题，都走这里，别再抓 logcat。**
     */
    private fun diag(context: Context, vararg lines: String) {
        try {
            val f = File(context.filesDir, "diag.txt")
            f.appendText(lines.joinToString("") { "[" + System.currentTimeMillis() + "] $it\n" })
        } catch (t: Throwable) {
            Log.w(TAG, "diag 写不了", t)
        }
    }

    /** 清空诊断文件（每次验收前先清，免得旧行混进来）。 */
    fun clearDiag(context: Context) {
        try { File(context.filesDir, "diag.txt").delete() } catch (t: Throwable) { /* 忽略 */ }
    }

    /**
     * 打开书库里某本书的第 [relPath] 个文件（相对书目录，如 `assets/photos/01-x.jpg`）。
     * 封面缩略图就是靠它**按需**取的（不做预先索引，省事也够快）。
     */
    fun openRel(context: Context, tree: Uri, dirDocId: String, relPath: String): InputStream? {
        return try {
            var cur = dirDocId
            val parts = relPath.split('/').filter { it.isNotBlank() }
            for ((i, seg) in parts.withIndex()) {
                val hit = children(context, tree, cur)
                    .firstOrNull { nameOf(it.first, it.second) == seg }
                    ?: return null
                if (i < parts.size - 1) {
                    if (!hit.third) return null
                    cur = hit.first
                } else {
                    return context.contentResolver.openInputStream(docUri(tree, hit.first))
                }
            }
            null
        } catch (t: Throwable) {
            Log.w(TAG, "读书库里的 $relPath 失败", t)
            null
        }
    }

    /**
     * 把书库里的一本书**整本拷进私有目录**（`files/books/<dirName>`）。
     *
     * 已经有一份**完整**（`index.html` 在）且大小与书库那份一致 ⇒ 认为已导入过，直接返回
     * （省一次拷贝；书 6MB 上下，拷一次一秒多）。
     * 返回落地后的目录；失败返回 null。
     *
     * ★★ 拷贝必须**先落到 `.tmp` 临时目录、成功后再改名**成真名。
     *    这是个真踩过的坑：原先 `deleteRecursively()` 之后**直接往真目录拷** ——
     *    中途被打断（用户切走、进程被杀）就留下一本**半本书**
     *    （我见过只剩 `assets/style/vendor`、顶层 `index.html` 还没拷到的）。
     *    而书架只按目录名判断"这本在不在"，半本书点开就是「网页无法打开」——
     *    **比"没这本书"坏得多**，还会被误判成"书库坏了"。
     *    改成临时目录后：失败只留一个 `.tmp` 垃圾（下次覆盖），真名目录要么是上一本
     *    完整的、要么是新拷完整的，**不存在半本**。
     */
    fun importBook(context: Context, tree: Uri, dirDocId: String, dirName: String,
                   destRoot: File): File? {
        val dest = File(destRoot, safeName(dirName))
        return try {
            val localIndex = File(dest, "index.html")
            if (localIndex.isFile) {
                val idxId = children(context, tree, dirDocId)
                    .firstOrNull { it.second == "index.html" && !it.third }?.first
                val remote = if (idxId != null) childSize(context, tree, idxId) else 0L
                if (remote > 0 && remote == localIndex.length()) {
                    diag(context, "importBook【$dirName】本地已完整（index.html $remote 字节），跳过")
                    return dest
                }
            }
            // 不完整（或没导过）⇒ 拷到 .tmp，**成功后才改名顶上**
            val tmp = File(destRoot, safeName(dirName) + ".tmp")
            if (tmp.exists()) tmp.deleteRecursively()
            if (!tmp.mkdirs()) { diag(context, "importBook【$dirName】建临时目录失败"); return null }
            val n = copyTree(context, tree, dirDocId, tmp)
            // ★ 拷完必须自检 —— **而且不能只查 index.html**：
            //    index.html 在、照片一张都没有的书，开出来是满屏破图（比拷失败更坑：
            //    界面看着"书在"，用户翻才发现坏）。
            //    我就踩了：`openInputStream` 返回 null 时静默跳过（见 copyTree 里的注释），
            //    照片全丢，自检只查 index.html 就放行 ⇒ "图全加载 0/15"。
            val photos = File(tmp, "assets/photos")
            val photoCount = photos.listFiles()?.count { it.isFile } ?: 0
            if (!File(tmp, "index.html").isFile) {
                tmp.deleteRecursively()
                diag(context, "importBook【$dirName】拷了 $n 个文件但没有 index.html ⇒ 丢弃，不留半本书")
                return null
            }
            if (photoCount == 0) {
                tmp.deleteRecursively()
                diag(context, "importBook【$dirName】拷了 $n 个文件但**照片一张都没有**（$photoCount）⇒ 丢弃")
                return null
            }
            if (dest.exists()) dest.deleteRecursively()
            if (!tmp.renameTo(dest)) {
                // 改名失败（少见：目标被占/跨卷）⇒ 退回"再删一次真目录"重试
                dest.deleteRecursively()
                if (!tmp.renameTo(dest)) {
                    tmp.deleteRecursively()
                    diag(context, "importBook【$dirName】临时目录改名失败，放弃")
                    return null
                }
            }
            Log.i(TAG, "【$dirName】导入完成：$n 个文件 → ${dest.absolutePath}")
            diag(context, "importBook【$dirName】导入完成：$n 个文件 -> ${dest.name}")
            dest
        } catch (t: Throwable) {
            Log.e(TAG, "导入书库里的书失败", t)
            diag(context, "importBook【$dirName】失败：${t.javaClass.simpleName} ${t.message}")
            null
        }
    }

    /** 就地删除书库里的一本书（书架长按删「书库」里的书时用）。 */
    fun deleteFromLibrary(context: Context, tree: Uri, dirDocId: String): Boolean = try {
        DocumentsContract.deleteDocument(context.contentResolver, docUri(tree, dirDocId))
    } catch (t: Throwable) {
        Log.w(TAG, "删书库里的书失败", t); false
    }

    // ------------------------------------------------------------------
    // SAF 底层（用 framework 的 DocumentsContract —— 手工打包没有 AndroidX 的 DocumentFile）
    // ------------------------------------------------------------------

    private fun docUri(tree: Uri, docId: String): Uri =
        DocumentsContract.buildDocumentUriUsingTree(tree, docId)

    private fun childUri(tree: Uri, docId: String): Uri =
        DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)

    /** 列一个目录下的直接子项：`[(docId, 显示名, 是不是目录)]`。 */
    private fun children(context: Context, tree: Uri, docId: String): List<Triple<String, String, Boolean>> {
        val out = ArrayList<Triple<String, String, Boolean>>()
        try {
            // ★★ 必须按**列名**取列，不能按下标 —— provider 有权调整/补充它返回的列
            //    （投影只是"想要的"）。我一开始写 getString(0/1/2)，在这台 ROM 上字段全错位：
            //    目录名变成了 msd_176 这种内部 id ⇒ 书库里冒出一堆假书、点开还打不开。
            val cols = arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE
            )
            context.contentResolver.query(childUri(tree, docId), cols, null, null, null)?.use { c ->
                val iId = c.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
                val iName = c.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                val iMime = c.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
                if (iId < 0) {
                    Log.w(TAG, "这家的 provider 不给 document_id 列，列不了目录")
                    return@use
                }
                while (c.moveToNext()) {
                    val id = c.getString(iId) ?: continue
                    val name = if (iName >= 0) c.getString(iName) ?: "" else ""
                    val mime = if (iMime >= 0) c.getString(iMime) ?: "" else ""
                    out += Triple(id, name, mime == MIME_DIR)
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "列目录失败（权限可能失效）：$docId", t)
        }
        return out
    }

    private fun childSize(context: Context, tree: Uri, docId: String): Long = try {
        context.contentResolver.query(
            docUri(tree, docId),
            arrayOf(DocumentsContract.Document.COLUMN_SIZE), null, null, null
        )?.use { c ->
            val i = c.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE)
            if (i >= 0 && c.moveToFirst()) c.getLong(i) else 0L
        } ?: 0L
    } catch (t: Throwable) {
        0L
    }

    private fun readText(context: Context, tree: Uri, docId: String): String? =
        context.contentResolver.openInputStream(docUri(tree, docId))
            ?.bufferedReader()?.use { it.readText() }

    /**
     * 这个文档**真的读得出内容**吗（只读头 64 字节，够判断）。
     *
     * 存在的理由见 `scan()` 里"幽灵书过滤"那段：provider 会把已删除的目录留在缓存里，
     * 查询照样返回、`index.html` 照样列得出来，但真去读是 0 字节。
     * 只读头部、不 `readText()` 全文 —— 扫十几本书时省时间（HTML 十几 KB × N）。
     */
    private fun readable(context: Context, tree: Uri, docId: String): Boolean = try {
        context.contentResolver.openInputStream(docUri(tree, docId))?.use { ins ->
            val buf = ByteArray(64)
            val n = ins.read(buf)
            n > 0 && !(n == 64 && String(buf, Charsets.UTF_8).isBlank())
        } ?: false
    } catch (t: Throwable) {
        Log.w(TAG, "读 $docId 失败，当它不存在", t)
        false
    }

    /** 递归把一个 SAF 目录拷进本地目录，返回拷成功的文件数。 */
    private fun copyTree(context: Context, tree: Uri, docId: String, dest: File): Int {
        var n = 0
        if (!dest.isDirectory && !dest.mkdirs()) return 0
        for ((id, rawName, isDir) in children(context, tree, docId)) {
            // 名字先按nameOf 校正（见它的注释：这台 ROM 会拿原始路径当显示名），
            // 再清一遍危险字符（恶意/异常名字不许写到目录外）
            val safe = safeName(nameOf(id, rawName))
            if (isDir) {
                n += copyTree(context, tree, id, File(dest, safe))
            } else {
                try {
                    // ★★ `openInputStream` 失败时**返回 null 而不是抛异常** —— 必须判 null！
                    //    我漏了判：整段 `?.use{}` 静默跳过，照片一张没拷进来，
                    //    而 `copyTree` 返回的 0 让上层以为"没东西可拷"，
                    //    `importBook` 只查 index.html 在不在（它在）就放行
                    //    ⇒ 私有目录里一本书"照片目录是空的"，
                    //    翻开后满屏破图（实测"图全加载 0/15"）。
                    val ins = context.contentResolver.openInputStream(docUri(tree, id))
                    if (ins == null) {
                        diag(context, "    拷不到内容（openInputStream 返回 null）：$safe")
                        Log.w(TAG, "拷 $safe 失败：provider 返回 null")
                        continue
                    }
                    ins.use { input ->
                        FileOutputStream(File(dest, safe)).use { os -> input.copyTo(os, 64 * 1024) }
                        n++
                    }
                } catch (t: Throwable) {
                    Log.w(TAG, "拷 $safe 失败", t)
                    diag(context, "    拷 $safe 抛异常：${t.javaClass.simpleName}")
                }
            }
        }
        return n
    }

    private fun safeName(s: String): String = cleanName(s, 120, "unnamed")

    /**
     * 一个 SAF 项该落成什么文件名/目录名。
     *
     * ★★ 这是个**真踩到的坑**：vivo 这套 provider 会把**原始路径**当"显示名"返回，
     *    例如 `raw:/storage/emulated/0/Download/照片画册/用户书`。
     *    直接拿去当文件名，括号里的斜杠会被 `safeName` 换成下划线 ⇒
     *    落成 `raw__storage_emulated_0_Download_照片画册_用户书`；
     *    **连书目录里的 `index.html` 也会被改成 `raw__…_index.html`** ⇒ 书当然打不开
     *    （浏览器找的是 `index.html`）。
     *    ⇒ 显示名里出现 `/` 或 `:` 就不信它，改用 docId 的**最后一段**（那才是真名字）。
     */
    private fun nameOf(docId: String, displayName: String): String {
        val fromId = docId.substringAfterLast('/').substringAfterLast(':')
        val d = displayName.trim()
        if (d.isEmpty() || d.contains('/') || d.contains(':')) {
            return fromId.ifBlank { d }
        }
        return d
    }

    private fun isImage(n: String): Boolean {
        val l = n.lowercase()
        return l.endsWith(".jpg") || l.endsWith(".jpeg") || l.endsWith(".png") ||
               l.endsWith(".webp") || l.endsWith(".bmp")
    }
}
