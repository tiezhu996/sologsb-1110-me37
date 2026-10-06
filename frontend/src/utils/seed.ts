import { db } from './db';
import type { WoodBoard } from '../types/wood-board';
import type { SoundChamber } from '../types/sound-chamber';
import type { LacquerLayer } from '../types/lacquer-layer';
import type { Stringing } from '../types/stringing';
import { cumulativeThickness } from './layer';

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

/** 示例琴坯：6 个琴号（Q-2506 与临时号 临-2506 待合档）、14 块板材 */
export const SEED_BOARDS: WoodBoard[] = [
  { id: 'board-001', boardNo: 'MB-2501', guqinNo: 'Q-2501', part: '面板', species: '桐木', dryYears: 8, thicknessMm: 32, grain: '直纹', defect: '无', receivedAt: daysAgo(120), remark: '河南兰考桐' },
  { id: 'board-002', boardNo: 'MB-2502', guqinNo: 'Q-2501', part: '底板', species: '梓木', dryYears: 6, thicknessMm: 18, grain: '直纹', defect: '无', receivedAt: daysAgo(118) },
  { id: 'board-003', boardNo: 'MB-2503', guqinNo: 'Q-2502', part: '面板', species: '杉木', dryYears: 12, thicknessMm: 30, grain: '水波纹', defect: '无', receivedAt: daysAgo(110), remark: '川杉，纹路佳' },
  { id: 'board-004', boardNo: 'MB-2504', guqinNo: 'Q-2502', part: '底板', species: '梓木', dryYears: 7, thicknessMm: 17, grain: '直纹', defect: '节疤', receivedAt: daysAgo(108) },
  { id: 'board-005', boardNo: 'MB-2505', guqinNo: 'Q-2503', part: '面板', species: '桐木', dryYears: 5, thicknessMm: 31, grain: '直纹', defect: '无', receivedAt: daysAgo(96) },
  { id: 'board-006', boardNo: 'MB-2506', guqinNo: 'Q-2503', part: '底板', species: '杉木', dryYears: 5, thicknessMm: 18, grain: '直纹', defect: '无', receivedAt: daysAgo(95) },
  { id: 'board-007', boardNo: 'MB-2507', guqinNo: 'Q-2504', part: '面板', species: '杉木', dryYears: 15, thicknessMm: 33, grain: '水波纹', defect: '无', receivedAt: daysAgo(80), remark: '老房料' },
  { id: 'board-008', boardNo: 'MB-2508', guqinNo: 'Q-2504', part: '底板', species: '梓木', dryYears: 9, thicknessMm: 19, grain: '直纹', defect: '无', receivedAt: daysAgo(78) },
  { id: 'board-009', boardNo: 'MB-2509', guqinNo: 'Q-2505', part: '面板', species: '桐木', dryYears: 2, thicknessMm: 29, grain: '直纹', defect: '裂纹', receivedAt: daysAgo(30), remark: '阴干不足且有裂纹，待退料' },
  { id: 'board-010', boardNo: 'MB-2510', guqinNo: 'Q-2505', part: '底板', species: '梓木', dryYears: 4, thicknessMm: 17, grain: '直纹', defect: '无', receivedAt: daysAgo(28) },
  // Q-2506：面板底板已配对并改挂正式琴号；临-2506 是改号前的临时琴号，旧板材数据仍在（厚度与正式号不同），待合档
  { id: 'board-011', boardNo: 'MB-2511', guqinNo: 'Q-2506', part: '面板', species: '桐木', dryYears: 6, thicknessMm: 30, grain: '直纹', defect: '无', receivedAt: daysAgo(70), remark: '配对后刨去 1mm' },
  { id: 'board-012', boardNo: 'MB-2512', guqinNo: 'Q-2506', part: '底板', species: '梓木', dryYears: 5, thicknessMm: 17, grain: '直纹', defect: '无', receivedAt: daysAgo(69) },
  { id: 'board-013', boardNo: 'MB-2513', guqinNo: '临-2506', part: '面板', species: '桐木', dryYears: 6, thicknessMm: 31, grain: '直纹', defect: '无', receivedAt: daysAgo(72), remark: '改号前登记的临时厚度' },
  { id: 'board-014', boardNo: 'MB-2514', guqinNo: '临-2506', part: '底板', species: '梓木', dryYears: 5, thicknessMm: 16.5, grain: '直纹', defect: '无', receivedAt: daysAgo(71) },
];

