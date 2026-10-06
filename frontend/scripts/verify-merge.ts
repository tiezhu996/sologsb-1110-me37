import 'fake-indexeddb/auto';
import assert from 'node:assert';
import { db } from '../src/utils/db';
import type { WoodBoard } from '../src/types/wood-board';
import type { SoundChamber } from '../src/types/sound-chamber';
import type { LacquerLayer } from '../src/types/lacquer-layer';
import type { Stringing } from '../src/types/stringing';
import { buildChecklist, canRunItem, type MergeDataBundle } from '../src/utils/merge';
import {
  bundleFrom,
  finalizeMigration,
  loadActiveChecklist,
  restoreFromChecklist,
  runCategoryMigration,
  saveActiveChecklist,
} from '../src/utils/mergeRunner';
import { withCumulative } from '../src/utils/seed';

const D = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

// ---------- 造数据：旧号 OLD 与正式号 NEW，四类都有，且多处两边不一致 ----------
const boards: WoodBoard[] = [
  { id: 'b-f-panel', boardNo: 'MB-FP', guqinNo: 'NEW', part: '面板', species: '桐木', dryYears: 7, thicknessMm: 32, grain: '直纹', defect: '无', receivedAt: D(50) },
  { id: 'b-f-base', boardNo: 'MB-FB', guqinNo: 'NEW', part: '底板', species: '梓木', dryYears: 6, thicknessMm: 18, grain: '直纹', defect: '无', receivedAt: D(49) },
];
const chambers: SoundChamber[] = [
  // 正式号槽腹（新测）
  { id: 'c-f', guqinNo: 'NEW', nayinThickness: 15, longchiThickness: 13, fengzhaoThickness: 14, chamberDepth: 27, postPos: '天柱中', poolSize: '205×23', carvedAt: D(30), carver: '周' },
  // 旧号槽腹（初掏），纳音/龙池/凤沼/深度/池沼尺寸都不同
  { id: 'c-o', guqinNo: 'OLD', nayinThickness: 16, longchiThickness: 14, fengzhaoThickness: 15, chamberDepth: 25, postPos: '天柱中', poolSize: '200×22', carvedAt: D(40), carver: '周' },
];
const rawLayers: LacquerLayer[] = [
  // 第 1 遍两边完全相同 → 自动去重
  { id: 'l-f-1', guqinNo: 'NEW', seq: 1, mixRatio: '1:1', curingTemp: 24, curingHumidity: 78, polishGrit: 240, layerThickness: 0.12, totalThickness: 0, appliedAt: D(26), operator: '林' },
  { id: 'l-o-1', guqinNo: 'OLD', seq: 1, mixRatio: '1:1', curingTemp: 24, curingHumidity: 78, polishGrit: 240, layerThickness: 0.12, totalThickness: 0, appliedAt: D(26), operator: '林' },
  // 第 2 遍两边不同 → 需裁决
  { id: 'l-f-2', guqinNo: 'NEW', seq: 2, mixRatio: '1:1.2', curingTemp: 26, curingHumidity: 82, polishGrit: 400, layerThickness: 0.1, totalThickness: 0, appliedAt: D(14), operator: '林' },
  { id: 'l-o-2', guqinNo: 'OLD', seq: 2, mixRatio: '1:1', curingTemp: 25, curingHumidity: 80, polishGrit: 320, layerThickness: 0.11, totalThickness: 0, appliedAt: D(14), operator: '林' },
  // 第 3 遍仅旧号 → 单边迁入
  { id: 'l-o-3', guqinNo: 'OLD', seq: 3, mixRatio: '纯生漆', curingTemp: 23, curingHumidity: 72, polishGrit: 800, layerThickness: 0.04, totalThickness: 0, appliedAt: D(6), operator: '周' },
];
const lacquers = withCumulative(rawLayers);
const stringings: Stringing[] = [
  { id: 's-f', guqinNo: 'NEW', stringType: '丝弦', nut: '红木雁足', stringGap: 17, sanNote: '正式散音', anNote: '正式按音', fanNote: '泛音相同', nineVirtues: '正式九德', defects: ['无'], strungAt: D(4), operator: '周', noteVersions: [{ id: 'tv-f', savedAt: D(4), sanNote: 'f1', anNote: 'f2', fanNote: 'f3', nineVirtues: 'f9' }] },
  { id: 's-o', guqinNo: 'OLD', stringType: '丝弦', nut: '红木雁足', stringGap: 17, sanNote: '旧散音', anNote: '旧按音', fanNote: '泛音相同', nineVirtues: '旧九德', defects: ['抗指'], strungAt: D(9), operator: '林', noteVersions: [{ id: 'tv-o', savedAt: D(9), sanNote: 'o1', anNote: 'o2', fanNote: 'o3', nineVirtues: 'o9' }] },
];

