'use strict';

/**
 * 道具连续离仓超时排查引擎（只读，生成即时结果，不改写交接记录 / 签收）。
 *
 * 输入「截止分钟」（含）与「允许离仓分钟数」（阈值，非负整数），
 * 对每件道具沿用现有「同分钟唯一交接链」规则，逐件重放截止时刻内
 * （minute <= cutoffMinute）的记录：
 *
 * - 把每一次「从仓库交出（交接后离开仓库）」到「重新入仓（交接后回到仓库）」
 *   视为一个离仓区间：起点分钟 = 仓库交出记录所在分钟，终点分钟 = 回到仓库
 *   记录所在分钟；时长 = endMinute - startMinute。同分钟内的多次转手只按
 *   该分钟全部交接完成后的最终持有状态判断（例如同分钟 仓库→A、A→仓库
 *   构成一个时长 0 的闭合离仓区间；同分钟 仓库→A、A→B 构成一个出仓区间）。
 * - 已闭合区间：时长「严格大于」阈值才算超时——时长等于阈值不算超时。
 * - 截止时刻全部交接完成后仍未归仓：区间保持开放，截至查询时刻（截止分钟）
 *   计时，时长 = cutoffMinute - startMinute（同样严格大于阈值才算超时）。
 * - 交接链冲突：只保留冲突前可确定的区间；冲突发生时道具若仍在仓外，
 *   该开放区间按冲突分钟（该分钟已唯一归约的交接完成后）计时——
 *   此时长已严格越过阈值，仍列为「确定超时」；否则标为「无法判定」
 *   （冲突后的离仓时长无法判定）。冲突分钟之后的记录一律不作为确定持有。
 */

const { WAREHOUSE, sortRecords, replayPropRecords } = require('./verify');

/**
 * 逐分钟增量重放（沿用同分钟唯一链规则，但保留每个交接分钟的完整轨迹）。
 *
 * 直接复用 replayPropRecords：依次把「截至第 m 分钟」的全部记录重放一次，
 * 该分钟新进入链的记录即该分钟唯一归约出的交接——与单跑全量得到的链一致，
 * 同时能拿到每个交接分钟「全部交接完成后」的持有人与该分钟归约出的记录集合，
 * 用于按分钟的最终在仓状态切分离仓区间。
 *
 * 注意：同一分钟内若在仓库再次分叉（如 仓库→甲、甲→仓库、仓库→乙 同时存在），
 * 持有人无法唯一确定，仍按既有规则判为 AMBIGUOUS 冲突，不会产生确定区间。
 *
 * @returns {{
 *   ok: boolean,
 *   chain: Array,                       // 冲突前（含冲突分钟已唯一归约部分）的全部链记录
 *   steps: Array<{minute:number, holder:string, added:Array}>, // 每个交接分钟完成后的状态
 *   conflict: object|null
 * }}
 */
function replayByMinute(records) {
  const chain = [];
  const steps = [];
  let conflict = null;

  for (let i = 0; i < records.length; ) {
    const minute = records[i].minute;
    let j = i;
    while (j < records.length && records[j].minute === minute) j += 1;

    const replay = replayPropRecords(records.slice(0, j));
    const added = replay.chain.slice(chain.length);
    chain.push(...added);
    steps.push({ minute, holder: replay.holder, added });

    if (!replay.ok) {
      conflict = replay.conflict;
      break;
    }
    i = j;
  }

  return { ok: !conflict, chain, steps, conflict };
}

/** 离仓区间结论 */
const INTERVAL = {
  RETURNED: 'RETURNED',           // 已归仓的闭合区间，时长未超阈值
  RETURNED_TIMEOUT: 'RETURNED_TIMEOUT', // 已归仓的闭合区间，时长严格超过阈值
  OPEN: 'OPEN',                   // 截至查询时刻仍未归仓，时长未超阈值
  OPEN_TIMEOUT: 'OPEN_TIMEOUT',   // 截至查询时刻仍未归仓，时长严格超过阈值（确定超时）
};

/** 无法判定（冲突时仍在仓外且冲突前时长未越过阈值） */
const UNDETERMINABLE = 'UNDETERMINABLE';

function recordRef(r) {
  return {
    id: r.id,
    minute: r.minute,
    from: r.from,
    to: r.to,
    note: r.note || '',
  };
}

function closedNote(startRec, endRec, duration, limit, timeout) {
  const tail = timeout
    ? `时长 ${duration} 分钟，已超过允许离仓 ${limit} 分钟（超过 ${duration - limit} 分钟），判定为离仓超时。`
    : `时长 ${duration} 分钟，未超过允许离仓 ${limit} 分钟，不算超时。`;
  const sameMinute = duration === 0
    ? '出仓与归仓发生在同一分钟（同分钟多次转手按最终在仓判定，时长 0 分钟）。'
    : '';
  return `第${startRec.minute}分钟道具由「${WAREHOUSE}」交给「${startRec.to}」离仓，` +
    `第${endRec.minute}分钟经 ${endRec.from} 交接重新归仓（记录 ${endRec.id}）；${tail}${sameMinute}`;
}

