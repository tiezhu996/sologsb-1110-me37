import type { GuqinAlias, MergeCategory, MergeChecklist, MergeFieldDecision, MergeItem, MergeLayerConflict, MergeSide, MergeSnapshot } from '../types/guqin-alias';
import type { WoodBoard } from '../types/wood-board';
import type { SoundChamber } from '../types/sound-chamber';
import type { LacquerLayer } from '../types/lacquer-layer';
import type { Stringing } from '../types/stringing';
import { cumulativeThickness, sortLayers } from './layer';

/* ------------------------------------------------------------------ */
/* 展示与比对元数据                                                     */
/* ------------------------------------------------------------------ */

export interface MergeDataBundle {
  boards: WoodBoard[];
  chambers: SoundChamber[];
  lacquers: LacquerLayer[];
  stringings: Stringing[];
  aliases: GuqinAlias[];
}

/** 槽腹逐项裁决字段（两边槽腹都存在且值不同才需裁决） */
const CHAMBER_FIELDS: Array<{ field: keyof SoundChamber; label: string }> = [
  { field: 'nayinThickness', label: '纳音处厚度(mm)' },
  { field: 'longchiThickness', label: '龙池处厚度(mm)' },
  { field: 'fengzhaoThickness', label: '凤沼处厚度(mm)' },
  { field: 'chamberDepth', label: '槽腹深度(mm)' },
  { field: 'postPos', label: '天地柱位置' },
  { field: 'poolSize', label: '龙池凤沼尺寸' },
];

/** 上弦逐项裁决的评语字段（散音/按音/泛音/九德，纯文本） */
const STRINGING_NOTE_FIELDS: Array<{ field: keyof Stringing; label: string }> = [
  { field: 'sanNote', label: '散音评语' },
  { field: 'anNote', label: '按音评语' },
  { field: 'fanNote', label: '泛音评语' },
  { field: 'nineVirtues', label: '九德简述' },
];

/** 髹漆遍次用于判断「同一遍」是否重复的字段（本遍厚度、配比、温湿度、目数、施工日期） */
const LAYER_SAME_KEYS: Array<keyof LacquerLayer> = [
  'mixRatio',
  'curingTemp',
  'curingHumidity',
  'polishGrit',
  'layerThickness',
  'appliedAt',
];

function display(value: unknown): string {
  if (value === undefined || value === null || value === '') return '（空）';
  return String(value);
}

function layersSame(a: LacquerLayer, b: LacquerLayer): boolean {
  return LAYER_SAME_KEYS.every((key) => String(a[key]) === String(b[key]));
}

function layerSummary(layer: LacquerLayer): string {
  return `配比${layer.mixRatio}，本遍${layer.layerThickness}mm，${layer.curingTemp}℃/${layer.curingHumidity}%，${layer.polishGrit}目，${layer.appliedAt.slice(0, 10)}`;
}

/* ------------------------------------------------------------------ */
/* 校验：未通过前只生成清单，绝不改库                                   */
/* ------------------------------------------------------------------ */

