'use strict';

/* 道具连续离仓超时排查引擎单元测试：node test/away-timeout.test.js */

const assert = require('assert');
const { checkAwayTimeouts, INTERVAL } = require('../src/away-timeout');
const { WAREHOUSE } = require('../src/verify');

let seq = 0;
const t = (n) => 1000 + n;

function mkData(props, records) {
  return {
    rev: 1,
    props: props.map((name, i) => ({ id: `p${i}`, name, note: '', createdAt: t(seq++) })),
    records,
  };
}
function rec(propId, minute, from, to) {
  return { id: `r${seq++}`, propId, minute, from, to, note: '', createdAt: t(seq) };
}

let passed = 0;
function test(name, fn) {
  seq = 0;
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function one(data, cutoff = 99, limit = 5) {
  const res = checkAwayTimeouts(data, cutoff, limit);
  return res.props[0];
}
function flat(data, cutoff = 99, limit = 5) {
  const res = checkAwayTimeouts(data, cutoff, limit);
  return {
    res,
    ivs: res.props.flatMap((p) => [...p.intervals, ...(p.openInterval ? [p.openInterval] : [])]),
  };
}

// 1. 完整归仓链：单个闭合区间，时长 = 归仓分钟 - 出仓分钟
test('离仓：完整归仓链给出单个闭合区间与正确时长', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 3, '张三', '李四'),
    rec('p0', 8, '李四', '张三'),
    rec('p0', 12, '张三', WAREHOUSE),
  ]);
  const p = one(data, 12, 5);
  assert.strictEqual(p.intervals.length, 1);
  assert.strictEqual(p.openInterval, null);
  const iv = p.intervals[0];
  assert.strictEqual(iv.status, INTERVAL.RETURNED_TIMEOUT);
  assert.strictEqual(iv.startMinute, 0);
  assert.strictEqual(iv.endMinute, 12);
  assert.strictEqual(iv.duration, 12);
  assert.strictEqual(iv.overdue, true);
  assert.strictEqual(iv.closed, true);
  assert.strictEqual(iv.records.length, 4);
  assert.strictEqual(iv.startRecord.to, '张三');
  assert.strictEqual(iv.endRecord.from, '张三');
});

// 2. 等于阈值不算超时（闭合区间严格大于）
test('离仓：闭合区间时长等于阈值 -> 不算超时', () => {
  const data = mkData(['剑'], [
    rec('p0', 2, WAREHOUSE, '张三'),
    rec('p0', 7, '张三', WAREHOUSE), // 时长 5
  ]);
  const p = one(data, 12, 5);
  assert.strictEqual(p.intervals[0].status, INTERVAL.RETURNED);
  assert.strictEqual(p.intervals[0].overdue, false);
  // 6 分钟则超时
  const data2 = mkData(['剑'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 7, '张三', WAREHOUSE),
  ]);
  const p2 = one(data2, 12, 5);
  assert.strictEqual(p2.intervals[0].status, INTERVAL.RETURNED_TIMEOUT);
});

// 3. 同分钟多次转手：仓库→甲、甲→乙（最终在仓外）= 出仓
test('离仓：同分钟链式转手按最终是否在仓判定（出仓）', () => {
  const data = mkData(['枪'], [
    rec('p0', 2, WAREHOUSE, '甲'),
    rec('p0', 2, '甲', '乙'),
    rec('p0', 4, '乙', WAREHOUSE),
  ]);
  const p = one(data, 9, 5);
  assert.strictEqual(p.intervals.length, 1);
  assert.strictEqual(p.intervals[0].startMinute, 2);
  assert.strictEqual(p.intervals[0].endMinute, 4);
  assert.strictEqual(p.intervals[0].duration, 2);
  assert.strictEqual(p.intervals[0].records.length, 3);
});

// 4. 同分钟仓库→甲、甲→仓库（最终在仓）= 时长 0 的闭合区间，不算超时
test('离仓：同分钟出仓又归仓 -> 时长 0 的闭合区间', () => {
  const data = mkData(['镜'], [
    rec('p0', 3, WAREHOUSE, '甲'),
    rec('p0', 3, '甲', WAREHOUSE),
  ]);
  const p = one(data, 9, 0); // 阈值 0：时长 0 仍不超时
  assert.strictEqual(p.intervals.length, 1);
  assert.strictEqual(p.intervals[0].status, INTERVAL.RETURNED);
  assert.strictEqual(p.intervals[0].duration, 0);
  assert.strictEqual(p.intervals[0].overdue, false);
});

