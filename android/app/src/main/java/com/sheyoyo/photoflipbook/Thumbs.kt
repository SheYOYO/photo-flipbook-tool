package com.sheyoyo.photoflipbook

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import android.util.LruCache
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream

/**
 * 缩略图仓库 —— **原生解码 + 降采样 + 内存缓存 + 磁盘缓存 + 并行**。
 *
 * 为什么要它（清单第 3 节「性能打底」）
 * ---------------------------------------------------------------------------
 * 书里那批照片实测单张有 **750×1692**（见 `book-plan.json` 的 `size`）。
 * 一张 ARGB_8888 解码出来就是 `750×1692×4 ≈ 5MB` —— 一屏放 12 张就是 60MB，
 * 必卡、必被系统杀。所以：
 *
 *   · **降采样**：`inSampleSize` 让解码结果不超过需求的像素尺寸（缩略图只要几百 px）
 *   · **RGB_565**：缩略图不需要 alpha（照片全是 jpg）⇒ **内存减半**
 *   · **LruCache 按字节算**：按"占多少字节"淘汰，而不是按"几张"（大图小图差别太大）
 *   · **后台线程解码**：`Dispatchers.IO`，主线程只贴图
 *
 * ★★ F165（2026-10-12）：他报「**工作台加载几十张图片的时候，加载很慢**」。
 *   诊断坐实（读代码 + 量化）：老路子对**每张**照片**打开两遍流** ——
 *   第一遍 `inJustDecodeBounds` 只量尺寸、第二遍再 `open()` 一次真解码；
 *   且 `LruCache` 是**内存态**、进程一退就空 ⇒ **每次进工作台都全量重解码**。
 *   90 张 12MP ⇒ 180 次完整 IO，手机上就是"几十张很慢"。
 *
 *   两件事一起治（他 2026-10-12 拍板：方案一 + 方案二都做）：
 *
 *   · **方案一（一次解码）**：量尺寸时把字节**整个读进内存缓冲**，真解码**复用同一块缓冲**
 *     ⇒ **每张只开一次流**，IO 直接减半（90 张从 180 次降到 90 次）。
 *   · **方案二（磁盘缓存）**：解出的缩略图**写一份 200px 小图**到 `picked/.thumbs/`
 *     ⇒ **第二次起进工作台只读小文件**，原图再也不碰（除非照片变了）。
 *
 *   ⚠ **会不会影响体验**（他先问的）：不会，理由三条 ——
 *     ① UI 层**零变化**：调用点还是 `rememberThumb(key, targetPx, open)`；
 *     ② 失效校验用 **`文件名 + 文件长度 + 最后修改时间`** 三件套（[stamp]）⇒
 *        照片被替换/删改 ⇒ 键变 ⇒ 读不到缓存 ⇒ **自动回退解码原图** ⇒ 永远拿到当前真图；
 *     ③ 磁盘写失败只是"下次不快"，**不影响这一次显示**。
 *   ⚠ 内置素材（assets）**不走磁盘**：assets 随包不变，且没有"文件"可作指纹
 *     ⇒ [stamp] 返回 null 时自动只走内存缓存。
 *   ⚠ `.thumbs/` 放在 `picked/` 里 ⇒ `PhotoStore.clearPicked` 一并清掉（见该函数的 F165 段）。
 *
 * ⚠ 不引入图片库（Coil/Glide）是有意的：体积为零，且降采样参数完全自己说了算。
 */
object Thumbs {
    private const val TAG = "Thumbs"