await db.boards.bulkPut(boards);
await db.chambers.bulkPut(chambers);
await db.lacquers.bulkPut(lacquers);
await db.stringings.bulkPut(stringings);

function readData(): MergeDataBundle {
  return bundleFrom(boards, chambers, lacquers, stringings, []);
}
async function reload() {
  boards.length = 0;
  boards.push(...(await db.boards.toArray()));
  chambers.length = 0;
  chambers.push(...(await db.chambers.toArray()));
  lacquers.length = 0;
  lacquers.push(...(await db.lacquers.toArray()));
  stringings.length = 0;
  stringings.push(...(await db.stringings.toArray()));
}

// ---------- 1. 生成清单 ----------
let checklist = await buildChecklist('OLD', 'NEW', readData());
await saveActiveChecklist(checklist);
const byCat = Object.fromEntries(checklist.items.map((i) => [i.category, i])) as Record<string, (typeof checklist.items)[number]>;
assert.strictEqual(checklist.items.length, 4, '应有四类条目');
// 板材两边厚度相同 → 无冲突可直接迁
assert.strictEqual(byCat.board.conflicts.length, 0, '板材厚度相同应无冲突');
assert.strictEqual(canRunItem(byCat.board), true);
// 槽腹 5 个字段不同（postPos 相同）
assert.strictEqual(byCat.chamber.conflicts.length, 5, '槽腹应有 5 个字段冲突');
assert.strictEqual(canRunItem(byCat.chamber), false, '槽腹未裁决应禁止执行');
// 髹漆 1 个遍次冲突 + 1 遍重复 + 1 遍单边
assert.strictEqual(byCat.lacquer.layerConflicts.length, 1, '髹漆应有 1 个遍次冲突');
assert.strictEqual(canRunItem(byCat.lacquer), false);
// 上弦：散音/按音/九德 3 处不同（泛音相同不算冲突）
assert.strictEqual(byCat.stringing.conflicts.length, 3, '上弦应有 3 处评语冲突');
assert.strictEqual(canRunItem(byCat.stringing), false);

// ---------- 2. 未裁决前不得改库：尝试执行槽腹应被拒绝 ----------
await assert.rejects(() => runCategoryMigration(checklist, readData(), 'chamber'), /未裁决/);
assert.strictEqual((await db.chambers.where('guqinNo').equals('OLD').count()), 1, '拒绝后旧号槽腹必须仍在');

// ---------- 3. 板材（无冲突）先迁 ----------
checklist = await runCategoryMigration(checklist, readData(), 'board');
await saveActiveChecklist(checklist);
await reload();
assert.strictEqual(boards.filter((b) => b.guqinNo === 'NEW').length, 2, '板材都应在正式号');
assert.strictEqual(boards.some((b) => b.guqinNo === 'OLD'), false, '旧号不应再有板材');

// ---------- 4. 裁决：槽腹纳音取旧号、其余取正式号；髹漆第 2 遍取旧号；上弦散音取旧、按音取正式、九德取旧 ----------
byCat.chamber.conflicts.find((c) => c.field === 'nayinThickness')!.winner = 'old';
byCat.chamber.conflicts.filter((c) => c.field !== 'nayinThickness').forEach((c) => (c.winner = 'formal'));
byCat.lacquer.layerConflicts[0].winner = 'old';
byCat.stringing.conflicts.find((c) => c.field === 'sanNote')!.winner = 'old';
byCat.stringing.conflicts.find((c) => c.field === 'anNote')!.winner = 'formal';
byCat.stringing.conflicts.find((c) => c.field === 'nineVirtues')!.winner = 'old';
checklist.items.forEach((i) => (i.resolved = i.conflicts.every((c) => c.winner !== null) && i.layerConflicts.every((c) => c.winner !== null)));
await saveActiveChecklist(checklist);

// ---------- 5. 执行槽腹 / 髹漆 / 上弦 ----------
checklist = await runCategoryMigration(checklist, readData(), 'chamber');
await reload();
let c = await db.chambers.toArray();
assert.strictEqual(c.length, 1, '槽腹应只剩一条');
assert.strictEqual(c[0].guqinNo, 'NEW');
assert.strictEqual(c[0].nayinThickness, 16, '纳音应取旧号 16');
assert.strictEqual(c[0].longchiThickness, 13, '龙池应取正式号 13');
assert.strictEqual(c[0].chamberDepth, 27, '深度应取正式号 27');
assert.strictEqual(c[0].poolSize, '205×23', '池沼尺寸应取正式号');