export const SEED_CHAMBERS: SoundChamber[] = [
  { id: 'chamber-001', guqinNo: 'Q-2501', nayinThickness: 16, longchiThickness: 14, fengzhaoThickness: 15, chamberDepth: 26, postPos: '天柱中', poolSize: '200×22', carvedAt: daysAgo(88), carver: '周砚秋', remark: '纳音略厚，出音偏沉' },
  { id: 'chamber-002', guqinNo: 'Q-2502', nayinThickness: 14, longchiThickness: 12, fengzhaoThickness: 13, chamberDepth: 28, postPos: '天柱偏左', poolSize: '210×24', carvedAt: daysAgo(76), carver: '周砚秋' },
  { id: 'chamber-003', guqinNo: 'Q-2503', nayinThickness: 15, longchiThickness: 13, fengzhaoThickness: 14, chamberDepth: 25, postPos: '天柱偏右', poolSize: '195×21', carvedAt: daysAgo(60), carver: '林听雪' },
  { id: 'chamber-004', guqinNo: 'Q-2504', nayinThickness: 17, longchiThickness: 15, fengzhaoThickness: 16, chamberDepth: 24, postPos: '天柱中', poolSize: '215×25', carvedAt: daysAgo(44), carver: '林听雪', remark: '老料槽腹留厚' },
  // Q-2506 / 临-2506 两边各一份槽腹记录，纳音厚度与槽腹深度不同（合档时逐项裁决）
  { id: 'chamber-005', guqinNo: 'Q-2506', nayinThickness: 15, longchiThickness: 13, fengzhaoThickness: 14, chamberDepth: 25, postPos: '天柱中', poolSize: '205×23', carvedAt: daysAgo(52), carver: '周砚秋', remark: '复掏后记录' },
  { id: 'chamber-006', guqinNo: '临-2506', nayinThickness: 16, longchiThickness: 13, fengzhaoThickness: 14, chamberDepth: 27, postPos: '天柱偏左', poolSize: '205×23', carvedAt: daysAgo(55), carver: '周砚秋', remark: '初次掏膛' },
];

function buildSeedLayers(): LacquerLayer[] {
  const plan: Array<[string, string, number, number, number, number, number, string]> = [
    // guqinNo, mixRatio, temp, humidity, grit, thicknessMm, daysAgo, operator
    ['Q-2501', '1:1', 24, 78, 240, 0.12, 70, '林听雪'],
    ['Q-2501', '1:1', 25, 80, 320, 0.1, 58, '林听雪'],
    ['Q-2501', '1:1.2', 26, 82, 400, 0.09, 40, '林听雪'],
    ['Q-2502', '1:1', 23, 76, 240, 0.13, 62, '林听雪'],
    ['Q-2502', '1:1.5', 27, 84, 400, 0.11, 45, '周砚秋'],
    ['Q-2502', '1:1.5', 25, 80, 600, 0.08, 30, '周砚秋'],
    ['Q-2503', '1:1.2', 22, 74, 240, 0.12, 48, '林听雪'],
    ['Q-2503', '1:1.2', 26, 82, 400, 0.1, 33, '林听雪'],
    ['Q-2504', '1:1', 24, 79, 320, 0.12, 36, '周砚秋'],
    ['Q-2504', '1:1.5', 28, 85, 600, 0.09, 21, '周砚秋'],
    ['Q-2501', '1:2', 18, 65, 800, 0.05, 18, '林听雪'],
    ['Q-2502', '纯生漆', 24, 70, 1000, 0.04, 12, '周砚秋'],
    // Q-2506 / 临-2506：第 1 遍两边都有且厚度不同；第 2 遍只有旧号挂着（合档后重新连续编号，不重复累加）
    ['Q-2506', '1:1', 25, 80, 320, 0.12, 40, '林听雪'],
    ['临-2506', '1:1', 24, 78, 240, 0.11, 42, '周砚秋'],
    ['临-2506', '1:1.2', 26, 82, 400, 0.1, 28, '周砚秋'],
  ];

  const seqMap = new Map<string, number>();
  return plan.map(([guqinNo, mixRatio, temp, humidity, grit, thickness, days, operator], index) => {
    const seq = (seqMap.get(guqinNo) ?? 0) + 1;
    seqMap.set(guqinNo, seq);
    return {
      id: `layer-${String(index + 1).padStart(3, '0')}`,
      guqinNo,
      seq,
      mixRatio,
      curingTemp: temp,
      curingHumidity: humidity,
      polishGrit: grit,
      layerThickness: thickness,
      totalThickness: 0,
      appliedAt: daysAgo(days),
      operator,
    };
  });
}

/** 重新计算每张琴的累计厚度（写入本地库前的派生值） */
export function withCumulative(layers: LacquerLayer[]): LacquerLayer[] {
  const byGuqin = new Map<string, LacquerLayer[]>();
  layers.forEach((layer) => {
    const list = byGuqin.get(layer.guqinNo) ?? [];
    list.push(layer);
    byGuqin.set(layer.guqinNo, list);
  });
  return layers.map((layer) => ({
    ...layer,
    totalThickness: cumulativeThickness(byGuqin.get(layer.guqinNo) ?? [], layer.seq),
  }));
}

