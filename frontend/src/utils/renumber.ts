import { db } from './db';
import { uid } from './id';
import { buildMergePlan, resolveMerge } from './mergeEngine';
import { recordAliasAfterMerge } from './aliases';
import type { WoodBoard } from '../types/wood-board';
import type { SoundChamber } from '../types/sound-chamber';
import type { LacquerLayer } from '../types/lacquer-layer';
import type { Stringing } from '../types/stringing';
import type {
  GuqinSnapshot,
  MergeCategory,
  MergeChecklist,
  MergeSide,
} from '../types/merge';

const CHECKLIST_META_KEY = 'renumberChecklists';

export const CATEGORY_ORDER: MergeCategory[] = ['board', 'chamber', 'lacquer', 'stringing'];

/**
 * 合档仓储：把「某类数据按号码范围整体替换」抽象出来，
 * Dexie 实现用于生产，内存实现用于单测（可注入故障验证恢复/重试）。
 */
export interface MergeRepository {
  snapshot(oldNo: string, newNo: string): Promise<GuqinSnapshot>;
  /** 把某类数据中属于 oldNo/newNo 的行替换为 rows（原子） */
  replaceCategory(category: MergeCategory, oldNo: string, newNo: string, rows: unknown[]): Promise<void>;
  /** 从快照恢复某类数据：删除当前 oldNo/newNo 行，原样写回快照两边的行（原子） */
  restoreCategory(category: MergeCategory, snapshot: GuqinSnapshot): Promise<void>;
  /** 合档全部完成后登记旧号别名 */
  commitAlias(oldNo: string, newNo: string): Promise<void>;
}

/** 核对清单检查点读写（生产走 Dexie meta，测试可注入内存实现） */
export interface ChecklistStore {
  load(id: string): Promise<MergeChecklist | undefined>;
  save(checklist: MergeChecklist): Promise<void>;
  remove(id: string): Promise<void>;
}

export class DexieMergeRepository implements MergeRepository {
  async snapshot(oldNo: string, newNo: string): Promise<GuqinSnapshot> {
    const [oldBoards, newBoards, oldChambers, newChambers, oldLacquers, newLacquers, oldStringings, newStringings] =
      await Promise.all([
        db.boards.where('guqinNo').equals(oldNo).toArray(),
        db.boards.where('guqinNo').equals(newNo).toArray(),
        db.chambers.where('guqinNo').equals(oldNo).toArray(),
        db.chambers.where('guqinNo').equals(newNo).toArray(),
        db.lacquers.where('guqinNo').equals(oldNo).toArray(),
        db.lacquers.where('guqinNo').equals(newNo).toArray(),
        db.stringings.where('guqinNo').equals(oldNo).toArray(),
        db.stringings.where('guqinNo').equals(newNo).toArray(),
      ]);
    return {
      oldNo,
      newNo,
      takenAt: new Date().toISOString(),
      boards: { old: oldBoards, new: newBoards },
      chambers: { old: oldChambers as SoundChamber[], new: newChambers as SoundChamber[] },
      lacquers: { old: oldLacquers as LacquerLayer[], new: newLacquers as LacquerLayer[] },
      stringings: { old: oldStringings as Stringing[], new: newStringings as Stringing[] },
    };
  }

  async replaceCategory(category: MergeCategory, oldNo: string, newNo: string, rows: unknown[]): Promise<void> {
    const table = db.table<Record<string, unknown>, string>(this.tableName(category));
    await db.transaction('rw', table, async () => {
      await table.where('guqinNo').anyOf(oldNo, newNo).delete();
      if (rows.length) await table.bulkPut(rows as never[]);
    });
  }

  async restoreCategory(category: MergeCategory, snapshot: GuqinSnapshot): Promise<void> {
    const rows: unknown[] =
      category === 'board'
        ? [...snapshot.boards.old, ...snapshot.boards.new]
        : category === 'chamber'
          ? [...snapshot.chambers.old, ...snapshot.chambers.new]
          : category === 'lacquer'
            ? [...snapshot.lacquers.old, ...snapshot.lacquers.new]
            : [...snapshot.stringings.old, ...snapshot.stringings.new];
    await this.replaceCategory(category, snapshot.oldNo, snapshot.newNo, rows);
  }

