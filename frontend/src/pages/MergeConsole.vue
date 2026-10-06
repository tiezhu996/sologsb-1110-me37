<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useBoardStore } from '../stores/boardStore';
import { useChamberStore } from '../stores/chamberStore';
import { useLacquerStore } from '../stores/lacquerStore';
import { useStringingStore } from '../stores/stringingStore';
import {
  commitMerge,
  discardMerge,
  listMergeChecklists,
  prepareMerge,
  rollbackMerge,
  saveAdjudications,
  CATEGORY_ORDER,
} from '../utils/renumber';
import {
  categoryStats,
  MERGE_CATEGORY_LABELS,
  pendingAdjudications,
} from '../utils/mergeEngine';
import { loadAliases, aliasLabel } from '../utils/aliases';
import type { MergeChecklist } from '../types/merge';
import type { MergeCategory, MergeItem, MergeSide } from '../types/merge';

const boardStore = useBoardStore();
const chamberStore = useChamberStore();
const lacquerStore = useLacquerStore();
const stringingStore = useStringingStore();

const oldNo = ref('');
const newNo = ref('');
const checklist = ref<MergeChecklist | null>(null);
const savedChecklists = ref<MergeChecklist[]>([]);
const busy = ref(false);

/** 折叠面板默认展开四类 */
const activeGroups = ref<MergeCategory[]>(['board', 'chamber', 'lacquer', 'stringing']);

const allGuqinNos = computed(() => {
  const set = new Set<string>();
  boardStore.boards.forEach((b) => set.add(b.guqinNo));
  chamberStore.chambers.forEach((c) => set.add(c.guqinNo));
  lacquerStore.layers.forEach((l) => set.add(l.guqinNo));
  stringingStore.stringings.forEach((s) => set.add(s.guqinNo));
  return Array.from(set).sort();
});

const stats = computed(() => (checklist.value ? categoryStats(checklist.value.plan) : null));
const pending = computed(() => (checklist.value ? pendingAdjudications(checklist.value.plan) : 0));

const groupedItems = computed(() => {
  if (!checklist.value) return [] as Array<{ category: MergeCategory; items: MergeItem[] }>;
  return CATEGORY_ORDER.map((category) => ({
    category,
    items: checklist.value!.plan.items.filter((i) => i.category === category),
  })).filter((g) => g.items.length > 0);
});

const doneCategories = computed(() => new Set(checklist.value?.doneCategories ?? []));

async function refreshStores() {
  await Promise.all([
    boardStore.hydrate(),
    chamberStore.hydrate(),
    lacquerStore.hydrate(),
    stringingStore.hydrate(),
    loadAliases(),
  ]);
}

onMounted(async () => {
  await loadAliases();
  await refreshSaved();
});

async function refreshSaved() {
  savedChecklists.value = await listMergeChecklists();
}

async function createPlan() {
  if (!oldNo.value || !newNo.value) {
    ElMessage.warning('请先选择临时琴号与正式琴号');
    return;
  }
  if (oldNo.value === newNo.value) {
    ElMessage.warning('临时琴号与正式琴号不能相同');
    return;
  }
  busy.value = true;
  try {
    checklist.value = await prepareMerge(oldNo.value, newNo.value);
    ElMessage.success('核对清单已生成：冲突项逐项裁决后才能执行，期间不会改动任何业务数据');
    await refreshSaved();
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    busy.value = false;
  }
}

function choose(item: MergeItem, side: MergeSide) {
  item.decision = side;
  item.confirmed = true;
}

/** 一键把某类所有冲突项选到同一边（即显式确认；auto 项不动） */
function chooseCategory(category: MergeCategory, side: MergeSide) {
  checklist.value?.plan.items
    .filter((item) => item.category === category && item.status === 'conflict')
    .forEach((item) => {
      item.decision = side;
      item.confirmed = true;
    });
}

function chooseAll(side: MergeSide) {
  checklist.value?.plan.items
    .filter((item) => item.status === 'conflict')
    .forEach((item) => {
      item.decision = side;
      item.confirmed = true;
    });
}

