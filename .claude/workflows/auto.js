export const meta = {
  name: 'auto',
  description: 'Авто-роутер lampa-stream: читает произвольный запрос, сам определяет нужных агентов (Сэм/Макс/Анна/Том/Ли) и режим (ответ / один спец / команда), затем выполняет.',
  whenToUse: 'Когда не хочешь думать, какого агента звать — просто опиши задачу в args, роутер сам разберётся.',
  phases: [
    { title: 'Route', detail: 'Классификатор определяет агентов и режим' },
    { title: 'Run', detail: 'Ответ / один спец / команда по зависимостям' },
  ],
}

const task = typeof args === 'string' ? args : (args && (args.task || args.feature)) || ''
if (!task) {
  throw new Error('Передай запрос: Workflow({ name: "auto", args: "твоё описание задачи" })')
}

// ---------- ФАЗА 1: КЛАССИФИКАЦИЯ ----------
phase('Route')
const ROUTE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['mode', 'agents', 'reasoning'],
  properties: {
    mode: {
      type: 'string', enum: ['answer', 'single', 'team'],
      description: 'answer=просто объяснить, код не трогать; single=один специалист правит код; team=фича через несколько слоёв',
    },
    agents: {
      type: 'array',
      description: 'Имена агентов в ПОРЯДКЕ зависимости (для team: backend→ipc→ui→player). Для answer — пустой. Для single — один элемент.',
      items: { type: 'string', enum: ['sam', 'max', 'anna', 'tom', 'lee'] },
    },
    reasoning: { type: 'string', description: 'Почему так (1-2 предложения)' },
  },
}

const route = await agent([
  'Ты — диспетчер команды lampa-stream. Реши, кто должен обработать запрос.',
  '',
  'Запрос пользователя:',
  `"${task}"`,
  '',
  'Слои команды:',
  '- sam (Сэм, backend): api/, server/, src/utils/*-client.js — источники, HTTP-клиенты, парсинг',
  '- max (Макс, Electron/IPC): index.js, preload.js, src/ipc/ — IPC-мост, окна, безопасность',
  '- anna (Анна, UI): src/pages, src/components, src/styles — React-интерфейс',
  '- tom (Том, player): OnlinePlayer/TorrPlayer, aniSkip, subtitles — dash.js/hls.js, дорожки',
  '- lee (Ли, QA): сборка, тесты, дистрибутивы — НЕ пишет фичи',
  '',
  'Правила:',
  '1. Если запрос — вопрос/объяснение без правки кода → mode=answer, agents=[].',
  '2. Если правка в одном слое → mode=single, agents=[один].',
  '3. Если фича требует стыка слоёв (напр. UI + новый IPC + backend) → mode=team, agents в порядке зависимости: sam → max → anna → tom (только нужные, omit lee — он добавится автоматически на verify).',
  '4. lee НЕ клади в agents для team (он зовётся отдельно на verify). Для single-задачи про сборку/CI — lee ок.',
  '5. Плеер/медиа в запросе → включи tom.',
].join('\n'), { label: 'router', phase: 'Route', schema: ROUTE_SCHEMA })

log(`Роутер: mode=${route.mode}, agents=[${(route.agents||[]).join(', ')}] — ${route.reasoning}`)

// ---------- ФАЗА 2: ВЫПОЛНЕНИЕ ----------
phase('Run')
const TYPE = { sam: 'sam-backend', max: 'max-electron', anna: 'anna-frontend', tom: 'tom-player', lee: 'lee-qa' }
const NAME = { sam: 'Сэм', max: 'Макс', anna: 'Анна', tom: 'Том', lee: 'Ли' }

// --- answer: просто ответить ---
if (route.mode === 'answer' || !route.agents || route.agents.length === 0) {
  const answer = await agent([
    'Ответь на запрос пользователя по lampa-stream. Код не правь — только объясни/подсказка/план. Кратко и по делу.',
    `Запрос: "${task}"`,
  ].join('\n'), { label: 'answer', phase: 'Run' })
  return { route, mode: 'answer', answer }
}

