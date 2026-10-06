import type { GuqinAlias } from '../types/guqin-alias';

/**
 * 旧号（临时琴号）别名解析。
 * 合档后四类数据只挂正式琴号；凡是「按琴号找数据」的入口都经此把旧号解析到正式琴号，
 * 使旧号仅以可搜索别名的形式存在。
 */

/** 旧号 → 正式琴号 索引 */
export function buildAliasIndex(list: GuqinAlias[]): Map<string, string> {
  const map = new Map<string, string>();
  list.forEach((row) => {
    row.aliases.forEach((alias) => map.set(alias, row.guqinNo));
  });
  return map;
}

/** 正式琴号集合 */
export function formalSet(list: GuqinAlias[]): Set<string> {
  return new Set(list.map((row) => row.guqinNo));
}

/** 把任意琴号（可能是旧号）解析为正式琴号；查不到时原样返回 */
export function resolveGuqinNo(no: string, index: Map<string, string>): string {
  return index.get(no) ?? no;
}

/** 某正式琴号的全部旧号别名 */
export function aliasesOf(guqinNo: string, list: GuqinAlias[]): string[] {
  return list.find((row) => row.guqinNo === guqinNo)?.aliases ?? [];
}

/** 某正式琴号的检索串：正式号 + 全部旧号，供关键字搜索 */
export function searchTokensOf(guqinNo: string, list: GuqinAlias[]): string {
  return [guqinNo, ...aliasesOf(guqinNo, list)].join(' ');
}

/** 关键字是否命中正式号或其任一旧号别名 */
export function matchesGuqin(guqinNo: string, keyword: string, list: GuqinAlias[]): boolean {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return true;
  return searchTokensOf(guqinNo, list).toLowerCase().includes(kw);
}
