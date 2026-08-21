import type { PetRuntimeTrigger } from './pet-behavior-module'

export interface PetScheduleOccurrence {
  key: string
  dueAt: number
  expiresAt: number
}

type ScheduleTrigger = Extract<PetRuntimeTrigger, { type: 'schedule' }>
type DailyWindowTrigger = Extract<PetRuntimeTrigger, { type: 'daily-window' }>
type CalendarTrigger = Pick<ScheduleTrigger, 'dates' | 'weekdays'>

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

export function findDuePetScheduleOccurrence(
  trigger: ScheduleTrigger,
  now: number,
): PetScheduleOccurrence | undefined {
  const current = new Date(now)

  // catchUpMs 可跨过午夜，因此向前检查它实际覆盖的日期；每个 occurrence 仍只消费一次。
  const coveredDays = Math.ceil(trigger.catchUpMs / DAY_MS)

  for (let dayOffset = 0; dayOffset >= -coveredDays; dayOffset--) {
    const day = new Date(
      current.getFullYear(),
      current.getMonth(),
      current.getDate() + dayOffset,
    )

    if (!matchesScheduleDate(trigger, day)) continue

    const dueAt = strictLocalTimeOnDay(day, trigger.time, 0)

    // 精确日程和日窗口共用严格本地时间语义；DST 缺失时刻当天不补到另一个钟点。
    if (dueAt === undefined) continue
    // 扫描按分钟边界后移 10ms；catchUpMs=0 仍应代表“本分钟触发”，否则永远错过精确时刻。
    const expiresAt = dueAt + Math.max(trigger.catchUpMs, MINUTE_MS - 1)

    // 到期窗口统一使用 [dueAt, expiresAt)，让相邻扫描在 expiresAt 边界只由后一状态处理，避免重复触发。
    if (now < dueAt || now >= expiresAt) continue

    return {
      key: `${trigger.id}:${formatLocalDate(day)}:${trigger.time}`,
      dueAt,
      expiresAt,
    }
  }
}

export function findDuePetDailyWindowOccurrence(
  trigger: DailyWindowTrigger,
  now: number,
  sampleFraction: number,
): PetScheduleOccurrence | undefined {
  assertDailyWindowSampleFraction(sampleFraction)

  const current = new Date(now)
  // 跨午夜窗口在次日仍归属于开始日；额外回看一天才能在凌晨找到前一晚的 occurrence。
  const coveredDays = Math.ceil(trigger.catchUpMs / DAY_MS) + 1

  for (let dayOffset = 0; dayOffset >= -coveredDays; dayOffset--) {
    const startDay = new Date(
      current.getFullYear(),
      current.getMonth(),
      current.getDate() + dayOffset,
    )

    if (!matchesScheduleDate(trigger, startDay)) continue

    const projection = projectPetDailyWindow(trigger, startDay)

    // DST spring-forward 会让某些本地时刻不存在；当天跳过，不接受 Date 的自动归一化。
    if (!projection) continue

    const { endAt } = projection
    // sampleFraction 由控制器按 occurrence 固定采样；helper 只做纯日历投影，重复扫描不会漂移。
    const dueAt = projectSampledDailyDueAt(projection, sampleFraction)
    // 最低一分钟容错匹配 scheduler 的分钟扫描，同时 clamp 防止补触发越过行为窗口。
    const expiresAt = Math.min(
      endAt,
      dueAt + Math.max(trigger.catchUpMs, MINUTE_MS - 1),
    )

    // 日窗口同样保持右端开区间；恰好到 expiresAt 已经不再属于本次 occurrence。
    if (now < dueAt || now >= expiresAt) continue

    return {
      key: `${trigger.id}:${formatLocalDate(startDay)}:${trigger.startTime}-${trigger.endTime}`,
      dueAt,
      expiresAt,
    }
  }
}

