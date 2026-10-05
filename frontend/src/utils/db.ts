/**
 * IndexedDB 持久化层（Dexie 封装）· 电梯维保工序与困人救援台账
 * - 数据结构版本号 + 升级迁移逻辑
 * - 各实体表增删改查（含级联删除）
 * - 首屏自动播种互相引用的演示数据（电梯 → 计划 → 保养项 / 困人事件 / 整改单）
 * 纯前端应用：不依赖任何后端或数据库服务
 */
import Dexie, { type Table } from 'dexie';
import type { Elevator } from '../types/elevator';
import type { Plan } from '../types/plan';
import type { CheckItem, CheckResult } from '../types/checkItem';
import { isAbnormal, itemsForCycle } from '../types/checkItem';
import type { Rescue } from '../types/rescue';
import type { Rectify } from '../types/rectify';
import {
  isMasterRectify,
  isOpenRectify,
  mergeDuplicateRectifies,
  normalizeRectifyRow,
  rectifyDedupeKey,
} from '../types/rectify';
import { ROW_REVISION, type Revisioned } from '../types/persistence';
import { addDays, generatePlanDates, nextPlanDate } from './cycle';
import { nowDateTime, rescueMinutes, todayDate } from './duration';
import { uuid } from './export';

/** 浏览器 IndexedDB 库名 */
export const DB_NAME = 'gbelevsvc';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

export { ROW_REVISION };
export type { Revisioned };

export type ElevatorRow = Elevator;
export type PlanRow = Plan;
export type CheckItemRow = CheckItem;
export type RescueRow = Rescue;
export type RectifyRow = Rectify;

class ElevatorServiceDatabase extends Dexie {
  elevators!: Table<ElevatorRow, string>;
  plans!: Table<PlanRow, string>;
  checkItems!: Table<CheckItemRow, string>;
  rescues!: Table<RescueRow, string>;
  rectifies!: Table<RectifyRow, string>;
  settings!: Table<{ id: string; value: string; updatedAt: string }, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（保留历史数据）
    this.version(1).stores({
      elevators: 'id, regCode, owner, maintCycle',
      plans: 'id, elevatorId, cycleType, state, planDate',
      checkItems: 'id, planId, seq, result',
      rescues: 'id, elevatorId, alarmAt',
      rectifies: 'id, elevatorId, state, dueDate',
    });

    // v2：新增 revision 行修订号；计划补充 executor 索引，保养项补充 itemName 索引，
    //     困人事件补充 responder 索引，并新增 settings 表存放自定义字典
    this.version(2)
      .stores({
        elevators: 'id, regCode, owner, maintCycle, useDate',
        plans: 'id, elevatorId, cycleType, state, planDate, executor, [elevatorId+planDate]',
        checkItems: 'id, planId, seq, result, itemName, [planId+seq]',
        rescues: 'id, elevatorId, alarmAt, responder',
        rectifies: 'id, elevatorId, state, dueDate, reviewer',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        const tables: Array<Table<Record<string, unknown>, string>> = [
          tx.table('elevators'),
          tx.table('plans'),
          tx.table('checkItems'),
          tx.table('rescues'),
          tx.table('rectifies'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowDateTime();
          });
        }
        // 迁移：旧版计划的执行人字段 executorName → executor
        await tx.table('plans').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.executor !== 'string' && typeof row.executorName === 'string') {
            row.executor = row.executorName;
          }
        });
        // 迁移：旧版保养项 checkedAt 作为签署时间的兜底
        await tx.table('checkItems').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.remark !== 'string') row.remark = '';
          if (row.result === undefined) row.result = null;
        });
      });

    // v3：整改单补充去重键与来源 / 归并字段及索引，状态机扩展"待复核"；
    //     历史重复整改单（同电梯同项目多条）归并为一条主单并留来源
    this.version(DB_SCHEMA_VERSION)
      .stores({
        elevators: 'id, regCode, owner, maintCycle, useDate',
        plans: 'id, elevatorId, cycleType, state, planDate, executor, [elevatorId+planDate]',
        checkItems: 'id, planId, seq, result, itemName, [planId+seq]',
        rescues: 'id, elevatorId, alarmAt, responder',
        rectifies:
          'id, elevatorId, state, dueDate, reviewer, dedupeKey, sourcePlanId, sourceItemId, mergedInto',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        const tables: Array<Table<Record<string, unknown>, string>> = [
          tx.table('elevators'),
          tx.table('plans'),
          tx.table('checkItems'),
          tx.table('rescues'),
          tx.table('rectifies'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowDateTime();
          });
        }
        // 整改单：补齐去重键与来源 / 归并字段，旧状态值兜底
        await tx.table('rectifies').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.dedupeKey !== 'string' || !row.dedupeKey) {
            row.dedupeKey = `${String(row.elevatorId ?? '')}::${String(row.item ?? '').trim()}`;
          }
          if (typeof row.sourcePlanId !== 'string') row.sourcePlanId = null;
          if (typeof row.sourceItemId !== 'string') row.sourceItemId = null;
          if (typeof row.mergedInto !== 'string') row.mergedInto = null;
          if (!Array.isArray(row.mergedFrom)) row.mergedFrom = [];
          if (row.state !== 'reviewed' && row.state !== 'recheck') row.state = 'pending';
        });
        // 历史重复整改单归并：同电梯同项目只留一条主单，其余标记 mergedInto 留来源
        const rectifyTable: Table<RectifyRow, string> = tx.table('rectifies');
        const rows = await rectifyTable.toArray();
        const merged = mergeDuplicateRectifies(rows);
        if (merged.some((row, index) => row !== rows[index])) {
          await rectifyTable.bulkPut(merged);
        }
      });
  }
}

