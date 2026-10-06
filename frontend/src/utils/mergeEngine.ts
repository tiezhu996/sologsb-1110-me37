import type { WoodBoard } from '../types/wood-board';
import type { SoundChamber } from '../types/sound-chamber';
import type { LacquerLayer } from '../types/lacquer-layer';
import type { Stringing, ToneVersion } from '../types/stringing';
import { sortLayers } from './layer';
import type {
  CategorySnapshot,
  GuqinMergePlan,
  GuqinSnapshot,
  MergeCategory,
  MergeItem,
  MergeSide,
  ResolvedMerge,
} from '../types/merge';

export const MERGE_CATEGORY_LABELS: Record<MergeCategory, string> = {
  board: '板材厚度',
  chamber: '槽腹尺寸',
  lacquer: '髹漆遍次',
  stringing: '上弦评语',
};

/** 板材按「板材号」稳定排序，保证清单展示可复现 */
function sortBoards(boards: WoodBoard[]): WoodBoard[] {
  return [...boards].sort((a, b) => a.boardNo.localeCompare(b.boardNo) || a.id.localeCompare(b.id));
}

/**
 * 板材合档：按部位（面板/底板）配对，同部位两块板材时逐项（以厚度为准）选保留哪一边；
 * 仅一边有的板材自动迁入正式号；同部位多出的板材全部保留、改挂正式号。
 */
export function buildBoardItems(snap: CategorySnapshot<WoodBoard>): MergeItem[] {
  const items: MergeItem[] = [];
  const parts = ['面板', '底板'] as const;

  parts.forEach((part) => {
    const oldBoards = sortBoards(snap.old.filter((b) => b.part === part));
    const newBoards = sortBoards(snap.new.filter((b) => b.part === part));
    const [oldFirst, ...oldRest] = oldBoards;
    const [newFirst, ...newRest] = newBoards;

    if (oldFirst && newFirst) {
      const conflict = oldFirst.thicknessMm !== newFirst.thicknessMm;
      items.push({
        id: `board:${part}`,
        category: 'board',
        group: part,
        label: `${part}厚度（保留整块板材，以厚度为准）`,
        status: conflict ? 'conflict' : 'auto',
        oldValue: `${oldFirst.boardNo} · ${oldFirst.species} · ${oldFirst.thicknessMm}mm`,
        newValue: `${newFirst.boardNo} · ${newFirst.species} · ${newFirst.thicknessMm}mm`,
        decision: 'new',
        hint: conflict ? undefined : '两边厚度一致，默认保留正式号板材，旧号板材退为历史记录',
      });
    } else if (oldFirst && !newFirst) {
      items.push({
        id: `board:${part}`,
        category: 'board',
        group: part,
        label: `${part}（仅旧号有）`,
        status: 'auto',
        oldValue: `${oldFirst.boardNo} · ${oldFirst.thicknessMm}mm`,
        decision: 'old',
        hint: '正式号缺该部位，整块迁入正式琴号',
      });
    } else if (newFirst && !oldFirst) {
      items.push({
        id: `board:${part}`,
        category: 'board',
        group: part,
        label: `${part}（仅正式号有）`,
        status: 'auto',
        newValue: `${newFirst.boardNo} · ${newFirst.thicknessMm}mm`,
        decision: 'new',
        hint: '正式号已登记，保留',
      });
    }

    [...oldRest, ...newRest].forEach((board) => {
      const side: MergeSide = oldRest.includes(board) ? 'old' : 'new';
      items.push({
        id: `board:extra:${board.id}`,
        category: 'board',
        group: part,
        label: `多余${part} ${board.boardNo}`,
        status: 'auto',
        oldValue: side === 'old' ? `${board.boardNo} · ${board.thicknessMm}mm` : undefined,
        newValue: side === 'new' ? `${board.boardNo} · ${board.thicknessMm}mm` : undefined,
        decision: side,
        hint: '同部位多出的板材保留，改挂正式琴号',
      });
    });
  });

  return items;
}

interface ChamberFieldDescriptor {
  key: keyof Pick<
    SoundChamber,
    | 'nayinThickness'
    | 'longchiThickness'
    | 'fengzhaoThickness'
    | 'chamberDepth'
    | 'postPos'
    | 'poolSize'
  >;
  label: string;
  /** 三处厚度与槽腹深度为尺寸项，必须逐项裁决 */
  dimension: boolean;
}

