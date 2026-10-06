import { db } from './db';
import { getMeta, setMeta } from './db';
import type { MergeCategory, MergeChecklist } from '../types/guqin-alias';
import type { WoodBoard } from '../types/wood-board';
import type { SoundChamber } from '../types/sound-chamber';
import type { LacquerLayer } from '../types/lacquer-layer';
import type { Stringing } from '../types/stringing';
import type { GuqinAlias } from '../types/guqin-alias';
import { canRunItem, pendingDecisions, planAlias, planCategory, restoreOps, type MergeDataBundle } from './merge';
import { toPlain } from './plain';

/** 进行中的核对清单存 meta（含全量快照），任何一步失败都可据此恢复/继续 */
export const ACTIVE_CHECKLIST_KEY = 'merge:active-checklist';
/** 已完成合档的历史（精简记录，供查档） */
export const MERGE_HISTORY_KEY = 'merge:history';

export const CATEGORY_LABELS: Record<MergeCategory, string> = {
  board: '板材厚度',
  chamber: '槽腹尺寸',
  lacquer: '髹漆遍次',
  stringing: '上弦评语',
};

/** 从四个 store 的内存态组装引擎所需数据包 */
export function bundleFrom(
  boards: WoodBoard[],
  chambers: SoundChamber[],
  lacquers: LacquerLayer[],
  stringings: Stringing[],
  aliases: GuqinAlias[],
): MergeDataBundle {
  return JSON.parse(JSON.stringify({ boards, chambers, lacquers, stringings, aliases })) as MergeDataBundle;
}

export async function loadActiveChecklist(): Promise<MergeChecklist | null> {
  const raw = await getMeta(ACTIVE_CHECKLIST_KEY);
  return raw ? (JSON.parse(raw) as MergeChecklist) : null;
}

export async function saveActiveChecklist(checklist: MergeChecklist): Promise<void> {
  checklist.updatedAt = new Date().toISOString();
  await setMeta(ACTIVE_CHECKLIST_KEY, JSON.stringify(toPlain(checklist)));
}

export async function clearActiveChecklist(): Promise<void> {
  await db.meta.delete(ACTIVE_CHECKLIST_KEY);
}

async function appendHistory(checklist: MergeChecklist): Promise<void> {
  const raw = await getMeta(MERGE_HISTORY_KEY);
  const history: Array<{ oldNo: string; formalNo: string; finishedAt: string }> = raw ? JSON.parse(raw) : [];
  history.unshift({ oldNo: checklist.oldNo, formalNo: checklist.formalNo, finishedAt: new Date().toISOString() });
  await setMeta(MERGE_HISTORY_KEY, JSON.stringify(history.slice(0, 20)));
}

const TABLE_OF: Record<MergeCategory, 'boards' | 'chambers' | 'lacquers' | 'stringings'> = {
  board: 'boards',
  chamber: 'chambers',
  lacquer: 'lacquers',
  stringing: 'stringings',
};

/** 分表写入器（避免联合类型 Table 上 bulkPut/bulkDelete 签名不可调用） */
const WRITERS: Record<MergeCategory, { put: (rows: unknown[]) => Promise<unknown>; remove: (ids: string[]) => Promise<unknown> }> = {
  board: { put: (rows) => db.boards.bulkPut(rows as never[]), remove: (ids) => db.boards.bulkDelete(ids) },
  chamber: { put: (rows) => db.chambers.bulkPut(rows as never[]), remove: (ids) => db.chambers.bulkDelete(ids) },
  lacquer: { put: (rows) => db.lacquers.bulkPut(rows as never[]), remove: (ids) => db.lacquers.bulkDelete(ids) },
  stringing: { put: (rows) => db.stringings.bulkPut(rows as never[]), remove: (ids) => db.stringings.bulkDelete(ids) },
};

/**
 * 执行单类迁移（各自独立事务）：
 * - 该类存在未裁决项时直接拒绝，不动库；
 * - 失败时该事务整体回滚（Dexie 保证原子性），条目标记 failed，可从清单恢复或只重试剩余项；
 * - 每类成功后都幂等写入旧号别名（旧号只留别名），保证迁到一半旧号也可搜到。
 * 返回更新后的清单（调用方负责落 meta 与重新 hydrate 各 store）。
 */
export async function runCategoryMigration(checklist: MergeChecklist, data: MergeDataBundle, category: MergeCategory): Promise<MergeChecklist> {
  const item = checklist.items.find((i) => i.category === category);
  if (!item) return checklist;
  if (item.status === 'done') return checklist;
  const pending = pendingDecisions(item);
  if (pending > 0) {
    throw new Error(`${CATEGORY_LABELS[category]}还有 ${pending} 项未裁决，未裁决前不得改库`);
  }

  const plan = planCategory(checklist, data, category);
  const writer = WRITERS[category];
  const aliasPlan = planAlias(checklist, data);

  try {
    await db.transaction('rw', [db[TABLE_OF[category]], db.aliases], async () => {
      if (plan.deletes.length) await writer.remove(plan.deletes);
      if (plan.puts.length) await writer.put(toPlain(plan.puts));
      if (aliasPlan.deletes.length) await db.aliases.bulkDelete(aliasPlan.deletes);
      await db.aliases.put(toPlain(aliasPlan.row));
    });
    item.status = 'done';
    item.error = undefined;
  } catch (error) {
    item.status = 'failed';
    item.error = (error as Error).message;
    throw error;
  }
  return checklist;
}

/** 全部条目是否已完成（含别名随上弦类写入） */
export function allItemsDone(checklist: MergeChecklist): boolean {
  return checklist.items.every((i) => i.status === 'done');
}

/** 收尾：写历史、清活动清单 */
export async function finalizeMigration(checklist: MergeChecklist): Promise<void> {
  await appendHistory(checklist);
  await clearActiveChecklist();
}

/**
 * 从核对清单恢复：把四张业务表 + 别名表中旧号/正式号相关行还原到清单生成时的快照。
 * 恢复后所有条目标记回 pending，可重新裁决或只重试剩余项。
 */
export async function restoreFromChecklist(checklist: MergeChecklist, data: MergeDataBundle): Promise<MergeChecklist> {
  const ops = restoreOps(checklist, data);
  await db.transaction(
    'rw',
    [db.boards, db.chambers, db.lacquers, db.stringings, db.aliases],
    async () => {
      await db.boards.bulkDelete(ops.boards.deletes);
      await db.boards.bulkPut(toPlain(ops.boards.puts) as never[]);
      await db.chambers.bulkDelete(ops.chambers.deletes);
      await db.chambers.bulkPut(toPlain(ops.chambers.puts) as never[]);
      await db.lacquers.bulkDelete(ops.lacquers.deletes);
      await db.lacquers.bulkPut(toPlain(ops.lacquers.puts) as never[]);
      await db.stringings.bulkDelete(ops.stringings.deletes);
      await db.stringings.bulkPut(toPlain(ops.stringings.puts) as never[]);
      await db.aliases.bulkDelete(ops.aliases.deletes);
      if (ops.aliases.puts.length) await db.aliases.bulkPut(toPlain(ops.aliases.puts));
    },
  );
  checklist.items.forEach((item) => {
    item.status = 'pending';
    item.error = undefined;
  });
  return checklist;
}

export { canRunItem };