  async commitAlias(oldNo: string, newNo: string): Promise<void> {
    await recordAliasAfterMerge(oldNo, newNo);
  }

  private tableName(category: MergeCategory): string {
    return category === 'board'
      ? 'boards'
      : category === 'chamber'
        ? 'chambers'
        : category === 'lacquer'
          ? 'lacquers'
          : 'stringings';
  }
}

async function loadChecklistsRaw(): Promise<MergeChecklist[]> {
  const raw = await db.meta.get(CHECKLIST_META_KEY);
  return raw?.value ? (JSON.parse(raw.value) as MergeChecklist[]) : [];
}

async function saveChecklistsRaw(list: MergeChecklist[]): Promise<void> {
  await db.meta.put({ key: CHECKLIST_META_KEY, value: JSON.stringify(list) });
}

export async function listMergeChecklists(): Promise<MergeChecklist[]> {
  return (await loadChecklistsRaw()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export class DexieChecklistStore implements ChecklistStore {
  async load(id: string): Promise<MergeChecklist | undefined> {
    return (await loadChecklistsRaw()).find((c) => c.id === id);
  }

  async save(checklist: MergeChecklist): Promise<void> {
    const list = await loadChecklistsRaw();
    const idx = list.findIndex((c) => c.id === checklist.id);
    checklist.updatedAt = new Date().toISOString();
    if (idx >= 0) list[idx] = checklist;
    else list.push(checklist);
    await saveChecklistsRaw(list);
  }

  async remove(id: string): Promise<void> {
    const list = await loadChecklistsRaw();
    await saveChecklistsRaw(list.filter((c) => c.id !== id));
  }
}

/**
 * 发起合档：拍快照、生成核对清单并持久化。
 * 注意：此时不改任何业务表——任何冲突项裁决完成前不得落库。
 */
export async function prepareMerge(oldNo: string, newNo: string): Promise<MergeChecklist> {
  const oldTrim = oldNo.trim();
  const newTrim = newNo.trim();
  if (!oldTrim || !newTrim) throw new Error('请选择临时琴号与正式琴号');
  if (oldTrim === newTrim) throw new Error('临时琴号与正式琴号不能相同');

  const repo = new DexieMergeRepository();
  const snapshot = await repo.snapshot(oldTrim, newTrim);
  const hasOld =
    snapshot.boards.old.length +
      snapshot.chambers.old.length +
      snapshot.lacquers.old.length +
      snapshot.stringings.old.length >
    0;
  const hasNew =
    snapshot.boards.new.length +
      snapshot.chambers.new.length +
      snapshot.lacquers.new.length +
      snapshot.stringings.new.length >
    0;
  if (!hasOld) throw new Error(`临时琴号 ${oldTrim} 下没有任何工序数据`);
  if (!hasNew) throw new Error(`正式琴号 ${newTrim} 下没有配对后的板材数据`);

  const plan = buildMergePlan(snapshot);
  const now = new Date().toISOString();
  const checklist: MergeChecklist = {
    id: uid('merge'),
    state: 'pending',
    createdAt: now,
    updatedAt: now,
    doneCategories: [],
    plan,
  };
  await new DexieChecklistStore().save(checklist);
  return checklist;
}

/** 保存一页/逐项裁决结果（只改清单，不碰业务表） */
export async function saveAdjudications(
  checklistId: string,
  decisions: Record<string, MergeSide>,
  confirmed?: Record<string, boolean>,
): Promise<MergeChecklist> {
  const store = new DexieChecklistStore();
  const checklist = await store.load(checklistId);
  if (!checklist) throw new Error('核对清单不存在或已清理');
  checklist.plan.items.forEach((item) => {
    const decision = decisions[item.id];
    if (decision) item.decision = decision;
    if (confirmed && Object.prototype.hasOwnProperty.call(confirmed, item.id)) {
      item.confirmed = Boolean(confirmed[item.id]);
    }
  });
  checklist.state = checklist.doneCategories.length > 0 ? 'committing' : 'pending';
  await store.save(checklist);
  return checklist;
}

/**
 * 执行合档（也用于失败后的重试）。
 * 实际逐类提交循环见 runMergeWithRepo（仓储可注入，便于内存测试）。
 */
export async function commitMerge(
  checklistId: string,
  repo: MergeRepository = new DexieMergeRepository(),
): Promise<MergeChecklist> {
  const checklist = await new DexieChecklistStore().load(checklistId);
  if (!checklist) throw new Error('核对清单不存在或已清理');
  return runMergeWithRepo(checklist, repo);
}

/**
 * 合档逐类提交循环（生产与测试共用同一份逻辑）：
 * - 四类按 board → chamber → lacquer → stringing 顺序，各走一个独立原子事务；
 * - 每个事务先按清单快照恢复该类两边原始行，再写入裁决结果——
 *   因此重试幂等，髹漆遍次与累计厚度绝不会重复加一遍；
 * - 每类成功后写检查点，重试只处理剩下的类别；
 * - 任一类失败：清单标记 failed 并记下错误，业务库回到「已成功的类已迁移、其余类维持原状」状态。
 */
export async function runMergeWithRepo(
  checklist: MergeChecklist,
  repo: MergeRepository,
  checkpointStore: ChecklistStore = new DexieChecklistStore(),
): Promise<MergeChecklist> {
  if (checklist.state === 'done') return checklist;

  const unresolved = checklist.plan.items.filter((item) => item.status === 'conflict' && !item.confirmed);
  if (unresolved.length > 0) {
    throw new Error(`还有 ${unresolved.length} 项冲突未裁决，任何一项未裁决前不得改库`);
  }

  checklist.state = 'committing';
  await checkpointStore.save(checklist);

  try {
    const resolved = resolveMerge(checklist.plan);
    for (const category of CATEGORY_ORDER) {
      if (checklist.doneCategories.includes(category)) continue;
      // 先恢复后重放：即使上次在该类写入中途失败，重试也从原始快照重建，杜绝重复
      await repo.restoreCategory(category, checklist.plan.snapshot);
      await repo.replaceCategory(
        category,
        checklist.plan.oldNo,
        checklist.plan.newNo,
        categoryRows(resolved, category),
      );
      checklist.doneCategories.push(category);
      await checkpointStore.save(checklist);
    }

    await repo.commitAlias(checklist.plan.oldNo, checklist.plan.newNo);
    checklist.state = 'done';
    await checkpointStore.save(checklist);
    await checkpointStore.remove(checklist.id);
    return checklist;
  } catch (error) {
    checklist.state = 'failed';
    checklist.lastError = (error as Error).message;
    await checkpointStore.save(checklist);
    throw error;
  }
}

function categoryRows(resolved: ReturnType<typeof resolveMerge>, category: MergeCategory): unknown[] {
  switch (category) {
    case 'board':
      return resolved.boards;
    case 'chamber':
      return resolved.chamber ? [resolved.chamber] : [];
    case 'lacquer':
      return resolved.lacquers;
    case 'stringing':
      return resolved.stringing ? [resolved.stringing] : [];
  }
}

/**
 * 迁移失败后从核对清单整体恢复：逐类写回快照两边原始数据，并清除检查点。
 * 仓储与检查点存储均可注入（生产走 Dexie，测试走内存）。
 */
export async function rollbackWithRepo(
  checklist: MergeChecklist,
  repo: MergeRepository,
  checkpointStore?: ChecklistStore,
): Promise<MergeChecklist> {
  for (const category of CATEGORY_ORDER) {
    await repo.restoreCategory(category, checklist.plan.snapshot);
  }
  checklist.doneCategories = [];
  checklist.state = 'pending';
  checklist.lastError = undefined;
  await checkpointStore?.save(checklist);
  return checklist;
}

export async function rollbackMerge(
  checklistId: string,
  repo: MergeRepository = new DexieMergeRepository(),
): Promise<MergeChecklist> {
  const store = new DexieChecklistStore();
  const checklist = await store.load(checklistId);
  if (!checklist) throw new Error('核对清单不存在或已清理');
  return rollbackWithRepo(checklist, repo, store);
}

/** 放弃合档：删除核对清单（未提交的清单可直接放弃；失败状态请先恢复） */
export async function discardMerge(checklistId: string): Promise<void> {
  const store = new DexieChecklistStore();
  const checklist = await store.load(checklistId);
  if (checklist && checklist.state === 'committing') {
    throw new Error('清单正在提交中，不能放弃');
  }
  await store.remove(checklistId);
}
