import { describe, expect, it, beforeEach } from 'vitest';
import { buildMergePlan } from './mergeEngine';
import {
  runMergeWithRepo,
  rollbackWithRepo,
  CATEGORY_ORDER,
  type MergeRepository,
  type ChecklistStore,
} from './renumber';
import { recordAliasAfterMerge, putAliases, getAliasesCached, matchesAlias, setAliasSink } from './aliases';
import type { MergeCategory, MergeChecklist, GuqinSnapshot } from '../types/merge';
import type { GuqinAliasMap } from './aliases';
import type { WoodBoard } from '../types/wood-board';
import type { SoundChamber } from '../types/sound-chamber';
import type { LacquerLayer } from '../types/lacquer-layer';
import type { Stringing } from '../types/stringing';

/** 内存检查点存储（测试用） */
class MemoryChecklistStore implements ChecklistStore {
  map = new Map<string, MergeChecklist>();
  async load(id: string) {
    return this.map.get(id);
  }
  async save(checklist: MergeChecklist) {
    checklist.updatedAt = new Date().toISOString();
    this.map.set(checklist.id, checklist);
  }
  async remove(id: string) {
    this.map.delete(id);
  }
}

/** 内存业务仓储：模拟 IndexedDB 四类表，可按类别注入一次性故障 */
class MemoryRepository implements MergeRepository {
  boards: WoodBoard[] = [];
  chambers: SoundChamber[] = [];
  lacquers: LacquerLayer[] = [];
  stringings: Stringing[] = [];
  /** 下次 replaceCategory 命中这些类别时，写入残缺数据后抛错（模拟事务中途失败） */
  failNext = new Set<MergeCategory>();

  private rowsOf(category: MergeCategory) {
    if (category === 'board') return this.boards;
    if (category === 'chamber') return this.chambers;
    if (category === 'lacquer') return this.lacquers;
    return this.stringings;
  }

  private pick<T extends { guqinNo: string }>(rows: T[], no: string): T[] {
    return JSON.parse(JSON.stringify(rows.filter((r) => r.guqinNo === no)));
  }

  async snapshot(oldNo: string, newNo: string): Promise<GuqinSnapshot> {
    return {
      oldNo,
      newNo,
      takenAt: new Date().toISOString(),
      boards: { old: this.pick(this.boards, oldNo), new: this.pick(this.boards, newNo) },
      chambers: { old: this.pick(this.chambers, oldNo), new: this.pick(this.chambers, newNo) },
      lacquers: { old: this.pick(this.lacquers, oldNo), new: this.pick(this.lacquers, newNo) },
      stringings: { old: this.pick(this.stringings, oldNo), new: this.pick(this.stringings, newNo) },
    };
  }

  async replaceCategory(category: MergeCategory, oldNo: string, newNo: string, rows: unknown[]): Promise<void> {
    const target = this.rowsOf(category);
    const others = target.filter((r) => r.guqinNo !== oldNo && r.guqinNo !== newNo);
    if (this.failNext.has(category)) {
      this.failNext.delete(category);
      // 故意留下残缺结果再抛错，考验「重试先恢复快照」的兜底能力
      const partial = (rows as Array<{ guqinNo: string }>).slice(0, Math.max(0, rows.length - 1));
      this.setRows(category, [...others, ...partial] as never);
      throw new Error(`注入故障：${category} 写入中途失败`);
    }
    this.setRows(category, [...others, ...(rows as never[])]);
  }

  async restoreCategory(category: MergeCategory, snapshot: GuqinSnapshot): Promise<void> {
    const restoreRows =
      category === 'board'
        ? [...snapshot.boards.old, ...snapshot.boards.new]
        : category === 'chamber'
          ? [...snapshot.chambers.old, ...snapshot.chambers.new]
          : category === 'lacquer'
            ? [...snapshot.lacquers.old, ...snapshot.lacquers.new]
            : [...snapshot.stringings.old, ...snapshot.stringings.new];
    const target = this.rowsOf(category);
    const others = target.filter((r) => r.guqinNo !== snapshot.oldNo && r.guqinNo !== snapshot.newNo);
    this.setRows(category, [...others, ...(restoreRows as never[])]);
  }

  async commitAlias(oldNo: string, newNo: string): Promise<void> {
    await recordAliasAfterMerge(oldNo, newNo);
  }

  private setRows(category: MergeCategory, rows: unknown[]) {
    if (category === 'board') this.boards = rows as WoodBoard[];
    else if (category === 'chamber') this.chambers = rows as SoundChamber[];
    else if (category === 'lacquer') this.lacquers = rows as LacquerLayer[];
    else this.stringings = rows as Stringing[];
  }
}

