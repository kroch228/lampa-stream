export const meta = {
  name: 'feature-team',
  description: 'Команда lampa-stream: Сэм(backend)→Макс(IPC)→Анна(UI)→Том(player)→Ли(QA) реализуют фичу по зависимостям, план — параллельно.',
  whenToUse: 'Когда нужно реализовать фичу в lampa-stream, затрагивающую несколько слоёв (UI + backend + IPC). Передай описание фичи как args.',
  phases: [
    { title: 'Plan', detail: 'Сэм/Макс/Анна/Том параллельно планируют свой слой' },
    { title: 'Implement', detail: 'По зависимостям: backend → IPC → UI → player' },
    { title: 'Verify', detail: 'Ли прогоняет сборку и smoke-тест' },
  ],
}

// args = строка-описание фичи (или { feature: "..." })
const feature = typeof args === 'string' ? args : (args && args.feature) || ''
if (!feature) {
  throw new Error('Передай описание фичи: Workflow({ name: "feature-team", args: "добавить кнопку ..." })')
}

// Тома подключаем только если фича касается плеера/медиа
const PLAYER_RE = /player|плеер|stream|стрим|audio|аудио|subtitle|субтитр|dash|hls|аниме|аним|skip|опенинг|титр|торрент|torrent/i
const needsTom = PLAYER_RE.test(feature)

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'files', 'contracts', 'openQuestions'],
  properties: {
    summary: { type: 'string', description: 'Что именно делает этот слой для фичи (1-3 предложения)' },
    files: {
      type: 'array', items: { type: 'string' },
      description: 'Список файлов этого слоя, которые будут созданы/изменены',
    },
    contracts: {
      type: 'array',
      description: 'Контракты на стыке со соседями: новые IPC-каналы, методы window.electron, функции-клиенты, props/события плеера',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'shape', 'forWhom'],
        properties: {
          name: { type: 'string', description: 'Имя канала/метода/пропса' },
          shape: { type: 'string', description: 'args -> return, сигнатура' },
          forWhom: { type: 'string', description: 'Кто из соседей должен это пробросить/использовать (Макс/Анна/Сэм/Том)' },
        },
      },
    },
    openQuestions: {
      type: 'array', items: { type: 'string' },
      description: 'Вопросы/риски, которые требуют ответа до или во время реализации',
    },
  },
}

const REPORT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'changed', 'notes'],
  properties: {
    status: { type: 'string', enum: ['done', 'blocked', 'partial'] },
    changed: { type: 'array', items: { type: 'string' }, description: 'Изменённые файлы' },
    notes: { type: 'string', description: 'Что сделано, что передано соседям, что осталось' },
  },
}

// ---------- ФАЗА 1: ПЛАН (параллельно, read-only) ----------
phase('Plan')
const team = [
  { key: 'sam',  type: 'sam-backend',  prompt: `Фича: "${feature}". Как бэкенд lampa-stream должен её поддержать? Опиши: какие файлы в api/ server/ src/utils/*-client.js меняются, какие новые методы/клиенты нужны, и какие IPC-контракты потребуются рендереру (имя канала + args->return) для Макса. Не пиши код — только план.` },
  { key: 'max',  type: 'max-electron', prompt: `Фича: "${feature}". Какие новые/изменённые IPC-каналы и методы window.electron.* нужны? Какие файлы (index.js/preload.js/src/ipc/*) меняются? Учти contextIsolation. Не пиши код — только план + контракты для Сэма (что вызывать в main) и Анны (что звать из UI).` },
  { key: 'anna', type: 'anna-frontend', prompt: `Фича: "${feature}". Какие страницы/компоненты/стили меняются или создаются в src/pages src/components src/styles? Какие вызовы window.electron.* понадобятся (контракты для Макса)? Не пиши код — только план.` },
]
if (needsTom) {
  team.push({ key: 'tom', type: 'tom-player', prompt: `Фича: "${feature}". Что меняется в плеерах/медиа (OnlinePlayer/TorrPlayer/aniSkip/subtitles/introDetect)? Какие props/события плеера меняются (контракты для Анны)? Не пиши код — только план.` })
}

