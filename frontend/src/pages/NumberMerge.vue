<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useBoardStore } from '../stores/boardStore';
import { useChamberStore } from '../stores/chamberStore';
import { useLacquerStore } from '../stores/lacquerStore';
import { useStringingStore } from '../stores/stringingStore';
import { useAliasStore } from '../stores/aliasStore';
import type { MergeCategory, MergeChecklist, MergeItem } from '../types/guqin-alias';
import { buildChecklist, canRunItem, pendingDecisions, suggestOldNos } from '../utils/merge';
import {
  CATEGORY_LABELS,
  bundleFrom,
  clearActiveChecklist,
  finalizeMigration,
  loadActiveChecklist,
  restoreFromChecklist,
  runCategoryMigration,
  saveActiveChecklist,
} from '../utils/mergeRunner';

const boardStore = useBoardStore();
const chamberStore = useChamberStore();
const lacquerStore = useLacquerStore();
const stringingStore = useStringingStore();
const aliasStore = useAliasStore();

const oldNoInput = ref('');
const formalNoInput = ref('');
const checklist = ref<MergeChecklist | null>(null);
const running = ref<MergeCategory | ''>('');
const restoring = ref(false);

const CATEGORY_ORDER: MergeCategory[] = ['board', 'chamber', 'lacquer', 'stringing'];

function bundle() {
  return bundleFrom(
    boardStore.boards,
    chamberStore.chambers,
    lacquerStore.layers,
    stringingStore.stringings,
    aliasStore.aliases,
  );
}

/** 疑似临时旧号：挂着槽腹/髹漆/上弦但板材未配对 */
const suggestions = computed(() => suggestOldNos(bundle()));
const allGuqinNos = computed(() =>
  Array.from(
    new Set([
      ...boardStore.guqinNos,
      ...chamberStore.chambers.map((c) => c.guqinNo),
      ...lacquerStore.guqinNos,
      ...stringingStore.stringings.map((s) => s.guqinNo),
    ]),
  ).sort(),
);

const itemsByCategory = computed(() => {
  const map = new Map<MergeCategory, MergeItem>();
  checklist.value?.items.forEach((item) => map.set(item.category, item));
  return map;
});

const totalPending = computed(() =>
  checklist.value ? checklist.value.items.reduce((sum, item) => sum + pendingDecisions(item), 0) : 0,
);

const doneCount = computed(() => checklist.value?.items.filter((i) => i.status === 'done').length ?? 0);
const failedCount = computed(() => checklist.value?.items.filter((i) => i.status === 'failed').length ?? 0);
const allDone = computed(() => (checklist.value ? checklist.value.items.every((i) => i.status === 'done') : false));

async function rehydrateAll() {
  await Promise.all([
    aliasStore.hydrate(),
    boardStore.hydrate(),
    chamberStore.hydrate(),
    lacquerStore.hydrate(),
    stringingStore.hydrate(),
  ]);
}

onMounted(async () => {
  // 上次有未完成的核对清单：直接恢复到裁决/执行现场（含快照）
  const active = await loadActiveChecklist();
  if (active) checklist.value = active;
});