export const db = new ElevatorServiceDatabase();

/* ============================== 演示数据播种 ============================== */

interface SeedPlanSpec {
  cycleType: Plan['cycleType'];
  offsetDays: number;
  executor: string;
  state: Plan['state'];
  /** 异常项序号（从 1 开始），空数组表示全正常 */
  abnormalSeq: number[];
  adviceSeq: number[];
}

interface SeedElevatorSpec {
  regCode: string;
  owner: string;
  loadKg: number;
  stops: number;
  useDate: string;
  maintCycle: Elevator['maintCycle'];
  plans: SeedPlanSpec[];
  rescues: Array<{
    offsetDays: number;
    alarmHour: number;
    arriveLagMinutes: number;
    rescueLagMinutes: number;
    cause: string;
    trappedCount: number;
    responder: string;
  }>;
  rectifies: Array<{
    item: string;
    dueOffsetDays: number;
    state: Rectify['state'];
    reviewer: string;
    /** 来源计划（播种下标）与保养项序号；缺省表示手工登记 */
    source?: { planIndex: number; seq: number };
  }>;
}

const SEED_ELEVATORS: SeedElevatorSpec[] = [
  {
    regCode: 'DT-3101-2021-0087',
    owner: '云锦花园物业管理处',
    loadKg: 1000,
    stops: 18,
    useDate: '2021-08-16',
    maintCycle: 'halfMonth',
    plans: [
      { cycleType: 'halfMonth', offsetDays: -22, executor: '刘建国', state: 'signed', abnormalSeq: [], adviceSeq: [] },
      { cycleType: 'halfMonth', offsetDays: -7, executor: '刘建国', state: 'signed', abnormalSeq: [3], adviceSeq: [] },
      { cycleType: 'halfMonth', offsetDays: 6, executor: '张海涛', state: 'executing', abnormalSeq: [], adviceSeq: [] },
      { cycleType: 'quarter', offsetDays: -35, executor: '张海涛', state: 'signed', abnormalSeq: [], adviceSeq: [7] },
    ],
    rescues: [
      {
        offsetDays: -12,
        alarmHour: 19,
        arriveLagMinutes: 18,
        rescueLagMinutes: 41,
        cause: '门锁回路故障',
        trappedCount: 2,
        responder: '刘建国',
      },
      {
        offsetDays: -3,
        alarmHour: 8,
        arriveLagMinutes: 36,
        rescueLagMinutes: 68,
        cause: '变频器故障',
        trappedCount: 1,
        responder: '张海涛',
      },
    ],
    rectifies: [
      { item: '限速器动作', dueOffsetDays: -5, state: 'pending', reviewer: '王敏', source: { planIndex: 1, seq: 3 } },
      { item: '轿厢应急照明失效', dueOffsetDays: 12, state: 'pending', reviewer: '王敏' },
    ],
  },
  {
    regCode: 'DT-3102-2018-0233',
    owner: '锦华商务中心',
    loadKg: 1600,
    stops: 26,
    useDate: '2018-03-05',
    maintCycle: 'quarter',
    plans: [
      { cycleType: 'quarter', offsetDays: -50, executor: '陈志远', state: 'signed', abnormalSeq: [], adviceSeq: [] },
      { cycleType: 'quarter', offsetDays: 4, executor: '陈志远', state: 'pending', abnormalSeq: [], adviceSeq: [] },
      { cycleType: 'year', offsetDays: -180, executor: '陈志远', state: 'signed', abnormalSeq: [5], adviceSeq: [] },
    ],
    rescues: [
      {
        offsetDays: -26,
        alarmHour: 14,
        arriveLagMinutes: 22,
        rescueLagMinutes: 35,
        cause: '停电困人',
        trappedCount: 3,
        responder: '陈志远',
      },
    ],
    rectifies: [
      { item: '钢丝绳磨损', dueOffsetDays: 8, state: 'pending', reviewer: '王敏', source: { planIndex: 2, seq: 5 } },
    ],
  },
  {
    regCode: 'DT-3103-2022-0119',
    owner: '云锦花园物业管理处',
    loadKg: 800,
    stops: 11,
    useDate: '2022-11-21',
    maintCycle: 'halfMonth',
    plans: [
      { cycleType: 'halfMonth', offsetDays: -31, executor: '刘建国', state: 'signed', abnormalSeq: [], adviceSeq: [] },
      { cycleType: 'halfMonth', offsetDays: -2, executor: '刘建国', state: 'pending', abnormalSeq: [], adviceSeq: [] },
    ],
    rescues: [],
    rectifies: [
      { item: '超载保护装置失灵', dueOffsetDays: -11, state: 'reviewed', reviewer: '李强' },
      { item: '钢丝绳断丝超标', dueOffsetDays: 20, state: 'pending', reviewer: '李强' },
    ],
  },
];

