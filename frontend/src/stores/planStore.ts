/**
 * 保养计划状态（Pinia）
 * 维护计划生成规则、执行人指派、状态流转与完成度派生值。
 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  ROW_REVISION,
  db,
  listCheckItems,
  listElevators,
  listPlans,
  planDatesFrom,
  putPlan,
  putPlans,
  putCheckItems,
  removePlan,
  type CheckItemRow,
  type ElevatorRow,
  type PlanRow,
} from '../utils/db';
import { itemsForCycle } from '../types/checkItem';
import type { CheckItemDraft } from '../types/checkItem';
import { isPlanOverdue, planProgress, type PlanDraft, type PlanState, type PlanView } from '../types/plan';
import type { MaintCycle } from '../types/elevator';
import { changePlanTx, signPlanTx } from '../utils/workflow';
import { nowDateTime, todayDate } from '../utils/duration';
import { uuid } from '../utils/export';
import { emitChange, onChange } from '../utils/events';

export interface BatchGenerateInput {
  elevatorIds: string[];
  cycleType: MaintCycle;
  startDate: string;
  /** 连续生成期数 */
  periods: number;
  executor: string;
}

export const usePlanStore = defineStore('plan', () => {
  const plans = ref<PlanRow[]>([]);
  const elevators = ref<ElevatorRow[]>([]);
  const checkItems = ref<CheckItemRow[]>([]);
  const activePlanId = ref<string>('');
  /** 列表筛选：周期类型（空数组表示全部） */
  const cycleFilters = ref<MaintCycle[]>([]);
  /** 列表筛选：状态 */
  const stateFilters = ref<PlanState[]>([]);
  const loading = ref(false);
  const error = ref('');
  const initialized = ref(false);
  let subscribed = false;

  async function load(): Promise<void> {
    loading.value = true;
    try {
      const [planRows, elevatorRows, itemRows] = await Promise.all([
        listPlans(),
        listElevators(),
        listCheckItems(),
      ]);
      plans.value = planRows;
      elevators.value = elevatorRows;
      checkItems.value = itemRows;
      error.value = '';
      if (!activePlanId.value || !planRows.some((item) => item.id === activePlanId.value)) {
        activePlanId.value = planRows[0]?.id ?? '';
      }
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '保养计划读取失败';
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

  function setCycleFilters(values: MaintCycle[]): void {
    cycleFilters.value = values;
  }

  function setStateFilters(values: PlanState[]): void {
    stateFilters.value = values;
  }

  function setActivePlan(id: string): void {
    activePlanId.value = id;
  }

  /** 为指定电梯生成一期计划（计划与保养项同一事务提交） */
  async function createPlan(draft: PlanDraft): Promise<PlanRow> {
    const row: PlanRow = {
      id: uuid(),
      elevatorId: draft.elevatorId,
      cycleType: draft.cycleType,
      planDate: draft.planDate,
      executor: draft.executor.trim(),
      state: 'pending',
      signedAt: null,
      createdAt: nowDateTime(),
      revision: ROW_REVISION,
    };
    const itemRows: CheckItemRow[] = itemsForCycle(row.cycleType).map((itemName, index) => ({
      id: `chk-${row.id}-${index + 1}`,
      planId: row.id,
      seq: index + 1,
      itemName,
      result: null,
      value: '',
      remark: '',
      createdAt: nowDateTime(),
      revision: ROW_REVISION,
    }));
    await db.transaction('rw', [db.plans, db.checkItems], async () => {
      await putPlan(row);
      await putCheckItems(itemRows);
    });
    emitChange();
    return row;
  }

  /** 按周期批量生成计划（计划与保养项同一事务提交，失败整体回滚） */
  async function batchGenerate(input: BatchGenerateInput): Promise<number> {
    const rows: PlanRow[] = [];
    const items: CheckItemRow[] = [];
    for (const elevatorId of input.elevatorIds) {
      const dates = planDatesFrom(input.startDate, input.cycleType, input.periods);
      for (const planDate of dates) {
        const id = uuid();
        const stamp = nowDateTime();
        rows.push({
          id,
          elevatorId,
          cycleType: input.cycleType,
          planDate,
          executor: input.executor.trim(),
          state: 'pending',
          signedAt: null,
          createdAt: stamp,
          revision: ROW_REVISION,
        });
        items.push(
          ...itemsForCycle(input.cycleType).map((itemName, index) => ({
            id: `chk-${id}-${index + 1}`,
            planId: id,
            seq: index + 1,
            itemName,
            result: null,
            value: '',
            remark: '',
            createdAt: stamp,
            revision: ROW_REVISION,
          })),
        );
      }
    }
    if (rows.length === 0) return 0;
    await db.transaction('rw', [db.plans, db.checkItems], async () => {
      await putPlans(rows);
      await putCheckItems(items);
    });
    emitChange();
    return rows.length;
  }

  /**
   * 改期 / 更换电梯 / 调整计划（同一事务）。
   * 改期或换梯后，该计划来源的未复核整改单回到待复核；已复核结论保留。
   */
  async function updatePlan(id: string, draft: PlanDraft): Promise<{ reopenedCount: number }> {
    const result = await changePlanTx(id, draft);
    emitChange();
    return { reopenedCount: result?.reopened.length ?? 0 };
  }

  /** 指派执行人 */
  async function assignExecutor(id: string, executor: string): Promise<void> {
    const existing = plans.value.find((item) => item.id === id);
    if (!existing) return;
    await putPlan({ ...existing, executor: executor.trim() });
    emitChange();
  }

  /** 状态流转：待执行 → 执行中 → 已签署 */
  async function updateState(id: string, state: PlanState): Promise<void> {
    const existing = plans.value.find((item) => item.id === id);
    if (!existing) return;
    await putPlan({
      ...existing,
      state,
      signedAt: state === 'signed' ? nowDateTime() : null,
    });
    emitChange();
  }

  /**
   * 签署：保养项保存与计划签署在同一本地事务。
   * - 可传入当前页面草稿，签署前一次性落库；
   * - 未全部填写 / 没有保养项时事务回滚，已保存项与签署草稿均可恢复，重试不产生重复数据。
   */
  async function signPlan(
    id: string,
    drafts?: Array<{ id: string } & CheckItemDraft>,
  ): Promise<{ ok: boolean; message: string; reopenedCount: number }> {
    try {
      const result = await signPlanTx(
        id,
        drafts?.map((draft) => ({
          id: draft.id,
          itemName: draft.itemName,
          result: draft.result,
          value: draft.value,
          remark: draft.remark,
        })),
      );
      emitChange();
      return { ok: result.ok, message: result.message, reopenedCount: result.reopened.length };
    } catch (cause) {
      // 校验失败由事务整体回滚：计划不会签署，保养项也不落半成品
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : '签署失败，已恢复未签署状态',
        reopenedCount: 0,
      };
    }
  }

  async function deletePlan(id: string): Promise<void> {
    await removePlan(id);
    if (activePlanId.value === id) activePlanId.value = '';
    emitChange();
  }

  /** 计划视图：附带电梯上下文、完成度与逾期判定 */
  const planViews = computed<PlanView[]>(() =>
    plans.value.map((plan) => {
      const elevator = elevators.value.find((item) => item.id === plan.elevatorId);
      const items = checkItems.value.filter((item) => item.planId === plan.id);
      const filledCount = items.filter((item) => item.result !== null).length;
      const abnormalCount = items.filter(
        (item) => item.result === 'abnormal' || item.result === 'advice',
      ).length;
      return {
        ...plan,
        elevatorName: elevator ? `${elevator.regCode}（${elevator.owner}）` : '已删除电梯',
        owner: elevator?.owner ?? '-',
        itemCount: items.length,
        filledCount,
        abnormalCount,
        overdue: isPlanOverdue(plan),
        progress: planProgress(filledCount, items.length),
      };
    }),
  );

  /** 应用列表筛选后的计划 */
  const filteredPlans = computed(() =>
    planViews.value.filter((plan) => {
      if (cycleFilters.value.length > 0 && !cycleFilters.value.includes(plan.cycleType)) return false;
      if (stateFilters.value.length > 0 && !stateFilters.value.includes(plan.state)) return false;
      return true;
    }),
  );

  /** 未来待执行计划（用于生成提示） */
  const upcomingPlans = computed(() =>
    planViews.value
      .filter((plan) => plan.state !== 'signed')
      .sort((a, b) => a.planDate.localeCompare(b.planDate)),
  );

  const planOfId = computed(() => (id: string) => planViews.value.find((item) => item.id === id) ?? null);

  const executorOptions = computed(() => {
    const names = new Set(plans.value.map((item) => item.executor).filter(Boolean));
    for (const fallback of ['刘建国', '张海涛', '陈志远', '李强']) names.add(fallback);
    return [...names].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  });

  const todayPlanCount = computed(
    () => plans.value.filter((item) => item.planDate === todayDate()).length,
  );

  return {
    plans,
    elevators,
    checkItems,
    activePlanId,
    cycleFilters,
    stateFilters,
    loading,
    error,
    initialized,
    load,
    bootstrap,
    setCycleFilters,
    setStateFilters,
    setActivePlan,
    createPlan,
    batchGenerate,
    updatePlan,
    assignExecutor,
    updateState,
    signPlan,
    deletePlan,
    planViews,
    filteredPlans,
    upcomingPlans,
    planOfId,
    executorOptions,
    todayPlanCount,
  };
});
