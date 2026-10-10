package com.sheyoyo.photoflipbook

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * **草稿** —— 工作台没出书就退出去时，用户的排版/封面文案**别丢**。
 *
 * ★ 为什么要有这个（真踩到的）：
 *   照片本身早就持久化了（在私有 `picked/` 目录里，见 [PhotoStore]），所以重进工作台
 *   照片还在。但**版���档位、位置、封面文案（书名/副标题/页脚）** 全在内存的
 *   `PhotoRef.plate / position / cover` 里 —— 退出去 = 全没了。
 *   30 张照片挑半天档位、封面文案写好，一按返回键全丢 ⇒ 用户得从头再来。
 *
 * ★ 存哪：`filesDir/draft.json`（**内部私有目录**，不参与扫描、不会混进书里）。
 *   写入用「先写 .tmp 再改名」—— 中途被杀不会留下半个损坏的草稿。
 *
 * ★ 什么时候清：出书成功（[clear]）—— 书已经生成了，草稿没用了。
 *   只在**照片集合变空**时也清（清空操作是用户的明确意图）。
 */
object DraftStore {
    private const val TAG = "DraftStore"
    private const val FILE = "draft.json"

    private fun file(context: Context) = File(context.filesDir, FILE)

    /** 草稿：每张照片的档位/位置 + 封面三元素的样式 + 书名/副标题文案。 */
    data class Draft(
        val title: String,
        val subtitle: String,
        /**
         * ★ 2026-10-08（第六轮）：**页脚那一行的文字**（空 = 保持引擎现算的「N PHOTOGRAPHS」）。
         * ⚠ 它必须单独存：引擎的 `pageHtml` 把页脚写死成 `photoCount + ' PHOTOGRAPHS'`，
         *   `normalizeCoverText` 的 `text` 只对 extras 生效 ⇒ 页脚走预览页那条独立通路。
         */
        val footText: String = "",
        /** key → 档位/位置。 */
        val perPhoto: Map<String, PhotoEdit>,
        /** 封面元素（title/subtitle/foot + 文字框 xN）的样式覆盖（含文字框的 `text`）。 */
        val cover: Map<String, CoverConf>,
    ) {
        data class PhotoEdit(val plate: String?, val position: String?)

        /**
         * ★ 2026-10-08（第四轮）修：判据必须**把书名/副标题算进来**。
         *
         *   旧判据只看 `perPhoto` 与 `cover`（样式）—— 这两样都空时整份草稿被当成"空"
         *   ⇒ `load()` 返回 null、`saveNow()` 直接 `clear()`。
         *   后果：**只改了书名的草稿，退出去再进来就没了**（而"改书名"正是本轮新加的能力，
         *   等于新功能一上线就丢数据）。文字回到出厂默认才算"没内容"。
         */
        val isEmpty: Boolean
            get() = perPhoto.isEmpty() && cover.isEmpty() && footText.isBlank() &&
                isDefaultText(title, subtitle)
    }

    // ------------------------------------------------------------------
    // 存
    // ------------------------------------------------------------------

    /**
     * 存草稿（**同步写**，几百字节，主线程无感；比 `apply()` 更不容易丢）。
     *
     * @param keys 照片顺序（**顺序是身份的一部分** ⇒ 要存）
     */
    fun save(context: Context, title: String, subtitle: String,
              keys: List<String>, edits: Map<String, Draft.PhotoEdit>,
              cover: Map<String, CoverConf>, footText: String = "") {
        try {
            val o = JSONObject()
            o.put("title", title)
            o.put("subtitle", subtitle)
            if (footText.isNotBlank()) o.put("footText", footText)
            val arr = JSONArray()
            for (k in keys) {
                val e = edits[k] ?: continue
                if (e.plate == null && e.position == null) continue   // 默认的不存
                val eo = JSONObject()
                eo.put("key", k)
                e.plate?.let { eo.put("plate", it) }
                e.position?.let { eo.put("position", it) }
                arr.put(eo)
            }
            o.put("edits", arr)
            val coverJson = coverJsonOf(cover)
            if (coverJson.length() > 0) o.put("cover", coverJson)
            // ★ 先写 .tmp 再改名：中途被杀不会留半个损坏草稿（跟 importBook 同一个坑）
            val f = file(context)
            val tmp = File(context.filesDir, "$FILE.tmp")
            tmp.writeText(o.toString(), Charsets.UTF_8)
            if (f.exists()) f.delete()
            tmp.renameTo(f)
        } catch (t: Throwable) {
            // 草稿是"锦上添花"，存不上绝不能连累界面
            Log.w(TAG, "存草稿失败（不影响使用）", t)
        }
    }