// 5. 多次离仓归仓：一件道具多个区间，分别判定超时
test('离仓：多次出仓归仓形成多个区间，分别判定', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 2, '张三', WAREHOUSE),       // 时长 2，不超时
    rec('p0', 4, WAREHOUSE, '李四'),
    rec('p0', 10, '李四', WAREHOUSE),      // 时长 6，超时
  ]);
  const { ivs } = flat(data, 12, 5);
  assert.deepStrictEqual(ivs.map((iv) => [iv.startMinute, iv.endMinute, iv.overdue]),
    [[0, 2, false], [4, 10, true]]);
});

// 6. 未归仓开放区间：截至查询时刻（截止分钟）计时
test('离仓：未归仓区间截至查询时刻计时，越阈值判超时', () => {
  const data = mkData(['印'], [
    rec('p0', 1, WAREHOUSE, '周八'),
    rec('p0', 6, '周八', '孙七'),
  ]);
  // cutoff=12：时长 11 > 5 -> 确定超时
  const p = one(data, 12, 5);
  assert.strictEqual(p.intervals.length, 0);
  assert.ok(p.openInterval);
  assert.strictEqual(p.openInterval.status, INTERVAL.OPEN_TIMEOUT);
  assert.strictEqual(p.openInterval.duration, 11);
  assert.strictEqual(p.openInterval.asOfMinute, 12);
  assert.strictEqual(p.openInterval.endMinute, null);
  assert.strictEqual(p.openInterval.endRecord, null);

  // cutoff=6：时长 5 == 阈值 -> 不算超时
  const p2 = one(data, 6, 5);
  assert.strictEqual(p2.openInterval.status, INTERVAL.OPEN);
  assert.strictEqual(p2.openInterval.overdue, false);
  assert.strictEqual(p2.openInterval.duration, 5);
});

// 7. 截止分钟边界：晚于截止分钟的交接不计入（归仓发生在截止后仍是开放区间）
test('离仓：截止分钟之后的归仓不计入，区间保持开放', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 8, '张三', WAREHOUSE),
  ]);
  const p = one(data, 7, 5); // 第8分归仓不在窗口内
  assert.strictEqual(p.intervals.length, 0);
  assert.strictEqual(p.openInterval.duration, 7);
  assert.strictEqual(p.openInterval.status, INTERVAL.OPEN_TIMEOUT);
});

// 8. 歧义冲突且冲突前未越阈值：开放区间标为无法判定，不计入确定区间
test('离仓：歧义冲突且冲突前未越阈值 -> 无法判定区间', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '王五'),
    rec('p0', 5, '张三', '赵六'),
  ]);
  const res = checkAwayTimeouts(data, 12, 5); // 冲突前时长 4，未越阈值
  const p = res.props[0];
  assert.strictEqual(p.intervals.length, 0);
  assert.strictEqual(p.openInterval, null);
  assert.ok(p.conflict);
  assert.strictEqual(p.conflict.minute, 5);
  assert.strictEqual(res.undeterminable.length, 1);
  const u = res.undeterminable[0];
  assert.strictEqual(u.kind, 'UNDETERMINABLE');
  assert.strictEqual(u.startMinute, 1);
  assert.strictEqual(u.durationBeforeConflict, 4);
  assert.strictEqual(u.conflict.type, 'AMBIGUOUS');
  assert.strictEqual(res.overdueIntervals, 0);
  assert.strictEqual(res.undeterminableCount, 1);
});

// 9. 冲突前已严格越过阈值：仍列为确定超时，冲突后标无法判定
test('离仓：冲突前已越阈值 -> 确定超时保留，冲突后无法判定', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '王五'),
    rec('p0', 5, '张三', '赵六'),
    rec('p0', 9, '王五', WAREHOUSE), // 冲突之后：不得当作确定归仓
  ]);
  const res = checkAwayTimeouts(data, 12, 3); // 冲突前时长 4 > 3
  const p = res.props[0];
  assert.strictEqual(p.intervals.length, 0);
  assert.ok(p.openInterval);
  assert.strictEqual(p.openInterval.status, INTERVAL.OPEN_TIMEOUT);
  assert.strictEqual(p.openInterval.duration, 4);
  assert.strictEqual(p.openInterval.confirmedOverdueBeforeConflict, true);
  assert.strictEqual(p.openInterval.records.length, 1); // 只有冲突前的 仓库→张三
  assert.strictEqual(res.undeterminable.length, 0);
  assert.strictEqual(res.overdueIntervals, 1);
});