// --- single: один специалист ---
if (route.mode === 'single' && route.agents.length === 1) {
  const key = route.agents[0]
  log(`Один специалист: ${NAME[key]}`)
  const report = await agent([
    `Запрос: "${task}"`,
    `Ты — ${NAME[key]}. Реализуй в своей зоне, проверь синтаксис/сборку. Верни отчёт.`,
  ].join('\n'), { label: `run:${key}`, phase: 'Run', agentType: TYPE[key], schema: {
    type: 'object', additionalProperties: false, required: ['status', 'changed', 'notes'],
    properties: {
      status: { type: 'string', enum: ['done', 'blocked', 'partial'] },
      changed: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string' },
    },
  } })
  return { route, mode: 'single', report }
}

// --- team: план параллельно → реализация последовательно → Ли verify ---
const team = route.agents.filter(a => a !== 'lee')
const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'files', 'contracts', 'openQuestions'],
  properties: {
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    contracts: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['name', 'shape', 'forWhom'], properties: {
        name: { type: 'string' }, shape: { type: 'string' }, forWhom: { type: 'string' } } } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

const plans = await parallel(team.map(key => () =>
  agent([
    `Фича: "${task}". Спланируй свою часть (только свой слой, без кода). Опиши файлы и контракты на стыках со соседями.`,
  ].join('\n'), { label: `plan:${key}`, phase: 'Run', agentType: TYPE[key], schema: PLAN_SCHEMA })
    .then(p => ({ key, plan: p }))
))
const planMap = {}
for (const p of plans.filter(Boolean)) planMap[p.key] = p.plan
const allContracts = Object.values(planMap).flatMap(p => (p.contracts || []).map(c => `- ${c.name} (${c.forWhom}): ${c.shape}`)).join('\n')
const planBrief = Object.entries(planMap).map(([k, p]) => `### ${k}\n${p.summary}\nФайлы: ${(p.files||[]).join(', ')||'—'}\nВопросы: ${(p.openQuestions||[]).join('; ')||'—'}`).join('\n\n')
log(`Планы: ${Object.keys(planMap).join(', ')}`)

const REPORT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['status', 'changed', 'notes'],
  properties: {
    status: { type: 'string', enum: ['done', 'blocked', 'partial'] },
    changed: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}
const reports = {}
for (const key of team) {
  log(`Реализует: ${NAME[key]}`)
  const ctx = [
    `Фича: "${task}"`, '', 'Объединённый план:', planBrief, '',
    'Контракты на стыках:', allContracts || '(нет)', '',
    ...Object.entries(reports).map(([k, r]) => `Отчёт ${k}: ${r.status} — ${r.notes}`),
    '', `Ты — ${NAME[key]}. Реализуй свою часть, держи контракты, проверь сборку в своей зоне.`,
  ].join('\n')
  const r = await agent(ctx, { label: `impl:${key}`, phase: 'Run', agentType: TYPE[key], schema: REPORT_SCHEMA })
  reports[key] = r || { status: 'blocked', changed: [], notes: 'нет отчёта' }
  if (r && r.status === 'blocked') { log(`${NAME[key]} заблокирован: ${r.notes}`); break }
}

const implSummary = Object.entries(reports).map(([k, r]) => `- ${k}: ${r.status} — ${(r.changed||[]).join(', ')||'—'} :: ${r.notes}`).join('\n')
const qa = await agent([
  'Команда реализовала фичу. Проверь сборку и целостность.',
  `Фича: "${task}"`, '', 'Отчёты:', implSummary, '',
  'Ты — Ли (QA). npm run build, node -c index.js && node -c preload.js, smoke npm start если можно. Не правь фичи — верни вердикт и виновника.',
].join('\n'), { label: 'verify:lee', phase: 'Run', agentType: 'lee-qa', schema: {
  type: 'object', additionalProperties: false, required: ['verdict', 'buildOk', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['GREEN', 'RED'] },
    buildOk: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['where','owner','detail'], properties: {
      where: { type: 'string' }, owner: { type: 'string' }, detail: { type: 'string' } } } },
  },
} })

return { route, mode: 'team', plans: planMap, reports, qa }
