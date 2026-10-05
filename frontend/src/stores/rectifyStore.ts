/**
 * 年检整改状态（Pinia）
 * 维护整改单跟踪、提交复核 / 复核关闭、超期预警派生值。
 *
 * 列表与统计一律走「主单口径」：v3 升级归并出的历史重复从单只留来源，不展示；
 * 异常项转整改通过 utils/workflow 的本地事务 + sourceItemId 唯一索引保证
 * 同一异常只留一条有效整改单，重复提交返回已有单。
 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  ROW_REVISION,
  listElevators,
  listMasterRectifies,
  listRectifies,
  putRectify,
  removeRectify,
  type ElevatorRow,
  type RectifyRow,
} from '../utils/db';
import {
  isMasterRectify,
  overdueDaysOf,
  type RectifyDraft,
  type RectifyView,
} from '../types/rectify';
import { promoteAbnormalItemsTx, type PromoteResult } from '../utils/workflow';
import type { CheckItemDraft } from '../types/checkItem';
import { nowDateTime } from '../utils/duration';
import { uuid } from '../utils/export';
import { emitChange, onChange } from '../utils/events';

export interface PromoteSummary extends PromoteResult {
  /** 新建 + 已有合计（每个异常项对应一条有效单） */
  total: number;
}

export const useRectifyStore = defineStore('rectify', () => {
  /** 主单口径数据（从单仅存在于 IndexedDB 留痕） */
  const rectifies = ref<RectifyRow[]>([]);
  const elevators = ref<ElevatorRow[]>([]);
  const loading = ref(false);
  const error = ref('');
  const initialized = ref(false);
  let subscribed = false;

  async function load(): Promise<void> {
    loading.value = true;
    try {
      const [rectifyRows, elevatorRows] = await Promise.all([listMasterRectifies(), listElevators()]);
      rectifies.value = rectifyRows;
      elevators.value = elevatorRows;
      error.value = '';
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '整改单读取失败';
    } finally {
      loading.value = false;
    }
  }

  async function bootstrap(): Promise<void> {
    if (!initialized.value) initialized.value = true;
    if (!subscribed) {
      subscribed = true;
      onChange(() => {
        void load();
      });
    }
    await load();
  }

  /** 手工登记整改单（不绑定来源保养项，不参与异常项防重） */
  async function createRectify(draft: RectifyDraft): Promise<RectifyRow> {
    const id = uuid();
    const row: RectifyRow = {
      id,
      elevatorId: draft.elevatorId,
      item: draft.item.trim(),
      dueDate: draft.dueDate,
      state: 'pending',
      reviewer: draft.reviewer.trim(),
      reviewedAt: null,
      masterId: id,
      createdAt: nowDateTime(),
      revision: ROW_REVISION,
    };
    await putRectify(row);
    emitChange();
    return row;
  }

  async function updateRectify(id: string, draft: RectifyDraft): Promise<void> {
    const existing = rectifies.value.find((item) => item.id === id);
    if (!existing) return;
    await putRectify({
      ...existing,
      elevatorId: draft.elevatorId,
      item: draft.item.trim(),
      dueDate: draft.dueDate,
      reviewer: draft.reviewer.trim(),
    });
    emitChange();
  }

  /** 班组完成整改，提交进入待复核队列 */
  async function submitForReview(id: string, reviewer?: string): Promise<void> {
    const existing = rectifies.value.find((item) => item.id === id);
    if (!existing) return;
    await putRectify({
      ...existing,
      state: 'reviewing',
      reviewer: (reviewer ?? existing.reviewer).trim() || existing.reviewer,
      reviewedAt: null,
    });
    emitChange();
  }

  /** 复核通过：锁定结论，此后来源变更不再影响本单 */
  async function review(id: string, reviewer: string): Promise<void> {
    const existing = rectifies.value.find((item) => item.id === id);
    if (!existing) return;
    await putRectify({
      ...existing,
      state: 'reviewed',
      reviewer: reviewer.trim() || existing.reviewer,
      reviewedAt: nowDateTime(),
    });
    emitChange();
  }

  /** 复核不通过：退回待整改班组重新处理 */
  async function rejectToPending(id: string): Promise<void> {
    const existing = rectifies.value.find((item) => item.id === id);
    if (!existing) return;
    await putRectify({ ...existing, state: 'pending', reviewedAt: null });
    emitChange();
  }

  /** 撤销复核：结论作废，单子回到待复核队列重新确认 */
  async function revokeReview(id: string): Promise<void> {
    const existing = rectifies.value.find((item) => item.id === id);
    if (!existing) return;
    await putRectify({ ...existing, state: 'reviewing', reviewedAt: null });
    emitChange();
  }

  /** 删除主单时级联删除其归并留痕的从单 */
  async function deleteRectify(id: string): Promise<void> {
    const aliases = (await listRectifies()).filter((row) => row.masterId === id && row.id !== id);
    for (const alias of aliases) {
      await removeRectify(alias.id);
    }
    await removeRectify(id);
    emitChange();
  }

  /**
   * 由保养异常项一键转整改（一次本地事务）。
   * 同一异常项已有有效单时直接随 reused 返回，绝不重复建单；
   * 并发双提交由 sourceItemId 唯一索引兜底。
   */
  async function promoteAbnormalItems(
    elevatorId: string,
    planId: string,
    dueDate: string,
    reviewer: string,
    drafts?: Array<{ id: string } & CheckItemDraft>,
  ): Promise<PromoteSummary> {
    const result = await promoteAbnormalItemsTx(
      elevatorId,
      planId,
      dueDate,
      reviewer,
      drafts?.map((draft) => ({
        id: draft.id,
        itemName: draft.itemName,
        result: draft.result,
        value: draft.value,
        remark: draft.remark,
      })),
    );
    emitChange();
    return { ...result, total: result.created.length + result.reused.length };
  }

  /** 整改单视图：附电梯上下文、超期天数与归并来源数 */
  const rectifyViews = computed<RectifyView[]>(() =>
    rectifies.value
      .filter((row) => isMasterRectify(row))
      .map((row) => {
        const elevator = elevators.value.find((item) => item.id === row.elevatorId);
        const days = overdueDaysOf(row.dueDate, row.state);
        return {
          ...row,
          elevatorName: elevator ? `${elevator.regCode}（${elevator.owner}）` : '已删除电梯',
          owner: elevator?.owner ?? '-',
          overdue: days > 0,
          overdueDays: days,
          mergedCount: row.mergedFrom?.length ?? 0,
        };
      }),
  );

  const pendingViews = computed(() => rectifyViews.value.filter((item) => item.state === 'pending'));
  const reviewingViews = computed(() => rectifyViews.value.filter((item) => item.state === 'reviewing'));
  const overdueViews = computed(() =>
    rectifyViews.value
      .filter((item) => item.overdue)
      .sort((a, b) => b.overdueDays - a.overdueDays),
  );
  const reviewedViews = computed(() => rectifyViews.value.filter((item) => item.state === 'reviewed'));

  const reviewRate = computed(() => {
    if (rectifyViews.value.length === 0) return 0;
    return Number(((reviewedViews.value.length / rectifyViews.value.length) * 100).toFixed(1));
  });

  /** 按使用单位统计待办量（待整改 + 待复核均为未闭环） */
  const byOwner = computed(() => {
    const buckets = new Map<string, { owner: string; pending: number; overdue: number; total: number }>();
    for (const row of rectifyViews.value) {
      const bucket = buckets.get(row.owner) ?? { owner: row.owner, pending: 0, overdue: 0, total: 0 };
      bucket.total += 1;
      if (row.state !== 'reviewed') bucket.pending += 1;
      if (row.overdue) bucket.overdue += 1;
      buckets.set(row.owner, bucket);
    }
    return [...buckets.values()].sort((a, b) => b.pending - a.pending);
  });

  return {
    rectifies,
    elevators,
    loading,
    error,
    initialized,
    load,
    bootstrap,
    createRectify,
    updateRectify,
    submitForReview,
    review,
    rejectToPending,
    revokeReview,
    deleteRectify,
    promoteAbnormalItems,
    rectifyViews,
    pendingViews,
    reviewingViews,
    overdueViews,
    reviewedViews,
    reviewRate,
    byOwner,
  };
});