// 10. 冲突前时长恰好等于阈值：不算确定超时，整段标无法判定
test('离仓：冲突前时长等于阈值 -> 不判确定超时，标无法判定', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '王五'),
    rec('p0', 5, '张三', '赵六'),
  ]);
  const res = checkAwayTimeouts(data, 12, 4); // 冲突前时长 4 == 阈值
  assert.strictEqual(res.overdueIntervals, 0);
  assert.strictEqual(res.undeterminable.length, 1);
  assert.strictEqual(res.undeterminable[0].durationBeforeConflict, 4);
});

// 11. 断链冲突：冲突时仍在仓外，冲突前闭合区间仍正常保留
test('离仓：断链冲突前已闭合的区间照常列出', () => {
  const data = mkData(['灯'], [
    rec('p0', 0, WAREHOUSE, '王五'),
    rec('p0', 2, '王五', WAREHOUSE),   // 已闭合：时长 2（阈值 5，不超时）
    rec('p0', 3, WAREHOUSE, '王五'),   // 再次出仓
    rec('p0', 4, '李四', '钱七'),      // 第4分断链；冲突前时长 1
  ]);
  const res = checkAwayTimeouts(data, 12, 5);
  const p = res.props[0];
  assert.strictEqual(p.intervals.length, 1);
  assert.strictEqual(p.intervals[0].status, INTERVAL.RETURNED);
  assert.strictEqual(p.openInterval, null);
  assert.strictEqual(res.undeterminable.length, 1);
  assert.strictEqual(res.undeterminable[0].startMinute, 3);
  assert.strictEqual(res.undeterminable[0].conflict.type, 'BROKEN');
});

// 12. 断链冲突前闭合区间已超时：仍列为确定超时
test('离仓：冲突前闭合区间已超时仍列为确定超时', () => {
  const data = mkData(['灯'], [
    rec('p0', 0, WAREHOUSE, '王五'),
    rec('p0', 8, '王五', WAREHOUSE),   // 已闭合：时长 8 > 5 -> 超时
    rec('p0', 9, WAREHOUSE, '王五'),
    rec('p0', 10, '李四', '钱七'),     // 第10分断链
  ]);
  const res = checkAwayTimeouts(data, 12, 5);
  const p = res.props[0];
  assert.strictEqual(p.intervals.length, 1);
  assert.strictEqual(p.intervals[0].status, INTERVAL.RETURNED_TIMEOUT);
  assert.strictEqual(res.overdueIntervals, 1);
  assert.strictEqual(res.undeterminable.length, 1);
});

// 13. 冲突发生时道具已在仓库：没有开放区间，只报冲突；此前闭合区间保留
test('离仓：冲突时道具已在仓 -> 无无法判定区间，仅标冲突', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 3, '张三', WAREHOUSE), // 已归仓
    rec('p0', 5, '李四', '钱七'),    // 断链（仓库不可能交出）；冲突时持有人是仓库
  ]);
  const res = checkAwayTimeouts(data, 12, 5);
  const p = res.props[0];
  assert.strictEqual(p.intervals.length, 1);
  assert.strictEqual(p.openInterval, null);
  assert.strictEqual(p.undeterminableInterval, null);
  assert.ok(p.conflict);
  assert.strictEqual(res.undeterminable.length, 0);
  assert.strictEqual(res.conflictPropCount, 1);
});

// 14. 无交接记录：全程在仓库，没有离仓区间
test('离仓：无交接记录道具没有离仓区间', () => {
  const data = mkData(['箱'], []);
  const p = one(data, 12, 5);
  assert.strictEqual(p.intervals.length, 0);
  assert.strictEqual(p.openInterval, null);
  assert.strictEqual(p.conflict, null);
});

