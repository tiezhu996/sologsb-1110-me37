/** 琴号别名：正式琴号与改号前旧号（临时琴号）的映射。
 * 旧号只作为可搜索别名保留，四类工序数据一律挂正式琴号。 */
export interface GuqinAlias {
  /** 固定为 guqinNo，每个正式琴号一条 */
  id: string;
  /** 正式琴号 */
  guqinNo: string;
  /** 历史旧号（临时琴号），合档时写入；可多次合档追加 */
  aliases: string[];
  updatedAt: string;
}

/** 合档数据来源侧 */
export type MergeSide = 'old' | 'formal';

/** 四类旧数据 */
export type MergeCategory = 'board' | 'chamber' | 'lacquer' | 'stringing';

/** 待裁决字段 */
export interface MergeFieldDecision {
  /** 条目内稳定唯一 key（如 board:面板:thicknessMm / chamber:nayinThickness） */
  key: string;
  /** 字段 key（板材用 面板厚度/底板厚度，槽腹用具体尺寸字段，上弦用三段评语+九德） */
  field: string;
  /** 展示名 */
  label: string;
  oldValue: string;
  formalValue: string;
  /** 裁决保留哪边；未裁决前为 null，禁止执行迁移 */
  winner: MergeSide | null;
}

/** 髹漆遍次冲突：同一遍次两边都有但内容不同，整条选保留哪边 */
export interface MergeLayerConflict {
  /** 稳定 key：lacquer:seq:n */
  key: string;
  seq: number;
  oldSummary: string;
  formalSummary: string;
  winner: MergeSide | null;
}

/** 单个合档条目（一类数据一份） */
export interface MergeItem {
  category: MergeCategory;
  /** 稳定条目 id */
  key: string;
  title: string;
  /** 无冲突的单边迁移条目自动解决；双边有差异则等待逐项裁决 */
  conflicts: MergeFieldDecision[];
  layerConflicts: MergeLayerConflict[];
  resolved: boolean;
  status: 'pending' | 'done' | 'failed';
  /** 最近一次失败原因（迁移失败后保留，供重试参考） */
  error?: string;
}

/** 执行前对相关行的整表快照（深拷贝），迁移失败后据此恢复 */
export interface MergeSnapshot {
  boards: unknown[];
  chambers: unknown[];
  lacquers: unknown[];
  stringings: unknown[];
  aliases: unknown[];
}

/** 合档核对清单：生成即落 meta，之后任何一步都可从它恢复/继续 */
export interface MergeChecklist {
  id: string;
  oldNo: string;
  formalNo: string;
  createdAt: string;
  updatedAt: string;
  items: MergeItem[];
  /** 生成清单瞬间四类表中与旧号/正式号相关的全部行，恢复用 */
  snapshot: MergeSnapshot;
}