const CHAMBER_FIELDS: ChamberFieldDescriptor[] = [
  { key: 'nayinThickness', label: '纳音处面板厚度(mm)', dimension: true },
  { key: 'longchiThickness', label: '龙池处面板厚度(mm)', dimension: true },
  { key: 'fengzhaoThickness', label: '凤沼处面板厚度(mm)', dimension: true },
  { key: 'chamberDepth', label: '槽腹深度(mm)', dimension: true },
  { key: 'postPos', label: '天地柱位置', dimension: false },
  { key: 'poolSize', label: '龙池凤沼尺寸', dimension: false },
];

/** 槽腹合档：每张琴一条记录，尺寸/字段逐字段选保留旧号还是正式号 */
export function buildChamberItems(snap: CategorySnapshot<SoundChamber>): MergeItem[] {
  const items: MergeItem[] = [];
  const oldChamber = snap.old[0];
  const newChamber = snap.new[0];

  if (oldChamber && newChamber) {
    CHAMBER_FIELDS.forEach((field) => {
      const oldVal = oldChamber[field.key];
      const newVal = newChamber[field.key];
      const same = String(oldVal) === String(newVal);
      items.push({
        id: `chamber:${field.key}`,
        category: 'chamber',
        group: '槽腹尺寸',
        label: field.label,
        status: same ? 'auto' : 'conflict',
        oldValue: String(oldVal),
        newValue: String(newVal),
        decision: 'new',
        hint: same ? '两边一致' : field.dimension ? undefined : '非尺寸项，默认取正式号，可改选旧号',
      });
    });
  } else if (oldChamber && !newChamber) {
    CHAMBER_FIELDS.forEach((field) => {
      items.push({
        id: `chamber:${field.key}`,
        category: 'chamber',
        group: '槽腹尺寸',
        label: field.label,
        status: 'auto',
        oldValue: String(oldChamber[field.key]),
        decision: 'old',
        hint: '正式号无槽腹记录，整条迁入',
      });
    });
  } else if (newChamber && !oldChamber) {
    CHAMBER_FIELDS.forEach((field) => {
      items.push({
        id: `chamber:${field.key}`,
        category: 'chamber',
        group: '槽腹尺寸',
        label: field.label,
        status: 'auto',
        newValue: String(newChamber[field.key]),
        decision: 'new',
        hint: '正式号已有槽腹记录，保留',
      });
    });
  }

  return items;
}

/** 髹漆合档：按遍次（seq）配对，同一遍两边都有则选保留哪条；只一边有的遍次自动保留。绝不重复累加。 */
export function buildLacquerItems(snap: CategorySnapshot<LacquerLayer>): MergeItem[] {
  const items: MergeItem[] = [];
  const oldBySeq = new Map(sortLayers(snap.old).map((l) => [l.seq, l]));
  const newBySeq = new Map(sortLayers(snap.new).map((l) => [l.seq, l]));
  const seqs = Array.from(new Set([...oldBySeq.keys(), ...newBySeq.keys()])).sort((a, b) => a - b);

  seqs.forEach((seq) => {
    const oldLayer = oldBySeq.get(seq);
    const newLayer = newBySeq.get(seq);
    if (oldLayer && newLayer) {
      const same =
        oldLayer.layerThickness === newLayer.layerThickness &&
        oldLayer.mixRatio === newLayer.mixRatio &&
        oldLayer.curingTemp === newLayer.curingTemp &&
        oldLayer.curingHumidity === newLayer.curingHumidity &&
        oldLayer.polishGrit === newLayer.polishGrit;
      items.push({
        id: `lacquer:${seq}`,
        category: 'lacquer',
        group: `第 ${seq} 遍`,
        label: `第 ${seq} 遍（${formatDateShort(oldLayer.appliedAt)} / ${formatDateShort(newLayer.appliedAt)}）`,
        status: same ? 'auto' : 'conflict',
        oldValue: formatLayer(oldLayer),
        newValue: formatLayer(newLayer),
        decision: 'new',
        hint: same ? '两边该遍记录一致，去重保留一条' : undefined,
      });
    } else {
      const layer = oldLayer ?? newLayer!;
      const side: MergeSide = oldLayer ? 'old' : 'new';
      items.push({
        id: `lacquer:${seq}`,
        category: 'lacquer',
        group: `第 ${seq} 遍`,
        label: `第 ${seq} 遍（仅${side === 'old' ? '旧号' : '正式号'}有）`,
        status: 'auto',
        oldValue: oldLayer ? formatLayer(oldLayer) : undefined,
        newValue: newLayer ? formatLayer(newLayer) : undefined,
        decision: side,
        hint: '该遍只有一边记录，保留并重新连续编号',
      });
    }
  });

  return items;
}

