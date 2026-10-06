import { defineStore } from 'pinia';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { toPlain } from '../utils/plain';
import { pairBoards, boardUsable } from '../utils/wood';
import { useAliasStore } from './aliasStore';
import { aliasesOf, matchesGuqin, resolveGuqinNo } from '../utils/alias';
import type { BoardPart, BoardPair, WoodBoard, WoodDefect, WoodGrain, WoodSpecies } from '../types/wood-board';

export interface BoardInput {
  boardNo: string;
  guqinNo: string;
  part: BoardPart;
  species: WoodSpecies;
  dryYears: number;
  thicknessMm: number;
  grain: WoodGrain;
  defect: WoodDefect;
  receivedAt?: string;
  remark?: string;
}

interface BoardState {
  boards: WoodBoard[];
  hydrated: boolean;
}

/** 板材与面板/底板配对 */
export const useBoardStore = defineStore('board', {
  state: (): BoardState => ({ boards: [], hydrated: false }),

  getters: {
    /** 面板与底板按正式琴号配对并回显含水率 */
    pairs(state): BoardPair[] {
      const aliasStore = useAliasStore();
      return pairBoards(state.boards, aliasStore.aliasIndex);
    },
    /** 可用板材数（无裂纹且阴干达标） */
    usableCount(state): number {
      return state.boards.filter(boardUsable).length;
    },
    guqinNos(state): string[] {
      const aliasStore = useAliasStore();
      return Array.from(new Set(state.boards.map((b) => resolveGuqinNo(b.guqinNo, aliasStore.aliasIndex)))).sort();
    },
    boardsOf(state) {
      const aliasStore = useAliasStore();
      return (guqinNo: string): WoodBoard[] => {
        const canonical = resolveGuqinNo(guqinNo, aliasStore.aliasIndex);
        return state.boards.filter((b) => resolveGuqinNo(b.guqinNo, aliasStore.aliasIndex) === canonical);
      };
    },
    /** 某正式琴号的旧号别名 */
    aliasesOfGuqin() {
      const aliasStore = useAliasStore();
      return (guqinNo: string): string[] => aliasesOf(guqinNo, aliasStore.aliases);
    },
  },

  actions: {
    /** 把输入琴号（可能是旧号别名）规范为正式琴号；新数据一律挂正式号 */
    canonicalNo(guqinNo: string): string {
      return resolveGuqinNo(guqinNo.trim(), useAliasStore().aliasIndex);
    },

    async hydrate() {
      this.boards = await db.boards.orderBy('boardNo').toArray();
      this.hydrated = true;
    },

    async addBoard(input: BoardInput): Promise<WoodBoard> {
      const board: WoodBoard = {
        id: uid('board'),
        boardNo: input.boardNo.trim(),
        guqinNo: this.canonicalNo(input.guqinNo),
        part: input.part,
        species: input.species,
        dryYears: Number(input.dryYears) || 0,
        thicknessMm: Number(input.thicknessMm) || 0,
        grain: input.grain,
        defect: input.defect,
        receivedAt: input.receivedAt ?? new Date().toISOString(),
        remark: input.remark?.trim() || undefined,
      };
      await db.boards.put(toPlain(board));
      this.boards = [board, ...this.boards];
      return board;
    },

    async updateBoard(id: string, patch: Partial<BoardInput>) {
      const current = this.boards.find((b) => b.id === id);
      if (!current) return;
      const normalizedPatch =
        patch.guqinNo !== undefined ? { ...patch, guqinNo: this.canonicalNo(patch.guqinNo) } : patch;
      const next: WoodBoard = { ...current, ...normalizedPatch };
      await db.boards.put(toPlain(next));
      this.boards = this.boards.map((b) => (b.id === id ? next : b));
    },

    async removeBoard(id: string) {
      await db.boards.delete(id);
      this.boards = this.boards.filter((b) => b.id !== id);
    },

    /** 配对绑定：把某块板材与同琴号的另一部位板材绑定 */
    async pair(panelId: string, baseId: string) {
      const panel = this.boards.find((b) => b.id === panelId);
      const base = this.boards.find((b) => b.id === baseId);
      if (!panel || !base) return;
      const guqinNo = this.canonicalNo(panel.guqinNo);
      const updated = [panel, base].map((b) => ({ ...b, guqinNo }));
      for (const board of updated) {
        await db.boards.put(toPlain(board));
      }
      this.boards = this.boards.map((b) => updated.find((u) => u.id === b.id) ?? b);
    },
  },
});
