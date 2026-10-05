import { ROW_REVISION, type Revisioned } from './persistence';

/** 整改状态：待整改 / 待复核 / 已复核 */
export type RectifyState = 'pending' | 'recheck' | 'reviewed';

export const RECTIFY_STATE_LABEL: Record<RectifyState, string> = {
  pending: '待整改',
  recheck: '待复核',
  reviewed: '已复核',
};

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
  /** 去重键：电梯 + 不合格项，同一异常只留一条有效单 */
  dedupeKey: string;
  /** 来源保养计划（手工登记为 null） */
  sourcePlanId: string | null;
  /** 来源保养项（手工登记为 null） */
  sourceItemId: string | null;
  /** 重复单归并到的主单 id；null 表示本行即主单 */
  mergedInto: string | null;
  /** 主单吸收的来源单 id 列表（留来源） */
  mergedFrom: string[];
  createdAt: string;
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
  /** 是否超期（未复核且限期早于今天） */
  overdue: boolean;
  /** 超期天数（未超期为 0） */
  overdueDays: number;
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

/** 超期天数计算 */
export function overdueDaysOf(dueDate: string, state: RectifyState, now: Date = new Date()): number {
  if (state === 'reviewed') return 0;
  const due = new Date(`${dueDate}T23:59:59`);
  if (Number.isNaN(due.getTime())) return 0;
  const diff = now.getTime() - due.getTime();
  if (diff <= 0) return 0;
  return Math.ceil(diff / (24 * 3600 * 1000));
}

/** 整改单去重键：同一电梯同一不合格项只留一条有效单 */
export function rectifyDedupeKey(elevatorId: string, item: string): string {
  return `${elevatorId}::${item.trim()}`;
}

/** 是否主单（未归并到他单）；列表与导出只展示主单 */
export function isMasterRectify(row: Pick<Rectify, 'mergedInto'>): boolean {
  return row.mergedInto === null;
}

/** 是否有效（开口）整改单：主单且未复核关闭；重复提交时复用该单 */
export function isOpenRectify(row: Pick<Rectify, 'mergedInto' | 'state'>): boolean {
  return row.mergedInto === null && row.state !== 'reviewed';
}

/**
 * 旧行归一化：补齐 v3 新增的去重键与来源 / 归并字段。
 * IndexedDB 结构迁移与 JSON 导入共用，保证旧数据进入新结构时字段完整。
 */
export function normalizeRectifyRow(
  raw: Partial<Rectify> & Pick<Rectify, 'id' | 'elevatorId' | 'item'>,
): Rectify {
  return {
    id: raw.id,
    elevatorId: raw.elevatorId,
    item: raw.item,
    dueDate: typeof raw.dueDate === 'string' ? raw.dueDate : '',
    state: raw.state === 'reviewed' || raw.state === 'recheck' ? raw.state : 'pending',
    reviewer: typeof raw.reviewer === 'string' ? raw.reviewer : '',
    reviewedAt: typeof raw.reviewedAt === 'string' ? raw.reviewedAt : null,
    dedupeKey:
      typeof raw.dedupeKey === 'string' && raw.dedupeKey
        ? raw.dedupeKey
        : rectifyDedupeKey(raw.elevatorId, raw.item),
    sourcePlanId: typeof raw.sourcePlanId === 'string' ? raw.sourcePlanId : null,
    sourceItemId: typeof raw.sourceItemId === 'string' ? raw.sourceItemId : null,
    mergedInto: typeof raw.mergedInto === 'string' ? raw.mergedInto : null,
    mergedFrom: Array.isArray(raw.mergedFrom)
      ? raw.mergedFrom.filter((id): id is string => typeof id === 'string')
      : [],
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    revision: typeof raw.revision === 'number' ? raw.revision : ROW_REVISION,
  };
}

/** 主单选取优先级：已复核优先（结论照旧保留），其次创建时间最早，id 兜底 */
function compareMasterPriority(a: Rectify, b: Rectify): number {
  const ra = a.state === 'reviewed' ? 0 : 1;
  const rb = b.state === 'reviewed' ? 0 : 1;
  if (ra !== rb) return ra - rb;
  if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
  return a.id.localeCompare(b.id);
}

/**
 * 归并重复整改单：同一去重键（电梯 + 不合格项）只留一条主单，
 * 其余单标记 mergedInto 指向主单并保留原状（留来源），主单 mergedFrom 记录来源单 id。
 * 纯函数：返回处理后的全量行（主单 + 已归并单），调用方负责写回；无重复时原样返回。
 */
export function mergeDuplicateRectifies<T extends Rectify>(rows: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    if (row.mergedInto !== null) continue; // 已归并的从单不参与再分组
    const key = row.dedupeKey || rectifyDedupeKey(row.elevatorId, row.item);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  const mergedIntoById = new Map<string, string>();
  const mergedFromById = new Map<string, string[]>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(compareMasterPriority);
    const master = sorted[0];
    const sources = sorted.slice(1).map((row) => row.id);
    mergedFromById.set(master.id, sources);
    for (const id of sources) mergedIntoById.set(id, master.id);
  }
  if (mergedIntoById.size === 0) return rows;
  return rows.map((row) => {
    const into = mergedIntoById.get(row.id);
    if (into !== undefined) return { ...row, mergedInto: into };
    const from = mergedFromById.get(row.id);
    if (from) return { ...row, mergedFrom: [...new Set([...row.mergedFrom, ...from])] };
    return row;
  });
}