checklist = await runCategoryMigration(checklist, readData(), 'lacquer');
await reload();
const ls = (await db.lacquers.where('guqinNo').equals('NEW').toArray()).sort((a, b) => a.seq - b.seq);
assert.strictEqual(ls.length, 3, '髹漆应幸存 3 遍（重复去重 1 遍）');
assert.deepStrictEqual(ls.map((l) => l.seq), [1, 2, 3], '遍次应重排为 1..3');
// 第 2 遍取旧号（0.11、320 目），且复用正式号行 id
assert.strictEqual(ls[1].layerThickness, 0.11, '第 2 遍应取旧号厚度 0.11');
assert.strictEqual(ls[1].id, 'l-f-2', '第 2 遍应复用正式号行 id');
assert.strictEqual(ls[1].polishGrit, 320);
// 关键：累计厚度必须等于幸存三层之和，不重复累加
const expectedTotal = Number((0.12 + 0.11 + 0.04).toFixed(3));
assert.strictEqual(ls[2].totalThickness, expectedTotal, `累计厚度应为 ${expectedTotal}，实际 ${ls[2].totalThickness}`);
assert.strictEqual(ls[0].totalThickness, 0.12);
assert.strictEqual(ls[1].totalThickness, Number((0.12 + 0.11).toFixed(3)));
assert.strictEqual((await db.lacquers.where('guqinNo').equals('OLD').count()), 0, '旧号不应再有髹漆');

checklist = await runCategoryMigration(checklist, readData(), 'stringing');
await reload();
const ss = await db.stringings.toArray();
assert.strictEqual(ss.length, 1);
assert.strictEqual(ss[0].guqinNo, 'NEW');
assert.strictEqual(ss[0].sanNote, '旧散音', '散音应取旧号');
assert.strictEqual(ss[0].anNote, '正式按音', '按音应取正式号');
assert.strictEqual(ss[0].fanNote, '泛音相同');
assert.strictEqual(ss[0].nineVirtues, '旧九德', '九德应取旧号');
assert.strictEqual(ss[0].defects[0], '无', '非裁决字段应以正式号为准');
const versionIds = ss[0].noteVersions.map((v) => v.id).sort();
assert.deepStrictEqual(versionIds, ['tv-f', 'tv-o'], '两边评语版本应合并保留');
assert.strictEqual(ss[0].noteVersions[0].id, 'tv-f', '版本应按时间倒序（4 天前的 tv-f 在前）');

// ---------- 6. 别名：旧号只留可搜索别名 ----------
const aliases = await db.aliases.toArray();
assert.deepStrictEqual(aliases.map((a) => a.aliases), [['OLD']]);
assert.strictEqual(aliases[0].guqinNo, 'NEW');

// ---------- 7. 幂等：已完成类再跑不重复加 ----------
checklist = await runCategoryMigration(checklist, readData(), 'lacquer');
await reload();
const ls2 = await db.lacquers.where('guqinNo').equals('NEW').toArray();
assert.strictEqual(ls2.length, 3, '重复执行已完成类不应产生重复遍次');
assert.strictEqual(ls2.sort((a, b) => a.seq - b.seq)[2].totalThickness, expectedTotal);

await finalizeMigration(checklist);
assert.strictEqual(await loadActiveChecklist(), null, '完成后活动清单应清除');

// ---------- 8. 恢复演练：新建第二张合档，中途恢复 ----------
await db.boards.bulkPut([
  { id: 'b2-o', boardNo: 'MB-2O', guqinNo: 'OLD2', part: '面板', species: '桐木', dryYears: 5, thicknessMm: 30, grain: '直纹', defect: '无', receivedAt: D(20) },
  { id: 'b2-fp', boardNo: 'MB-2FP', guqinNo: 'NEW2', part: '面板', species: '桐木', dryYears: 5, thicknessMm: 33, grain: '直纹', defect: '无', receivedAt: D(19) },
  { id: 'b2-fb', boardNo: 'MB-2FB', guqinNo: 'NEW2', part: '底板', species: '梓木', dryYears: 5, thicknessMm: 18, grain: '直纹', defect: '无', receivedAt: D(19) },
]);
await reload();
let cl2 = await buildChecklist('OLD2', 'NEW2', {
  boards,
  chambers,
  lacquers,
  stringings,
  aliases: await db.aliases.toArray(),
});
await saveActiveChecklist(cl2);
// 面板厚度 30 vs 33 有冲突，先不裁决；先没有可跑的类之外…… 直接模拟：裁决后执行板材
cl2.items[0].conflicts.forEach((c) => (c.winner = 'old'));
cl2.items[0].resolved = true;
cl2 = await runCategoryMigration(cl2, bundleFrom(boards, chambers, lacquers, stringings, await db.aliases.toArray()), 'board');
await saveActiveChecklist(cl2);
await reload();
assert.strictEqual((await db.boards.where('guqinNo').equals('NEW2').toArray()).find((b) => b.part === '面板')!.thicknessMm, 30, '执行后面板厚度应取旧号 30');
assert.strictEqual((await db.boards.where('guqinNo').equals('OLD2').count()), 0);