export function validateMergePair(oldNo: string, formalNo: string, data: MergeDataBundle): string | null {
  const oldTrim = oldNo.trim();
  const formalTrim = formalNo.trim();
  if (!oldTrim || !formalTrim) return '请填写旧号与正式琴号';
  if (oldTrim === formalTrim) return '旧号与正式琴号不能相同';

  const aliasIndex = new Map<string, string>();
  data.aliases.forEach((row) => row.aliases.forEach((alias) => aliasIndex.set(alias, row.guqinNo)));
  const canonicalOf = (no: string) => aliasIndex.get(no) ?? no;

  if (aliasIndex.has(formalTrim)) return `正式琴号 ${formalTrim} 已是 ${aliasIndex.get(formalTrim)} 的旧号别名，不能再作正式号`;
  if (aliasIndex.has(oldTrim)) return `旧号 ${oldTrim} 已经合档到 ${aliasIndex.get(oldTrim)}，不能重复合档`;
  if (canonicalOf(oldTrim) === formalTrim) return '旧号与正式琴号指向同一张琴，无需合档';

  const touched: unknown[] = [
    ...data.boards,
    ...data.chambers,
    ...data.lacquers,
    ...data.stringings,
  ];
  if (!touched.some((row) => (row as { guqinNo?: string }).guqinNo === oldTrim)) {
    return `旧号 ${oldTrim} 下没有任何工序数据，无需合档`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 快照：清单生成瞬间把旧号/正式号相关的全部行整表拷出，供失败恢复       */
/* ------------------------------------------------------------------ */

const relevant = <T extends { guqinNo: string }>(rows: T[], oldNo: string, formalNo: string): T[] =>
  rows.filter((r) => r.guqinNo === oldNo || r.guqinNo === formalNo);

export async function takeSnapshot(data: MergeDataBundle, oldNo: string, formalNo: string): Promise<MergeSnapshot> {
  return JSON.parse(
    JSON.stringify({
      boards: relevant(data.boards, oldNo, formalNo),
      chambers: relevant(data.chambers, oldNo, formalNo),
      lacquers: relevant(data.lacquers, oldNo, formalNo),
      stringings: relevant(data.stringings, oldNo, formalNo),
      // 含正式号行与旧号自身行（旧号可能本身也是正式号、名下已挂一条别名链）
      aliases: data.aliases.filter((a) => a.guqinNo === formalNo || a.guqinNo === oldNo || a.aliases.includes(oldNo)),
    }),
  ) as MergeSnapshot;
}

/* ------------------------------------------------------------------ */
/* 核对清单构建：逐类逐项列出差异，等待人工裁决                         */
/* ------------------------------------------------------------------ */

function fieldDecision<T extends Record<string, unknown>>(
  key: string,
  field: string,
  label: string,
  oldRow: T | undefined,
  formalRow: T | undefined,
): MergeFieldDecision | null {
  const oldValue = oldRow ? display(oldRow[field]) : '（空）';
  const formalValue = formalRow ? display(formalRow[field]) : '（空）';
  if (oldValue === formalValue) return null;
  return { key, field, label, oldValue, formalValue, winner: null };
}

/** 板材条目：面板/底板厚度逐项裁决；非板材厚度字段（树种/阴干等）随板材归属，不需逐项裁决 */
function buildBoardItem(oldBoards: WoodBoard[], formalBoards: WoodBoard[]): MergeItem {
  const conflicts: MergeFieldDecision[] = [];
  (['面板', '底板'] as const).forEach((part) => {
    const oldRow = oldBoards.find((b) => b.part === part);
    const formalRow = formalBoards.find((b) => b.part === part);
    if (!oldRow || !formalRow) return; // 单边板材直接归并，无冲突
    const decision = fieldDecision(
      `board:${part}:thicknessMm`,
      'thicknessMm',
      `${part}厚度(mm)`,
      oldRow as unknown as Record<string, unknown>,
      formalRow as unknown as Record<string, unknown>,
    );
    if (decision) conflicts.push(decision);
  });
  return {
    category: 'board',
    key: 'board',
    title: `板材厚度（旧号 ${oldBoards.length} 块 / 正式号 ${formalBoards.length} 块）`,
    conflicts,
    layerConflicts: [],
    resolved: conflicts.length === 0,
    status: 'pending',
  };
}

/** 槽腹条目：两边各至多一条；尺寸字段逐项裁决 */
function buildChamberItem(oldRow: SoundChamber | undefined, formalRow: SoundChamber | undefined): MergeItem {
  const conflicts: MergeFieldDecision[] = [];
  if (oldRow && formalRow) {
    CHAMBER_FIELDS.forEach(({ field, label }) => {
      const decision = fieldDecision(
        `chamber:${field}`,
        field,
        label,
        oldRow as unknown as Record<string, unknown>,
        formalRow as unknown as Record<string, unknown>,
      );
      if (decision) conflicts.push(decision);
    });
  }
  return {
    category: 'chamber',
    key: 'chamber',
    title: '槽腹尺寸',
    conflicts,
    layerConflicts: [],
    resolved: conflicts.length === 0,
    status: 'pending',
  };
}

/** 髹漆条目：按遍次配对；完全相同视为重复（只留一遍），不同则整条选边，绝不叠加厚度 */
function buildLacquerItem(oldLayers: LacquerLayer[], formalLayers: LacquerLayer[]): MergeItem {
  const layerConflicts: MergeLayerConflict[] = [];
  const seqs = new Set([...oldLayers.map((l) => l.seq), ...formalLayers.map((l) => l.seq)]);
  let duplicateCount = 0;
  seqs.forEach((seq) => {
    const oldRow = oldLayers.find((l) => l.seq === seq);
    const formalRow = formalLayers.find((l) => l.seq === seq);
    if (oldRow && formalRow) {
      if (layersSame(oldRow, formalRow)) {
        duplicateCount += 1; // 同一遍同内容：自动去重，无需裁决
      } else {
        layerConflicts.push({
          key: `lacquer:seq:${seq}`,
          seq,
          oldSummary: layerSummary(oldRow),
          formalSummary: layerSummary(formalRow),
          winner: null,
        });
      }
    }
  });
  const parts: string[] = [];
  if (layerConflicts.length) parts.push(`${layerConflicts.length} 个遍次两边不一致`);
  if (duplicateCount) parts.push(`${duplicateCount} 遍重复自动去重`);
  const oldOnly = oldLayers.filter((l) => !formalLayers.some((f) => f.seq === l.seq)).length;
  if (oldOnly) parts.push(`${oldOnly} 遍仅旧号有`);
  return {
    category: 'lacquer',
    key: 'lacquer',
    title: `灰胎髹漆遍次（${parts.join('，') || '无重复'}）`,
    conflicts: [],
    layerConflicts,
    resolved: layerConflicts.length === 0,
    status: 'pending',
  };
}

/** 上弦条目：两边各至多一条；散音/按音/泛音/九德逐项裁决，版本历史合并不造新版本 */
function buildStringingItem(oldRow: Stringing | undefined, formalRow: Stringing | undefined): MergeItem {
  const conflicts: MergeFieldDecision[] = [];
  if (oldRow && formalRow) {
    STRINGING_NOTE_FIELDS.forEach(({ field, label }) => {
      const decision = fieldDecision(
        `stringing:${field}`,
        field,
        label,
        oldRow as unknown as Record<string, unknown>,
        formalRow as unknown as Record<string, unknown>,
      );
      if (decision) conflicts.push(decision);
    });
  }
  return {
    category: 'stringing',
    key: 'stringing',
    title: '上弦与音色评语',
    conflicts,
    layerConflicts: [],
    resolved: conflicts.length === 0,
    status: 'pending',
  };
}

export function buildMergeItems(oldNo: string, formalNo: string, data: MergeDataBundle): MergeItem[] {
  const items: MergeItem[] = [];
  const oldBoards = data.boards.filter((b) => b.guqinNo === oldNo);
  const formalBoards = data.boards.filter((b) => b.guqinNo === formalNo);
  if (oldBoards.length || formalBoards.length) {
    items.push(buildBoardItem(oldBoards, formalBoards));
  }
  const oldChamber = data.chambers.find((c) => c.guqinNo === oldNo);
  const formalChamber = data.chambers.find((c) => c.guqinNo === formalNo);
  if (oldChamber || formalChamber) {
    items.push(buildChamberItem(oldChamber, formalChamber));
  }
  const oldLayers = sortLayers(data.lacquers.filter((l) => l.guqinNo === oldNo));
  const formalLayers = sortLayers(data.lacquers.filter((l) => l.guqinNo === formalNo));
  if (oldLayers.length || formalLayers.length) {
    items.push(buildLacquerItem(oldLayers, formalLayers));
  }
  const oldStringing = data.stringings.find((s) => s.guqinNo === oldNo);
  const formalStringing = data.stringings.find((s) => s.guqinNo === formalNo);
  if (oldStringing || formalStringing) {
    items.push(buildStringingItem(oldStringing, formalStringing));
  }
  return items;
}

/** 生成核对清单（不写库；快照已含全部恢复所需行） */
export async function buildChecklist(oldNoRaw: string, formalNoRaw: string, data: MergeDataBundle): Promise<MergeChecklist> {
  const oldNo = oldNoRaw.trim();
  const formalNo = formalNoRaw.trim();
  const error = validateMergePair(oldNo, formalNo, data);
  if (error) throw new Error(error);
  const now = new Date().toISOString();
  return {
    id: `merge-${Date.now().toString(36)}`,
    oldNo,
    formalNo,
    createdAt: now,
    updatedAt: now,
    items: buildMergeItems(oldNo, formalNo, data),
    snapshot: await takeSnapshot(data, oldNo, formalNo),
  };
}

/** 某类条目是否仍有待裁决项（未裁决不得执行该类迁移） */
export function pendingDecisions(item: MergeItem): number {
  return item.conflicts.filter((c) => c.winner === null).length + item.layerConflicts.filter((c) => c.winner === null).length;
}

export function canRunItem(item: MergeItem): boolean {
  return item.status !== 'done' && pendingDecisions(item) === 0;
}

/* ------------------------------------------------------------------ */
/* 应用裁决：纯函数，输出每类最终要写入的行与要删除的 id                 */
/* ------------------------------------------------------------------ */

export interface CategoryPlan {
  category: MergeCategory;
  /** 最终保留（put）的行，guqinNo 已全部为正式号 */
  puts: Array<{ id: string }>;
  /** 需要删除的行 id */
  deletes: string[];
}

function winnerValue<T>(decision: MergeFieldDecision, oldRow: T, formalRow: T, key: string): unknown {
  const source = decision.winner === 'old' ? oldRow : formalRow;
  return (source as Record<string, unknown>)[key];
}

/** 安全删除清单：仍在库中、且不在本次保留（put）集合内 */
function safeDeletes(ids: string[], putIds: Set<string>, liveIds: Set<string>): string[] {
  return Array.from(new Set(ids.filter(Boolean))).filter((id) => liveIds.has(id) && !putIds.has(id));
}

function planBoard(checklist: MergeChecklist, data: MergeDataBundle): CategoryPlan {
  const { oldNo, formalNo, snapshot, items } = checklist;
  const item = items.find((i) => i.category === 'board');
  // 快照即迁移基准：即使上次部分执行过，恢复后重试仍只处理该类一次
  const oldBoards = (snapshot.boards as WoodBoard[]).filter((b) => b.guqinNo === oldNo);
  const formalBoards = (snapshot.boards as WoodBoard[]).filter((b) => b.guqinNo === formalNo);
  const liveIds = new Set(data.boards.map((b) => b.id));

  const kept: WoodBoard[] = [];
  const deletes: string[] = [];
  (['面板', '底板'] as const).forEach((part) => {
    const oldRow = oldBoards.find((b) => b.part === part);
    const formalRow = formalBoards.find((b) => b.part === part);
    if (oldRow && formalRow) {
      // 同部位两边都有：以正式号板材为底，厚度按裁决覆盖；旧号板材删除
      const thicknessDecision = item?.conflicts.find((c) => c.key === `board:${part}:thicknessMm`);
      const merged: WoodBoard = { ...formalRow, guqinNo: formalNo };
      if (thicknessDecision) {
        merged.thicknessMm = winnerValue(thicknessDecision, oldRow, formalRow, 'thicknessMm') as number;
      }
      kept.push(merged);
      deletes.push(oldRow.id);
    } else if (oldRow) {
      kept.push({ ...oldRow, guqinNo: formalNo });
    } else if (formalRow) {
      kept.push({ ...formalRow, guqinNo: formalNo });
    }
  });

  // 理论上每部位至多一块；若同号同部位出现多块，保留首块，其余删除，避免唯一部位配对歧义
  const seenPart = new Set<string>();
  const puts = kept.filter((b) => {
    if (seenPart.has(b.part)) {
      deletes.push(b.id);
      return false;
    }
    seenPart.add(b.part);
    return true;
  });

  return {
    category: 'board',
    puts: puts as unknown as Array<{ id: string }>,
    // 删除只针对库里仍存在、且不属本次保留行的 id（重试安全）
    deletes: safeDeletes(deletes, new Set(puts.map((b) => b.id)), liveIds),
  };
}

function planChamber(checklist: MergeChecklist, data: MergeDataBundle): CategoryPlan {
  const { oldNo, formalNo, snapshot, items } = checklist;
  const item = items.find((i) => i.category === 'chamber');
  const oldRow = (snapshot.chambers as SoundChamber[]).find((c) => c.guqinNo === oldNo);
  const formalRow = (snapshot.chambers as SoundChamber[]).find((c) => c.guqinNo === formalNo);
  const liveIds = new Set(data.chambers.map((c) => c.id));

  if (!oldRow && !formalRow) return { category: 'chamber', puts: [], deletes: [] };

  if (oldRow && formalRow) {
    const merged: SoundChamber = { ...formalRow, guqinNo: formalNo };
    CHAMBER_FIELDS.forEach(({ field }) => {
      const decision = item?.conflicts.find((c) => c.field === field);
      if (decision) {
        (merged as unknown as Record<string, unknown>)[field] = winnerValue(
          decision,
          oldRow as unknown as Record<string, unknown>,
          formalRow as unknown as Record<string, unknown>,
          field,
        );
      }
    });
    return {
      category: 'chamber',
      puts: [merged] as unknown as Array<{ id: string }>,
      deletes: safeDeletes([oldRow.id], new Set([merged.id]), liveIds),
    };
  }
  const only = (oldRow ?? formalRow) as SoundChamber;
  return {
    category: 'chamber',
    puts: [{ ...only, guqinNo: formalNo }] as unknown as Array<{ id: string }>,
    deletes: [],
  };
}

function planLacquer(checklist: MergeChecklist, data: MergeDataBundle): CategoryPlan {
  const { oldNo, formalNo, snapshot, items } = checklist;
  const item = items.find((i) => i.category === 'lacquer');
  const oldLayers = (snapshot.lacquers as LacquerLayer[]).filter((l) => l.guqinNo === oldNo);
  const formalLayers = (snapshot.lacquers as LacquerLayer[]).filter((l) => l.guqinNo === formalNo);
  const liveIds = new Set(data.lacquers.map((l) => l.id));

  // 以遍次配对选出幸存记录；同遍相同自动去重，不同按裁决整条选边
  const survivors: LacquerLayer[] = [];
  const deletes: string[] = [];
  const seqs = new Set([...oldLayers.map((l) => l.seq), ...formalLayers.map((l) => l.seq)]);
  seqs.forEach((seq) => {
    const oldRow = oldLayers.find((l) => l.seq === seq);
    const formalRow = formalLayers.find((l) => l.seq === seq);
    if (oldRow && formalRow) {
      const conflict = item?.layerConflicts.find((c) => c.seq === seq);
      if (!conflict) {
        // 完全相同的重复遍：保留正式号那条，旧号那条删除
        survivors.push({ ...formalRow, guqinNo: formalNo });
        deletes.push(oldRow.id);
      } else if (conflict.winner === 'old') {
        // 选旧号记录：复用正式号记录 id（同遍不产生双行），旧行删除
        survivors.push({ ...oldRow, id: formalRow.id, guqinNo: formalNo });
        deletes.push(oldRow.id);
      } else {
        survivors.push({ ...formalRow, guqinNo: formalNo });
        deletes.push(oldRow.id);
      }
    } else if (oldRow) {
      survivors.push({ ...oldRow, guqinNo: formalNo });
    } else if (formalRow) {
      survivors.push({ ...formalRow, guqinNo: formalNo });
    }
  });

  // 重排遍次并按幸存集合重算累计厚度——不读库里现有 totalThickness，杜绝重复加一遍
  const ordered = sortLayers(survivors);
  const recalculated = ordered.map((layer, index) => ({
    ...layer,
    seq: index + 1,
    totalThickness: cumulativeThickness(ordered, index + 1),
  }));

  return {
    category: 'lacquer',
    puts: recalculated as unknown as Array<{ id: string }>,
    deletes: safeDeletes(deletes, new Set(recalculated.map((l) => l.id)), liveIds),
  };
}

function planStringing(checklist: MergeChecklist, data: MergeDataBundle): CategoryPlan {
  const { oldNo, formalNo, snapshot, items } = checklist;
  const item = items.find((i) => i.category === 'stringing');
  const oldRow = (snapshot.stringings as Stringing[]).find((s) => s.guqinNo === oldNo);
  const formalRow = (snapshot.stringings as Stringing[]).find((s) => s.guqinNo === formalNo);
  const liveIds = new Set(data.stringings.map((s) => s.id));

  if (!oldRow && !formalRow) return { category: 'stringing', puts: [], deletes: [] };

  if (oldRow && formalRow) {
    // 非评语字段以正式号为准、旧号兜底；四段评语逐项裁决
    const merged: Stringing = {
      ...oldRow,
      ...formalRow,
      id: formalRow.id,
      guqinNo: formalNo,
      stringType: formalRow.stringType,
      nut: formalRow.nut ?? oldRow.nut,
      stringGap: formalRow.stringGap ?? oldRow.stringGap,
      defects: formalRow.defects.length ? formalRow.defects : oldRow.defects,
      strungAt: formalRow.strungAt,
      operator: formalRow.operator ?? oldRow.operator,
    };
    STRINGING_NOTE_FIELDS.forEach(({ field }) => {
      const decision = item?.conflicts.find((c) => c.field === field);
      if (decision) {
        (merged as unknown as Record<string, unknown>)[field] = winnerValue(
          decision,
          oldRow as unknown as Record<string, unknown>,
          formalRow as unknown as Record<string, unknown>,
          field,
        );
      }
    });
    // 评语版本历史：两边合并按 id 去重、按时间倒序，不伪造新版本
    const versionMap = new Map<string, Stringing['noteVersions'][number]>();
    [...formalRow.noteVersions, ...oldRow.noteVersions].forEach((v) => {
      if (!versionMap.has(v.id)) versionMap.set(v.id, v);
    });
    merged.noteVersions = Array.from(versionMap.values()).sort((a, b) => b.savedAt.localeCompare(a.savedAt));

    return {
      category: 'stringing',
      puts: [merged] as unknown as Array<{ id: string }>,
      deletes: safeDeletes([oldRow.id], new Set([merged.id]), liveIds),
    };
  }
  const only = (oldRow ?? formalRow) as Stringing;
  return {
    category: 'stringing',
    puts: [{ ...only, guqinNo: formalNo }] as unknown as Array<{ id: string }>,
    deletes: [],
  };
}

/**
 * 别名行 upsert：把旧号并入正式号别名（幂等，重复执行不重复追加）。
 * 若旧号本身也是正式号（链式改号），它名下整条别名链一并并入，并删除旧别名行，避免别名断链。
 */
export function planAlias(checklist: MergeChecklist, data: MergeDataBundle): { row: GuqinAlias; deletes: string[] } {
  const { oldNo, formalNo, snapshot } = checklist;
  const current =
    data.aliases.find((a) => a.guqinNo === formalNo)
    ?? (snapshot.aliases as GuqinAlias[]).find((a) => a.guqinNo === formalNo)
    ?? { id: formalNo, guqinNo: formalNo, aliases: [] as string[], updatedAt: '' };
  const oldAsFormal =
    data.aliases.find((a) => a.guqinNo === oldNo)
    ?? (snapshot.aliases as GuqinAlias[]).find((a) => a.guqinNo === oldNo);
  const inherited = oldAsFormal ? oldAsFormal.aliases : [];
  const aliases = Array.from(new Set([...current.aliases, ...inherited, oldNo])).filter((a) => a !== formalNo);
  const row: GuqinAlias = { id: formalNo, guqinNo: formalNo, aliases, updatedAt: new Date().toISOString() };
  const liveAliasIds = new Set(data.aliases.map((a) => a.id));
  const deletes = oldAsFormal && oldAsFormal.id !== row.id && liveAliasIds.has(oldAsFormal.id) ? [oldAsFormal.id] : [];
  return { row, deletes };
}

export function planCategory(checklist: MergeChecklist, data: MergeDataBundle, category: MergeCategory): CategoryPlan {
  switch (category) {
    case 'board':
      return planBoard(checklist, data);
    case 'chamber':
      return planChamber(checklist, data);
    case 'lacquer':
      return planLacquer(checklist, data);
    case 'stringing':
      return planStringing(checklist, data);
  }
}

/* ------------------------------------------------------------------ */
/* 恢复：按清单快照把相关表还原到生成清单时的状态                       */
/* ------------------------------------------------------------------ */

/** 还原单表：清掉当前旧号/正式号相关行，写回快照行 */
export function restoreTableRows<T extends { id: string; guqinNo: string }>(
  current: T[],
  snapshotRows: T[],
  oldNo: string,
  formalNo: string,
): { restorePuts: T[]; restoreDeletes: string[] } {
  const restoreDeletes = current.filter((r) => r.guqinNo === oldNo || r.guqinNo === formalNo).map((r) => r.id);
  return { restorePuts: JSON.parse(JSON.stringify(snapshotRows)) as T[], restoreDeletes };
}

/** 供执行器使用的恢复操作描述（puts/deletes 分表给出） */
export function restoreOps(checklist: MergeChecklist, data: MergeDataBundle) {
  const { oldNo, formalNo, snapshot } = checklist;
  const board = restoreTableRows(data.boards, snapshot.boards as WoodBoard[], oldNo, formalNo);
  const chamber = restoreTableRows(data.chambers, snapshot.chambers as SoundChamber[], oldNo, formalNo);
  const lacquer = restoreTableRows(data.lacquers, snapshot.lacquers as LacquerLayer[], oldNo, formalNo);
  const stringing = restoreTableRows(data.stringings, snapshot.stringings as Stringing[], oldNo, formalNo);
  return {
    boards: { puts: board.restorePuts, deletes: board.restoreDeletes },
    chambers: { puts: chamber.restorePuts, deletes: chamber.restoreDeletes },
    lacquers: { puts: lacquer.restorePuts, deletes: lacquer.restoreDeletes },
    stringings: { puts: stringing.restorePuts, deletes: stringing.restoreDeletes },
    aliases: {
      puts: JSON.parse(JSON.stringify(snapshot.aliases)) as GuqinAlias[],
      // 删除当前库中所有被快照涉及的别名行（含旧号自身是正式号的链式行），再整体写回快照
      deletes: data.aliases
        .filter(
          (a) =>
            a.guqinNo === formalNo ||
            a.guqinNo === oldNo ||
            a.aliases.includes(oldNo) ||
            (snapshot.aliases as GuqinAlias[]).some((s) => s.id === a.id),
        )
        .map((a) => a.id),
    },
  };
}

/* ------------------------------------------------------------------ */
/* 建议：哪些琴号疑似临时旧号（有非板材工序、且没有面板底板配对）       */
/* ------------------------------------------------------------------ */

export interface PendingSuggestion {
  oldNo: string;
  chamberCount: number;
  lacquerCount: number;
  stringingCount: number;
  boardCount: number;
  paired: boolean;
}

export function suggestOldNos(data: MergeDataBundle): PendingSuggestion[] {
  const aliasIndex = new Map<string, string>();
  data.aliases.forEach((row) => row.aliases.forEach((alias) => aliasIndex.set(alias, row.guqinNo)));

  const nos = new Set<string>();
  data.chambers.forEach((c) => nos.add(c.guqinNo));
  data.lacquers.forEach((l) => nos.add(l.guqinNo));
  data.stringings.forEach((s) => nos.add(s.guqinNo));
  data.boards.forEach((b) => nos.add(b.guqinNo));

  const result: PendingSuggestion[] = [];
  nos.forEach((no) => {
    if (aliasIndex.has(no)) return; // 已经是旧号别名
    const boards = data.boards.filter((b) => b.guqinNo === no);
    const parts = new Set(boards.map((b) => b.part));
    const paired = parts.has('面板') && parts.has('底板');
    const chamberCount = data.chambers.filter((c) => c.guqinNo === no).length;
    const lacquerCount = data.lacquers.filter((l) => l.guqinNo === no).length;
    const stringingCount = data.stringings.filter((s) => s.guqinNo === no).length;
    // 改号只动板材的典型特征：槽腹/髹漆/上弦挂着，但板材未配对
    if (!paired && (chamberCount || lacquerCount || stringingCount)) {
      result.push({ oldNo: no, chamberCount, lacquerCount, stringingCount, boardCount: boards.length, paired });
    }
  });
  return result.sort((a, b) => a.oldNo.localeCompare(b.oldNo));
}
