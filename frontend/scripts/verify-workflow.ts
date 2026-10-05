/* eslint-disable no-console */
/**
 * 事务工作流端到端验证（fake-indexeddb，不落浏览器）：
 * 1. 并发双提交只产生一条整改单，重复提交返回已有单；
 * 2. 签署事务原子性：校验失败回滚，签署草稿 / 已完成项不被破坏，重试不重复建单；
 * 3. 计划改期 / 更换电梯 / 异常项作废后，未复核单回到待复核，已复核结论保留；
 * 4. 旧数据（v2 风格重复单 + 无 masterId）经 v3 升级归并成主单 + 来源。
 */
import 'fake-indexeddb/auto';
import {
  db,
  initDatabase,
  listRectifies,
  listMasterRectifies,
  putElevator,
  putPlan,
  putCheckItems,
  ROW_REVISION,
  type ElevatorRow,
  type PlanRow,
  type CheckItemRow,
  type RectifyRow,
} from '../src/utils/db';
import {
  promoteAbnormalItemsTx,
  signPlanTx,
  changePlanTx,
  setCheckResultTx,
} from '../src/utils/workflow';

let passed = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ✓ ${message}`);
}

const stamp = '2026-10-05 09:00';
function elevator(id: string): ElevatorRow {
  return {
    id,
    regCode: `T-${id}`,
    owner: '测试单位',
    loadKg: 1000,
    stops: 10,
    useDate: '2020-01-01',
    maintCycle: 'quarter',
    createdAt: stamp,
    revision: ROW_REVISION,
  };
}
function plan(id: string, elevatorId: string, planDate = '2026-10-01'): PlanRow {
  return {
    id,
    elevatorId,
    cycleType: 'quarter',
    planDate,
    executor: '测试员',
    state: 'executing',
    signedAt: null,
    createdAt: stamp,
    revision: ROW_REVISION,
  };
}
function items(planId: string): CheckItemRow[] {
  return ['制动器动作试验', '层门锁紧装置', '限速器动作'].map((itemName, index) => ({
    id: `${planId}-c${index + 1}`,
    planId,
    seq: index + 1,
    itemName,
    result: index === 1 ? ('abnormal' as const) : ('normal' as const),
    value: '',
    remark: '',
    createdAt: stamp,
    revision: ROW_REVISION,
  }));
}

async function reset(): Promise<void> {
  // db 是单例：关闭并删除物理库后再重新 open 即得到全新结构
  if (db.isOpen()) await db.close();
  await db.delete();
}

/* ------------------------------ 场景一：并发防重 ------------------------------ */
async function scenarioConcurrency(): Promise<void> {
  console.log('\n[1] 并发双提交 / 重复提交只保留一条有效整改单');
  await reset();
  await initDatabase();
  // 清掉播种，使用可控数据
  await Promise.all([db.elevators.clear(), db.plans.clear(), db.checkItems.clear(), db.rectifies.clear()]);
  await putElevator(elevator('e1'));
  await putPlan(plan('p1', 'e1'));
  await putCheckItems(items('p1'));

  // 两个执行终端「同时」点转整改
  const [a, b] = await Promise.all([
    promoteAbnormalItemsTx('e1', 'p1', '2026-10-20', '王敏'),
    promoteAbnormalItemsTx('e1', 'p1', '2026-10-20', '王敏'),
  ]);
  const all = await listRectifies();
  assert(all.filter((r) => r.sourceItemId === 'p1-c2').length === 1, '唯一索引下同一异常只有一条整改单');
  // 同进程并发被 in-flight 合并：两笔拿到同一结果
  assert(a.created.length === b.created.length && a.reused.length === b.reused.length, '并发双提交合并为同一处理');
  assert(a.created.length + a.reused.length === 1, '合并结果只对应一条有效单');

  // 再次重复提交
  const c = await promoteAbnormalItemsTx('e1', 'p1', '2026-10-20', '王敏');
  assert(c.created.length === 0 && c.reused.length === 1, '重复提交不建单，返回已有单');
  assert(all[0]?.masterId === all[0]?.id, '整改单自身即主单');

  // 跨事务真正抢跑（不经 in-flight 合并）：唯一索引必须兜底
  const rawRows = items('p1b').map((item) => ({ ...item, planId: 'p1b' }));
  await putPlan(plan('p1b', 'e1'));
  await putCheckItems(rawRows);
  const idA = `rect-race-${Date.now()}-a`;
  const idB = `rect-race-${Date.now()}-b`;
  let uniqueError = false;
  try {
    await Promise.all([
      db.rectifies.add({
        id: idA,
        elevatorId: 'e1',
        item: '层门锁紧装置',
        dueDate: '2026-10-20',
        state: 'pending',
        reviewer: '王敏',
        reviewedAt: null,
        sourceItemId: 'p1b-c2',
        masterId: idA,
        createdAt: stamp,
        revision: ROW_REVISION,
      }),
      db.rectifies.add({
        id: idB,
        elevatorId: 'e1',
        item: '层门锁紧装置',
        dueDate: '2026-10-20',
        state: 'pending',
        reviewer: '王敏',
        reviewedAt: null,
        sourceItemId: 'p1b-c2',
        masterId: idB,
        createdAt: stamp,
        revision: ROW_REVISION,
      }),
    ]);
  } catch {
    uniqueError = true;
  }
  assert(uniqueError, '同一 sourceItemId 的并发插入被唯一索引拒绝');
  const raced = await db.rectifies.where('sourceItemId').equals('p1b-c2').toArray();
  assert(raced.length === 1, '抢跑后库里仍只有一条有效单');
}

/* --------------------------- 场景二：签署原子性与回滚 --------------------------- */
async function scenarioAtomicSign(): Promise<void> {
  console.log('\n[2] 签署事务失败回滚：签署草稿与已完成项可恢复，重试不重复建单');
  await reset();
  await db.open();
  await Promise.all([db.elevators.clear(), db.plans.clear(), db.checkItems.clear(), db.rectifies.clear()]);
  await putElevator(elevator('e2'));
  await putPlan(plan('p2', 'e2'));
  // 一项未填
  const rows = items('p2').map((item) => ({ ...item, result: item.seq === 3 ? null : item.result }));
  await putCheckItems(rows);

  const drafts = rows.map((item) => ({
    id: item.id,
    itemName: item.itemName,
    // 页面草稿里第 3 项仍为 null（用户没填完）
    result: item.seq === 3 ? null : item.result,
    value: item.value,
    remark: item.remark,
  }));

  let failed = false;
  try {
    await signPlanTx('p2', drafts);
  } catch (error) {
    failed = true;
    assert(/未填写/.test(String((error as Error).message)), '未填项时报错中止事务');
  }
  assert(failed, '签署事务抛错');
  const afterPlan = await db.plans.get('p2');
  assert(afterPlan?.state === 'executing' && afterPlan.signedAt === null, '计划未被签署（回滚生效）');

  // 补填后重试：成功且只签一次
  const okDrafts = drafts.map((draft) =>
    draft.id === 'p2-c3' ? { ...draft, result: 'normal' as const } : draft,
  );
  const r1 = await signPlanTx('p2', okDrafts);
  assert(r1.ok, '补填后重试签署成功');
  const r2 = await signPlanTx('p2', okDrafts);
  assert(r2.ok, '重复签署幂等成功');
  const signedPlan = await db.plans.get('p2');
  assert(signedPlan?.state === 'signed' && !!signedPlan.signedAt, '计划已签署且带签署时间');

  // 没有保养项的计划：事务回滚，连草稿写入也不留
  await putPlan(plan('pEmpty', 'e2'));
  let emptyFailed = false;
  try {
    await signPlanTx('pEmpty', []);
  } catch {
    emptyFailed = true;
  }
  assert(emptyFailed, '无保养项签署失败');
  assert((await db.checkItems.where('planId').equals('pEmpty').count()) === 0, '无半成品保养项写入');
}

/* ---------------------- 场景三：改期 / 换梯 / 异常作废回流 ---------------------- */
async function scenarioReopen(): Promise<void> {
  console.log('\n[3] 改期 / 换梯 / 异常项作废 → 未复核回待复核，已复核结论保留');
  await reset();
  await db.open();
  await Promise.all([db.elevators.clear(), db.plans.clear(), db.checkItems.clear(), db.rectifies.clear()]);
  await putElevator(elevator('e3'));
  await putElevator(elevator('e4'));
  await putPlan(plan('p3', 'e3', '2026-10-01'));
  await putCheckItems(items('p3'));

  const promoted = await promoteAbnormalItemsTx('e3', 'p3', '2026-10-20', '王敏');
  const rectifyId = promoted.created[0]!.id;

  // 待整改 → 提交复核 → 复核通过（锁定结论）
  await db.rectifies.update(rectifyId, { state: 'reviewing' });
  await db.rectifies.update(rectifyId, {
    state: 'reviewed',
    reviewer: '李安全',
    reviewedAt: '2026-10-08 10:00',
  });

  // 再加第二个异常项（序号 1 也改异常），生成第二张单（待整改）
  await setCheckResultTx('p3-c1', 'abnormal');
  const second = await promoteAbnormalItemsTx('e3', 'p3', '2026-10-22', '王敏');
  const secondId = second.created[0]!.id;
  assert(!!secondId && secondId !== rectifyId, '不同异常项各自一张单');

  // 事件 A：计划改期 → 未复核单回待复核；已复核单不动
  await changePlanTx('p3', {
    elevatorId: 'e3',
    cycleType: 'quarter',
    planDate: '2026-10-15',
    executor: '测试员',
  });
  const afterDate = await db.rectifies.get(secondId);
  assert(afterDate?.state === 'reviewing', '改期后未复核单回到待复核');
  const reviewed = await db.rectifies.get(rectifyId);
  assert(
    reviewed?.state === 'reviewed' && reviewed.reviewer === '李安全' && !!reviewed.reviewedAt,
    '改期后已复核结论照旧保留',
  );

  // 事件 B：更换电梯 → 待复核单随计划迁移，仍在待复核；已复核单不迁移、结论不动
  await changePlanTx('p3', {
    elevatorId: 'e4',
    cycleType: 'quarter',
    planDate: '2026-10-15',
    executor: '测试员',
  });
  const moved = await db.rectifies.get(secondId);
  assert(moved?.elevatorId === 'e4' && moved.state === 'reviewing', '换梯后未复核单随迁并保持待复核');
  const stayed = await db.rectifies.get(rectifyId);
  assert(stayed?.elevatorId === 'e3' && stayed.state === 'reviewed', '换梯后已复核单不迁移、结论保留');

  // 事件 C：异常项作废（异常 → 正常）→ 对应未复核单回待复核
  // 先退回待整改，再作废
  await db.rectifies.update(secondId, { state: 'pending' });
  await setCheckResultTx('p3-c1', 'normal');
  const voided = await db.rectifies.get(secondId);
  assert(voided?.state === 'reviewing', '异常项作废后整改单回到待复核');
}

/* ----------------------------- 场景四：旧数据归并 ----------------------------- */
async function scenarioMigration(): Promise<void> {
  console.log('\n[4] v2 旧数据升级：重复整改单归并为主单并保留来源');
  // 直接构造 v2 风格库（v2 schema：rectifies 无 sourceItemId / masterId）
  await reset();
  {
    // 临时以旧结构声明并打开 v2
    const DexieMod = await import('dexie');
    const oldDb = new DexieMod.default('gbelevsvc');
    oldDb.version(2).stores({
      elevators: 'id, regCode, owner, maintCycle, useDate',
      plans: 'id, elevatorId, cycleType, state, planDate, executor, [elevatorId+planDate]',
      checkItems: 'id, planId, seq, result, itemName, [planId+seq]',
      rescues: 'id, elevatorId, alarmAt, responder',
      rectifies: 'id, elevatorId, state, dueDate, reviewer',
      settings: 'id',
    });
    await oldDb.open();
    const legacy: Array<Record<string, unknown>> = [
      {
        id: 'dup-1',
        elevatorId: 'eX',
        item: '制动器制动力矩不足',
        dueDate: '2026-10-20',
        state: 'pending',
        reviewer: '王敏',
        reviewedAt: null,
        createdAt: '2026-10-01 09:00',
        revision: 2,
      },
      {
        id: 'dup-2',
        elevatorId: 'eX',
        item: '制动器制动力矩不足',
        dueDate: '2026-10-20',
        state: 'reviewed',
        reviewer: '李安全',
        reviewedAt: '2026-10-09 11:00',
        createdAt: '2026-10-02 09:00',
        revision: 2,
      },
      {
        id: 'only-1',
        elevatorId: 'eX',
        item: '钢丝绳断丝超标',
        dueDate: '2026-11-01',
        state: 'pending',
        reviewer: '王敏',
        reviewedAt: null,
        createdAt: '2026-10-03 09:00',
        revision: 2,
      },
    ];
    await oldDb.table('rectifies').bulkPut(legacy);
    oldDb.close();
  }

  // 以当前代码（v3）重新打开 → 触发 upgrade
  await db.open();
  const all = await listRectifies();
  assert(all.length === 3, '归并不删除历史行（主单 + 从单留痕）');

  const masters = await listMasterRectifies();
  assert(masters.length === 2, '主单口径只剩 2 条（重复对归并为 1）');

  const master = masters.find((row: RectifyRow) => row.item === '制动器制动力矩不足');
  assert(!!master, '找到归并主单');
  assert(master!.state === 'reviewed' && master!.reviewer === '李安全', '已复核结论归并到主单');
  assert(master!.id === 'dup-2', '主单优先选取已复核的一条');
  assert(master!.mergedFrom?.length === 1 && master!.mergedFrom[0]!.id === 'dup-1', '主单记录了从单来源 dup-1');

  const alias = all.find((row) => row.id === 'dup-1');
  assert(alias?.masterId === master!.id && alias.sourceItemId === undefined, '从单指向主单且不占唯一槽位');
  assert(all.find((row) => row.id === 'only-1')?.masterId === 'only-1', '无重复的单自身即主单');
}

async function main(): Promise<void> {
  await scenarioConcurrency();
  await scenarioAtomicSign();
  await scenarioReopen();
  await scenarioMigration();
  console.log(`\n全部通过：${passed} 项断言`);
  await db.close();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