// 现在从清单恢复
const data2 = bundleFrom(boards, chambers, lacquers, stringings, await db.aliases.toArray());
cl2 = await restoreFromChecklist(cl2, data2);
await saveActiveChecklist(cl2);
await reload();
assert.strictEqual((await db.boards.where('guqinNo').equals('OLD2').count()), 1, '恢复后旧号面板应回来');
assert.strictEqual((await db.boards.where('guqinNo').equals('NEW2').toArray()).find((b) => b.part === '面板')!.thicknessMm, 33, '恢复后正式号面板应回到 33');
assert.strictEqual(cl2.items.every((i) => i.status === 'pending'), true, '恢复后条目状态应重置为 pending，可重试剩余项');

// 恢复后重试（只处理未完成的板材类）应再次成功
cl2.items[0].conflicts.forEach((c) => (c.winner = 'formal'));
cl2.items[0].resolved = true;
cl2 = await runCategoryMigration(cl2, bundleFrom(boards, chambers, lacquers, stringings, await db.aliases.toArray()), 'board');
await reload();
assert.strictEqual((await db.boards.where('guqinNo').equals('NEW2').toArray()).find((b) => b.part === '面板')!.thicknessMm, 33, '重试后应取正式号 33');
await finalizeMigration(cl2);

// ---------- 9. 链式改号：旧号本身是正式号（名下已挂别名链），别名链整体迁到新正式号 ----------
await db.aliases.clear();
await db.aliases.put({ id: 'MID', guqinNo: 'MID', aliases: ['ANCIENT'], updatedAt: D(2) });
// MID 上还挂一张板材；NEW3 为最终正式号
await db.boards.put({ id: 'b-mid', boardNo: 'MB-M', guqinNo: 'MID', part: '面板', species: '杉木', dryYears: 9, thicknessMm: 31, grain: '直纹', defect: '无', receivedAt: D(10) });
await db.boards.put({ id: 'b3-fp', boardNo: 'MB-3P', guqinNo: 'NEW3', part: '面板', species: '杉木', dryYears: 9, thicknessMm: 31, grain: '直纹', defect: '无', receivedAt: D(9) });
await db.boards.put({ id: 'b3-fb', boardNo: 'MB-3B', guqinNo: 'NEW3', part: '底板', species: '梓木', dryYears: 8, thicknessMm: 18, grain: '直纹', defect: '无', receivedAt: D(9) });
await reload();
let cl3 = await buildChecklist('MID', 'NEW3', bundleFrom(boards, chambers, lacquers, stringings, await db.aliases.toArray()));
cl3.items[0].conflicts.forEach((c) => (c.winner = 'formal'));
cl3.items[0].resolved = true;
cl3 = await runCategoryMigration(cl3, bundleFrom(boards, chambers, lacquers, stringings, await db.aliases.toArray()), 'board');
const aliasRows = await db.aliases.toArray();
assert.strictEqual(aliasRows.length, 1, '链式合档后别名表应只剩新正式号一行');
assert.strictEqual(aliasRows[0].guqinNo, 'NEW3');
assert.deepStrictEqual(aliasRows[0].aliases.sort(), ['ANCIENT', 'MID'], '旧别名链 ANCIENT 与 MID 都应并入 NEW3，不断链');
assert.strictEqual((await db.boards.where('guqinNo').equals('MID').count()), 0, 'MID 下不应再有业务数据');

// 恢复链式合档：旧别名行应回来、新行撤销
cl3 = await restoreFromChecklist(cl3, bundleFrom(boards, chambers, lacquers, stringings, await db.aliases.toArray()));
const restoredAliasRows = await db.aliases.toArray();
assert.strictEqual(restoredAliasRows.length, 1, '恢复后别名表应回到清单生成时一行');
assert.strictEqual(restoredAliasRows[0].guqinNo, 'MID');
assert.deepStrictEqual(restoredAliasRows[0].aliases, ['ANCIENT']);
assert.strictEqual((await db.boards.where('guqinNo').equals('MID').count()), 1, '恢复后 MID 板材应回来');

console.log('全部合档引擎断言通过 ✅');
process.exit(0);
