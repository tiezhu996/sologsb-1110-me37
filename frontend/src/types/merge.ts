import type { WoodBoard } from './wood-board';
import type { SoundChamber } from './sound-chamber';
import type { LacquerLayer } from './lacquer-layer';
import type { Stringing } from './stringing';

/** 合档四类旧数据 */
export type MergeCategory = 'board' | 'chamber' | 'lacquer' | 'stringing';

/** 保留哪一边：旧号（临时琴号）/ 正式琴号 */
export type MergeSide = 'old' | 'new';

/** 清单项状态：auto 可自动定夺，conflict 必须人工裁决 */
export type MergeItemStatus = 'auto' | 'conflict';

/** 某类数据在旧号与正式号两边的快照 */
export interface CategorySnapshot<T> {
  old: T[];
  new: T[];
}

/** 合档发起时的全量快照（核对清单的恢复依据，落库到 meta） */
export interface GuqinSnapshot {
  oldNo: string;
  newNo: string;
  takenAt: string;
  boards: CategorySnapshot<WoodBoard>;
  chambers: CategorySnapshot<SoundChamber>;
  lacquers: CategorySnapshot<LacquerLayer>;
  stringings: CategorySnapshot<Stringing>;
}

/** 核对清单项：逐项记录两边取值与裁决结果 */
export interface MergeItem {
  id: string;
  category: MergeCategory;
  /** 分组标题（如「面板」「第 2 遍」「散音评语」） */
  group: string;
  /** 字段/条目标题 */
  label: string;
  status: MergeItemStatus;
  /** 旧号一边的展示值 */
  oldValue?: string;
  /** 正式号一边的展示值 */
  newValue?: string;
  /** auto 项为预填裁决；conflict 项未裁决前为 undefined */
  decision?: MergeSide;
  /** 冲突项是否已由档案员显式确认（auto 项归一化为 true，conflict 项初始 false）；未确认的冲突项禁止落库 */
  confirmed?: boolean;
  /** 自动定夺原因（冲突项为空） */
  hint?: string;
}

/** 合档方案（快照 + 核对清单） */
export interface GuqinMergePlan {
  oldNo: string;
  newNo: string;
  createdAt: string;
  snapshot: GuqinSnapshot;
  items: MergeItem[];
}

/** 持久化的核对清单，带分阶段检查点 */
export interface MergeChecklist {
  id: string;
  state: 'pending' | 'committing' | 'failed' | 'done';
  createdAt: string;
  updatedAt: string;
  /** 已成功提交的类别（重试时跳过） */
  doneCategories: MergeCategory[];
  lastError?: string;
  plan: GuqinMergePlan;
}

/** 合档推导出的四张表最终行 */
export interface ResolvedMerge {
  boards: WoodBoard[];
  chamber?: SoundChamber;
  lacquers: LacquerLayer[];
  stringing?: Stringing;
}