function openNote(startRec, duration, limit, timeout, endMinute) {
  const tail = timeout
    ? `截至查询时刻已离仓 ${duration} 分钟，已超过允许离仓 ${limit} 分钟（超过 ${duration - limit} 分钟），判定为确定超时。`
    : `截至查询时刻已离仓 ${duration} 分钟，未超过允许离仓 ${limit} 分钟，暂不算超时。`;
  return `第${startRec.minute}分钟道具由「${WAREHOUSE}」交给「${startRec.to}」离仓，` +
    `截至查询时刻（第${endMinute}分钟全部交接完成后）尚未归仓；${tail}`;
}

/**
 * 沿逐分钟轨迹，把交接链切成「离仓区间」。
 *
 * 每个交接分钟按该分钟全部交接完成后的持有人判定（同分钟多次转手只看最终在仓状态）：
 * - 持有人在该分钟离开仓库（步骤完成后持有人 ≠ 仓库，且本分钟存在 仓库→某人 的交接）
 *   时开启离仓区间；人员之间的转手不改变「仍在仓外」状态；
 * - 持有人在该分钟重新回到仓库时闭合区间（含同分钟出仓又归仓，时长 0）；
 * - 同一分钟内在唯一链上先归仓又再次出仓（如 仓库→甲→仓库→乙，链唯一）
 *   时，先闭合一个时长 0 区间，再开启新的开放区间；若该分钟在仓库处分叉
 *   导致链不唯一，则在重放阶段即判为冲突，不会进入这里。
 *
 * @param {Array} steps replayByMinute 的逐分钟轨迹
 * @param {number} endMinute 开放区间的计时终点（查询时刻 = 截止分钟；冲突时 = 冲突分钟）
 * @param {number} limit 允许离仓分钟数（阈值）
 * @returns {{intervals: Array, open: object|null}}
 */
function buildIntervals(steps, endMinute, limit) {
  const intervals = [];
  let current = null; // 当前开放离仓区间

  for (const step of steps) {
    const leftWarehouse = step.added.some((x) => x.from === WAREHOUSE);
    const backWarehouse = step.added.some((x) => x.to === WAREHOUSE);

    if (leftWarehouse) {
      // 该分钟有从仓库交出：开启新的离仓区间（上一轮往返若已归仓则 current 已清空）
      const startRec = step.added.find((x) => x.from === WAREHOUSE);
      current = { startMinute: step.minute, startRecord: recordRef(startRec), records: [] };
    }
    if (current) current.records.push(...step.added.map(recordRef));

    if (current && backWarehouse) {
      // 该分钟交接完成后重新入仓：闭合区间（含同分钟出仓又归仓，时长 0）
      const endRec = step.added.filter((x) => x.to === WAREHOUSE).pop();
      const duration = step.minute - current.startMinute;
      const timeout = duration > limit;
      intervals.push({
        status: timeout ? INTERVAL.RETURNED_TIMEOUT : INTERVAL.RETURNED,
        startMinute: current.startMinute,
        endMinute: step.minute,
        duration,
        limit,
        overdue: timeout,
        closed: true,
        openEnded: false,
        startRecord: current.startRecord,
        endRecord: recordRef(endRec),
        records: current.records,
        note: closedNote(current.startRecord, recordRef(endRec), duration, limit, timeout),
      });
      current = null;
    }
  }

  let open = null;
  if (current) {
    // 轨迹走完仍未归仓：区间开放，截至 endMinute 计时
    const duration = endMinute - current.startMinute;
    const timeout = duration > limit;
    open = {
      status: timeout ? INTERVAL.OPEN_TIMEOUT : INTERVAL.OPEN,
      startMinute: current.startMinute,
      endMinute: null,
      asOfMinute: endMinute,
      duration,
      limit,
      overdue: timeout,
      closed: false,
      openEnded: true,
      startRecord: current.startRecord,
      endRecord: null,
      records: current.records,
      note: openNote(current.startRecord, duration, limit, timeout, endMinute),
    };
  }

  return { intervals, open };
}

/**
 * 执行一次道具连续离仓超时排查。
 *
 * @param {{props: Array, records: Array}} data 当前数据（只读）
 * @param {number} cutoffMinute 截止分钟（含）：只重放该分钟及以前的记录
 * @param {number} limit 允许离仓分钟数（阈值）；时长严格大于阈值才算超时
 * @returns {object} 排查结果（只读）
 */