/** 生成保养项：按周期类型选必检项，套用预设异常/建议序号 */
function buildCheckItems(
  planId: string,
  cycleType: Plan['cycleType'],
  abnormalSeq: number[],
  adviceSeq: number[],
  createdAt: string,
): CheckItemRow[] {
  return itemsForCycle(cycleType).map((itemName, index) => {
    const seq = index + 1;
    let result: CheckResult | null = null;
    let value = '';
    let remark = '';
    if (abnormalSeq.includes(seq)) {
      result = 'abnormal';
      value = itemName.includes('间隙') ? '4.8mm（标准 ≤3mm）' : '动作迟缓，需调整';
      remark = '已现场标记，需转整改单跟踪';
    } else if (adviceSeq.includes(seq)) {
      result = 'advice';
      value = '偏差处于临界值';
      remark = '建议下次保养重点复查';
    } else {
      result = 'normal';
      value = itemName.includes('平层') ? '±2mm' : itemName.includes('温度') ? '31℃' : '符合要求';
      remark = '';
    }
    return {
      id: `chk-${planId}-${seq}`,
      planId,
      seq,
      itemName,
      result,
      value,
      remark,
      createdAt,
      revision: ROW_REVISION,
    };
  });
}

/** 播种：3 台电梯 × 2~4 个计划 × 每计划 5~10 个保养项 + 困人事件 + 整改单 */
async function seedDatabase(): Promise<void> {
  const stamp = nowDateTime();
  const elevators: ElevatorRow[] = [];
  const plans: PlanRow[] = [];
  const checkItems: CheckItemRow[] = [];
  const rescues: RescueRow[] = [];
  const rectifies: RectifyRow[] = [];

  SEED_ELEVATORS.forEach((spec, elevatorIndex) => {
    const elevatorId = `elev-${elevatorIndex + 1}`;
    elevators.push({
      id: elevatorId,
      regCode: spec.regCode,
      owner: spec.owner,
      loadKg: spec.loadKg,
      stops: spec.stops,
      useDate: spec.useDate,
      maintCycle: spec.maintCycle,
      createdAt: stamp,
      revision: ROW_REVISION,
    });

    spec.plans.forEach((planSpec, planIndex) => {
      const planId = `plan-${elevatorIndex + 1}-${planIndex + 1}`;
      const planDate = addDays(todayDate(), planSpec.offsetDays);
      plans.push({
        id: planId,
        elevatorId,
        cycleType: planSpec.cycleType,
        planDate,
        executor: planSpec.executor,
        state: planSpec.state,
        signedAt: planSpec.state === 'signed' ? `${planDate} 16:20` : null,
        createdAt: stamp,
        revision: ROW_REVISION,
      });
      checkItems.push(
        ...buildCheckItems(planId, planSpec.cycleType, planSpec.abnormalSeq, planSpec.adviceSeq, stamp),
      );
    });

    spec.rescues.forEach((rescueSpec, rescueIndex) => {
      const date = addDays(todayDate(), rescueSpec.offsetDays);
      const alarmAt = `${date} ${String(rescueSpec.alarmHour).padStart(2, '0')}:05`;
      const arriveAt = `${date} ${String(
        rescueSpec.alarmHour + Math.floor((5 + rescueSpec.arriveLagMinutes) / 60),
      ).padStart(2, '0')}:${String((5 + rescueSpec.arriveLagMinutes) % 60).padStart(2, '0')}`;
      const rescueAt = `${date} ${String(
        rescueSpec.alarmHour + Math.floor((5 + rescueSpec.rescueLagMinutes) / 60),
      ).padStart(2, '0')}:${String((5 + rescueSpec.rescueLagMinutes) % 60).padStart(2, '0')}`;
      rescues.push({
        id: `rescue-${elevatorIndex + 1}-${rescueIndex + 1}`,
        elevatorId,
        alarmAt,
        arriveAt,
        rescueAt,
        cause: rescueSpec.cause,
        trappedCount: rescueSpec.trappedCount,
        responder: rescueSpec.responder,
        createdAt: stamp,
        revision: ROW_REVISION,
      });
    });

    spec.rectifies.forEach((rectifySpec, rectifyIndex) => {
      const sourcePlanId = rectifySpec.source
        ? `plan-${elevatorIndex + 1}-${rectifySpec.source.planIndex + 1}`
        : null;
      rectifies.push({
        id: `rect-${elevatorIndex + 1}-${rectifyIndex + 1}`,
        elevatorId,
        item: rectifySpec.item,
        dueDate: addDays(todayDate(), rectifySpec.dueOffsetDays),
        state: rectifySpec.state,
        reviewer: rectifySpec.reviewer,
        reviewedAt: rectifySpec.state === 'reviewed' ? `${addDays(todayDate(), -3)} 10:30` : null,
        dedupeKey: rectifyDedupeKey(elevatorId, rectifySpec.item),
        sourcePlanId,
        sourceItemId:
          sourcePlanId && rectifySpec.source ? `chk-${sourcePlanId}-${rectifySpec.source.seq}` : null,
        mergedInto: null,
        mergedFrom: [],
        createdAt: stamp,
        revision: ROW_REVISION,
      });
    });
  });

  await db.transaction(
    'rw',
    [db.elevators, db.plans, db.checkItems, db.rescues, db.rectifies],
    async () => {
      await db.elevators.bulkPut(elevators);
      await db.plans.bulkPut(plans);
      await db.checkItems.bulkPut(checkItems);
      await db.rescues.bulkPut(rescues);
      await db.rectifies.bulkPut(rectifies);
    },
  );
}

