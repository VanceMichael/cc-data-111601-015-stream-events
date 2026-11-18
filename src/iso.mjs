// ISO 8601 duration / DASH 片段时间线工具。
// 全部换算保留分子/分母（BigInt）形式，避免不同 timescale 之间的浮点误差，
// 原始字符串始终由调用方另行保留，这里只提供可复核的解释结果。

const UNIT_SECONDS = { W: 3024000n, D: 86400n, H: 3600n, M: 60n, S: 1n };

function gcd(a, b) { let x = a; let y = b; while (y) { [x, y] = [y, x % y]; } return x || 1n; }
function lcm(a, b) { return (a * b) / gcd(a, b); }

// 解析一个可能带小数的十进制部分，返回该部分的精确分数。
function decimalPart(text) {
  const [whole, fraction = ''] = text.split('.');
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole) * denominator + BigInt(fraction || '0');
  return { numerator, denominator };
}

// 仅支持周/日/时/分/秒（ISO 8601 时长，年月语义不固定，本交换子集不使用）。
export function parseDuration(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('iso_duration_required');
  const match = /^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match) throw new Error(`iso_duration:${value}`);
  const [, weeks, days, hours, minutes, seconds] = match;
  const groups = [[weeks, UNIT_SECONDS.W], [days, UNIT_SECONDS.D], [hours, UNIT_SECONDS.H],
    [minutes, UNIT_SECONDS.M], [seconds, UNIT_SECONDS.S]];
  if (groups.every(([part]) => part === undefined)) throw new Error(`iso_duration:${value}`);
  let numerator = 0n;
  let denominator = 1n;
  for (const [part, unitSeconds] of groups) {
    if (part === undefined) continue;
    const fraction = decimalPart(part);
    const common = lcm(denominator, fraction.denominator);
    numerator = numerator * (common / denominator)
      + fraction.numerator * (common / fraction.denominator) * unitSeconds;
    denominator = common;
  }
  const g = gcd(numerator, denominator);
  return { seconds: { numerator: numerator / g, denominator: denominator / g }, raw: value };
}

// 把秒级有理数乘以某个 timescale，得到该 timescale 下的 tick（BigInt）。
export function secondsToTicks(rational, timescale) {
  const scale = BigInt(timescale);
  const scaled = rational.numerator * scale;
  if (scaled % rational.denominator !== 0n) {
    return { quotient: scaled / rational.denominator, remainder: scaled % rational.denominator,
      divisor: rational.denominator, exact: false };
  }
  return { quotient: scaled / rational.denominator, remainder: 0n, divisor: 1n, exact: true };
}

// 任意 timescale 下的 tick 转秒级有理数。
export function ticksToSeconds(ticks, timescale) {
  const numerator = BigInt(ticks);
  const denominator = BigInt(timescale);
  const g = gcd(numerator, denominator);
  return { numerator: numerator / g, denominator: denominator / g };
}

export function rationalToDecimal(rational, digits = 6) {
  const whole = rational.numerator / rational.denominator;
  let remainder = rational.numerator % rational.denominator;
  let fraction = '';
  for (let i = 0; i < digits && remainder > 0n; i += 1) {
    remainder *= 10n;
    fraction += String(remainder / rational.denominator);
    remainder %= rational.denominator;
  }
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

// 持久化用：把 BigInt 有理数转成纯字符串/数字结构，计算用原始字段另行保留。
export function rationalRecord(rational) {
  return { numerator: rational.numerator.toString(),
    denominator: rational.denominator.toString(),
    seconds: rationalToDecimal(rational) };
}

export function parseInteger(value, label) {
  if (value === undefined || value === null || value === '') throw new Error(`${label}_required`);
  if (!/^-?\d+$/.test(String(value))) throw new Error(`${label}_integer`);
  return BigInt(value);
}

// 展开 SegmentTimeline 的 S t/d/r（r>=0），返回 [{t, d}] 的 tick 序列。
export function expandTimeline(entries, implicitStart) {
  const points = [];
  let next = null;
  for (const entry of entries) {
    const t = entry.t !== undefined ? parseInteger(entry.t, 'timeline_t')
      : (next ?? parseInteger(implicitStart, 'timeline_t'));
    const d = parseInteger(entry.d, 'timeline_d');
    const repeat = entry.r === undefined ? 0n : parseInteger(entry.r, 'timeline_r');
    if (repeat < 0n) throw new Error('timeline_r_negative');
    for (let i = 0n; i <= repeat; i += 1n) points.push({ t: t + d * i, d });
    next = t + d * (repeat + 1n);
  }
  return points;
}

// $Number$ / $RepresentationID$ 模板替换，$$ 为字面量 $。
export function applyTemplate(template, values) {
  return template.replace(/\$\$|\$(Number)(?:%(0\d+)d)?\$|\$(RepresentationID)\$/g,
    (match, number, width, representation) => {
      if (match === '$$') return '$';
      if (number) {
        const text = String(values.number);
        return width ? text.padStart(Number(width.slice(1)), '0') : text;
      }
      if (representation) return String(values.representationId ?? '');
      return match;
    });
}