    /** 按**字节**算容量的内存缓存（24MB —— 横屏一屏的缩略图够放好几轮）。 */
    private val cache = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }

    /** 磁盘缩略图目录（懒建 —— 第一次用到时才 mkdirs）。 */
    private var thumbDir: File? = null

    private fun dir(context: Context?): File? {
        if (thumbDir == null) {
            val base = context?.getExternalFilesDir(null) ?: context?.filesDir ?: return null
            thumbDir = File(base, "picked/.thumbs")
        }
        return thumbDir
    }

    /** 已经解好的（同步、无阻塞）—— 列表快速滚动时靠它避免闪烁。 */
    fun peek(key: String): Bitmap? = cache.get(key)

    /**
     * 一份「这张照片现在是什么」的指纹（磁盘缓存的失效校验）。
     *
     * 三件套：**文件长度** + **最后修改时间**（文件名已在 `key` 里）。
     * 照片被覆盖替换（重新导入同名文件）⇒ 长度或时间必变 ⇒ 键失效。
     * ⚠ 内置素材 / 读不到文件 ⇒ 返回 null ⇒ **该键不走磁盘缓存**（只走内存）。
     */
    fun stamp(file: File?): String? = try {
        if (file == null || !file.isFile) null
        else "${file.length()}:${file.lastModified()}"
    } catch (t: Throwable) {
        Log.w(TAG, "取指纹失败", t)
        null
    }

    /**
     * 磁盘缓存的**完整路径**（含指纹签名）。
     *
     * @param stamp [stamp] 的结果；**null 表示不走磁盘**（内置素材）。
     * @return 路径；拿不到目录也返回 null（⇒ 自动退回只走内存）。
     */
    fun diskPath(context: Context?, key: String, stamp: String?): String? {
        if (stamp == null) return null
        val d = dir(context) ?: return null
        // 文件名里只留安全字符（`picked/` 前缀的 `/` 换成 `_`），再拼一段指纹签名
        val safe = key.replace(Regex("[^A-Za-z0-9._-]"), "_").take(120)
        val sig = (key + "|" + stamp).hashCode().toLong().and(0xFFFFFFFFL).toString(16)
        return File(d, "$safe-$sig.jpg").absolutePath
    }

    /** 读磁盘缓存（不存在 / 读坏 ⇒ null，回退解码原图）。命中也顺手放进内存缓存。 */
    fun loadFromDisk(path: String, key: String): Bitmap? {
        return try {
            val f = File(path)
            if (!f.isFile || f.length() <= 0L) return null
            val bmp = BitmapFactory.decodeFile(f.absolutePath) ?: return null
            cache.put(key, bmp)
            bmp
        } catch (t: Throwable) {
            Log.w(TAG, "读磁盘缓存失败：$path", t)
            null
        }
    }

    /** 写真到磁盘（失败只影响"下次快不快"，**不影响这一次显示**）。 */
    fun saveToDisk(path: String, bmp: Bitmap) {
        try {
            val f = File(path)
            f.parentFile?.mkdirs()
            FileOutputStream(f).use { os -> bmp.compress(Bitmap.CompressFormat.JPEG, 82, os) }
        } catch (t: Throwable) {
            Log.w(TAG, "写真失败：$path", t)
        }
    }

    /**
     * 解码一张不超过 [targetPx] 的缩略图。
     *
     * [open] 每次调用都要返回**新的** InputStream。
     *
     * ★ F165 方案一：第一遍量尺寸时**把字节读进内存**，第二遍复用这块缓冲
     *   ⇒ **只开一次流**。内存代价：单张 12MP ≈ 4~10MB 的 `ByteArray`，
     *   **用完即弃**（不进缓存、不解引用保留）。
     */
    fun decode(key: String, targetPx: Int, open: () -> InputStream?): Bitmap? {
        cache.get(key)?.let { return it }
        return try {
            // ① 只开一次流，把字节读进内存
            val bytes = open()?.use { ins ->
                val bos = ByteArrayOutputStream(64 * 1024)
                ins.copyTo(bos, 256 * 1024)
                bos.toByteArray()
            }
            if (bytes == null || bytes.isEmpty()) {
                Log.w(TAG, "读不到字节：$key")
                return null
            }
            // ② 用同一块缓冲量尺寸（不解像素，只走文件头）
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
                Log.w(TAG, "尺寸不对（$key）：${bounds.outWidth}x${bounds.outHeight}")
                return null
            }
            // ③ 算采样率：结果不超过 targetPx 的 2 倍（留点余量给不同 DPR 的屏）
            var sample = 1
            while (bounds.outWidth / (sample * 2) >= targetPx && bounds.outHeight / (sample * 2) >= targetPx) {
                sample *= 2
            }
            // ④ 真解码：**复用同一块缓冲**，不再第二次开流
            val opts = BitmapFactory.Options().apply {
                inSampleSize = sample
                inPreferredConfig = Bitmap.Config.RGB_565
            }
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
            if (bmp == null) {
                Log.w(TAG, "解码返回空：$key")
                null
            } else {
                cache.put(key, bmp)
                bmp
            }
        } catch (t: Throwable) {
            Log.w(TAG, "解码失败：$key", t)
            null
        }
    }
}

/**
 * Compose 里拿缩略图：**内存缓存 → 磁盘缓存 → 解码原图**三级，都没命中才真解码。
 *
 * ⚠ 首次没命中时先给 `null`（界面显示占位底色）—— 这样列表滚动**不会卡**：
 *   主线程一帧都不等 IO（三级全在 `Dispatchers.IO` 上跑）。
 *
 * @param stamp [Thumbs.stamp] 的结果（内置素材传 null ⇒ 不走磁盘缓存）。
 */
@Composable
fun rememberThumb(
    key: String?,
    targetPx: Int,
    open: (() -> InputStream?)?,
    stamp: String? = null,
): ImageBitmap? {
    val ctx = LocalContext.current
    var bmp by remember(key) { mutableStateOf(if (key == null) null else Thumbs.peek(key)) }
    LaunchedEffect(key) {
        if (key == null || open == null) {
            bmp = null
            return@LaunchedEffect
        }
        if (bmp != null) return@LaunchedEffect
        bmp = withContext(Dispatchers.IO) {
            // ② 方案二：先试磁盘（第二次起进工作台走这条 ⇒ 秒开）
            val path = Thumbs.diskPath(ctx, key, stamp)
            val hit = path?.let { Thumbs.loadFromDisk(it, key) }
            // ③ 都没有才解码原图；解到了顺手写真，让**下一次**快
            hit ?: Thumbs.decode(key, targetPx, open)?.also { b ->
                if (path != null) Thumbs.saveToDisk(path, b)
            }
        }
    }
    return bmp?.asImageBitmap()
}