    /**
     * 直接从 `photos` 这个可变列表存（拖拽那种在 lambda 里改完就要存的路子用）。
     *
     * 为什么要有这个重载：拖拽发生在网格的 `pointerInput` lambda 里，
     * **看不到 Compose 的局部函数**（Kotlin 前向引用）⇒ 拿不到 `saveDraftSoon`，
     * 只能在这儿把存取两件事收在一个函数里。
     */
    fun saveNow(context: Context, photos: List<PhotoRef>, title: String, subtitle: String,
                cover: Map<String, CoverConf>, footText: String = "") {
        val edits = HashMap<String, Draft.PhotoEdit>()
        for (p in photos) {
            if (p.plate != null || p.position != null) {
                edits[p.key] = Draft.PhotoEdit(p.plate, p.position)
            }
        }
        // ★ 判据与 [Draft.isEmpty] 同一套：只改了书名/副标题也算"有内容"，不能 clear
        val textDefault = isDefaultText(title, subtitle)
        if (edits.isEmpty() && cover.isEmpty() && textDefault && footText.isBlank()) clear(context)
        else save(context, title, subtitle, photos.map { it.key }, edits, cover, footText)
    }

    /** 封面配置 → JSON。与 [coverTextJson] 逐字段一致，直接委托它（第十九轮合并重复）。 */
    private fun coverJsonOf(cover: Map<String, CoverConf>): JSONObject = coverTextJson(cover)

    // ------------------------------------------------------------------
    // 取
    // ------------------------------------------------------------------

    /** 读草稿；没有 / 坏了 / 全空都返回 null（调用方按"没草稿"处理）。 */
    fun load(context: Context): Draft? = try {
        val f = file(context)
        if (!f.isFile) null else {
            val o = JSONObject(f.readText(Charsets.UTF_8))
            val edits = LinkedHashMap<String, Draft.PhotoEdit>()
            val arr = o.optJSONArray("edits") ?: JSONArray()
            for (i in 0 until arr.length()) {
                val eo = arr.optJSONObject(i) ?: continue
                val key = eo.optString("key").takeIf { it.isNotBlank() } ?: continue
                edits[key] = Draft.PhotoEdit(
                    plate = if (eo.has("plate")) eo.optString("plate") else null,
                    position = if (eo.has("position")) eo.optString("position") else null,
                )
            }
            val cover = LinkedHashMap<String, CoverConf>()
            val co = o.optJSONObject("cover")
            if (co != null) {
                for (el in co.keys()) {
                    val c = co.optJSONObject(el) ?: continue
                    cover[el] = CoverConf(
                        hide = if (c.has("hide")) c.optBoolean("hide") else null,
                        x = if (c.has("x")) c.optDouble("x").toFloat() else null,
                        y = if (c.has("y")) c.optDouble("y").toFloat() else null,
                        size = if (c.has("size")) c.optDouble("size").toFloat() else null,
                        w = if (c.has("w")) c.optDouble("w").toFloat() else null,
                        color = if (c.has("color")) c.optString("color") else null,
                        font = if (c.has("font")) c.optString("font") else null,
                        align = if (c.has("align")) c.optString("align") else null,
                        italic = if (c.has("italic")) c.optBoolean("italic") else null,
                        text = if (c.has("text")) c.optString("text") else null,
                    )
                }
            }
            val d = Draft(
                title = o.optString("title"),
                subtitle = o.optString("subtitle"),
                footText = o.optString("footText"),
                perPhoto = edits,
                cover = cover,
            )
            if (d.isEmpty) null else d        // 全空 = 等于没草稿，删掉更干净
        }
    } catch (t: Throwable) {
        Log.w(TAG, "读草稿失败，当没有", t)
        null
    }

    /** 清草稿（出书成功 / 用户清空照片时调）。 */
    fun clear(context: Context) {
        try {
            file(context).delete()
            File(context.filesDir, "$FILE.tmp").delete()
        } catch (t: Throwable) {
            Log.w(TAG, "清草稿失败", t)
        }
    }

    /** 诊断用（这台 ROM 的 logcat 抓不到东西，见 LibraryStore 里的说明）。 */
    fun diag(context: Context) {
        val f = file(context)
        Log.w(TAG, "草稿：存在=${f.isFile} ${if (f.isFile) "${f.length()} 字节" else ""}")
    }
}