function formatLayer(layer: LacquerLayer): string {
  return `${layer.mixRatio} · 本遍 ${layer.layerThickness}mm · ${layer.curingTemp}℃/${layer.curingHumidity}% · ${layer.polishGrit} 目 · ${formatDateShort(layer.appliedAt)} ${layer.operator}`;
}

function formatDateShort(iso: string): string {
  return iso.slice(0, 10);
}

interface StringFieldDescriptor {
  key: keyof Pick<
    Stringing,
    | 'stringType'
    | 'nut'
    | 'stringGap'
    | 'sanNote'
    | 'anNote'
    | 'fanNote'
    | 'nineVirtues'
    | 'strungAt'
    | 'operator'
  >;
  label: string;
  /** 评语字段必须逐项裁决；工艺字段默认取正式号 */
  note: boolean;
}

const STRINGING_FIELDS: StringFieldDescriptor[] = [
  { key: 'sanNote', label: '散音评语', note: true },
  { key: 'anNote', label: '按音评语', note: true },
  { key: 'fanNote', label: '泛音评语', note: true },
  { key: 'nineVirtues', label: '九德简述', note: true },
  { key: 'stringType', label: '弦材质', note: false },
  { key: 'nut', label: '雁足与绒扣', note: false },
  { key: 'stringGap', label: '弦距(mm)', note: false },
  { key: 'strungAt', label: '上弦日期', note: false },
  { key: 'operator', label: '上弦人', note: false },
];

/** 上弦合档：每张琴一条记录，三段评语与九德逐项选边；评语历史版本两边合并、去重 */
export function buildStringingItems(snap: CategorySnapshot<Stringing>): MergeItem[] {
  const items: MergeItem[] = [];
  const oldS = snap.old[0];
  const newS = snap.new[0];

  STRINGING_FIELDS.forEach((field) => {
    if (oldS && newS) {
      const same = String(oldS[field.key]) === String(newS[field.key]);
      items.push({
        id: `stringing:${field.key}`,
        category: 'stringing',
        group: '上弦与评语',
        label: field.label,
        status: same ? 'auto' : 'conflict',
        oldValue: String(oldS[field.key]),
        newValue: String(newS[field.key]),
        decision: 'new',
        hint: same ? '两边一致' : field.note ? undefined : '非评语字段，默认取正式号，可改选旧号',
      });
    } else if (oldS && !newS) {
      items.push({
        id: `stringing:${field.key}`,
        category: 'stringing',
        group: '上弦与评语',
        label: field.label,
        status: 'auto',
        oldValue: String(oldS[field.key]),
        decision: 'old',
        hint: '正式号无上弦记录，整条迁入（含评语版本）',
      });
    } else if (newS && !oldS) {
      items.push({
        id: `stringing:${field.key}`,
        category: 'stringing',
        group: '上弦与评语',
        label: field.label,
        status: 'auto',
        newValue: String(newS[field.key]),
        decision: 'new',
        hint: '正式号已有上弦记录，保留',
      });
    }
  });

  return items;
}

/** 缺陷标记展示（合档时优先保留有具体缺陷的一边） */
export function buildDefectItem(snap: CategorySnapshot<Stringing>): MergeItem | null {
  const oldS = snap.old[0];
  const newS = snap.new[0];
  if (!oldS && !newS) return null;
  const realDefects = (s: Stringing) => s.defects.filter((d) => d !== '无');
  if (oldS && newS) {
    const o = realDefects(oldS).join('、') || '无';
    const n = realDefects(newS).join('、') || '无';
    const same = o === n;
    return {
      id: 'stringing:defects',
      category: 'stringing',
      group: '上弦与评语',
      label: '缺陷标记',
      status: same ? 'auto' : 'conflict',
      oldValue: o,
      newValue: n,
      decision: realDefects(newS).length >= realDefects(oldS).length ? 'new' : 'old',
      hint: same ? '两边一致' : '默认保留缺陷记录更全的一边',
    };
  }
  const side: MergeSide = oldS ? 'old' : 'new';
  const s = oldS ?? newS!;
  return {
    id: 'stringing:defects',
    category: 'stringing',
    group: '上弦与评语',
    label: '缺陷标记',
    status: 'auto',
    oldValue: oldS ? realDefects(s).join('、') || '无' : undefined,
    newValue: newS ? realDefects(s).join('、') || '无' : undefined,
    decision: side,
    hint: '仅一边有上弦记录',
  };
}

