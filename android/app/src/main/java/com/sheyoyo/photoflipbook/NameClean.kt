package com.sheyoyo.photoflipbook

/**
 * ★ 第十九轮（代码优化）：文件名/目录名/ID 清洗，**四处重复的正则合一**。
 *
 * 原本 `LibraryStore.safeName` / `PhotoStore.safeName` / `BookWriter.safeId` /
 * `BookWriter.safeFileName` 四处各自写了一遍同一个正则（`[\\/:*?"<>|\x00-\x1f]`），
 * 只有「截断长度」和「兜底名」不同。抽成这一个函数，调用方传参数即可。
 *
 * ⚠ 语义必须与原来逐字一致（合并不能改行为）：
 *   · 危险字符一律替换成 `_`（不是删除，否则 `a/b` 和 `ab` 会撞名）；
 *   · `take(maxLen)` 截断 —— 截断**在替换之后**（先换再截，顺序不能反）；
 *   · `ifBlank { fallback }` —— 空串 / 全被换成 `_` 之后的空白，用兜底名。
 *
 * ⚠ 函数名叫 `cleanName`（不叫 `safeName`）—— 因为 `LibraryStore`/`PhotoStore` 内部
 *   各有一个 `private fun safeName(s: String)`，同名会遮蔽、读代码时也分不清。
 */
internal fun cleanName(s: String, maxLen: Int, fallback: String): String =
    s.replace(Regex("""[\\/:*?"<>|\x00-\x1f]"""), "_").take(maxLen).ifBlank { fallback }