// 15. 晚于截止分钟的冲突不影响本次结果（窗口内链完整、未归仓按开放区间）
test('离仓：截止分钟之后的冲突不影响本次排查', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 9, '张三', '王五'),
    rec('p0', 9, '张三', '赵六'), // 第9分冲突
  ]);
  const p = one(data, 8, 5); // 冲突在窗口外
  assert.strictEqual(p.conflict, null);
  assert.ok(p.openInterval);
  assert.strictEqual(p.openInterval.duration, 7); // 1 -> 8
  assert.strictEqual(p.openInterval.status, INTERVAL.OPEN_TIMEOUT);
});

// 16. 汇总计数与只读标记
test('离仓：汇总计数正确并带 rev / readOnly', () => {
  const data = mkData(['剑', '印'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 12, '张三', WAREHOUSE), // 超时
    rec('p1', 1, WAREHOUSE, '周八'),  // cutoff=12 开放，时长 11，超时
  ]);
  const res = checkAwayTimeouts(data, 12, 5);
  assert.strictEqual(res.totalProps, 2);
  assert.strictEqual(res.totalIntervals, 2);
  assert.strictEqual(res.overdueIntervals, 2);
  assert.strictEqual(res.conflictPropCount, 0);
  assert.strictEqual(res.hasTimeout, true);
  assert.strictEqual(res.readOnly, true);
  assert.strictEqual(res.rev, 1);
  assert.strictEqual(res.queryMinute, 12);
  assert.strictEqual(res.limit, 5);
});

// 17. 参数校验
test('离仓：非法截止分钟 / 阈值抛出 BAD_REQUEST', () => {
  const data = mkData(['剑'], []);
  assert.throws(() => checkAwayTimeouts(data, -1, 5), (e) => e.code === 'BAD_REQUEST');
  assert.throws(() => checkAwayTimeouts(data, 1.5, 5), (e) => e.code === 'BAD_REQUEST');
  assert.throws(() => checkAwayTimeouts(data, 5, -1), (e) => e.code === 'BAD_REQUEST');
  assert.throws(() => checkAwayTimeouts(data, 5, 2.5), (e) => e.code === 'BAD_REQUEST');
});

// 18. 引擎只读：不修改传入数据
test('离仓：引擎不改写传入数据', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 3, '张三', '李四'),
  ]);
  const snapshot = JSON.stringify(data);
  checkAwayTimeouts(data, 12, 1);
  assert.strictEqual(JSON.stringify(data), snapshot);
});

// 19. 同分钟在仓库再次分叉（仓库→甲→仓库→乙…）：链不唯一，按冲突处理
test('离仓：同分钟在仓库再次分叉 -> 歧义冲突，冲突前无可确定区间', () => {
  // 仓库→甲、甲→仓库 是唯一链（出仓又归仓）；再追加 仓库→乙 使持有人无法唯一确定
  const data = mkData(['剑'], [
    rec('p0', 3, WAREHOUSE, '甲'),
    rec('p0', 3, '甲', WAREHOUSE),
    rec('p0', 3, WAREHOUSE, '乙'),
  ]);
  const res = checkAwayTimeouts(data, 5, 0);
  const p = res.props[0];
  assert.ok(p.conflict);
  assert.strictEqual(p.conflict.type, 'AMBIGUOUS');
  // 冲突分钟的归约本身不唯一：冲突前没有任何可确定的区间或开放区间
  assert.strictEqual(p.intervals.length, 0);
  assert.strictEqual(p.openInterval, null);
  assert.strictEqual(res.undeterminable.length, 0);
});

// 20. 不同分钟两次出仓归仓 + 第二次未归仓：闭合区间与开放区间并存
test('离仓：前一区间闭合超时、后一区间开放未超时并存', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 8, '张三', WAREHOUSE),   // 时长 8 > 5 超时
    rec('p0', 10, WAREHOUSE, '李四'),  // 再次出仓，cutoff=12 时开放时长 2
  ]);
  const res = checkAwayTimeouts(data, 12, 5);
  const p = res.props[0];
  assert.strictEqual(p.intervals.length, 1);
  assert.strictEqual(p.intervals[0].status, INTERVAL.RETURNED_TIMEOUT);
  assert.strictEqual(p.openInterval.status, INTERVAL.OPEN);
  assert.strictEqual(p.openInterval.duration, 2);
  assert.strictEqual(res.totalIntervals, 2);
  assert.strictEqual(res.overdueIntervals, 1);
});

console.log(`\n全部 ${passed} 个离仓超时排查引擎测试通过 ✔`);