/** 从四张表快照构建合档方案（含核对清单） */
export function buildMergePlan(snapshot: Omit<GuqinSnapshot, 'takenAt'>, now: Date = new Date()): GuqinMergePlan {
  const items: MergeItem[] = [
    ...buildBoardItems(snapshot.boards),
    ...buildChamberItems(snapshot.chambers),
    ...buildLacquerItems(snapshot.lacquers),
    ...buildStringingItems(snapshot.stringings),
  ];
  const defectItem = buildDefectItem(snapshot.stringings);
  if (defectItem) items.push(defectItem);

  // auto 项视为已确认；conflict 项虽带默认建议值（取正式号），仍须档案员显式确认后才能落库
  items.forEach((item) => {
    item.confirmed = item.status === 'auto' ? true : (item.confirmed ?? false);
  });

  return {
    oldNo: snapshot.oldNo,
    newNo: snapshot.newNo,
    createdAt: now.toISOString(),
    snapshot: { ...snapshot, takenAt: now.toISOString() },
    items,
  };
}

/**
 * 未裁决的冲突项：auto 项自动放行；conflict 项即使有默认建议值，
 * 也必须由档案员显式确认（confirmed）后才算裁决。
 */
export function unresolvedItems(plan: GuqinMergePlan): MergeItem[] {
  return plan.items.filter((item) => item.status === 'conflict' && !item.confirmed);
}

/** 未裁决冲突项数量（页面与落库闸门共用） */
export function pendingAdjudications(plan: GuqinMergePlan): number {
  return unresolvedItems(plan).length;
}

export function categoryStats(plan: GuqinMergePlan): Record<MergeCategory, { total: number; conflicts: number }> {
  const stats: Record<MergeCategory, { total: number; conflicts: number }> = {
    board: { total: 0, conflicts: 0 },
    chamber: { total: 0, conflicts: 0 },
    lacquer: { total: 0, conflicts: 0 },
    stringing: { total: 0, conflicts: 0 },
  };
  plan.items.forEach((item) => {
    stats[item.category].total += 1;
    if (item.status === 'conflict') stats[item.category].conflicts += 1;
  });
  return stats;
}

function decisionOf(plan: GuqinMergePlan, itemId: string): MergeSide {
  const item = plan.items.find((i) => i.id === itemId);
  if (!item) throw new Error(`清单项不存在：${itemId}`);
  if (item.status === 'conflict' && !item.confirmed) {
    throw new Error(`清单项未裁决：${itemId}`);
  }
  if (!item.decision) throw new Error(`清单项缺少裁决：${itemId}`);
  return item.decision;
}

/**
 * 根据裁决结果推导最终落库行。
 * 髹漆遍次合并后统一重新连续编号并重算累计厚度，任何一条只计入一次。
 */
