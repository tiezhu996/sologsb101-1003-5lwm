/**
 * 跨表本地事务工作流（Dexie / IndexedDB）
 *
 * 把「保养项签署保存、异常项转整改、计划改期 / 更换电梯、异常项作废」这几类
 * 同时改动保养项、保养计划、年检整改单的动作收进同一个 IndexedDB 事务：
 *
 * 1. 原子性：事务内任一写入失败，整笔回滚——签署状态、已完成项、整改单要么全部生效，
 *    要么都不落地，调用方重试不会产生半成功数据，也不会重复建单；
 * 2. 一单防重：异常转整改的单子带 sourceItemId 唯一索引，同一异常项只有一条有效主单，
 *    并发 / 重复提交返回已有单（同进程内再用 in-flight 合并快速去重）；
 * 3. 复核回流：计划改期、更换电梯或异常项作废后，来源未复核的整改单回到「待复核」，
 *    已复核结论锁定不动。
 */
import {
  db,
  ROW_REVISION,
  type CheckItemRow,
  type PlanRow,
  type RectifyRow,
} from './db';
import type { CheckItemDraft } from '../types/checkItem';
import { isAbnormal } from '../types/checkItem';
import type { PlanState } from '../types/plan';
import { isMasterRectify } from '../types/rectify';
import { nowDateTime } from './duration';
import { uuid } from './export';

/** 本工作流涉及的全部表：同一事务内提交，保证跨表一致 */
const SCOPE = { tables: [db.checkItems, db.plans, db.rectifies] } as const;

export interface SaveDraftInput extends CheckItemDraft {
  id: string;
}

export interface SaveItemsResult {
  /** 实际更新的保养项数 */
  updated: number;
  /** 因源头变更回到待复核队列的整改单 */
  reopened: RectifyRow[];
}

export interface SignResult extends SaveItemsResult {
  ok: boolean;
  message: string;
  plan: PlanRow | null;
}

export interface PromoteResult {
  /** 新建的整改单（本次提交首次产生） */
  created: RectifyRow[];
  /** 重复提交时返回的已有单（不再重复建单） */
  reused: RectifyRow[];
}

/* ----------------- 同进程 in-flight 合并：快速连点 / 双终端并发 ----------------- */

const inflight = new Map<string, Promise<unknown>>();

/**
 * 同一 key 的并发调用复用同一个 Promise（在唯一索引之外的进程内快速去重）；
 * 跨标签页 / 跨终端的真正并发由 IndexedDB 唯一索引 sourceItemId 兜底。
 */
function coalesce<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const task = factory().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, task);
  return task;
}

/* -------------------------------- 内部工具 -------------------------------- */

/** 找出来源异常项已不再异常、需要回到待复核的主整改单 */
function collectReopens(
  rectifies: RectifyRow[],
  invalidSourceItemIds: Set<string>,
): RectifyRow[] {
  const reopened: RectifyRow[] = [];
  for (const rectify of rectifies) {
    if (!isMasterRectify(rectify)) continue;
    if (rectify.state === 'reviewed') continue;
    if (!rectify.sourceItemId || !invalidSourceItemIds.has(rectify.sourceItemId)) continue;
    rectify.state = 'reviewing';
    reopened.push(rectify);
  }
  return reopened;
}

/** 落一批保养项草稿，返回待写行 + 异常项作废的来源 id 集合 */
function applyItemDrafts(
  scoped: CheckItemRow[],
  drafts: SaveDraftInput[],
): { nextRows: CheckItemRow[]; invalidSourceItemIds: Set<string> } {
  const byId = new Map(scoped.map((item) => [item.id, item]));
  const nextRows: CheckItemRow[] = [];
  const invalidSourceItemIds = new Set<string>();
  for (const draft of drafts) {
    const existing = byId.get(draft.id);
    if (!existing) continue;
    if (isAbnormal(existing.result) && !isAbnormal(draft.result)) {
      invalidSourceItemIds.add(existing.id);
    }
    nextRows.push({
      ...existing,
      itemName: draft.itemName.trim(),
      result: draft.result,
      value: draft.value.trim(),
      remark: draft.remark.trim(),
    });
  }
  return { nextRows, invalidSourceItemIds };
}

/** 事务内：保存保养项并把作废异常项关联的未复核整改单打回待复核 */
async function persistItemDrafts(
  planId: string,
  drafts: SaveDraftInput[],
): Promise<SaveItemsResult> {
  const scoped = await db.checkItems.where('planId').equals(planId).toArray();
  const { nextRows, invalidSourceItemIds } = applyItemDrafts(scoped, drafts);
  if (nextRows.length === 0) return { updated: 0, reopened: [] };

  await db.checkItems.bulkPut(nextRows);

  let reopened: RectifyRow[] = [];
  if (invalidSourceItemIds.size > 0) {
    const rectifies = await db.rectifies.toArray();
    reopened = collectReopens(rectifies, invalidSourceItemIds);
    if (reopened.length > 0) await db.rectifies.bulkPut(reopened);
  }
  return { updated: nextRows.length, reopened };
}