export function samplePetDailyWindowDueAt(
  trigger: DailyWindowTrigger,
  startDay: Date,
  sampleFraction: number,
) {
  assertDailyWindowSampleFraction(sampleFraction)

  const projection = projectPetDailyWindow(trigger, startDay)

  if (!projection) return undefined

  return projectSampledDailyDueAt(projection, sampleFraction)
}

export function delayUntilNextScheduleScan(now: number) {
  // 对齐下一分钟并略加 10ms，避免系统计时误差让回调仍落在上一分钟。
  return MINUTE_MS - (now % MINUTE_MS) + 10
}

function matchesScheduleDate(trigger: CalendarTrigger, date: Date) {
  // 配置使用更符合文档习惯的 1=Monday…7=Sunday，避免暴露 Date.getDay() 的 Sunday=0 特例。
  const weekday = date.getDay() === 0 ? 7 : date.getDay()

  if (trigger.weekdays && !trigger.weekdays.includes(weekday)) return false
  if (!trigger.dates || trigger.dates.length === 0) return true

  const fullDate = formatLocalDate(date)
  const annualDate = `*-${fullDate.slice(5)}`

  return trigger.dates.includes(fullDate) || trigger.dates.includes(annualDate)
}

function projectPetDailyWindow(trigger: DailyWindowTrigger, startDay: Date) {
  const startMinutes = localTimeMinutes(trigger.startTime)
  const endMinutes = localTimeMinutes(trigger.endTime)
  // 跨午夜由配置的墙钟分钟决定，不能用已被 DST 归一化的 Date 比较。
  const crossesMidnight = endMinutes <= startMinutes
  const startAt = strictLocalTimeOnDay(startDay, trigger.startTime, 0)
  const endAt = strictLocalTimeOnDay(startDay, trigger.endTime, crossesMidnight ? 1 : 0)

  if (startAt === undefined || endAt === undefined || endAt <= startAt) return undefined

  return { startAt, endAt }
}

function projectSampledDailyDueAt(
  projection: { startAt: number, endAt: number },
  sampleFraction: number,
) {
  // 到期点至少给分钟扫描留出完整容错；短至一分钟的窗口因此固定落在起点，
  // 避免采到末端 59.999s 后仅因 timer 晚几毫秒就永久错过当天事件。
  const latestDueAt = Math.max(
    projection.startAt,
    projection.endAt - (MINUTE_MS - 1),
  )

  return projection.startAt
    + Math.floor((latestDueAt - projection.startAt) * sampleFraction)
}

function assertDailyWindowSampleFraction(sampleFraction: number) {
  if (typeof sampleFraction !== 'number'
    || !Number.isFinite(sampleFraction)
    || sampleFraction < 0
    || sampleFraction >= 1) {
    throw new RangeError('Daily window sampleFraction must be between 0 (inclusive) and 1 (exclusive)')
  }
}

function strictLocalTimeOnDay(day: Date, time: string, dayOffset: number) {
  const [hours, minutes] = time.split(':').map(Number)
  // 先用 UTC 只做无 DST 的日历进位，再构造本地时间并逐字段反验；这样既能跨月，也能识别春季跳时。
  const expectedUtc = new Date(Date.UTC(
    day.getFullYear(),
    day.getMonth(),
    day.getDate() + dayOffset,
  ))
  const year = expectedUtc.getUTCFullYear()
  const month = expectedUtc.getUTCMonth()
  const date = expectedUtc.getUTCDate()
  const candidate = new Date(year, month, date, hours, minutes)

  if (candidate.getFullYear() !== year
    || candidate.getMonth() !== month
    || candidate.getDate() !== date
    || candidate.getHours() !== hours
    || candidate.getMinutes() !== minutes) {
    return undefined
  }

  return candidate.getTime()
}

function localTimeMinutes(time: string) {
  const [hours, minutes] = time.split(':').map(Number)

  return hours * 60 + minutes
}

function formatLocalDate(date: Date) {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

export const PET_MAX_SCHEDULE_CATCH_UP_MS = DAY_MS