export const SEED_STRINGINGS: Stringing[] = [
  {
    id: 'stringing-001',
    guqinNo: 'Q-2501',
    stringType: '丝弦',
    nut: '红木雁足 + 丝绒扣',
    stringGap: 17,
    sanNote: '散音宽厚，一弦如钟，七弦略紧需再养。',
    anNote: '按音走手顺滑，九徽以下音色沉静，无抗指。',
    fanNote: '泛音清亮，五六徽尤其干净。',
    nineVirtues: '奇、古、透、静、润佳；圆、匀稍欠，清、芳待养。',
    defects: ['无'],
    strungAt: daysAgo(10),
    operator: '周砚秋',
    noteVersions: [],
  },
  {
    id: 'stringing-002',
    guqinNo: 'Q-2502',
    stringType: '钢弦',
    nut: '乌木雁足 + 尼龙扣',
    stringGap: 18,
    sanNote: '散音亮而略噪，钢弦本性使然。',
    anNote: '按音清越，四弦七徽处有轻微沙音。',
    fanNote: '泛音通透，尤以三徽为最。',
    nineVirtues: '透、清、亮为主；古、静不足。',
    defects: ['沙音'],
    strungAt: daysAgo(6),
    operator: '林听雪',
    noteVersions: [],
  },
  {
    id: 'stringing-003',
    guqinNo: 'Q-2503',
    stringType: '丝弦',
    nut: '红木雁足 + 丝绒扣',
    stringGap: 17,
    sanNote: '散音均匀，五弦稍闷。',
    anNote: '按音圆润，走弦无声，宜弹文曲。',
    fanNote: '泛音圆而不散。',
    nineVirtues: '圆、润、匀见长；透、芳尚需时日。',
    defects: ['无'],
    strungAt: daysAgo(3),
    operator: '林听雪',
    noteVersions: [
      { id: 'tv-001', savedAt: daysAgo(3), sanNote: '散音初上，音色紧。', anNote: '按音略抗指。', fanNote: '泛音偏闷。', nineVirtues: '新弦未开。' },
    ],
  },
  // Q-2506：上弦记录已在正式号重录；临-2506 还挂着旧记录与一条评语版本（合档时评语逐项裁决，版本合并）
  {
    id: 'stringing-004',
    guqinNo: 'Q-2506',
    stringType: '丝弦',
    nut: '红木雁足 + 丝绒扣',
    stringGap: 17,
    sanNote: '散音松透，一弦沉稳。',
    anNote: '按音圆润，走手顺滑。',
    fanNote: '泛音清亮。',
    nineVirtues: '润、圆见长。',
    defects: ['无'],
    strungAt: daysAgo(5),
    operator: '林听雪',
    noteVersions: [],
  },
  {
    id: 'stringing-005',
    guqinNo: '临-2506',
    stringType: '丝弦',
    nut: '老红木雁足 + 真丝绒扣',
    stringGap: 18,
    sanNote: '散音初评：略紧，待养。',
    anNote: '按音初评：九徽微抗指。',
    fanNote: '泛音清亮，三徽最佳。',
    nineVirtues: '初评：古、静尚可。',
    defects: ['抗指'],
    strungAt: daysAgo(9),
    operator: '周砚秋',
    noteVersions: [
      { id: 'tv-002', savedAt: daysAgo(9), sanNote: '散音未开。', anNote: '按音抗指明显。', fanNote: '泛音发紧。', nineVirtues: '新弦待养。' },
    ],
  },
];

/** 首次打开（表内无数据）时写入示例数据；已有数据则不动 */
export async function seedIfEmpty(): Promise<void> {
  const flag = await db.meta.get('seeded');
  if (flag) {
    return;
  }
  const [boardCount, chamberCount, lacquerCount, stringingCount] = await Promise.all([
    db.boards.count(),
    db.chambers.count(),
    db.lacquers.count(),
    db.stringings.count(),
  ]);
  const layers = withCumulative(buildSeedLayers());

  await db.transaction('rw', db.boards, db.chambers, db.lacquers, db.stringings, db.meta, async () => {
    if (boardCount === 0) await db.boards.bulkPut(SEED_BOARDS);
    if (chamberCount === 0) await db.chambers.bulkPut(SEED_CHAMBERS);
    if (lacquerCount === 0) await db.lacquers.bulkPut(layers);
    if (stringingCount === 0) await db.stringings.bulkPut(SEED_STRINGINGS);
    await db.meta.put({ key: 'seeded', value: new Date().toISOString() });
  });
}