async function persistDecisions() {
  if (!checklist.value) return;
  const decisions: Record<string, MergeSide> = {};
  const confirmed: Record<string, boolean> = {};
  checklist.value.plan.items.forEach((item) => {
    if (item.decision) decisions[item.id] = item.decision;
    confirmed[item.id] = Boolean(item.confirmed);
  });
  checklist.value = await saveAdjudications(checklist.value.id, decisions, confirmed);
  await refreshSaved();
}

async function execute() {
  if (!checklist.value) return;
  if (pending.value > 0) {
    ElMessage.warning(`还有 ${pending.value} 项冲突未裁决，任何一项未裁决前不得改库`);
    return;
  }
  const confirmed = await ElMessageBox.confirm(
    `确认把临时琴号 ${checklist.value.plan.oldNo} 的四类数据合档到正式琴号 ${checklist.value.plan.newNo}？`,
    '合档执行确认',
    { type: 'warning' },
  )
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;

  busy.value = true;
  try {
    await persistDecisions();
    checklist.value = await commitMerge(checklist.value.id);
    ElMessage.success('合档完成：四类数据已全部迁到正式琴号，旧号仅保留为可搜索别名');
    checklist.value = null;
    oldNo.value = '';
    newNo.value = '';
    await refreshStores();
    await refreshSaved();
  } catch (error) {
    ElMessage.error(`合档中断：${(error as Error).message}。可从核对清单恢复，或直接重试剩余类别`);
    await loadSavedState();
  } finally {
    busy.value = false;
  }
}

async function loadSavedState() {
  await refreshSaved();
  if (checklist.value) {
    const latest = savedChecklists.value.find((c) => c.id === checklist.value!.id);
    if (latest) checklist.value = latest;
  }
}

async function retrySaved(item: MergeChecklist) {
  busy.value = true;
  try {
    await commitMerge(item.id);
    ElMessage.success(`重试成功：${item.plan.oldNo} → ${item.plan.newNo} 剩余类别已迁移`);
    if (checklist.value?.id === item.id) checklist.value = null;
    await refreshStores();
    await refreshSaved();
  } catch (error) {
    ElMessage.error(`重试仍失败：${(error as Error).message}`);
    await refreshSaved();
    const latest = savedChecklists.value.find((c) => c.id === item.id);
    if (latest && checklist.value?.id === item.id) checklist.value = latest;
  } finally {
    busy.value = false;
  }
}

async function restoreSaved(item: MergeChecklist) {
  const confirmed = await ElMessageBox.confirm(
    `从核对清单恢复 ${item.plan.oldNo} / ${item.plan.newNo}？已迁移的类别将逐类写回快照原始数据。`,
    '恢复确认',
    { type: 'warning' },
  )
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  busy.value = true;
  try {
    const restored = await rollbackMerge(item.id);
    ElMessage.success('已按核对清单快照恢复，清单保留为待执行，可重新裁决后再执行');
    if (checklist.value?.id === item.id) checklist.value = restored;
    await refreshStores();
    await refreshSaved();
  } catch (error) {
    ElMessage.error(`恢复失败：${(error as Error).message}`);
  } finally {
    busy.value = false;
  }
}

async function discardSaved(item: MergeChecklist) {
  const confirmed = await ElMessageBox.confirm('确认放弃该核对清单？清单删除后不可再用于恢复。', '放弃确认', {
    type: 'warning',
  })
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  busy.value = true;
  try {
    await discardMerge(item.id);
    if (checklist.value?.id === item.id) checklist.value = null;
    await refreshSaved();
    ElMessage.success('核对清单已删除');
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    busy.value = false;
  }
}

function loadChecklist(item: MergeChecklist) {
  checklist.value = item;
  oldNo.value = item.plan.oldNo;
  newNo.value = item.plan.newNo;
}

const stateTagType: Record<string, 'info' | 'warning' | 'danger' | 'success'> = {
  pending: 'info',
  committing: 'warning',
  failed: 'danger',
  done: 'success',
};
const stateLabel: Record<string, string> = {
  pending: '待裁决/待执行',
  committing: '提交中（含检查点）',
  failed: '已中断',
  done: '已完成',
};
</script>