const plans = await parallel(team.map(t => () =>
  agent(t.prompt, { label: `plan:${t.key}`, phase: 'Plan', agentType: t.type, schema: PLAN_SCHEMA })
    .then(p => ({ key: t.key, plan: p }))
))
const planMap = {}
for (const p of plans.filter(Boolean)) planMap[p.key] = p.plan

const allContracts = Object.values(planMap)
  .flatMap(p => (p.contracts || []).map(c => `- ${c.name} (${c.forWhom}): ${c.shape}`))
  .join('\n')
const planBrief = Object.entries(planMap)
  .map(([k, p]) => `### ${k}\n${p.summary}\nФайлы: ${(p.files||[]).join(', ') || '—'}\nВопросы: ${(p.openQuestions||[]).join('; ') || '—'}`)
  .join('\n\n')
log(`Планы готовы: ${Object.keys(planMap).join(', ')}. Контракты:\n${allContracts || '(нет)'}`)

// ---------- ФАЗА 2: РЕАЛИЗАЦИЯ (последовательно по зависимостям) ----------
phase('Implement')
// Порядок зависимостей: backend → IPC-мост → UI → player. Каждый получает
// объединённый план + отчёты предыдущих, чтобы работать по согласованному контракту.
const order = ['sam', 'max', 'anna', ...(needsTom ? ['tom'] : [])]
const reports = {}
const ctx = (role) => [
  `Фича: "${feature}"`,
  '',
  'Объединённый план команды:',
  planBrief,
  '',
  'Контракты на стыках (держись их):',
  allContracts || '(нет)',
  '',
  ...Object.entries(reports).map(([k, r]) => `Отчёт ${k}: ${r.status} — ${r.notes} (изменено: ${(r.changed||[]).join(', ')||'—'})`),
  '',
  `Ты — ${role}. Реализуй свою часть по плану, держи контракты со соседями. После правок проверь синтаксис/сборку в своей зоне. Верни отчёт.`,
].join('\n')

for (const key of order) {
  const typeMap = { sam: 'sam-backend', max: 'max-electron', anna: 'anna-frontend', tom: 'tom-player' }
  const roleName = { sam: 'Сэм (backend)', max: 'Макс (IPC)', anna: 'Анна (UI)', tom: 'Том (player)' }[key]
  log(`Реализует: ${roleName}`)
  const r = await agent(ctx(roleName), {
    label: `impl:${key}`, phase: 'Implement', agentType: typeMap[key], schema: REPORT_SCHEMA,
  })
  reports[key] = r || { status: 'blocked', changed: [], notes: 'агент не вернул отчёт' }
  if (r && r.status === 'blocked') {
    log(`${roleName} заблокирован: ${r.notes}. Останавливаю реализацию.`)
    break
  }
}

// ---------- ФАЗА 3: ВЕРИФИКАЦИЯ (Ли) ----------
phase('Verify')
const implSummary = Object.entries(reports)
  .map(([k, r]) => `- ${k}: ${r.status} — ${(r.changed||[]).join(', ')||'—'} :: ${r.notes}`)
  .join('\n')
const lee = await agent([
  'Только что команда реализовала фичу. Проверь сборку и целостность.',
  `Фича: "${feature}"`,
  '',
  'Отчёты реализации:',
  implSummary,
  '',
  'Ты — Ли (QA). Прогони npm run build, проверь синтаксис node -c index.js && node -c preload.js, и (если возможно) smoke npm start. Не правь фичи — если билд падает, определи слой-виновник и верни точную ошибку файл:строка.',
].join('\n'), { label: 'verify:lee', phase: 'Verify', agentType: 'lee-qa', schema: {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'buildOk', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['GREEN', 'RED'] },
    buildOk: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['where','owner','detail'], properties: {
      where: { type: 'string' }, owner: { type: 'string', description: 'sam/max/anna/tom' }, detail: { type: 'string' },
    } } },
  },
} })

return {
  feature,
  plans: planMap,
  reports,
  qa: lee,
}
