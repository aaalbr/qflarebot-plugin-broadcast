import { definePlugin, type PluginContext } from '@qqbot/sdk'

/**
 * 群发 / 定时发送插件。
 *
 * 配额设计（对照 plugin-guide 第 9 节的免费版硬预算）：
 * - 所有命令只在「单聊 + Bot 管理员」下可用：`scenes: ['c2c']` + `permission: 'bot_admin'`。
 * - 列表与定时任务存 D1。写入只发生在用户主动操作时（建/改列表、建/删任务），
 *   每分钟的 cron 调度只读；一次性定时任务发完即删，不会造成「随消息数增长」的写入，
 *   也不碰 KV 每天 1000 次写的上限。
 * - 群发是主动消息：一次事件内子请求上限 50、处理总时长 30 秒，逐群 await 会很快撞墙，
 *   所以用 `maxPerSend` 限制单次发送群数（默认 50），需要发更多就分批调用。
 * - 定时用【北京时间 · 一次性】的 `月:日:时:分`：创建时换算成 UTC 时间戳存 `fire_at`，
 *   内置的每分钟 cron 判断 `fire_at <= now`，命中就发送并删除该任务。仅设置当年，已过或跨年一律提示不可用。
 * - 「所有群聊」用一个内置保留列表 `@all` 表示：管理员把全部群 id 放进 @all，
 *   发送时不填群参数即发 @all。平台 v2 API 无法从单聊枚举机器人的全部群，故采用该约定。
 */

export interface Config {
  /** 发送时每个目标群之间的间隔（毫秒），避免瞬间刷爆主动消息额度 */
  intervalMs: number
  /** 单次发送最多推的群数（防误发 + 防顶爆 50 子请求/30 秒），0 表示不限制 */
  maxPerSend: number
}

/** 「所有群聊」的保留列表名 */
const ALL_LIST = '@all'

// ---------- 定时任务结构 ----------

interface JobRow {
  id: number
  /** 目标触发时刻（UTC 毫秒时间戳），一次性 */
  fire_at: number
  content: string
  /** 逗号分隔的群 openid；空串表示所有群聊（@all） */
  groups: string
}

// ---------- 北京时间工具 ----------

/** 北京时间相对 UTC 的固定偏移：+8 小时 */
const BJ_OFFSET_MS = 8 * 60 * 60 * 1000

/** 当前北京时间对应的 UTC 毫秒数 */
function bjNowMs(now = Date.now()): number {
  return now + BJ_OFFSET_MS
}

/** 把「北京时间 月:日:时:分」解析成 UTC 时间戳；格式/范围/当年/已过均在此校验 */
function parseBeijingMdh(
  text: string,
  now = Date.now(),
): { ok: true; fireAt: number } | { ok: false; reason: string } {
  const t = text.trim()
  const m = /^(\d{1,2}):(\d{1,2}):(\d{1,2}):(\d{1,2})$/.exec(t)
  if (!m) return { ok: false, reason: '格式不对：要用「月:日:时:分」，如 10:15:09:30（北京时间）' }

  const month = Number(m[1])
  const day = Number(m[2])
  const hour = Number(m[3])
  const minute = Number(m[4])

  if (month < 1 || month > 12) return { ok: false, reason: `月份 ${month} 超出 1-12` }
  if (hour < 0 || hour > 23) return { ok: false, reason: `小时 ${hour} 超出 0-23` }
  if (minute < 0 || minute > 59) return { ok: false, reason: `分钟 ${minute} 超出 0-59` }

  // 判断「当年」：用当前北京时间所在的年份
  const year = new Date(bjNowMs(now)).getUTCFullYear()
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (day < 1 || day > daysInMonth) {
    return { ok: false, reason: `该月${month}月只有 ${daysInMonth} 天，日期 ${day} 不合法` }
  }

  // 构造北京时区下的目标时刻 → 转成 UTC 时间戳
  const fireAt = Date.UTC(year, month - 1, day, hour - 8, minute)
  // fire_at 必须严格大于当前时刻（已过或等于都算不可用）
  if (fireAt <= now) {
    return { ok: false, reason: `目标时间 ${t} 已经过去（北京时区），请设置在未来的时间` }
  }
  return { ok: true, fireAt }
}

/** 把 UTC 时间戳格式化成「北京时间 月:日:时:分」字符串（用于展示） */
function formatBeijing(ms: number): string {
  const d = new Date(ms + BJ_OFFSET_MS)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())}:${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

// ---------- 工具 ----------

/** 把逗号/中文逗号/空白分隔的一串 id 规整成去重数组 */
function splitIds(text: string): string[] {
  return [...new Set(text.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean))]
}

