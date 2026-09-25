'use strict';

/* 道具连续离仓超时排查接口集成测试：node test/away-timeout-api.test.js
 * 使用独立临时数据文件，真实启动服务走 HTTP 全流程。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tmp-away-timeout-api-store.json');
process.env.DATA_FILE = DATA_FILE;

for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
  try { fs.unlinkSync(f); } catch { /* 不存在则忽略 */ }
}

const app = require('../server');

let server;
let base;
let passed = 0;

async function api(url, options = {}) {
  const res = await fetch(`${base}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = res.status === 204 ? null : await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function propResult(body, propId) {
  return body.props.find((p) => p.propId === propId);
}
function allIntervals(body) {
  return body.props.flatMap((p) => [...p.intervals, ...(p.openInterval ? [p.openInterval] : [])]);
}

async function main() {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  // 初始演示数据：
  // 青龙剑 p_sword：仓库→张三@0 →李四@3 →张三@8 →仓库@12（闭合区间 [0,12]，时长 12）
  // 折扇 p_fan：仓库→张三@1，第5分多条可接续冲突（冲突前离仓 4 分钟）
  // 宫灯 p_lantern：仓库→王五@2，第4分断链（冲突前离仓 2 分钟），钱七→仓库@9 在冲突后
  // 御印 p_seal：仓库→周八@1 →孙七@6（cutoff=12 时开放区间，时长 11）
  const state0 = (await api('/api/state')).body;
  const rev0 = state0.rev;
  const count0 = state0.records.length;

  // 1. 完整结果：超时区间、开放区间、无法判定区间齐备
  await test('离仓超时：超时 / 开放 / 无法判定完整返回', async () => {
    const res = await api('/api/away-timeout?minute=12&limit=5');
    assert.strictEqual(res.status, 200);
    const r = res.body;
    assert.strictEqual(r.cutoffMinute, 12);
    assert.strictEqual(r.queryMinute, 12);
    assert.strictEqual(r.limit, 5);
    assert.strictEqual(r.readOnly, true);
    assert.strictEqual(r.totalProps, 4);
    assert.strictEqual(r.hasTimeout, true);

    // 青龙剑：[0,12] 闭合，时长 12 > 5 -> 超时
    const sword = propResult(r, 'p_sword');
    assert.strictEqual(sword.intervals.length, 1);
    assert.strictEqual(sword.intervals[0].status, 'RETURNED_TIMEOUT');
    assert.deepStrictEqual(
      sword.intervals[0].records.map((x) => x.id),
      ['r_sw1', 'r_sw2', 'r_sw3', 'r_sw4']
    );

    // 御印：开放区间 [1, ?]，截至第12分时长 11 -> 确定超时
    const seal = propResult(r, 'p_seal');
    assert.strictEqual(seal.intervals.length, 0);
    assert.strictEqual(seal.openInterval.status, 'OPEN_TIMEOUT');
    assert.strictEqual(seal.openInterval.duration, 11);
    assert.strictEqual(seal.openInterval.endMinute, null);

    // 折扇、宫灯：冲突前未越阈值（4 / 2 <= 5）-> 无法判定，不计确定区间
    const fan = propResult(r, 'p_fan');
    assert.strictEqual(fan.intervals.length, 0);
    assert.strictEqual(fan.openInterval, null);
    assert.strictEqual(fan.conflict.minute, 5);
    assert.strictEqual(fan.undeterminableInterval.durationBeforeConflict, 4);
    const lantern = propResult(r, 'p_lantern');
    assert.strictEqual(lantern.undeterminableInterval.durationBeforeConflict, 2);
    // 冲突后的 钱七→仓库@9 不得计入确定区间
    assert.strictEqual(lantern.openInterval, null);

    assert.strictEqual(r.undeterminable.length, 2);
    assert.deepStrictEqual(
      r.undeterminable.map((u) => [u.propId, u.conflict.type]),
      [['p_fan', 'AMBIGUOUS'], ['p_lantern', 'BROKEN']]
    );

    // 确定区间 = 青龙剑 1 个闭合超时 + 御印 1 个开放超时
    assert.strictEqual(allIntervals(r).length, 2);
    assert.strictEqual(r.totalIntervals, 2);
    assert.strictEqual(r.overdueIntervals, 2);
    assert.strictEqual(r.conflictPropCount, 2);
    assert.strictEqual(r.undeterminableCount, 2);
  });

  // 2. 等于阈值不算超时：阈值改为 12，青龙剑时长恰为 12 -> 不超时
  await test('离仓超时：时长等于阈值不算超时', async () => {
    const res = await api('/api/away-timeout?minute=12&limit=12');
    assert.strictEqual(res.status, 200);
    const sword = propResult(res.body, 'p_sword');
    assert.strictEqual(sword.intervals[0].status, 'RETURNED');
    assert.strictEqual(sword.intervals[0].overdue, false);
    // 御印时长 11 <= 12 -> 开放但不超时
    const seal = propResult(res.body, 'p_seal');
    assert.strictEqual(seal.openInterval.status, 'OPEN');
    assert.strictEqual(seal.openInterval.overdue, false);
    assert.strictEqual(res.body.overdueIntervals, 0);
    assert.strictEqual(res.body.hasTimeout, false);
  });

  // 3. 冲突前已越阈值仍列确定超时：折扇冲突前离仓 4 分钟，阈值取 3
  await test('离仓超时：冲突前已越阈值仍列为确定超时，冲突后无法判定', async () => {
    const res = await api('/api/away-timeout?minute=12&limit=3');
    assert.strictEqual(res.status, 200);
    const fan = propResult(res.body, 'p_fan');
    assert.ok(fan.openInterval, '冲突前已越阈值，开放区间应保留为确定超时');
    assert.strictEqual(fan.openInterval.status, 'OPEN_TIMEOUT');
    assert.strictEqual(fan.openInterval.duration, 4);
    assert.strictEqual(fan.openInterval.confirmedOverdueBeforeConflict, true);
    assert.strictEqual(fan.undeterminableInterval, null);
    // 宫灯冲突前只有 2 分钟，仍无法判定
    const lantern = propResult(res.body, 'p_lantern');
    assert.strictEqual(lantern.openInterval, null);
    assert.ok(lantern.undeterminableInterval);
    // 顶层无法判定只剩宫灯
    assert.deepStrictEqual(res.body.undeterminable.map((u) => u.propId), ['p_lantern']);
  });

  // 4. 截止分钟边界：minute=4 时宫灯尚未冲突（第4分断链——仍 <= 4 冲突），
  //    折扇 / 御印窗口内链完整；minute=0 时青龙剑刚出仓，开放时长 0
  await test('离仓超时：截止分钟边界按该分钟全部交接完成后判定', async () => {
    // 第0分：青龙剑 仓库→张三，同分钟无归仓 -> 开放区间 [0,0] 时长 0
    let res = await api('/api/away-timeout?minute=0&limit=0');
    assert.strictEqual(res.status, 200);
    const sword = propResult(res.body, 'p_sword');
    assert.strictEqual(sword.openInterval.duration, 0);
    assert.strictEqual(sword.openInterval.status, 'OPEN'); // 0 == 阈值 0，不算超时
    // 其余道具窗口内无记录
    assert.strictEqual(propResult(res.body, 'p_seal').intervals.length, 0);
    assert.strictEqual(propResult(res.body, 'p_seal').openInterval, null);

    // minute=3：折扇未冲突（冲突在第5分），开放区间 [1,3] 时长 2
    res = await api('/api/away-timeout?minute=3&limit=5');
    const fan = propResult(res.body, 'p_fan');
    assert.strictEqual(fan.conflict, null);
    assert.strictEqual(fan.openInterval.duration, 2);
  });

  // 5. 只读：查询不改写数据（版本号、记录数、签收数均不变）
  await test('离仓超时：查询只读，数据版本与记录数不变', async () => {
    await api('/api/away-timeout?minute=12&limit=5');
    await api('/api/away-timeout?minute=0&limit=0');
    await api('/api/away-timeout?minute=99&limit=12');
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, rev0);
    assert.strictEqual(after.records.length, count0);
    assert.deepStrictEqual(after.signoffs, []);
  });

  // 6. 参数校验 400
  await test('离仓超时：参数校验 400', async () => {
    let res = await api('/api/away-timeout?minute=12');
    assert.strictEqual(res.status, 400);
    assert.ok(/允许离仓分钟数不能为空/.test(res.body.error));

    res = await api('/api/away-timeout?limit=5');
    assert.strictEqual(res.status, 400);
    assert.ok(/截止分钟不能为空/.test(res.body.error));

    res = await api('/api/away-timeout?minute=-1&limit=5');
    assert.strictEqual(res.status, 400);

    res = await api('/api/away-timeout?minute=12&limit=-2');
    assert.strictEqual(res.status, 400);
    assert.ok(/允许离仓分钟数必须是不小于 0 的整数/.test(res.body.error));

    res = await api('/api/away-timeout?minute=1.5&limit=5');
    assert.strictEqual(res.status, 400);

    res = await api('/api/away-timeout?minute=12&limit=x');
    assert.strictEqual(res.status, 400);
  });

  server.close();
  for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
    try { fs.unlinkSync(f); } catch { /* 忽略 */ }
  }
  console.log(`\n全部 ${passed} 个离仓超时排查接口测试通过 ✔`);
}

main().catch((err) => {
  console.error(err);
  if (server) server.close();
  process.exit(1);
});
