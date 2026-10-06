import { describe, expect, it } from 'vitest';
import {
  buildMergePlan,
  pendingAdjudications,
  resolveMerge,
  categoryStats,
} from './mergeEngine';
import type { WoodBoard } from '../types/wood-board';
import type { SoundChamber } from '../types/sound-chamber';
import type { LacquerLayer } from '../types/lacquer-layer';
import type { Stringing } from '../types/stringing';
import type { GuqinSnapshot } from '../types/merge';

function board(partial: Partial<WoodBoard> & Pick<WoodBoard, 'id' | 'boardNo' | 'guqinNo' | 'part' | 'thicknessMm'>): WoodBoard {
  return {
    species: '桐木',
    dryYears: 5,
    grain: '直纹',
    defect: '无',
    receivedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

function chamber(partial: Partial<SoundChamber> & Pick<SoundChamber, 'id' | 'guqinNo'>): SoundChamber {
  return {
    nayinThickness: 15,
    longchiThickness: 13,
    fengzhaoThickness: 14,
    chamberDepth: 25,
    postPos: '天柱中',
    poolSize: '200×22',
    carvedAt: '2026-02-01T00:00:00.000Z',
    carver: '周砚秋',
    ...partial,
  };
}

function layer(partial: Partial<LacquerLayer> & Pick<LacquerLayer, 'id' | 'guqinNo' | 'seq' | 'layerThickness' | 'appliedAt'>): LacquerLayer {
  return {
    mixRatio: '1:1',
    curingTemp: 25,
    curingHumidity: 80,
    polishGrit: 320,
    totalThickness: 0,
    operator: '林听雪',
    ...partial,
  };
}

function stringing(partial: Partial<Stringing> & Pick<Stringing, 'id' | 'guqinNo'>): Stringing {
  return {
    stringType: '丝弦',
    nut: '红木雁足',
    stringGap: 17,
    sanNote: '',
    anNote: '',
    fanNote: '',
    nineVirtues: '',
    defects: ['无'],
    strungAt: '2026-03-01T00:00:00.000Z',
    operator: '周砚秋',
    noteVersions: [],
    ...partial,
  };
}

function snapshot(overrides: Partial<GuqinSnapshot> = {}): GuqinSnapshot {
  return {
    oldNo: '临-X',
    newNo: 'Q-X',
    takenAt: '2026-04-01T00:00:00.000Z',
    boards: { old: [], new: [] },
    chambers: { old: [], new: [] },
    lacquers: { old: [], new: [] },
    stringings: { old: [], new: [] },
    ...overrides,
  };
}

describe('buildMergePlan · 板材', () => {
  it('同部位厚度不同 → 冲突且必须裁决；同厚度 → 自动保留正式号', () => {
    const plan = buildMergePlan(
      snapshot({
        boards: {
          old: [board({ id: 'ob1', boardNo: 'MB-1', guqinNo: '临-X', part: '面板', thicknessMm: 31 })],
          new: [board({ id: 'nb1', boardNo: 'MB-2', guqinNo: 'Q-X', part: '面板', thicknessMm: 30 })],
        },
      }),
    );
    const item = plan.items.find((i) => i.id === 'board:面板')!;
    expect(item.status).toBe('conflict');
    expect(item.confirmed).toBe(false);
    expect(item.decision).toBe('new'); // 默认建议取正式号
    expect(pendingAdjudications(plan)).toBe(1);

    // 同厚度场景
    const samePlan = buildMergePlan(
      snapshot({
        boards: {
          old: [board({ id: 'ob2', boardNo: 'MB-3', guqinNo: '临-X', part: '底板', thicknessMm: 17 })],
          new: [board({ id: 'nb2', boardNo: 'MB-4', guqinNo: 'Q-X', part: '底板', thicknessMm: 17 })],
        },
      }),
    );
    expect(samePlan.items.find((i) => i.id === 'board:底板')?.status).toBe('auto');
    expect(pendingAdjudications(samePlan)).toBe(0);
  });

  it('仅旧号有某部位 → 自动迁入；多余板材自动保留并改挂正式号', () => {
    const plan = buildMergePlan(
      snapshot({
        boards: {
          old: [
            board({ id: 'ob1', boardNo: 'MB-1', guqinNo: '临-X', part: '面板', thicknessMm: 31 }),
            board({ id: 'ob2', boardNo: 'MB-2', guqinNo: '临-X', part: '面板', thicknessMm: 30 }),
          ],
          new: [board({ id: 'nb1', boardNo: 'MB-3', guqinNo: 'Q-X', part: '底板', thicknessMm: 17 })],
        },
      }),
    );
    expect(plan.items.find((i) => i.id === 'board:面板')?.status).toBe('auto');
    expect(plan.items.find((i) => i.id === 'board:extra:ob2')?.decision).toBe('old');
    const resolved = resolveMerge(plan);
    expect(resolved.boards.map((b) => b.guqinNo).every((no) => no === 'Q-X')).toBe(true);
    expect(resolved.boards.map((b) => b.id).sort()).toEqual(['nb1', 'ob1', 'ob2']);
  });
});

describe('buildMergePlan · 槽腹', () => {
  it('逐字段裁决：不同字段为冲突，相同字段自动', () => {
    const plan = buildMergePlan(
      snapshot({
        chambers: {
          old: [chamber({ id: 'c1', guqinNo: '临-X', nayinThickness: 16, chamberDepth: 27, postPos: '天柱偏左' })],
          new: [chamber({ id: 'c2', guqinNo: 'Q-X', nayinThickness: 15, chamberDepth: 25, postPos: '天柱偏左' })],
        },
      }),
    );
    expect(plan.items.find((i) => i.id === 'chamber:nayinThickness')?.status).toBe('conflict');
    expect(plan.items.find((i) => i.id === 'chamber:chamberDepth')?.status).toBe('conflict');
    expect(plan.items.find((i) => i.id === 'chamber:postPos')?.status).toBe('auto');
    expect(plan.items.find((i) => i.id === 'chamber:longchiThickness')?.status).toBe('auto');
    expect(pendingAdjudications(plan)).toBe(2);
  });

  it('裁决后按字段拼合最终记录，guqinNo 为正式号', () => {
    const plan = buildMergePlan(
      snapshot({
        chambers: {
          old: [chamber({ id: 'c1', guqinNo: '临-X', nayinThickness: 16, chamberDepth: 27 })],
          new: [chamber({ id: 'c2', guqinNo: 'Q-X', nayinThickness: 15, chamberDepth: 25 })],
        },
      }),
    );
    // 纳音取旧号，槽腹深度取正式号（冲突项必须显式确认后才能落库）
    const nayin = plan.items.find((i) => i.id === 'chamber:nayinThickness')!;
    nayin.decision = 'old';
    nayin.confirmed = true;
    const depth = plan.items.find((i) => i.id === 'chamber:chamberDepth')!;
    depth.confirmed = true;
    const resolved = resolveMerge(plan);
    expect(resolved.chamber?.nayinThickness).toBe(16);
    expect(resolved.chamber?.chamberDepth).toBe(25);
    expect(resolved.chamber?.longchiThickness).toBe(13);
    expect(resolved.chamber?.guqinNo).toBe('Q-X');
  });
});

describe('buildMergePlan · 髹漆', () => {
  it('同遍次两边不同 → 冲突；只有一边 → 自动；合并后重排遍次并重算累计厚度，绝不重复', () => {
    const plan = buildMergePlan(
      snapshot({
        lacquers: {
          old: [
            layer({ id: 'l1', guqinNo: '临-X', seq: 1, layerThickness: 0.11, appliedAt: '2026-02-02T00:00:00.000Z' }),
            layer({ id: 'l2', guqinNo: '临-X', seq: 2, layerThickness: 0.1, appliedAt: '2026-02-20T00:00:00.000Z' }),
          ],
          new: [
            layer({ id: 'l3', guqinNo: 'Q-X', seq: 1, layerThickness: 0.12, appliedAt: '2026-02-01T00:00:00.000Z' }),
          ],
        },
      }),
    );
    expect(plan.items.find((i) => i.id === 'lacquer:1')?.status).toBe('conflict');
    expect(plan.items.find((i) => i.id === 'lacquer:2')?.status).toBe('auto');
    expect(pendingAdjudications(plan)).toBe(1);

    // 第 1 遍取正式号（0.12，日期更早），第 2 遍来自旧号
    const first = plan.items.find((i) => i.id === 'lacquer:1')!;
    first.decision = 'new';
    first.confirmed = true;
    const resolved = resolveMerge(plan);
    expect(resolved.lacquers.map((l) => l.id)).toEqual(['l3', 'l2']);
    expect(resolved.lacquers.map((l) => l.seq)).toEqual([1, 2]);
    expect(resolved.lacquers[0].totalThickness).toBeCloseTo(0.12, 5);
    expect(resolved.lacquers[1].totalThickness).toBeCloseTo(0.22, 5);
  });

  it('两边各有独有遍次且日期交错时，仍按施工日期重排，每条只计入一次', () => {
    const plan = buildMergePlan(
      snapshot({
        lacquers: {
          old: [layer({ id: 'a', guqinNo: '临-X', seq: 1, layerThickness: 0.1, appliedAt: '2026-03-10T00:00:00.000Z' })],
          new: [layer({ id: 'b', guqinNo: 'Q-X', seq: 1, layerThickness: 0.2, appliedAt: '2026-03-01T00:00:00.000Z' })],
        },
      }),
    );
    const first = plan.items.find((i) => i.id === 'lacquer:1')!;
    first.decision = 'old';
    first.confirmed = true;
    const resolved = resolveMerge(plan);
    // seq 冲突只选一条；这里只保留旧号 a
    expect(resolved.lacquers.map((l) => l.id)).toEqual(['a']);
    expect(resolved.lacquers[0].totalThickness).toBeCloseTo(0.1, 5);
  });
});

describe('buildMergePlan · 上弦', () => {
  it('评语逐字段裁决，历史版本合并去重', () => {
    const plan = buildMergePlan(
      snapshot({
        stringings: {
          old: [
            stringing({
              id: 's1',
              guqinNo: '临-X',
              sanNote: '旧散音',
              anNote: '旧按音',
              defects: ['抗指'],
              noteVersions: [
                { id: 'v1', savedAt: '2026-02-28T00:00:00.000Z', sanNote: 'v1散', anNote: 'v1按', fanNote: 'v1泛', nineVirtues: 'v1九' },
              ],
            }),
          ],
          new: [
            stringing({
              id: 's2',
              guqinNo: 'Q-X',
              sanNote: '新散音',
              anNote: '新按音',
              defects: ['无'],
              noteVersions: [
                { id: 'v2', savedAt: '2026-03-05T00:00:00.000Z', sanNote: 'v2散', anNote: 'v2按', fanNote: 'v2泛', nineVirtues: 'v2九' },
                { id: 'v1', savedAt: '2026-02-28T00:00:00.000Z', sanNote: 'v1散', anNote: 'v1按', fanNote: 'v1泛', nineVirtues: 'v1九' },
              ],
            }),
          ],
        },
      }),
    );
    // 散音取旧号，其余冲突项默认取新号（逐项显式确认）
    plan.items
      .filter((i) => i.status === 'conflict')
      .forEach((i) => {
        if (i.id === 'stringing:sanNote') i.decision = 'old';
        i.confirmed = true;
      });
    const resolved = resolveMerge(plan);
    expect(resolved.stringing?.sanNote).toBe('旧散音');
    expect(resolved.stringing?.anNote).toBe('新按音');
    expect(resolved.stringing?.guqinNo).toBe('Q-X');
    expect(resolved.stringing?.noteVersions.map((v) => v.id)).toEqual(['v2', 'v1']);
    // 缺陷默认保留更全的一边（旧号有抗指）
    expect(resolved.stringing?.defects).toEqual(['抗指']);
  });

  it('仅旧号有上弦记录 → 整条自动迁入（含版本）', () => {
    const plan = buildMergePlan(
      snapshot({
        stringings: {
          old: [stringing({ id: 's1', guqinNo: '临-X', sanNote: '唯一', noteVersions: [{ id: 'v9', savedAt: 'x', sanNote: 'h', anNote: 'h', fanNote: 'h', nineVirtues: 'h' }] })],
          new: [],
        },
      }),
    );
    const resolved = resolveMerge(plan);
    expect(resolved.stringing?.id).toBe('s1');
    expect(resolved.stringing?.guqinNo).toBe('Q-X');
    expect(resolved.stringing?.noteVersions).toHaveLength(1);
  });
});

describe('落库闸门', () => {
  it('任一冲突未裁决前 resolveMerge 抛错，不得落库', () => {
    const plan = buildMergePlan(
      snapshot({
        chambers: {
          old: [chamber({ id: 'c1', guqinNo: '临-X', chamberDepth: 27 })],
          new: [chamber({ id: 'c2', guqinNo: 'Q-X', chamberDepth: 25 })],
        },
      }),
    );
    expect(plan.items.find((i) => i.id === 'chamber:chamberDepth')?.status).toBe('conflict');
    // 冲突项虽有默认建议值，但未显式确认前应拦截落库
    expect(pendingAdjudications(plan)).toBeGreaterThan(0);
    expect(() => resolveMerge(plan)).toThrow(/未裁决/);
  });

  it('categoryStats 统计四类条目与冲突数', () => {
    const plan = buildMergePlan(
      snapshot({
        boards: {
          old: [board({ id: 'ob1', boardNo: 'MB-1', guqinNo: '临-X', part: '面板', thicknessMm: 31 })],
          new: [board({ id: 'nb1', boardNo: 'MB-2', guqinNo: 'Q-X', part: '面板', thicknessMm: 30 })],
        },
      }),
    );
    const stats = categoryStats(plan);
    expect(stats.board.conflicts).toBe(1);
    expect(stats.chamber.total).toBe(0);
  });
});