/** 读取某个列表内的群 id */
async function readListGroups(ctx: PluginContext<Config>, name: string): Promise<string[]> {
  const rows = await ctx.db.all<{ group_id: string }>(
    'SELECT group_id FROM {list_groups} WHERE list_name = ? ORDER BY group_id',
    name,
  )
  return rows.map((r) => r.group_id)
}

/**
 * 把 `/群发` 的 argText 拆成「内容」和「群参数」。
 *
 * 群参数在末尾且可选，规则：从 argText 的末尾向前收集连续 token，每个 token 只要满足
 * 「@all / 已知列表名 / 含逗号的 id 串」就并入群参数块，直到遇到不满足的为止；
 * 剩下的拼成内容。若没有任何可识别为群参数的尾部块，则整个 argText 都是内容，
 * 群参数为空串（即发 @all）。
 */
async function splitContentAndTarget(
  argText: string,
  ctx: PluginContext<Config>,
): Promise<{ content: string; targetSec: string }> {
  const trimmed = argText.trim()
  if (!trimmed) return { content: '', targetSec: '' }

  // 已知列表名集合（用于识别「列表名」token）
  const listRows = await ctx.db.all<{ name: string }>('SELECT name FROM {lists}')
  const known = new Set(listRows.map((r) => r.name))

  const tokens = trimmed.split(/\s+/)
  let idx = tokens.length - 1
  while (idx >= 0) {
    const t = tokens[idx]!
    const isList = t === ALL_LIST || known.has(t)
    const isIdRun = t.includes(',') || t.includes('，')
    if (isList || isIdRun) {
      idx--
      continue
    }
    break
  }

  // idx+1 处开始是群参数块
  const targetTokens = tokens.slice(idx + 1)
  const contentTokens = tokens.slice(0, idx + 1)
  return { content: contentTokens.join(' '), targetSec: targetTokens.join(' ') }
}

/**
 * 解析发送目标（sec 为用户输入的「群 id / 列表名 / @all」，可为空）：
 * - 空 → 所有群聊，即保留列表 @all 的内容
 * - 其他 → 先当作列表名查，查得到就返回列表内容；查不到再当作 id 列表拆
 * 返回 { ids } 或 { error }。
 */
async function resolveTargets(
  sec: string,
  ctx: PluginContext<Config>,
): Promise<{ ids: string[] } | { error: string }> {
  const t = sec.trim()
  const name = t === '' ? ALL_LIST : t

  const hasSep = /[,，\s]/.test(name)
  if (!hasSep) {
    const ids = await readListGroups(ctx, name)
    if (ids.length > 0) return { ids }
    // 查不到列表，但恰好是一个纯 id 样式，也当作单个群 id；否则报错
    if (t !== '') return { ids: [t] }
  }

  const ids = splitIds(t)
  if (ids.length === 0) {
    return {
      error:
        t === ''
          ? `「所有群聊」列表 ${ALL_LIST} 还没有内容，请先用 /列表 ${ALL_LIST} <群id…> 填充`
          : '目标解析为空',
    }
  }
  return { ids }
}

/** 执行发送，返回汇总文案 */
async function runSend(ctx: PluginContext<Config>, targets: string[], content: string): Promise<string> {
  const max = ctx.config.maxPerSend
  const list = max > 0 ? targets.slice(0, max) : targets

  const fail: Array<{ id: string; reason: string }> = []
  let ok = 0
  for (let i = 0; i < list.length; i++) {
    const id = list[i]!
    const r = await ctx.api.sendMessage({ scene: 'group', id }, content)
    if (r.ok) ok++
    else fail.push({ id, reason: r.error ?? `status ${r.status}` })
    if (ctx.config.intervalMs > 0) {
      await new Promise((res) => setTimeout(res, ctx.config.intervalMs))
    }
  }

  const overHint =
    max > 0 && targets.length > list.length ? `（还有 ${targets.length - list.length} 个群超出单次上限 ${max}，可再次 /群发）` : ''
  const lines = [`群发完成：成功 ${ok} / 失败 ${fail.length}（本次发送 ${list.length} 个群）。${overHint}`]
  for (const f of fail) lines.push(`· ${f.id}：${f.reason}`)
  return lines.join('\n')
}