function checkAwayTimeouts(data, cutoffMinute, limit) {
  if (!Number.isInteger(cutoffMinute) || cutoffMinute < 0) {
    const err = new Error('截止分钟必须是不小于 0 的整数');
    err.code = 'BAD_REQUEST';
    throw err;
  }
  if (!Number.isInteger(limit) || limit < 0) {
    const err = new Error('允许离仓分钟数必须是不小于 0 的整数');
    err.code = 'BAD_REQUEST';
    throw err;
  }

  const props = [...(data.props || [])].sort((a, b) =>
    String(a.id).localeCompare(String(b.id))
  );
  const allRecords = data.records || [];

  const propsResult = [];
  const undeterminable = [];
  let totalIntervals = 0;
  let overdueIntervals = 0;
  let undeterminableCount = 0;
  let conflictPropCount = 0;

  for (const prop of props) {
    const propRecords = sortRecords(
      allRecords.filter((r) => r.propId === prop.id && Number(r.minute) <= cutoffMinute)
    );
    const replay = replayByMinute(propRecords);

    const base = {
      intervals: [],
      openInterval: null,
      conflict: null,
      undeterminableInterval: null,
    };

    let built;
    if (!replay.ok) {
      // 截止时刻内发生链冲突：只保留冲突前可确定的区间。
      // steps 已包含冲突分钟内唯一归约的前缀，开放区间按冲突分钟计时。
      built = buildIntervals(replay.steps, replay.conflict.minute, limit);
      base.conflict = {
        minute: replay.conflict.minute,
        type: replay.conflict.type,
        reason: replay.conflict.reason,
        records: replay.conflict.records,
        recordRefs: replay.conflict.recordRefs,
      };
      conflictPropCount += 1;
      if (built.open) {
        if (built.open.overdue) {
          // 冲突前已越过阈值：仍列为确定超时；冲突后的时长无法判定
          built.open.confirmedOverdueBeforeConflict = true;
          built.open.note +=
            `第${replay.conflict.minute}分钟交接链冲突（` +
            `${replay.conflict.type === 'AMBIGUOUS' ? '多条可接续记录，交接链不唯一' : '剩余记录无法接续，交接链断裂'}）` +
            `——冲突前该区间已确定离仓 ${built.open.duration} 分钟、超过允许的 ${limit} 分钟，` +
            '仍列为确定超时；冲突之后是否归仓、最终时长均无法判定。';
        } else {
          // 冲突前未越过阈值：整个区间标为无法判定，不计入确定区间与超时
          undeterminable.push({
            propId: prop.id,
            propName: prop.name,
            kind: UNDETERMINABLE,
            startMinute: built.open.startMinute,
            asOfMinute: replay.conflict.minute,
            durationBeforeConflict: built.open.duration,
            limit,
            startRecord: built.open.startRecord,
            records: built.open.records,
            conflict: base.conflict,
            note:
              `道具自第${built.open.startMinute}分钟由「${WAREHOUSE}」交给` +
              `「${built.open.startRecord.to}」后离仓，第${replay.conflict.minute}分钟交接链冲突前` +
              `已确定离仓 ${built.open.duration} 分钟（未超过允许的 ${limit} 分钟）；` +
              '冲突使该分钟起的持有人无法判定，道具是否已归仓、离仓总时长均无法判定，' +
              '故该区间是否超时无法判定（冲突前的时长本身不构成超时）。',
          });
          undeterminableCount += 1;
          base.undeterminableInterval = undeterminable[undeterminable.length - 1];
          built.open = null; // 不计入确定区间
        }
      }
    } else {
      // 链可完整重放（冲突若有也晚于截止时刻，不在本次窗口内）：截至查询时刻计时
      built = buildIntervals(replay.steps, cutoffMinute, limit);
    }

    for (const iv of built.intervals) {
      iv.propId = prop.id;
      iv.propName = prop.name;
    }
    if (built.open) {
      built.open.propId = prop.id;
      built.open.propName = prop.name;
    }

    base.intervals = built.intervals;
    base.openInterval = built.open;
    totalIntervals += base.intervals.length + (base.openInterval ? 1 : 0);
    overdueIntervals +=
      base.intervals.filter((iv) => iv.overdue).length + (base.openInterval && base.openInterval.overdue ? 1 : 0);

    propsResult.push({
      propId: prop.id,
      propName: prop.name,
      intervals: base.intervals,
      openInterval: base.openInterval,
      conflict: base.conflict,
      undeterminableInterval: base.undeterminableInterval
        ? {
            kind: UNDETERMINABLE,
            startMinute: base.undeterminableInterval.startMinute,
            asOfMinute: base.undeterminableInterval.asOfMinute,
            durationBeforeConflict: base.undeterminableInterval.durationBeforeConflict,
            startRecord: base.undeterminableInterval.startRecord,
            conflictMinute: base.conflict.minute,
            conflictType: base.conflict.type,
            note: base.undeterminableInterval.note,
          }
        : null,
      recordsInWindow: propRecords.length,
      replayedCount: replay.chain.length,
    });
  }

  return {
    warehouse: WAREHOUSE,
    cutoffMinute,
    limit,
    queryMinute: cutoffMinute,
    totalProps: props.length,
    totalIntervals,
    overdueIntervals,
    conflictPropCount,
    undeterminableCount,
    hasTimeout: overdueIntervals > 0,
    props: propsResult,
    undeterminable,
    rev: data.rev,
    readOnly: true,
  };
}

module.exports = {
  INTERVAL,
  UNDETERMINABLE,
  checkAwayTimeouts,
};