<template>
  <div v-loading="busy" element-loading-text="正在处理合档…">
    <h2 class="page-title">琴号合档</h2>
    <p class="page-desc">
      面板底板配对改挂正式琴号后，把临时琴号下的板材、槽腹、髹漆、上弦四类数据迁到正式琴号；两边取值不同的逐项选保留哪边。
      全部冲突裁决前不改库；失败可从核对清单恢复，重试只处理剩余类别，髹漆遍次与累计厚度绝不重复累加。
    </p>

    <el-card shadow="never" class="block">
      <template #header>发起合档</template>
      <div class="init-row">
        <div class="init-field">
          <span class="init-label">临时琴号（旧号）</span>
          <el-select v-model="oldNo" filterable placeholder="选择改号前的临时琴号" style="width: 240px">
            <el-option v-for="no in allGuqinNos" :key="`old-${no}`" :label="no" :value="no" />
          </el-select>
        </div>
        <span class="arrow">→</span>
        <div class="init-field">
          <span class="init-label">正式琴号（配对后）</span>
          <el-select v-model="newNo" filterable placeholder="选择配对后的正式琴号" style="width: 240px">
            <el-option
              v-for="no in allGuqinNos"
              :key="`new-${no}`"
              :label="aliasLabel(no) ? `${no}（${aliasLabel(no)}）` : no"
              :value="no"
            />
          </el-select>
        </div>
        <el-button type="primary" :disabled="!!checklist" @click="createPlan">生成核对清单</el-button>
      </div>
    </el-card>

    <el-card v-if="savedChecklists.length" shadow="never" class="block">
      <template #header>未完成的核对清单（{{ savedChecklists.length }}）</template>
      <el-table :data="savedChecklists" size="small" border>
        <el-table-column label="合档" min-width="180">
          <template #default="scope">{{ scope.row.plan.oldNo }} → {{ scope.row.plan.newNo }}</template>
        </el-table-column>
        <el-table-column label="状态" width="150">
          <template #default="scope">
            <el-tag :type="stateTagType[scope.row.state]" size="small">{{ stateLabel[scope.row.state] }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="已迁移类别" min-width="220">
          <template #default="scope">
            <el-tag
              v-for="cat in CATEGORY_ORDER.filter((c) => scope.row.doneCategories.includes(c))"
              :key="cat"
              size="small"
              type="success"
              class="cat-tag"
            >
              {{ MERGE_CATEGORY_LABELS[cat] }}
            </el-tag>
            <span v-if="!scope.row.doneCategories.length" class="muted">无</span>
          </template>
        </el-table-column>
        <el-table-column prop="lastError" label="中断原因" min-width="160" show-overflow-tooltip />
        <el-table-column label="操作" width="270" fixed="right">
          <template #default="scope">
            <el-button link type="primary" @click="loadChecklist(scope.row)">打开裁决</el-button>
            <el-button link type="warning" @click="retrySaved(scope.row)">重试剩余</el-button>
            <el-button link type="danger" @click="restoreSaved(scope.row)">从清单恢复</el-button>
            <el-button link @click="discardSaved(scope.row)">放弃</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <template v-if="checklist">
      <el-card shadow="never" class="block">
        <template #header>
          <div class="card-head">
            <span>核对清单 · {{ checklist.plan.oldNo }} → {{ checklist.plan.newNo }}</span>
            <div>
              <el-tag :type="pending ? 'danger' : 'success'" effect="plain" class="head-tag">
                待裁决冲突 {{ pending }} 项
              </el-tag>
              <el-button size="small" @click="chooseAll('new')">冲突全部取正式号</el-button>
              <el-button size="small" @click="chooseAll('old')">冲突全部取旧号</el-button>
            </div>
          </div>
        </template>

        <el-collapse v-model="activeGroups" v-for="group in groupedItems" :key="group.category" class="group-collapse">
          <el-collapse-item :name="group.category">
            <template #title>
              <span class="group-title">{{ MERGE_CATEGORY_LABELS[group.category] }}</span>
              <el-tag size="small" type="info" effect="plain" class="head-tag">
                {{ group.items.length }} 项
              </el-tag>
              <el-tag v-if="stats?.[group.category].conflicts" size="small" type="danger" effect="plain" class="head-tag">
                冲突 {{ stats?.[group.category].conflicts }}
              </el-tag>
              <el-tag
                v-if="doneCategories.has(group.category)"
                size="small"
                type="success"
                effect="plain"
                class="head-tag"
              >
                已迁移（检查点）
              </el-tag>
              <div class="group-actions" @click.stop>
                <el-button link type="primary" @click="chooseCategory(group.category, 'new')">冲突取正式号</el-button>
                <el-button link type="primary" @click="chooseCategory(group.category, 'old')">冲突取旧号</el-button>
              </div>
            </template>

            <div v-for="item in group.items" :key="item.id" class="item-row" :class="{ conflict: item.status === 'conflict' }">
              <div class="item-head">
                <span class="item-label">{{ item.label }}</span>
                <el-tag :type="item.status === 'conflict' ? (item.confirmed ? 'success' : 'danger') : 'info'" size="small" effect="plain">
                  {{ item.status === 'conflict' ? (item.confirmed ? '已裁决' : '需裁决') : '自动' }}
                </el-tag>
                <el-radio-group
                  :model-value="item.decision"
                  size="small"
                  :disabled="item.status === 'auto'"
                  @change="(v: MergeSide) => choose(item, v)"
                >
                  <el-radio value="old">保留旧号</el-radio>
                  <el-radio value="new">保留正式号</el-radio>
                </el-radio-group>
              </div>
              <div class="value-grid">
                <div class="value-cell old" :class="{ picked: item.decision === 'old' }">
                  <div class="cell-title">旧号 {{ checklist.plan.oldNo }}</div>
                  <div class="cell-text">{{ item.oldValue ?? '—（无记录）' }}</div>
                </div>
                <div class="value-cell new" :class="{ picked: item.decision === 'new' }">
                  <div class="cell-title">正式号 {{ checklist.plan.newNo }}</div>
                  <div class="cell-text">{{ item.newValue ?? '—（无记录）' }}</div>
                </div>
              </div>
              <div v-if="item.hint" class="item-hint">{{ item.hint }}</div>
            </div>
          </el-collapse-item>
        </el-collapse>
      </el-card>

      <div class="action-bar">
        <el-button @click="persistDecisions">暂存裁决</el-button>
        <el-button type="primary" :disabled="pending > 0" @click="execute">
          执行合档（{{ pending > 0 ? `还差 ${pending} 项裁决` : '四类原子迁移' }}）
        </el-button>
        <el-button type="danger" plain @click="restoreSaved(checklist)">失败恢复演练（从清单恢复）</el-button>
        <span class="muted">执行顺序：板材 → 槽腹 → 髹漆 → 上弦；每类一个事务并设检查点</span>
      </div>
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
  margin: 0 0 12px;
  color: #8a7a68;
  font-size: 13px;
}
.block {
  margin-bottom: 16px;
  border-radius: 8px;
}
.init-row {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.init-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.init-label {
  font-size: 12px;
  color: #8a7a68;
}
.arrow {
  font-size: 18px;
  color: #4a3728;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.head-tag {
  margin-right: 8px;
}
.cat-tag {
  margin-right: 4px;
}
.group-collapse {
  border-bottom: 1px solid #ece0cf;
}
.group-title {
  font-weight: 600;
  color: #4a3728;
  margin-right: 8px;
}
.group-actions {
  margin-left: auto;
  padding-right: 12px;
}
.item-row {
  padding: 10px 12px;
  margin-bottom: 8px;
  border: 1px solid #ece0cf;
  border-radius: 6px;
  background: #fdfaf5;
}
.item-row.conflict {
  border-color: #e6a23c;
  background: #fdf6ec;
}
.item-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.item-label {
  font-size: 13px;
  font-weight: 600;
  color: #4a3728;
}
.value-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.value-cell {
  border: 1px solid #e4d8c6;
  border-radius: 6px;
  padding: 8px 10px;
  background: #fff;
  font-size: 13px;
}
.value-cell.picked {
  border-width: 2px;
  border-color: #67c23a;
  background: #f0f9eb;
}
.cell-title {
  font-size: 12px;
  color: #8a7a68;
  margin-bottom: 4px;
}
.cell-text {
  color: #4a3728;
  white-space: pre-wrap;
}
.item-hint {
  margin-top: 6px;
  font-size: 12px;
  color: #a3968a;
}
.action-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.muted {
  color: #a3968a;
  font-size: 12px;
}
</style>
