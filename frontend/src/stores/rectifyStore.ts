/**
 * 年检整改状态（Pinia）
 * 维护整改单跟踪、复核关闭与超期预警派生值；
 * 列表只含主单（重复单已在持久层归并），新建走幂等事务。
 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  listElevators,
  listRectifies,
  putRectify,
  createRectifyIdempotent,
  removeRectify,
  type ElevatorRow,
  type RectifyRow,
} from '../utils/db';
import {
  overdueDaysOf,
  rectifyDedupeKey,
  type RectifyDraft,
  type RectifyView,
} from '../types/rectify';
import { nowDateTime } from '../utils/duration';
import { emitChange, onChange } from '../utils/events';

export const useRectifyStore = defineStore('rectify', () => {
  const rectifies = ref<RectifyRow[]>([]);
  const elevators = ref<ElevatorRow[]>([]);
  const loading = ref(false);
  const error = ref('');
  const initialized = ref(false);
  let subscribed = false;

  async function load(): Promise<void> {
    loading.value = true;
    try {
      const [rectifyRows, elevatorRows] = await Promise.all([listRectifies(), listElevators()]);
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

  /**
   * 幂等登记整改单：同一电梯同一不合格项只留一条有效单，
   * 已存在有效单时复用并返回 reused = true，重复提交不产生新单。
   */
  async function createRectify(draft: RectifyDraft): Promise<{ row: RectifyRow; reused: boolean }> {
    const result = await createRectifyIdempotent(draft);
    emitChange();
    return result;
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
      dedupeKey: rectifyDedupeKey(draft.elevatorId, draft.item),
    });
    emitChange();
  }

  /** 复核通过：关闭整改单并回写复核人与时间（待整改 / 待复核均可复核） */
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

  /** 撤销复核：退回待整改 */
  async function revokeReview(id: string): Promise<void> {
    const existing = rectifies.value.find((item) => item.id === id);
    if (!existing) return;
    await putRectify({ ...existing, state: 'pending', reviewedAt: null });
    emitChange();
  }

  /** 待复核单确认无误：退回待整改继续跟踪 */
  async function resumeRectify(id: string): Promise<void> {
    const existing = rectifies.value.find((item) => item.id === id);
    if (!existing || existing.state !== 'recheck') return;
    await putRectify({ ...existing, state: 'pending' });
    emitChange();
  }

  async function deleteRectify(id: string): Promise<void> {
    await removeRectify(id);
    emitChange();
  }

  /** 整改单视图：附电梯上下文与超期天数（仅主单） */
  const rectifyViews = computed<RectifyView[]>(() =>
    rectifies.value.map((row) => {
      const elevator = elevators.value.find((item) => item.id === row.elevatorId);
      const days = overdueDaysOf(row.dueDate, row.state);
      return {
        ...row,
        elevatorName: elevator ? `${elevator.regCode}（${elevator.owner}）` : '已删除电梯',
        owner: elevator?.owner ?? '-',
        overdue: days > 0,
        overdueDays: days,
      };
    }),
  );

  const pendingViews = computed(() => rectifyViews.value.filter((item) => item.state === 'pending'));
  const recheckViews = computed(() => rectifyViews.value.filter((item) => item.state === 'recheck'));
  /** 未复核开口单（待整改 + 待复核） */
  const openViews = computed(() => rectifyViews.value.filter((item) => item.state !== 'reviewed'));
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

  /** 按使用单位统计未复核整改量 */
  const byOwner = computed(() => {
    const buckets = new Map<string, { owner: string; open: number; overdue: number; total: number }>();
    for (const row of rectifyViews.value) {
      const bucket = buckets.get(row.owner) ?? { owner: row.owner, open: 0, overdue: 0, total: 0 };
      bucket.total += 1;
      if (row.state !== 'reviewed') bucket.open += 1;
      if (row.overdue) bucket.overdue += 1;
      buckets.set(row.owner, bucket);
    }
    return [...buckets.values()].sort((a, b) => b.open - a.open);
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
    review,
    revokeReview,
    resumeRectify,
    deleteRectify,
    rectifyViews,
    pendingViews,
    recheckViews,
    openViews,
    overdueViews,
    reviewedViews,
    reviewRate,
    byOwner,
  };
});