function seed(repo: MemoryRepository) {
  repo.boards = [
    { id: 'b-o', boardNo: 'MB-O', guqinNo: '临-1', part: '面板', species: '桐木', dryYears: 5, thicknessMm: 31, grain: '直纹', defect: '无', receivedAt: '2026-01-01' },
    { id: 'b-n', boardNo: 'MB-N', guqinNo: 'Q-1', part: '面板', species: '桐木', dryYears: 5, thicknessMm: 30, grain: '直纹', defect: '无', receivedAt: '2026-01-02' },
  ];
  repo.chambers = [
    { id: 'c-o', guqinNo: '临-1', nayinThickness: 16, longchiThickness: 13, fengzhaoThickness: 14, chamberDepth: 27, postPos: '天柱中', poolSize: '200×22', carvedAt: '2026-02-01', carver: '周' },
    { id: 'c-n', guqinNo: 'Q-1', nayinThickness: 15, longchiThickness: 13, fengzhaoThickness: 14, chamberDepth: 25, postPos: '天柱中', poolSize: '200×22', carvedAt: '2026-02-02', carver: '周' },
  ];
  repo.lacquers = [
    { id: 'l-o1', guqinNo: '临-1', seq: 1, mixRatio: '1:1', curingTemp: 25, curingHumidity: 80, polishGrit: 240, layerThickness: 0.11, totalThickness: 0.11, appliedAt: '2026-02-10', operator: '周' },
    { id: 'l-o2', guqinNo: '临-1', seq: 2, mixRatio: '1:1.2', curingTemp: 26, curingHumidity: 82, polishGrit: 400, layerThickness: 0.1, totalThickness: 0.21, appliedAt: '2026-02-20', operator: '周' },
    { id: 'l-n1', guqinNo: 'Q-1', seq: 1, mixRatio: '1:1', curingTemp: 25, curingHumidity: 80, polishGrit: 320, layerThickness: 0.12, totalThickness: 0.12, appliedAt: '2026-02-09', operator: '林' },
  ];
  repo.stringings = [
    { id: 's-o', guqinNo: '临-1', stringType: '丝弦', nut: '旧', stringGap: 18, sanNote: '旧散', anNote: '旧按', fanNote: '旧泛', nineVirtues: '旧九', defects: ['抗指'], strungAt: '2026-03-01', operator: '周', noteVersions: [] },
    { id: 's-n', guqinNo: 'Q-1', stringType: '丝弦', nut: '新', stringGap: 17, sanNote: '新散', anNote: '新按', fanNote: '新泛', nineVirtues: '新九', defects: ['无'], strungAt: '2026-03-05', operator: '林', noteVersions: [] },
  ];
}

async function makeChecklist(repo: MemoryRepository): Promise<MergeChecklist> {
  const snap = await repo.snapshot('临-1', 'Q-1');
  const plan = buildMergePlan(snap);
  plan.items.forEach((item) => {
    if (item.status === 'conflict') {
      item.decision = 'new';
      item.confirmed = true;
    }
  });
  const now = new Date().toISOString();
  return { id: 'merge-test', state: 'pending', createdAt: now, updatedAt: now, doneCategories: [], plan };
}

