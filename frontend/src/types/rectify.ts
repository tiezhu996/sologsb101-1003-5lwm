import type { Revisioned } from './persistence';

/**
 * 整改状态：待整改 / 待复核 / 已复核
 * - pending   待整改：刚生成，班组尚未提交整改结果
 * - reviewing 待复核：整改已提交，或来源保养项 / 计划 / 电梯发生变化后
 *             尚未复核的单子回到此队列，等待安全管理员重新确认
 * - reviewed  已复核：复核结论已锁定，来源变更不再影响该结论
 */
export type RectifyState = 'pending' | 'reviewing' | 'reviewed';

export const RECTIFY_STATE_LABEL: Record<RectifyState, string> = {
  pending: '待整改',
  reviewing: '待复核',
  reviewed: '已复核',
};

/** 尚未完成复核的状态（来源数据变更时这些状态的单子需要回到待复核队列） */
export const UNREVIEWED_RECTIFY_STATES: RectifyState[] = ['pending', 'reviewing'];

/** 年检整改单 */
export interface Rectify extends Revisioned {
  id: string;
  /** 所属电梯 */
  elevatorId: string;
  /** 不合格项 */
  item: string;
  /** 限期 yyyy-MM-dd */
  dueDate: string;
  /** 状态 */
  state: RectifyState;
  /** 复核人 */
  reviewer: string;
  /** 复核时间 */
  reviewedAt: string | null;
  /**
   * 来源保养项 id（checkItems.id）。
   * 由异常项转整改生成的有效单必有该字段，且在 rectifies.&sourceItemId 唯一索引上唯一，
   * 作为「同一异常只留一条有效整改单」的硬约束；手工登记 / 被归并的从单不带该字段。
   */
  sourceItemId?: string;
  /**
   * 主单 id：v3 升级归并重复单时，主单指向自身、从单指向主单。
   * 列表与导出只展示主单（masterId === id），从单仅留来源、不参与业务展示。
   */
  masterId?: string;
  /** 归并到本主单的历史重复单来源（仅主单有值，留痕用） */
  mergedFrom?: RectifyMergeSource[];
  createdAt: string;
}

/** 归并来源记录：旧数据升级时被并入主单的重复整改单摘要 */
export interface RectifyMergeSource {
  /** 原整改单 id */
  id: string;
  /** 原整改单状态 */
  state: RectifyState;
  /** 原复核人（可空） */
  reviewer: string;
  /** 原限期 */
  dueDate: string;
  /** 原创建时间 */
  createdAt: string;
  /** 归并时间 */
  mergedAt: string;
}

/** 整改单草稿 */
export interface RectifyDraft {
  elevatorId: string;
  item: string;
  dueDate: string;
  reviewer: string;
}

/** 整改单视图：带电梯上下文与超期天数 */
export interface RectifyView extends Rectify {
  elevatorName: string;
  owner: string;
  /** 是否超期（未复核且限期早于今天；待复核排队中不计超期） */
  overdue: boolean;
  /** 超期天数（未超期为 0） */
  overdueDays: number;
  /** 归并进本主单的历史重复单数 */
  mergedCount: number;
}

/** 年检不合格项字典 */
export const RECTIFY_ITEM_LIBRARY: string[] = [
  '限速器动作速度超差',
  '层门门锁啮合深度不足',
  '制动器制动力矩不足',
  '缓冲器复位异常',
  '钢丝绳断丝超标',
  '轿厢应急照明失效',
  '超载保护装置失灵',
  '机房通风不符合要求',
];

/** 是否为尚未复核的状态 */
export function isUnreviewedState(state: RectifyState): boolean {
  return state !== 'reviewed';
}

/** 是否为列表 / 导出口径下的主单 */
export function isMasterRectify(row: Pick<Rectify, 'id' | 'masterId'>): boolean {
  return !row.masterId || row.masterId === row.id;
}

/** 超期天数计算（仅待整改单计超期；待复核排队中与已复核均不计） */
export function overdueDaysOf(dueDate: string, state: RectifyState, now: Date = new Date()): number {
  if (state !== 'pending') return 0;
  const due = new Date(`${dueDate}T23:59:59`);
  if (Number.isNaN(due.getTime())) return 0;
  const diff = now.getTime() - due.getTime();
  if (diff <= 0) return 0;
  return Math.ceil(diff / (24 * 3600 * 1000));
}