/* ============================== 初始化 ============================== */

/** 打开数据库；电梯表为空时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open();
  const count = await db.elevators.count();
  if (count === 0) {
    await seedDatabase();
  }
}

/* ============================== 电梯 ============================== */

export async function listElevators(): Promise<ElevatorRow[]> {
  const rows = await db.elevators.toArray();
  return rows.sort((a, b) => a.regCode.localeCompare(b.regCode));
}

export async function putElevator(row: ElevatorRow): Promise<void> {
  await db.elevators.put(row);
}

/** 删除电梯并级联清理计划、保养项、困人事件与整改单 */
export async function removeElevator(id: string): Promise<void> {
  await db.transaction('rw', [db.elevators, db.plans, db.checkItems, db.rescues, db.rectifies], async () => {
    const plans = await db.plans.where('elevatorId').equals(id).toArray();
    const planIds = plans.map((item) => item.id);
    if (planIds.length > 0) {
      await db.checkItems.where('planId').anyOf(planIds).delete();
    }
    await db.plans.where('elevatorId').equals(id).delete();
    await db.rescues.where('elevatorId').equals(id).delete();
    await db.rectifies.where('elevatorId').equals(id).delete();
    await db.elevators.delete(id);
  });
}

/* ============================== 计划 ============================== */