export function resolveMerge(plan: GuqinMergePlan): ResolvedMerge {
  if (unresolvedItems(plan).length > 0) {
    throw new Error('尚有冲突项未裁决，不得落库');
  }

  const { snapshot } = plan;

  // 板材
  const keptBoards: WoodBoard[] = [];
  (['面板', '底板'] as const).forEach((part) => {
    const item = plan.items.find((i) => i.id === `board:${part}`);
    if (!item) return;
    const side = decisionOf(plan, item.id);
    const source =
      side === 'old'
        ? sortBoards(snapshot.boards.old.filter((b) => b.part === part))[0]
        : sortBoards(snapshot.boards.new.filter((b) => b.part === part))[0];
    if (source) keptBoards.push({ ...source, guqinNo: plan.newNo });

    // 多余板材（同部位第二块及以后）按各自裁决保留并改挂正式号
    const oldRest = sortBoards(snapshot.boards.old.filter((b) => b.part === part)).slice(1);
    const newRest = sortBoards(snapshot.boards.new.filter((b) => b.part === part)).slice(1);
    [...oldRest, ...newRest].forEach((board) => {
      const extraDecision = decisionOf(plan, `board:extra:${board.id}`);
      const fromOld = oldRest.some((b) => b.id === board.id);
      if ((fromOld && extraDecision === 'old') || (!fromOld && extraDecision === 'new')) {
        keptBoards.push({ ...board, guqinNo: plan.newNo });
      }
    });
  });

  // 槽腹
  let chamber: SoundChamber | undefined;
  if (snapshot.chambers.old[0] || snapshot.chambers.new[0]) {
    const base = snapshot.chambers.new[0] ?? snapshot.chambers.old[0]!;
    const merged: SoundChamber = { ...base, id: base.id, guqinNo: plan.newNo };
    CHAMBER_FIELDS.forEach((field) => {
      const side = decisionOf(plan, `chamber:${field.key}`);
      const source = side === 'old' ? snapshot.chambers.old[0] : snapshot.chambers.new[0];
      if (source) (merged as unknown as Record<string, unknown>)[field.key] = source[field.key];
    });
    // 掏膛人 / 备注随字段裁决之外的元信息：正式号有则保留，否则取旧号
    const metaSource = snapshot.chambers.new[0] ?? snapshot.chambers.old[0]!;
    merged.carver = metaSource.carver;
    merged.remark = metaSource.remark;
    merged.carvedAt = metaSource.carvedAt;
    chamber = merged;
  }

  // 髹漆：按 seq 选条 → 按施工日期重排 → 重新连续编号 → 重算累计厚度
  const pickedLayers: LacquerLayer[] = [];
  const oldBySeq = new Map(snapshot.lacquers.old.map((l) => [l.seq, l]));
  const newBySeq = new Map(snapshot.lacquers.new.map((l) => [l.seq, l]));
  const seqs = Array.from(new Set([...oldBySeq.keys(), ...newBySeq.keys()])).sort((a, b) => a - b);
  seqs.forEach((seq) => {
    const side = decisionOf(plan, `lacquer:${seq}`);
    const source = side === 'old' ? oldBySeq.get(seq) : newBySeq.get(seq);
    if (source) pickedLayers.push({ ...source, guqinNo: plan.newNo });
  });
  const ordered = [...pickedLayers].sort(
    (a, b) => new Date(a.appliedAt).getTime() - new Date(b.appliedAt).getTime() || a.id.localeCompare(b.id),
  );
  const lacquers: LacquerLayer[] = ordered.map((layer, index) => {
    // 按新的连续顺序逐遍累加（此时 ordered 仍带旧 seq，不能用 seq 过滤，否则会漏算）
    const sum = ordered.slice(0, index + 1).reduce((acc, item) => acc + (Number(item.layerThickness) || 0), 0);
    return {
      ...layer,
      guqinNo: plan.newNo,
      seq: index + 1,
      totalThickness: Number(sum.toFixed(3)),
    };
  });

  // 上弦
  let stringing: Stringing | undefined;
  if (snapshot.stringings.old[0] || snapshot.stringings.new[0]) {
    const base = snapshot.stringings.new[0] ?? snapshot.stringings.old[0]!;
    const merged: Stringing = { ...base, id: base.id, guqinNo: plan.newNo, noteVersions: [] };
    STRINGING_FIELDS.forEach((field) => {
      const side = decisionOf(plan, `stringing:${field.key}`);
      const source = side === 'old' ? snapshot.stringings.old[0] : snapshot.stringings.new[0];
      if (source) (merged as unknown as Record<string, unknown>)[field.key] = source[field.key];
    });
    const defectDecision = decisionOf(plan, 'stringing:defects');
    const defectSource = defectDecision === 'old' ? snapshot.stringings.old[0] : snapshot.stringings.new[0];
    merged.defects = defectSource ? [...defectSource.defects] : ['无'];
    if (merged.defects.length === 0) merged.defects = ['无'];

    // 评语历史版本两边合并、去重（最新在前），迁移不新增版本
    const versionMap = new Map<string, ToneVersion>();
    [...(snapshot.stringings.new[0]?.noteVersions ?? []), ...(snapshot.stringings.old[0]?.noteVersions ?? [])].forEach(
      (v) => versionMap.set(v.id, v),
    );
    merged.noteVersions = Array.from(versionMap.values()).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    stringing = merged;
  }

  return { boards: sortBoards(keptBoards), chamber, lacquers, stringing };
}