/** 第一步：生成核对清单并立即落 meta（此时不改任何业务库） */
async function generateChecklist() {
  try {
    const created = await buildChecklist(oldNoInput.value, formalNoInput.value, bundle());
    checklist.value = created;
    await saveActiveChecklist(created);
    const conflictTotal = created.items.reduce((sum, item) => sum + pendingDecisions(item), 0);
    ElMessage.success(
      conflictTotal > 0
        ? `核对清单已保存：${created.items.length} 类数据，${conflictTotal} 处两边不一致，请逐项裁决后再迁移`
        : `核对清单已保存：${created.items.length} 类数据无冲突项，可直接迁移`,
    );
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
}

function useSuggestion(no: string) {
  oldNoInput.value = no;
  if (!formalNoInput.value) {
    // 默认推荐编号对应的正式号（临时号 Q-LS-06 → 正式号 Q-2506 仅为演示启发，不做强制）
    const guessed = allGuqinNos.value.find((n) => n !== no && n.endsWith(no.slice(-2)) && !suggestions.value.some((s) => s.oldNo === n));
    formalNoInput.value = guessed ?? '';
  }
}

/** 记录一次裁决（即时落清单，刷新不丢） */
async function decide(itemKey: string, conflictKey: string, winner: 'old' | 'formal') {
  if (!checklist.value) return;
  const item = checklist.value.items.find((i) => i.key === itemKey);
  if (!item) return;
  const target = item.conflicts.find((c) => c.key === conflictKey) ?? item.layerConflicts.find((c) => c.key === conflictKey);
  if (target) target.winner = winner;
  item.resolved = pendingDecisions(item) === 0;
  await saveActiveChecklist(checklist.value);
}

/** 某类一键裁决（批量选边） */
async function decideAll(item: MergeItem, winner: 'old' | 'formal') {
  item.conflicts.forEach((c) => (c.winner = winner));
  item.layerConflicts.forEach((c) => (c.winner = winner));
  item.resolved = true;
  if (checklist.value) await saveActiveChecklist(checklist.value);
}

/** 执行单类迁移（失败只标记该类，已完成类不动，重试只处理未完成类） */
async function runCategory(category: MergeCategory) {
  if (!checklist.value) return;
  const item = itemsByCategory.value.get(category);
  if (!item) return;
  if (!canRunItem(item)) {
    ElMessage.warning(`${CATEGORY_LABELS[category]}还有 ${pendingDecisions(item)} 项未裁决，未裁决前不得改库`);
    return;
  }
  running.value = category;
  try {
    await runCategoryMigration(checklist.value, bundle(), category);
    await saveActiveChecklist(checklist.value);
    await rehydrateAll();
    ElMessage.success(`${CATEGORY_LABELS[category]}已迁到正式琴号 ${checklist.value.formalNo}（旧号保留为可搜索别名）`);
    await maybeFinalize();
  } catch (error) {
    if (checklist.value) await saveActiveChecklist(checklist.value).catch(() => undefined);
    ElMessage.error(`${CATEGORY_LABELS[category]}迁移失败，已回滚该类：${(error as Error).message}；可从核对清单恢复后重试`);
  } finally {
    running.value = '';
  }
}

/** 顺序执行所有未完成类；任一类失败立即停下，只处理剩下的 */
async function runAll() {
  if (!checklist.value) return;
  if (totalPending.value > 0) {
    ElMessage.warning(`还有 ${totalPending.value} 处不一致未裁决，任何一条未裁决前不得先改库`);
    return;
  }
  for (const category of CATEGORY_ORDER) {
    const item = itemsByCategory.value.get(category);
    if (!item || item.status === 'done') continue;
    running.value = category;
    try {
      await runCategoryMigration(checklist.value, bundle(), category);
      await saveActiveChecklist(checklist.value);
      await rehydrateAll();
    } catch (error) {
      await saveActiveChecklist(checklist.value).catch(() => undefined);
      ElMessage.error(`${CATEGORY_LABELS[category]}迁移失败并已回滚，剩余类别未执行：${(error as Error).message}`);
      running.value = '';
      await rehydrateAll();
      return;
    }
  }
  running.value = '';
  await rehydrateAll();
  ElMessage.success('四类旧数据已全部迁到正式琴号');
  await maybeFinalize();
}

async function maybeFinalize() {
  if (!checklist.value || !allDone.value) return;
  await finalizeMigration(checklist.value);
  ElMessage.success(`合档完成：${checklist.value.oldNo} 已作为 ${checklist.value.formalNo} 的可搜索别名保留`);
  checklist.value = null;
  oldNoInput.value = '';
  formalNoInput.value = '';
}

/** 从核对清单快照恢复全部相关表，再重新裁决/重试 */
async function restore() {
  if (!checklist.value) return;
  const confirmed = await ElMessageBox.confirm(
    '将按核对清单快照，把旧号/正式号相关的四类数据与别名恢复到生成清单时的状态；已做的迁移全部撤销。确认恢复？',
    '从核对清单恢复',
    { type: 'warning' },
  )
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  restoring.value = true;
  try {
    const restored = await restoreFromChecklist(checklist.value, bundle());
    checklist.value = restored;
    await saveActiveChecklist(restored);
    await rehydrateAll();
    ElMessage.success('已按核对清单恢复，可重新裁决；重试时只处理未完成的类别');
  } catch (error) {
    ElMessage.error(`恢复失败：${(error as Error).message}`);
  } finally {
    restoring.value = false;
  }
}

async function discard() {
  if (!checklist.value) return;
  const confirmed = await ElMessageBox.confirm('丢弃当前核对清单？清单及其快照将被删除（不影响已完成的迁移）。', '丢弃清单', {
    type: 'warning',
  })
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  await clearActiveChecklist();
  checklist.value = null;
  oldNoInput.value = '';
  formalNoInput.value = '';
  ElMessage.success('核对清单已丢弃');
}

function statusTagType(item: MergeItem): 'info' | 'success' | 'danger' | 'warning' {
  if (item.status === 'done') return 'success';
  if (item.status === 'failed') return 'danger';
  return pendingDecisions(item) > 0 ? 'warning' : 'info';
}
function statusText(item: MergeItem): string {
  if (item.status === 'done') return '已迁移';
  if (item.status === 'failed') return '失败待重试';
  return pendingDecisions(item) > 0 ? `待裁决（${pendingDecisions(item)}）` : '可迁移';
}
</script>

<template>
  <div>
    <h2 class="page-title">琴号合档（临时号 → 正式琴号）</h2>
    <p class="page-desc">
      面板底板配对后把临时琴号改为正式琴号；槽腹、髹漆、上弦仍挂旧号时在此合档。四类旧数据迁到正式琴号，两边不一致的
      <b>板材厚度 / 槽腹尺寸 / 髹漆遍次 / 上弦评语</b> 逐项选保留哪边；旧号仅保留为可搜索别名。未裁决前不改库，失败可按清单恢复，重试只处理剩下的。
    </p>

    <!-- 第一步：指定旧号与正式号 -->
    <el-card v-if="!checklist" shadow="never" class="block">
      <template #header>第一步 · 指定旧号（临时琴号）与正式琴号</template>
      <el-form label-width="130px" class="pair-form">
        <el-form-item label="旧号（临时琴号）">
          <el-input v-model="oldNoInput" placeholder="如：Q-LS-06" maxlength="20" style="width: 240px" clearable />
        </el-form-item>
        <el-form-item label="正式琴号">
          <el-input v-model="formalNoInput" placeholder="如：Q-2506" maxlength="20" style="width: 240px" clearable />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :disabled="!oldNoInput || !formalNoInput" @click="generateChecklist">
            生成核对清单
          </el-button>
          <span class="hint">只生成清单与快照，不修改任何工序数据</span>
        </el-form-item>
      </el-form>

      <template v-if="suggestions.length">
        <el-divider content-position="left">疑似待合档临时号（有槽腹/髹漆/上弦、板材未配对）</el-divider>
        <el-table :data="suggestions" size="small" border>
          <el-table-column prop="oldNo" label="临时琴号" width="130" />
          <el-table-column label="挂着的旧数据" min-width="260">
            <template #default="scope">
              <el-tag v-if="scope.row.chamberCount" size="small" class="tag">槽腹 ×{{ scope.row.chamberCount }}</el-tag>
              <el-tag v-if="scope.row.lacquerCount" size="small" type="warning" class="tag">髹漆 ×{{ scope.row.lacquerCount }}</el-tag>
              <el-tag v-if="scope.row.stringingCount" size="small" type="success" class="tag">上弦 ×{{ scope.row.stringingCount }}</el-tag>
              <el-tag v-if="scope.row.boardCount" size="small" type="info" class="tag">板材 ×{{ scope.row.boardCount }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="120">
            <template #default="scope">
              <el-button link type="primary" @click="useSuggestion(scope.row.oldNo)">填入旧号</el-button>
            </template>
          </el-table-column>
        </el-table>
      </template>
    </el-card>

    <!-- 第二步：核对清单与逐项裁决 -->
    <template v-else>
      <el-card shadow="never" class="block">
        <template #header>
          <div class="card-head">
            <span>
              核对清单：旧号 <el-tag type="warning" size="small">{{ checklist.oldNo }}</el-tag>
              → 正式琴号 <el-tag type="success" size="small">{{ checklist.formalNo }}</el-tag>
            </span>
            <span class="card-note">
              待裁决 {{ totalPending }} 处 · 已迁移 {{ doneCount }}/{{ checklist.items.length }} 类
              <el-tag v-if="failedCount" type="danger" size="small" class="tag">{{ failedCount }} 类失败</el-tag>
            </span>
          </div>
        </template>

        <div class="action-bar">
          <el-button type="primary" :disabled="totalPending > 0 || allDone" :loading="running !== ''" @click="runAll">
            执行全部剩余迁移
          </el-button>
          <el-button :disabled="!doneCount && !failedCount" :loading="restoring" @click="restore">
            从核对清单恢复
          </el-button>
          <el-button @click="discard">丢弃清单</el-button>
          <span v-if="totalPending > 0" class="warn">还有 {{ totalPending }} 处两边不一致未裁决，未裁决前不得改库</span>
          <span v-else-if="!allDone" class="hint">冲突已裁决完毕，髹漆合并后会重排遍次并重算累计厚度，不会重复累加</span>
        </div>
      </el-card>

      <el-card v-for="category in CATEGORY_ORDER" :key="category" shadow="never" class="block">
        <template #header>
          <div class="card-head">
            <span>{{ CATEGORY_LABELS[category] }}</span>
            <div>
              <template v-if="itemsByCategory.get(category) as MergeItem">
                <el-tag :type="statusTagType(itemsByCategory.get(category)!)" size="small" class="tag">
                  {{ statusText(itemsByCategory.get(category)!) }}
                </el-tag>
                <el-button
                  v-if="itemsByCategory.get(category)!.status !== 'done'"
                  link
                  type="primary"
                  size="small"
                  @click="decideAll(itemsByCategory.get(category)!, 'formal')"
                >
                  全取正式号
                </el-button>
                <el-button
                  v-if="itemsByCategory.get(category)!.status !== 'done'"
                  link
                  type="warning"
                  size="small"
                  @click="decideAll(itemsByCategory.get(category)!, 'old')"
                >
                  全取旧号
                </el-button>
                <el-button
                  type="primary"
                  size="small"
                  :loading="running === category"
                  :disabled="!canRunItem(itemsByCategory.get(category)!)"
                  @click="runCategory(category)"
                >
                  {{ itemsByCategory.get(category)!.status === 'failed' ? '重试该类' : '执行该类迁移' }}
                </el-button>
              </template>
              <el-tag v-else type="info" size="small">本琴此类无数据</el-tag>
            </div>
          </div>
        </template>

        <template v-if="itemsByCategory.get(category)">
          <p class="item-title">{{ itemsByCategory.get(category)!.title }}</p>

          <!-- 板材厚度 / 槽腹尺寸 / 上弦评语：逐字段裁决 -->
          <el-table
            v-if="itemsByCategory.get(category)!.conflicts.length"
            :data="itemsByCategory.get(category)!.conflicts"
            size="small"
            border
            class="conflict-table"
          >
            <el-table-column prop="label" label="裁决项" width="150" />
            <el-table-column label="旧号「{{ checklist.oldNo }}」" min-width="200">
              <template #default="scope">
                <span :class="{ picked: scope.row.winner === 'old' }">{{ scope.row.oldValue }}</span>
              </template>
            </el-table-column>
            <el-table-column label="正式号「{{ checklist.formalNo }}」" min-width="200">
              <template #default="scope">
                <span :class="{ picked: scope.row.winner === 'formal' }">{{ scope.row.formalValue }}</span>
              </template>
            </el-table-column>
            <el-table-column label="保留哪边" width="220">
              <template #default="scope">
                <el-radio-group
                  :model-value="scope.row.winner"
                  :disabled="itemsByCategory.get(category)!.status === 'done'"
                  @change="(v: 'old' | 'formal') => decide(category, scope.row.key, v)"
                >
                  <el-radio-button value="old">保留旧号</el-radio-button>
                  <el-radio-button value="formal">保留正式号</el-radio-button>
                </el-radio-group>
              </template>
            </el-table-column>
          </el-table>

          <!-- 髹漆遍次：同遍两边不一致整条选边 -->
          <el-table
            v-if="itemsByCategory.get(category)!.layerConflicts.length"
            :data="itemsByCategory.get(category)!.layerConflicts"
            size="small"
            border
            class="conflict-table"
          >
            <el-table-column prop="seq" label="遍次" width="70" />
            <el-table-column label="旧号记录" min-width="240">
              <template #default="scope">
                <span :class="{ picked: scope.row.winner === 'old' }">{{ scope.row.oldSummary }}</span>
              </template>
            </el-table-column>
            <el-table-column label="正式号记录" min-width="240">
              <template #default="scope">
                <span :class="{ picked: scope.row.winner === 'formal' }">{{ scope.row.formalSummary }}</span>
              </template>
            </el-table-column>
            <el-table-column label="保留哪边" width="220">
              <template #default="scope">
                <el-radio-group
                  :model-value="scope.row.winner"
                  :disabled="itemsByCategory.get(category)!.status === 'done'"
                  @change="(v: 'old' | 'formal') => decide(category, scope.row.key, v)"
                >
                  <el-radio-button value="old">保留旧号</el-radio-button>
                  <el-radio-button value="formal">保留正式号</el-radio-button>
                </el-radio-group>
              </template>
            </el-table-column>
          </el-table>

          <el-alert
            v-if="itemsByCategory.get(category)!.status === 'failed'"
            type="error"
            :closable="false"
            show-icon
            class="tag"
            :title="`上次迁移失败：${itemsByCategory.get(category)!.error ?? '未知错误'}；该类已回滚，可直接重试`"
          />
          <el-alert
            v-else-if="itemsByCategory.get(category)!.status === 'done'"
            type="success"
            :closable="false"
            show-icon
            title="已迁到正式琴号；旧号该类数据已归并，旧号仅保留为可搜索别名"
          />
          <el-alert
            v-else-if="!pendingDecisions(itemsByCategory.get(category)!)"
            type="info"
            :closable="false"
            show-icon
            :title="
              category === 'lacquer'
                ? '无冲突遍次（含重复自动去重）；执行后按幸存遍次重排序号、重算累计厚度，不会重复加一遍'
                : '无冲突项，可直接迁移；单边数据自动归并到正式琴号'
            "
          />
        </template>
      </el-card>
    </template>
  </div>
</template>

<style scoped>
.page-title {
  margin: 0 0 4px;
  font-size: 20px;
  color: #4a3728;
}
.page-desc {
  margin: 0 0 14px;
  color: #8a7a68;
  font-size: 13px;
}
.block {
  margin-bottom: 16px;
  border-radius: 8px;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.card-note {
  font-size: 12px;
  color: #8a7a68;
}
.pair-form {
  max-width: 560px;
}
.hint {
  margin-left: 12px;
  color: #a3968a;
  font-size: 12px;
}
.warn {
  margin-left: 12px;
  color: #c62828;
  font-size: 13px;
}
.action-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.tag {
  margin-right: 6px;
}
.item-title {
  margin: 0 0 8px;
  color: #6b5b4b;
  font-size: 13px;
}
.conflict-table {
  margin-top: 8px;
}
.picked {
  font-weight: 600;
  color: #1f6f43;
}
</style>
