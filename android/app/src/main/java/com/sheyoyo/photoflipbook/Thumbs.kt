package com.sheyoyo.photoflipbook

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
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.InputStream

/**
 * 缩略图仓库 —— **原生解码 + 降采样 + 内存缓存 + 并行**。
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
 * ⚠ 不引入图片库（Coil/Glide）是有意的：体积为零，且降采样参数完全自己说了算。
 */
object Thumbs {
    private const val TAG = "Thumbs"

    /** 按**字节**算容量的内存缓存（24MB —— 横屏一屏的缩略图够放好几轮）。 */
    private val cache = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }

    /** 已经解好的（同步、无阻塞）—— 列表快速滚动时靠它避免闪烁。 */
    fun peek(key: String): Bitmap? = cache.get(key)

    /**
     * 解码一张不超过 [targetPx] 的缩略图。
     *
     * [open] 每次调用都要返回**新的** InputStream —— 因为要读两遍
     * （第一遍 `inJustDecodeBounds` 只量尺寸，第二遍才真解码）。
     */
    fun decode(key: String, targetPx: Int, open: () -> InputStream?): Bitmap? {
        cache.get(key)?.let { return it }

        // ① 先只量尺寸（不解码像素，几乎不耗内存）
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        try {
            open()?.use { BitmapFactory.decodeStream(it, null, bounds) }
        } catch (t: Throwable) {
            Log.w(TAG, "量尺寸失败：$key", t)
            return null
        }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            Log.w(TAG, "尺寸不对（$key）：${bounds.outWidth}x${bounds.outHeight}")
            return null
        }

        // ② 算采样率：结果不超过 targetPx 的 2 倍（留点余量给不同 DPR 的屏）
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= targetPx && bounds.outHeight / (sample * 2) >= targetPx) {
            sample *= 2
        }

        val opts = BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.RGB_565
        }
        return try {
            val bmp = open()?.use { BitmapFactory.decodeStream(it, null, opts) }
            if (bmp == null) {
                Log.w(TAG, "解码返回空：$key")
            } else {
                cache.put(key, bmp)
            }
            bmp
        } catch (t: Throwable) {
            Log.w(TAG, "解码失败：$key", t)
            null
        }
    }
}

/**
 * Compose 里拿缩略图：缓存里有就同步给，没有就后台解码后自动重组。
 *
 * ⚠ 首次没命中时先给 `null`（界面显示占位底色）—— 这样列表滚动**不会卡**：
 *   主线程一帧都不等 IO。
 */
@Composable
fun rememberThumb(key: String?, targetPx: Int, open: (() -> InputStream?)?): ImageBitmap? {
    var bmp by remember(key) { mutableStateOf(if (key == null) null else Thumbs.peek(key)) }
    LaunchedEffect(key) {
        if (key == null || open == null) {
            bmp = null
            return@LaunchedEffect
        }
        if (bmp == null) {
            bmp = withContext(Dispatchers.IO) { Thumbs.decode(key, targetPx, open) }
        }
    }
    return bmp?.asImageBitmap()
}