export async function listPlans(): Promise<PlanRow[]> {
  const rows = await db.plans.toArray();
  return rows.sort((a, b) => b.planDate.localeCompare(a.planDate));
}

export async function listPlansByElevator(elevatorId: string): Promise<PlanRow[]> {
  const rows = await db.plans.where('elevatorId').equals(elevatorId).toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function putPlan(row: PlanRow): Promise<void> {
  await db.plans.put(row);
}

export async function putPlans(rows: PlanRow[]): Promise<void> {
  await db.plans.bulkPut(rows);
}

/**
 * 更新计划并联动整改单（一次本地事务）：
 * 计划改期或更换电梯后，来源于该计划的未复核整改单回到待复核；
 * 更换电梯时未复核单同步迁移电梯归属与去重键；已复核结论照旧保留。
 */
export async function putPlanWithSync(row: PlanRow): Promise<void> {
  await db.transaction('rw', [db.plans, db.rectifies], async () => {
    const before = await db.plans.get(row.id);
    await db.plans.put(row);
    if (!before) return;
    const dateChanged = before.planDate !== row.planDate;
    const elevatorChanged = before.elevatorId !== row.elevatorId;
    if (!dateChanged && !elevatorChanged) return;
    const linked = await db.rectifies.where('sourcePlanId').equals(row.id).toArray();
    for (const item of linked) {
      if (!isOpenRectify(item)) continue;
      const next: RectifyRow = { ...item, state: 'recheck' };
      if (elevatorChanged) {
        next.elevatorId = row.elevatorId;
        next.dedupeKey = rectifyDedupeKey(row.elevatorId, item.item);
      }
      await db.rectifies.put(next);
    }
  });
}

/** 删除计划并级联删除保养项；来源随之作废的未复核整改单回到待复核 */
export async function removePlan(id: string): Promise<void> {
  await db.transaction('rw', [db.plans, db.checkItems, db.rectifies], async () => {
    const items = await db.checkItems.where('planId').equals(id).toArray();
    const voidedIds = items.filter((row) => isAbnormal(row.result)).map((row) => row.id);
    await db.checkItems.where('planId').equals(id).delete();
    await db.plans.delete(id);
    const linked = await db.rectifies.where('sourcePlanId').equals(id).toArray();
    const byItems =
      voidedIds.length > 0
        ? await db.rectifies.where('sourceItemId').anyOf(voidedIds).toArray()
        : [];
    await recheckOpenRectifies([...linked, ...byItems]);
  });
}

/* ============================= 保养项 ============================= */

export async function listCheckItems(): Promise<CheckItemRow[]> {
  return db.checkItems.toArray();
}

export async function listCheckItemsByPlan(planId: string): Promise<CheckItemRow[]> {
  const rows = await db.checkItems.where('planId').equals(planId).toArray();
  return rows.sort((a, b) => a.seq - b.seq);
}

export async function putCheckItem(row: CheckItemRow): Promise<void> {
  await db.checkItems.put(row);
}

export async function putCheckItems(rows: CheckItemRow[]): Promise<void> {
  await db.checkItems.bulkPut(rows);
}

/**
 * 批量保存保养项并联动整改单（一次本地事务）：
 * 结果由异常 / 建议改为非异常的项视为作废，其未复核整改单回到待复核；
 * 返回退回待复核的整改单数。
 */
export async function putCheckItemsWithSync(rows: CheckItemRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  return db.transaction('rw', [db.checkItems, db.rectifies], async () => {
    const oldRows = await db.checkItems
      .where('id')
      .anyOf(rows.map((row) => row.id))
      .toArray();
    const oldById = new Map(oldRows.map((row) => [row.id, row]));
    const voidedIds: string[] = [];
    for (const row of rows) {
      const before = oldById.get(row.id);
      if (before && isAbnormal(before.result) && !isAbnormal(row.result)) voidedIds.push(row.id);
    }
    await db.checkItems.bulkPut(rows);
    return recheckRectifiesOfItems(voidedIds);
  });
}

/** 删除保养项并联动：被删的异常项，其未复核整改单回到待复核 */
export async function removeCheckItemWithSync(id: string): Promise<void> {
  await db.transaction('rw', [db.checkItems, db.rectifies], async () => {
    const before = await db.checkItems.get(id);
    await db.checkItems.delete(id);
    if (before && isAbnormal(before.result)) await recheckRectifiesOfItems([id]);
  });
}

/** 重置某计划的保养项清单并联动：被清掉的异常项，其未复核整改单回到待复核 */
export async function replacePlanCheckItems(planId: string, rows: CheckItemRow[]): Promise<void> {
  await db.transaction('rw', [db.checkItems, db.rectifies], async () => {
    const oldRows = await db.checkItems.where('planId').equals(planId).toArray();
    const voidedIds = oldRows.filter((row) => isAbnormal(row.result)).map((row) => row.id);
    await db.checkItems.where('planId').equals(planId).delete();
    await db.checkItems.bulkPut(rows);
    await recheckRectifiesOfItems(voidedIds);
  });
}

/* ============================ 困人事件 ============================ */

export async function listRescues(): Promise<RescueRow[]> {
  const rows = await db.rescues.toArray();
  return rows.sort((a, b) => b.alarmAt.localeCompare(a.alarmAt));
}

export async function putRescue(row: RescueRow): Promise<void> {
  await db.rescues.put(row);
}

export async function removeRescue(id: string): Promise<void> {
  await db.rescues.delete(id);
}

/* ============================= 整改单 ============================= */

/** 列表与导出只按主单展示：已归并到他单的重复单（mergedInto 非空）不出现在查询结果 */
export async function listRectifies(): Promise<RectifyRow[]> {
  const rows = await db.rectifies.toArray();
  return rows.filter((row) => isMasterRectify(row)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

export async function putRectify(row: RectifyRow): Promise<void> {
  await db.rectifies.put(row);
}

export async function removeRectify(id: string): Promise<void> {
  await db.rectifies.delete(id);
}

/** 同事务内查有效整改单（主单且未复核关闭） */
async function findOpenRectify(dedupeKey: string): Promise<RectifyRow | undefined> {
  const rows = await db.rectifies.where('dedupeKey').equals(dedupeKey).toArray();
  return rows.find((row) => isOpenRectify(row));
}

/** 同事务内把给定整改单中未复核的退回待复核（已复核结论照旧保留），返回影响条数 */
async function recheckOpenRectifies(rows: RectifyRow[]): Promise<number> {
  let count = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (!isOpenRectify(row) || row.state === 'recheck') continue;
    await db.rectifies.put({ ...row, state: 'recheck' });
    count += 1;
  }
  return count;
}

/** 同事务内把来源保养项已作废的未复核整改单退回待复核 */
async function recheckRectifiesOfItems(itemIds: string[]): Promise<number> {
  if (itemIds.length === 0) return 0;
  const rows = await db.rectifies.where('sourceItemId').anyOf(itemIds).toArray();
  return recheckOpenRectifies(rows);
}

/** 构造一条新整改单（主单，带去重键与来源） */
function buildRectifyRow(input: {
  elevatorId: string;
  item: string;
  dueDate: string;
  reviewer: string;
  sourcePlanId: string | null;
  sourceItemId: string | null;
}): RectifyRow {
  return {
    id: uuid(),
    elevatorId: input.elevatorId,
    item: input.item.trim(),
    dueDate: input.dueDate,
    state: 'pending',
    reviewer: input.reviewer.trim(),
    reviewedAt: null,
    dedupeKey: rectifyDedupeKey(input.elevatorId, input.item),
    sourcePlanId: input.sourcePlanId,
    sourceItemId: input.sourceItemId,
    mergedInto: null,
    mergedFrom: [],
    createdAt: nowDateTime(),
    revision: ROW_REVISION,
  };
}

export interface RectifyCreateInput {
  elevatorId: string;
  item: string;
  dueDate: string;
  reviewer: string;
  sourcePlanId?: string | null;
  sourceItemId?: string | null;
}

export interface RectifyCreateResult {
  row: RectifyRow;
  /** true 表示已存在有效单，本次复用而未新建 */
  reused: boolean;
}

/**
 * 幂等登记整改单（独立本地事务）：
 * 同一电梯同一不合格项只留一条有效单；已存在有效单（未归并且未复核关闭）时
 * 直接返回该单，重复提交 / 双终端并发不产生新单。
 */
export async function createRectifyIdempotent(input: RectifyCreateInput): Promise<RectifyCreateResult> {
  return db.transaction('rw', db.rectifies, async () => {
    const key = rectifyDedupeKey(input.elevatorId, input.item);
    const existing = await findOpenRectify(key);
    if (existing) return { row: existing, reused: true };
    const row = buildRectifyRow({
      elevatorId: input.elevatorId,
      item: input.item,
      dueDate: input.dueDate,
      reviewer: input.reviewer,
      sourcePlanId: input.sourcePlanId ?? null,
      sourceItemId: input.sourceItemId ?? null,
    });
    await db.rectifies.add(row);
    return { row, reused: false };
  });
}

/* ==================== 保养执行事务（保养项 + 计划 + 整改单） ==================== */

export interface PlanExecutionInput {
  planId: string;
  /** 待落库的保养项（空数组表示本次不改动保养项） */
  items: CheckItemRow[];
  /** 是否同事务签署计划（校验未填项，失败则整体回滚） */
  sign: boolean;
  /** 异常项转整改参数；null 表示本次不转 */
  rectify: { dueDate: string; reviewer: string } | null;
}

export interface PlanExecutionResult {
  /** 本次落库的保养项数 */
  savedItems: number;
  /** 本次是否完成签署 */
  signed: boolean;
  /** 新建的整改单 */
  createdRectifies: RectifyRow[];
  /** 重复提交时复用的已有有效单 */
  reusedRectifies: RectifyRow[];
  /** 因异常项作废回到待复核的整改单数 */
  recheckedCount: number;
}

/**
 * 保养执行一次本地事务：保养项落库、计划签署、异常项转整改要么全部生效，要么整体回滚。
 * - 同一异常只留一条有效整改单：事务内按去重键查有效单，重复提交返回已有单；
 * - 写入失败后签署草稿与已完成项不落库也不丢失，重试按去重键幂等，不重复建单；
 * - 异常项作废（结果改回非异常）时，未复核整改单回到待复核，已复核结论照旧保留。
 */
export async function commitPlanExecution(input: PlanExecutionInput): Promise<PlanExecutionResult> {
  return db.transaction('rw', [db.plans, db.checkItems, db.rectifies], async () => {
    const plan = await db.plans.get(input.planId);
    if (!plan) throw new Error('计划不存在或已被删除');

    // 1) 保养项落库；结果由异常改为非异常的项，联动其未复核整改单回待复核
    let recheckedCount = 0;
    if (input.items.length > 0) {
      const oldRows = await db.checkItems
        .where('id')
        .anyOf(input.items.map((row) => row.id))
        .toArray();
      const oldById = new Map(oldRows.map((row) => [row.id, row]));
      const voidedIds: string[] = [];
      for (const row of input.items) {
        const before = oldById.get(row.id);
        if (before && isAbnormal(before.result) && !isAbnormal(row.result)) voidedIds.push(row.id);
      }
      await db.checkItems.bulkPut(input.items);
      recheckedCount = await recheckRectifiesOfItems(voidedIds);
    }

    // 2) 签署计划：基于落库后的全量保养项校验，未填项则抛错回滚整个事务
    let signed = false;
    if (input.sign) {
      const all = await db.checkItems.where('planId').equals(input.planId).toArray();
      if (all.length === 0) throw new Error('该计划没有保养项，无法签署');
      const unfilled = all.filter((row) => row.result === null);
      if (unfilled.length > 0) throw new Error(`还有 ${unfilled.length} 项未填写结果，无法签署`);
      await db.plans.put({ ...plan, state: 'signed', signedAt: nowDateTime() });
      signed = true;
    }

    // 3) 异常项转整改：同一异常只留一条有效单，重复提交复用已有单
    const createdRectifies: RectifyRow[] = [];
    const reusedRectifies: RectifyRow[] = [];
    if (input.rectify) {
      const all = await db.checkItems.where('planId').equals(input.planId).toArray();
      for (const item of all.filter((row) => isAbnormal(row.result))) {
        const key = rectifyDedupeKey(plan.elevatorId, item.itemName);
        const existing = await findOpenRectify(key);
        if (existing) {
          reusedRectifies.push(existing);
          continue;
        }
        const row = buildRectifyRow({
          elevatorId: plan.elevatorId,
          item: item.itemName,
          dueDate: input.rectify.dueDate,
          reviewer: input.rectify.reviewer,
          sourcePlanId: plan.id,
          sourceItemId: item.id,
        });
        await db.rectifies.add(row);
        createdRectifies.push(row);
      }
    }

    return {
      savedItems: input.items.length,
      signed,
      createdRectifies,
      reusedRectifies,
      recheckedCount,
    };
  });
}

/* ========================== 整库导入导出 ========================== */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  elevators: Elevator[];
  plans: Plan[];
  checkItems: CheckItem[];
  rescues: Rescue[];
  rectifies: Rectify[];
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [elevators, plans, checkItems, rescues, rectifies] = await Promise.all([
    listElevators(),
    listPlans(),
    listCheckItems(),
    listRescues(),
    listRectifies(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowDateTime(),
    elevators,
    plans,
    checkItems,
    rescues,
    rectifies,
  };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  // 旧版备份的整改单先补齐去重键 / 来源字段，再按主单归并重复单（与结构迁移同口径）
  const rectifies = mergeDuplicateRectifies(
    (snapshot.rectifies ?? []).map((row) => ({
      ...normalizeRectifyRow(row),
      createdAt: row.createdAt || nowDateTime(),
    })),
  );
  await db.transaction(
    'rw',
    [db.elevators, db.plans, db.checkItems, db.rescues, db.rectifies],
    async () => {
      await Promise.all([
        db.elevators.clear(),
        db.plans.clear(),
        db.checkItems.clear(),
        db.rescues.clear(),
        db.rectifies.clear(),
      ]);
      await db.elevators.bulkPut(snapshot.elevators ?? []);
      await db.plans.bulkPut(snapshot.plans ?? []);
      await db.checkItems.bulkPut(snapshot.checkItems ?? []);
      await db.rescues.bulkPut(snapshot.rescues ?? []);
      await db.rectifies.bulkPut(rectifies);
    },
  );
}

/** 清空并重新播种 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.elevators, db.plans, db.checkItems, db.rescues, db.rectifies],
    async () => {
      await Promise.all([
        db.elevators.clear(),
        db.plans.clear(),
        db.checkItems.clear(),
        db.rescues.clear(),
        db.rectifies.clear(),
      ]);
    },
  );
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [elevators, plans, checkItems, rescues, rectifies] = await Promise.all([
    db.elevators.count(),
    db.plans.count(),
    db.checkItems.count(),
    db.rescues.count(),
    db.rectifies.count(),
  ]);
  return { elevators, plans, checkItems, rescues, rectifies };
}

/** 结构版本信息 */
export interface SchemaInfo {
  dbName: string;
  schemaVersion: number;
  rowRevision: number;
  today: string;
}

export function schemaInfo(): SchemaInfo {
  return {
    dbName: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    rowRevision: ROW_REVISION,
    today: todayDate(),
  };
}

/** 依据周期类型推算某计划的下一期日期（供页面提示） */
export function nextPlanDateOf(planDate: string, cycle: Plan['cycleType']): string {
  return nextPlanDate(planDate, cycle);
}

/** 批量生成计划日期（对外暴露，避免页面直接依赖 utils/cycle） */
export function planDatesFrom(startDate: string, cycle: Plan['cycleType'], count: number): string[] {
  return generatePlanDates(startDate, cycle, count);
}

/** 困人时长（分钟）便捷函数，供 store 派生使用 */
export function rescueDurationMinutes(alarmAt: string, rescueAt: string): number {
  return rescueMinutes(alarmAt, rescueAt);
}
