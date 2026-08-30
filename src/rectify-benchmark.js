/**
 * rectify-benchmark.js — 定盘准确率批量测试
 * 随机生成 (日期, 真实时辰)，用真实时辰的盘模拟用户作答（含噪声），
 * 统计定盘结果命中率。
 * 用法：node src/rectify-benchmark.js [样本数] [噪声率]
 */
const rect = require('./rectify.js');

function run(n = 15, noise = 0.15) {
  let seed = 20260830;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let exact = 0, near = 0, total = 0;
  const qUsed = [];
  const rows = [];

  for (let i = 0; i < n; i++) {
    const y = 1965 + Math.floor(rnd() * 40);
    const m = 1 + Math.floor(rnd() * 12);
    const dmax = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const d = 1 + Math.floor(rnd() * dmax);
    const dateStr = `${y}-${m}-${d}`;
    const gender = rnd() > 0.5 ? '男' : '女';
    const truthHour = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22][Math.floor(rnd() * 12)];

    const session = rect.createSession({ dateStr, gender, city: null });
    const truth = session.candidates.find(c => c.hour === truthHour)
      || { profiles: {}, decadal: [] , astrolabe: { fiveElementsClass: '土五局' } };
    // 真实盘不在候选集（晚子时）时跳过
    if (!truth.profiles || !Object.keys(truth.profiles).length) continue;

    let q, steps = 0;
    while ((q = rect.nextQuestion(session)) !== null && steps < rect.PARAMS.maxQuestions) {
      steps++;
      let ans;
      if (q.type === 'decadal') {
        const k = rect.decadalAtAge(truth, q.probeAge).topicKey;
        ans = rnd() < noise ? 'unsure' : k;
      } else {
        const act = (truth.profiles[q.year]?.[q.dim] ?? 0) >= rect.PARAMS.activeThreshold;
        ans = rnd() < noise ? 'unsure' : (act ? 'yes' : 'no');
      }
      rect.answerQuestion(session, q, ans);
    }
    total++;
    const gotHour = session.result ? session.result.hour : null;
    if (gotHour === truthHour) exact++;
    if (gotHour != null && Math.abs(gotHour - truthHour) <= 2) near++;
    qUsed.push(session.asked.length);
    rows.push(`${dateStr} ${gender} 真实${truthHour}时 → 定盘${gotHour}时 (${session.result ? (session.result.posterior * 100).toFixed(0) + '%' : '未收敛'}, ${session.asked.length}题) ${gotHour === truthHour ? '✅' : Math.abs(gotHour - truthHour) <= 2 ? '🟡' : '❌'}`);
  }

  console.log(`定盘准确率测试（n=${total}，作答噪声 ${(noise * 100).toFixed(0)}%）\n`);
  rows.forEach(r => console.log('  ' + r));
  const avgQ = (qUsed.reduce((a, b) => a + b, 0) / qUsed.length).toFixed(1);
  console.log(`\n完全命中: ${exact}/${total} (${(exact / total * 100).toFixed(0)}%) | ±1时辰内: ${near}/${total} (${(near / total * 100).toFixed(0)}%) | 平均提问 ${avgQ} 题`);
}

run(Number(process.argv[2] || 15), Number(process.argv[3] || 0.15));