/* ------------------------------ 保养项签署保存 ------------------------------ */

/**
 * 一次本地事务保存某计划的保养项结果；若其中有「异常 → 正常 / 未填」的作废项，
 * 关联的未复核整改单同事务回到待复核。失败整体回滚，内存草稿不受影响。
 */
export function saveCheckItemsTx(planId: string, drafts: SaveDraftInput[]): Promise<SaveItemsResult> {
  return coalesce(`save-items:${planId}`, async () =>
    db.transaction('rw', SCOPE.tables, () => persistItemDrafts(planId, drafts)),
  );
}

/**
 * 保存保养项 + 签署计划在同一事务：
 * - 先按草稿落保养项（含异常项作废回流），再校验全部已填，最后把计划置为已签署；
 * - 任一步失败事务回滚：计划不会变成「已签署」而保养项还停在草稿，反之亦然；
 * - 已签署的计划重复提交直接幂等返回，不重复写。
 */
export function signPlanTx(planId: string, drafts?: SaveDraftInput[]): Promise<SignResult> {
  return coalesce(`sign:${planId}`, () =>
    db.transaction('rw', SCOPE.tables, async (): Promise<SignResult> => {
      const plan = await db.plans.get(planId);
      if (!plan) return { ok: false, message: '计划不存在', updated: 0, reopened: [], plan: null };

      const reopenedAll: RectifyRow[] = [];
      let updated = 0;
      if (drafts && drafts.length > 0) {
        const saved = await persistItemDrafts(planId, drafts);
        updated = saved.updated;
        reopenedAll.push(...saved.reopened);
      }

      const items = await db.checkItems.where('planId').equals(planId).toArray();
      if (items.length === 0) {
        // 抛错中止事务：前面的草稿写入一并回滚，签署与签署草稿都恢复
        throw new Error('该计划没有保养项');
      }
      const unfilled = items.filter((item) => item.result === null);
      if (unfilled.length > 0) {
        throw new Error(`还有 ${unfilled.length} 项未填写结果，无法签署`);
      }

      if (plan.state !== 'signed') {
        await db.plans.put({ ...plan, state: 'signed' as PlanState, signedAt: nowDateTime() });
      }
      return {
        ok: true,
        message: '签署完成',
        updated,
        reopened: reopenedAll,
        plan: { ...plan, state: 'signed', signedAt: plan.signedAt ?? nowDateTime() },
      };
    }),
  );
}

/* ---------------------------- 异常项 → 年检整改单 ---------------------------- */

/**
 * 同一事务完成「保存保养项草稿 → 异常项转整改单」：
 * - 草稿先在事务内落库并处理异常作废回流，再按最新结果挑异常项；
 * - 每个异常项只允许一条 sourceItemId 相同的有效主单（唯一索引硬约束）；
 * - 已有单则直接返回已有单（含已复核单，结论照旧），不重复建；
 * - 新单状态为「待整改」，masterId 指向自身。
 * 任一步失败整笔回滚：不会出现整改单已建而签署草稿没保存的中间态。
 */
export function promoteAbnormalItemsTx(
  elevatorId: string,
  planId: string,
  dueDate: string,
  reviewer: string,
  drafts?: SaveDraftInput[],
): Promise<PromoteResult> {
  return coalesce(`promote:${planId}`, () =>
    db.transaction('rw', SCOPE.tables, async (): Promise<PromoteResult> => {
      if (drafts && drafts.length > 0) {
        await persistItemDrafts(planId, drafts);
      }

      const items = await db.checkItems.where('planId').equals(planId).toArray();
      const abnormals = items.filter((item) => isAbnormal(item.result));
      if (abnormals.length === 0) return { created: [], reused: [] };

      const rectifies = await db.rectifies.toArray();
      const created: RectifyRow[] = [];
      const reused: RectifyRow[] = [];
      const stamp = nowDateTime();

      for (const item of abnormals) {
        const existing = rectifies.find(
          (row) => isMasterRectify(row) && row.sourceItemId === item.id,
        );
        if (existing) {
          reused.push(existing);
          continue;
        }
        const id = uuid();
        const row: RectifyRow = {
          id,
          elevatorId,
          item: item.itemName,
          dueDate,
          state: 'pending',
          reviewer: reviewer.trim(),
          reviewedAt: null,
          sourceItemId: item.id,
          masterId: id,
          createdAt: stamp,
          revision: ROW_REVISION,
        };
        created.push(row);
        // 同步进内存快照，保证同事务后续异常项能看到它（同电梯同项目也不重复）
        rectifies.push(row);
      }

      if (created.length > 0) {
        try {
          await db.rectifies.bulkPut(created);
        } catch {
          // 跨标签页 / 双终端抢跑：唯一索引拒绝后按已有单返回，不重试插入
          const winners = await db.rectifies
            .where('sourceItemId')
            .anyOf(abnormals.map((item) => item.id))
            .toArray();
          return { created: [], reused: winners };
        }
      }
      return { created, reused };
    }),
  );
}