export default definePlugin<Config>({
  name: 'broadcast',
  // 用了 ctx.db.batch()（契约版本 2 的能力），声明最低要求为 2；未用 v3 的任何能力
  apiVersion: 2,
  displayName: '群发助手',
  description: '群发与定时发送：管理群列表、/群发 立即推送、/定时 一次性定时推送',
  permissions: ['db', 'proactive'],

  configSchema: {
    type: 'object',
    properties: {
      intervalMs: {
        type: 'integer',
        title: '发送间隔（毫秒）',
        description: '每个目标群之间的发送间隔，避免瞬间刷爆主动消息额度。默认 500，0 表示不停顿。',
        default: 500,
        minimum: 0,
        maximum: 5000,
      },
      maxPerSend: {
        type: 'integer',
        title: '单次最多发送群数',
        description: '一条 /群发 或一次定时最多推送的群数。受 30 秒与 50 子请求限制，默认 50；0 表示不限制。',
        default: 50,
        minimum: 0,
        maximum: 100,
      },
    },
  },
  defaultConfig: { intervalMs: 500, maxPerSend: 50 },

  hooks: {
    async onInstall(ctx) {
      await ctx.db.exec(`
        CREATE TABLE IF NOT EXISTS {lists} (name TEXT PRIMARY KEY, ts INTEGER NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS {list_groups} (list_name TEXT NOT NULL, group_id TEXT NOT NULL, PRIMARY KEY (list_name, group_id)) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS {jobs} (id INTEGER PRIMARY KEY AUTOINCREMENT, fire_at INTEGER NOT NULL, content TEXT NOT NULL, groups TEXT NOT NULL, created_by TEXT NOT NULL, ts INTEGER NOT NULL);
      `)
    },
  },

  // 每分钟内部触发一次，由它分发到期的定时任务。
  // 只读不写：只用 `fire_at <= now` 过滤，命中极少的行；发送成功后删除该任务（一次性）。
  // 绝大多数时刻查询返回 0 行，CPU 与 D1 写入都极低。
  cron: {
    tick: {
      cron: '* * * * *',
      async handler({ ctx }) {
        const now = Date.now()
        const rows = await ctx.db.all<JobRow>('SELECT * FROM {jobs} WHERE fire_at <= ?', now)
        if (rows.length === 0) return
        const max = ctx.config.maxPerSend
        for (const job of rows) {
          // groups 空串 → 所有群聊（@all），否则逗号拆开
          const targets = job.groups === '' ? await readListGroups(ctx, ALL_LIST) : splitIds(job.groups)
          const list = max > 0 ? targets.slice(0, max) : targets
          let ok = 0
          for (let i = 0; i < list.length; i++) {
            const r = await ctx.api.sendMessage({ scene: 'group', id: list[i]! }, job.content)
            if (r.ok) ok++
            if (ctx.config.intervalMs > 0) {
              await new Promise((res) => setTimeout(res, ctx.config.intervalMs))
            }
          }
          ctx.logger.info(`定时任务 #${job.id} 发送 ${ok}/${list.length}`, { fire_at: job.fire_at })
          // 一次性：发完即删，避免重复触发与数据堆积
          await ctx.db.run('DELETE FROM {jobs} WHERE id = ?', job.id)
        }
      },
    },
  },

  commands: {
    列表: {
      scenes: ['c2c'],
      permission: 'bot_admin',
      description: '查看或创建/覆盖群列表',
      usage: '/列表 [列表名] [群会话id(逗号隔开)]',
      async handler({ ctx, args }) {
        const name = args[0]
        const groupsText = args.slice(1).join(' ')

        // 无参数：列出所有列表及群个数
        if (name === undefined) {
          const rows = await ctx.db.all<{ name: string }>('SELECT name FROM {lists} ORDER BY name')
          if (rows.length === 0) {
            return '还没有任何列表。\n用法：/列表 <名称> <群id逗号隔开> 创建；把全部群放进 @all 可支持不填群直发。'
          }
          const lines: string[] = []
          for (const r of rows) {
            const cnt = await ctx.db.first<{ n: number }>(
              'SELECT COUNT(*) AS n FROM {list_groups} WHERE list_name = ?',
              r.name,
            )
            lines.push(`· ${r.name}（${cnt?.n ?? 0} 个群）`)
          }
          return `共有 ${rows.length} 个列表：\n${lines.join('\n')}`
        }

        // 只有名字：查看该列表内的群
        if (!groupsText.trim()) {
          const ids = await readListGroups(ctx, name)
          return ids.length === 0
            ? `列表「${name}」不存在或为空。`
            : `列表「${name}」（${ids.length} 个群）：\n${ids.join('\n')}`
        }

        // 有名称 + 群id：整体覆盖该列表
        const ids = splitIds(groupsText)
        if (ids.length === 0) return '群会话 id 不能为空。'
        await ctx.db.batch([
          {
            sql: 'INSERT INTO {lists} (name, ts) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET ts = excluded.ts',
            params: [name, Date.now()],
          },
          { sql: 'DELETE FROM {list_groups} WHERE list_name = ?', params: [name] },
          ...ids.map((id) => ({
            sql: 'INSERT INTO {list_groups} (list_name, group_id) VALUES (?, ?)',
            params: [name, id],
          })),
        ])
        return `列表「${name}」已更新，共 ${ids.length} 个群。`
      },
    },

    群发: {
      scenes: ['c2c'],
      permission: 'bot_admin',
      description: '立即向群聊推送消息',
      usage: '/群发 <内容> [群id逗号隔开 | 列表名 | @all]',
      async handler({ ctx, argText }) {
        const { content, targetSec } = await splitContentAndTarget(argText, ctx)
        if (!content.trim()) {
          return '用法：/群发 <内容> [群id逗号隔开 | 列表名 | @all]（不填群默认发 @all）'
        }
        const resolved = await resolveTargets(targetSec, ctx)
        if ('error' in resolved) return resolved.error
        return runSend(ctx, resolved.ids, content)
      },
    },

    定时: {
      scenes: ['c2c'],
      permission: 'bot_admin',
      description: '创建定时发送（北京时间）',
      usage: '/定时 <月:日:时:分> <内容> [群id逗号隔开 | 列表名 | @all]',
      async handler({ ctx, argText, session }) {
        // 时间串紧跟命令，之后是「内容 + 群参数」
        const tokens = argText.trim().split(/\s+/).filter(Boolean)
        const timeStr = tokens[0]
        if (timeStr === undefined) {
          return '用法：/定时 <月:日:时:分> <内容> [群id…|列表名|@all]（北京时间，仅当年，例：10:15:09:30）'
        }
        const parsed = parseBeijingMdh(timeStr)
        if (!parsed.ok) return parsed.reason

        const rest = tokens.slice(1).join(' ')
        const { content, targetSec } = await splitContentAndTarget(rest, ctx)
        if (!content.trim()) return '内容不能为空。'
        const resolved = await resolveTargets(targetSec, ctx)
        if ('error' in resolved) return resolved.error

        // groups 存最终群 id 列表；targetSec 为空代表所有群聊，存空串
        const groups = targetSec.trim() === '' ? '' : resolved.ids.join(',')
        await ctx.db.run(
          'INSERT INTO {jobs} (fire_at, content, groups, created_by, ts) VALUES (?, ?, ?, ?, ?)',
          parsed.fireAt,
          content,
          groups,
          session.userId,
          Date.now(),
        )
        const info = await ctx.db.first<{ id: number }>('SELECT last_insert_rowid() AS id')
        const targetDesc = groups === '' ? `所有群聊（${ALL_LIST}）` : `${resolved.ids.length} 个群`
        const maxHint =
          ctx.config.maxPerSend > 0 && resolved.ids.length > ctx.config.maxPerSend
            ? `（注意：单次最多发送 ${ctx.config.maxPerSend} 个群，超出部分会被截断）`
            : ''
        return `已创建定时任务 #${info?.id ?? '?'}：${formatBeijing(parsed.fireAt)}（北京时间）→ ${targetDesc}${maxHint}`
      },
    },

    查定时: {
      scenes: ['c2c'],
      permission: 'bot_admin',
      description: '查看所有定时任务',
      usage: '/查定时',
      async handler({ ctx }) {
        const rows = await ctx.db.all<JobRow>('SELECT * FROM {jobs} ORDER BY fire_at')
        if (rows.length === 0) return '没有定时任务。'
        return rows
          .map((r) => {
            const t = r.groups === '' ? `所有群聊（${ALL_LIST}）` : `${r.groups.split(',').length} 个群`
            return `#${r.id} ${formatBeijing(r.fire_at)}（北京时间）→ ${t}：${r.content}`
          })
          .join('\n')
      },
    },

    删定时: {
      scenes: ['c2c'],
      permission: 'bot_admin',
      description: '删除定时任务',
      usage: '/删定时 <任务id>',
      async handler({ ctx, args }) {
        const id = Number(args[0])
        if (!Number.isInteger(id) || id <= 0) return '用法：/删定时 <任务id>（id 用 /查定时 查）'
        const res = await ctx.db.run('DELETE FROM {jobs} WHERE id = ?', id)
        return res.changes > 0 ? `已删除定时任务 #${id}。` : `没有 #${id} 这个任务。`
      },
    },

    删列表: {
      scenes: ['c2c'],
      permission: 'bot_admin',
      description: '删除一个群列表',
      usage: '/删列表 <列表名>',
      async handler({ ctx, args }) {
        const name = args[0]
        if (name === undefined) return '用法：/删列表 <列表名>'
        if (name === ALL_LIST) {
          return `${ALL_LIST} 是「所有群聊」的保留列表，不能删除；可用 /列表 @all <群id…> 覆盖其内容。`
        }
        await ctx.db.batch([
          { sql: 'DELETE FROM {lists} WHERE name = ?', params: [name] },
          { sql: 'DELETE FROM {list_groups} WHERE list_name = ?', params: [name] },
        ])
        return `已删除列表「${name}」。`
      },
    },
  },
})
