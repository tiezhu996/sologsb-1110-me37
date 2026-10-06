import { defineStore } from 'pinia';
import { db } from '../utils/db';
import { toPlain } from '../utils/plain';
import { aliasesOf, buildAliasIndex, matchesGuqin, resolveGuqinNo } from '../utils/alias';
import type { GuqinAlias } from '../types/guqin-alias';

interface AliasState {
  aliases: GuqinAlias[];
  hydrated: boolean;
}

/** 正式琴号 ↔ 旧号（临时琴号）别名表。合档后旧号只作为可搜索别名存在 */
export const useAliasStore = defineStore('alias', {
  state: (): AliasState => ({ aliases: [], hydrated: false }),

  getters: {
    /** 旧号 → 正式琴号 */
    aliasIndex(state): Map<string, string> {
      return buildAliasIndex(state.aliases);
    },
    /** 全部正式琴号 */
    formalNos(state): string[] {
      return state.aliases.map((a) => a.guqinNo).sort();
    },
  },

  actions: {
    /** 把任意琴号（可能是旧号）解析为正式琴号 */
    resolve(no: string): string {
      return resolveGuqinNo(no, this.aliasIndex);
    },
    /** 某正式琴号的旧号别名 */
    aliasesOf(guqinNo: string): string[] {
      return aliasesOf(guqinNo, this.aliases);
    },
    /** 关键字是否命中正式号或其旧号 */
    matches(guqinNo: string, keyword: string): boolean {
      return matchesGuqin(guqinNo, keyword, this.aliases);
    },

    async hydrate() {
      this.aliases = await db.aliases.toArray();
      this.hydrated = true;
    },

    /** 幂等 upsert：把 oldNo 并入 formalNo 的别名 */
    async addAlias(formalNo: string, oldNo: string) {
      const current = this.aliases.find((a) => a.guqinNo === formalNo);
      const aliases = Array.from(new Set([...(current?.aliases ?? []), oldNo]));
      const row: GuqinAlias = { id: formalNo, guqinNo: formalNo, aliases, updatedAt: new Date().toISOString() };
      await db.aliases.put(toPlain(row));
      this.aliases = [...this.aliases.filter((a) => a.guqinNo !== formalNo), row];
      return row;
    },

    /** 恢复备份时整表替换 */
    async replaceAll(rows: GuqinAlias[]) {
      await db.aliases.bulkPut(toPlain(rows));
      this.aliases = rows;
    },

    async clearAll() {
      await db.aliases.clear();
      this.aliases = [];
    },
  },
});