/* ---------------------- 计划改期 / 更换电梯 → 复核回流 ---------------------- */

export interface PlanChangeResult {
  plan: PlanRow;
  /** 回到待复核的整改单 */
  reopened: RectifyRow[];
}

/**
 * 同一事务更新计划，并在「改期」或「更换电梯」时把该计划来源的未复核整改单
 * 打回待复核；更换电梯时整改单随计划迁移到新电梯。执行人 / 周期调整不触发回流。
 * 已复核的单子及其复核结论原样保留。
 */
export function changePlanTx(
  planId: string,
  draft: { elevatorId: string; cycleType: PlanRow['cycleType']; planDate: string; executor: string },
): Promise<PlanChangeResult | null> {
  return coalesce(`plan-change:${planId}`, () =>
    db.transaction('rw', SCOPE.tables, async (): Promise<PlanChangeResult | null> => {
      const existing = await db.plans.get(planId);
      if (!existing) return null;

      const elevatorChanged = draft.elevatorId !== existing.elevatorId;
      const dateChanged = draft.planDate !== existing.planDate;
      const nextPlan: PlanRow = {
        ...existing,
        elevatorId: draft.elevatorId,
        cycleType: draft.cycleType,
        planDate: draft.planDate,
        executor: draft.executor.trim(),
      };
      await db.plans.put(nextPlan);

      let reopened: RectifyRow[] = [];
      if (elevatorChanged || dateChanged) {
        const items = await db.checkItems.where('planId').equals(planId).toArray();
        const sourceIds = new Set(items.map((item) => item.id));
        const rectifies = await db.rectifies.toArray();
        reopened = collectReopens(rectifies, sourceIds);
        if (elevatorChanged) {
          for (const rectify of reopened) rectify.elevatorId = draft.elevatorId;
        }
        if (reopened.length > 0) await db.rectifies.bulkPut(reopened);
      }
      return { plan: nextPlan, reopened };
    }),
  );
}

/* ------------------------ 异常项作废 → 复核回流 ------------------------ */

/**
 * 单条保养项结果落库的同一事务内处理回流：
 * 结果由异常 / 建议改为其它值时，关联的未复核整改单回到待复核。
 */
export function setCheckResultTx(itemId: string, result: CheckItemRow['result']): Promise<SaveItemsResult> {
  return coalesce(`set-result:${itemId}`, () =>
    db.transaction('rw', SCOPE.tables, async (): Promise<SaveItemsResult> => {
      const existing = await db.checkItems.get(itemId);
      if (!existing) return { updated: 0, reopened: [] };
      await db.checkItems.put({ ...existing, result });

      const invalidIds = new Set<string>();
      if (isAbnormal(existing.result) && !isAbnormal(result)) invalidIds.add(existing.id);
      let reopened: RectifyRow[] = [];
      if (invalidIds.size > 0) {
        const rectifies = await db.rectifies.toArray();
        reopened = collectReopens(rectifies, invalidIds);
        if (reopened.length > 0) await db.rectifies.bulkPut(reopened);
      }
      return { updated: 1, reopened };
    }),
  );
}

/**
 * 删除保养项（异常项作废）的同一事务：删除保养项，其关联的未复核整改单
 * 不删除、回到待复核队列等待确认；已复核结论保留。
 */
export function deleteCheckItemTx(itemId: string): Promise<{ reopened: RectifyRow[] }> {
  return coalesce(`delete-item:${itemId}`, () =>
    db.transaction('rw', SCOPE.tables, async () => {
      const existing = await db.checkItems.get(itemId);
      await db.checkItems.delete(itemId);
      let reopened: RectifyRow[] = [];
      if (existing && isAbnormal(existing.result)) {
        const rectifies = await db.rectifies.toArray();
        reopened = collectReopens(rectifies, new Set([itemId]));
        if (reopened.length > 0) await db.rectifies.bulkPut(reopened);
      }
      return { reopened };
    }),
  );
}