describe('合档提交 / 检查点 / 重试 / 恢复', () => {
  let repo: MemoryRepository;
  let checkpoint: MemoryChecklistStore;

  beforeEach(async () => {
    // 注入内存别名后端，避免触碰 IndexedDB
    const mem = new Map<string, unknown>();
    setAliasSink({
      load: async () => mem.get('aliases') as GuqinAliasMap | undefined,
      save: async (map) => { mem.set('aliases', map); },
    });
    await putAliases({});
    repo = new MemoryRepository();
    checkpoint = new MemoryChecklistStore();
    seed(repo);
  });

  it('完整提交：四类数据全部迁到正式号，旧号清空；髹漆重排遍次、重算累计且不重复', async () => {
    const checklist = await makeChecklist(repo);
    await runMergeWithRepo(checklist, repo, checkpoint);

    expect(repo.boards.every((b) => b.guqinNo !== '临-1')).toBe(true);
    expect(repo.chambers.map((c) => c.guqinNo)).toEqual(['Q-1']);
    expect(repo.stringings.map((s) => s.guqinNo)).toEqual(['Q-1']);
    expect(repo.lacquers.map((l) => [l.id, l.seq, l.totalThickness])).toEqual([
      ['l-n1', 1, 0.12],
      ['l-o2', 2, 0.22],
    ]);
    expect(repo.lacquers.some((l) => l.guqinNo === '临-1')).toBe(false);
    expect(checkpoint.map.size).toBe(0);
    // 旧号仅作为可搜索别名保留
    expect(getAliasesCached()['Q-1']).toEqual(['临-1']);
    expect(matchesAlias('Q-1', '临-1')).toBe(true);
  });

  it('未裁决冲突项不得提交', async () => {
    const checklist = await makeChecklist(repo);
    const item = checklist.plan.items.find((i) => i.id === 'board:面板')!;
    item.confirmed = false;
    await expect(runMergeWithRepo(checklist, repo, checkpoint)).rejects.toThrow(/未裁决/);
    // 业务库未动
    expect(repo.boards.some((b) => b.guqinNo === '临-1')).toBe(true);
    expect(repo.boards.some((b) => b.guqinNo === 'Q-1')).toBe(true);
  });

  it('髹漆阶段注入故障：前两类已检查点；重试先恢复快照再重放，遍次/累计不重复', async () => {
    const checklist = await makeChecklist(repo);
    repo.failNext.add('lacquer');

    await expect(runMergeWithRepo(checklist, repo, checkpoint)).rejects.toThrow(/注入故障/);
    const failed = await checkpoint.load(checklist.id);
    expect(failed?.state).toBe('failed');
    expect(failed?.doneCategories).toEqual(['board', 'chamber']);

    // 重试只处理 lacquer/stringing；lacquer 先恢复成 3 条原始行再合并
    await runMergeWithRepo(failed!, repo, checkpoint);
    expect(repo.lacquers).toHaveLength(2);
    expect(repo.lacquers.map((l) => l.totalThickness)).toEqual([0.12, 0.22]);
    expect(failed?.doneCategories).toEqual(CATEGORY_ORDER);
    expect(checkpoint.map.size).toBe(0);
  });

  it('从核对清单恢复：四类逐类写回快照，旧号/正式号原始数据原样回来', async () => {
    const checklist = await makeChecklist(repo);
    // 留一份合档前清单副本（生产中失败/中断的清单就在 meta 里）
    const savedCopy: MergeChecklist = JSON.parse(JSON.stringify(checklist));
    await runMergeWithRepo(checklist, repo, checkpoint);
    expect(repo.lacquers).toHaveLength(2);

    // 用合档前清单执行恢复
    await rollbackWithRepo(savedCopy, repo);
    expect(repo.boards.filter((b) => b.guqinNo === '临-1')).toHaveLength(1);
    expect(repo.boards.filter((b) => b.guqinNo === 'Q-1')).toHaveLength(1);
    expect(repo.lacquers).toHaveLength(3);
    expect(repo.lacquers.find((l) => l.id === 'l-o2')?.totalThickness).toBe(0.21);
    expect(repo.stringings.map((s) => s.guqinNo).sort()).toEqual(['Q-1', '临-1']);
  });

  it('重试幂等：连续两次重试（第二次无故障）不会把任何类别重复写入', async () => {
    const checklist = await makeChecklist(repo);
    repo.failNext.add('stringing');
    await expect(runMergeWithRepo(checklist, repo, checkpoint)).rejects.toThrow(/注入故障/);

    // 此时 stringing 表残留残缺；第一次重试（不再注入故障）成功
    const failed = await checkpoint.load(checklist.id)!;
    await runMergeWithRepo(failed!, repo, checkpoint);
    // 再把同一份（已 done 状态）清单跑一遍应直接返回，不产生副作用
    const lacquerIds = repo.lacquers.map((l) => l.id);
    await runMergeWithRepo(failed!, repo, checkpoint);
    expect(repo.lacquers.map((l) => l.id)).toEqual(lacquerIds);
    expect(repo.stringings).toHaveLength(1);
  });
});

describe('别名链顺延', () => {
  beforeEach(async () => {
    const mem = new Map<string, unknown>();
    setAliasSink({
      load: async () => mem.get('aliases') as GuqinAliasMap | undefined,
      save: async (map) => { mem.set('aliases', map); },
    });
    await putAliases({});
  });

  it('链式改号：正式号再改号时，旧别名随链顺延', async () => {
    await recordAliasAfterMerge('临-A', 'Q-A');
    await recordAliasAfterMerge('Q-A', 'Q-A2');
    expect(getAliasesCached()['Q-A2']).toEqual(['Q-A', '临-A']);
    expect(getAliasesCached()['Q-A']).toBeUndefined();
    expect(matchesAlias('Q-A2', '临-A')).toBe(true);
  });
});
