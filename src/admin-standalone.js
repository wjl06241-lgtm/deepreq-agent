// Database-only admin process. Never initialize a bot, model, outbox, or runtime lock.
import { Pool } from 'pg'
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { loadEnvFile, loadRuntimeConfig } from './config.js'
import { PostgresStore } from './store-postgres.js'
import { Enterprises } from './enterprises.js'
import { ProjectConfiguration } from './project-configuration.js'
import { createAdminServer } from './admin-server.js'

const ROOT = resolve(import.meta.dirname, '..')
const S = 'requirement_assistant'

export function standaloneConfig(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('独立管理平台需要 DATABASE_URL')
  if (!/^cli_[a-zA-Z0-9]+$/.test(env.ADMIN_APP_ID || '')) throw new Error('请设置 ADMIN_APP_ID（仅应用 ID，无需飞书密钥）')
  if (!env.ADMIN_PASSWORD_HASH || (env.ADMIN_SESSION_SECRET || '').length < 32) throw new Error('请设置后台密码哈希和至少 32 字符的会话密钥')
  const port = Number(env.ADMIN_ONLY_PORT || 3900)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ADMIN_ONLY_PORT 无效')
  const cfg = loadRuntimeConfig()
  return { ...cfg, dataDir: resolve(ROOT, env.ADMIN_ONLY_DATA_DIR || 'data/admin-only'),
    adminPort: port, adminHost: env.ADMIN_ONLY_HOST || '127.0.0.1',
    database: { enabled: true, url: env.DATABASE_URL },
    feishu: { appId: env.ADMIN_APP_ID, appSecret: '' },
    admin: { username: env.ADMIN_USERNAME || 'admin', passwordHash: env.ADMIN_PASSWORD_HASH,
      sessionSecret: env.ADMIN_SESSION_SECRET, sessionHours: Number(env.ADMIN_SESSION_HOURS) || 12 },
  }
}

export function createDatabaseAdminStore(pool, appId) {
  // Reuse read queries only, without constructing the local durable store.
  const store = Object.create(PostgresStore.prototype)
  Object.assign(store, { pool, appId, enterpriseMode: true,
    health: { enabled: true, connected: true, lastSuccessAt: Date.now(), errorCode: null },
    log: () => {},
    status() { return { ...this.health, pending: null, mode: 'database-only' } },
    async readRange(from, to) {
      const result = await pool.query(`SELECT payload FROM ${S}.records WHERE occurred_at >= $1 AND occurred_at < $2 AND app_id=$3 ORDER BY occurred_at`, [new Date(from), new Date(to), appId])
      this.succeeded()
      return result.rows.map(r => r.payload)
    },
    async readUsers() {
      return (await pool.query(`SELECT external_user_id AS "openId",display_name AS name,avatar_url AS avatar,profile_status AS status FROM ${S}.users WHERE app_id=$1 AND platform='feishu'`, [appId])).rows
    },
  })
  return store
}

export async function createStandaloneAdmin({ cfg, pool, root = ROOT, sharedMaterialsDir = '' }) {
  const store = createDatabaseAdminStore(pool, cfg.feishu.appId)
  const enterprises = new Enterprises(pool, cfg.feishu.appId)
  if (!await enterprises.enabled()) throw new Error('请先完成现有企业数据库迁移')
  const projects = { catalog: {}, list() { return Object.values(this.catalog) } }
  await enterprises.refresh(projects)
  if (!projects.enterprise) throw new Error('ADMIN_APP_ID 尚未绑定企业')
  const projectConfiguration = new ProjectConfiguration(pool, sharedMaterialsDir || join(cfg.dataDir, 'unavailable-materials'))
  let tasks = []
  const assistant = {
    projectNames: () => Object.fromEntries(projects.list().map(p => [p.id, p.name])),
    // Local unanswered resolution state is not yet synchronized. Do not fabricate it.
    openQuestions: async () => [],
    runtime: { tasks: { list: () => tasks } },
  }
  const beforeRequest = async url => {
    if (['/api/status', '/api/tasks', '/api/projects', '/api/chats'].includes(url.pathname)) await enterprises.refresh(projects)
    if (['/api/status', '/api/tasks'].includes(url.pathname)) {
      tasks = (await pool.query(`SELECT t.id,t.status,t.delivery_status AS delivery,c.project_id AS project,t.created_at AS "createdAt",t.updated_at AS "updatedAt" FROM ${S}.tasks t JOIN ${S}.users u ON u.id=t.user_id JOIN ${S}.conversations c ON c.id=t.conversation_id WHERE u.app_id=$1 AND u.platform='feishu' ORDER BY t.created_at DESC LIMIT 100`, [cfg.feishu.appId])).rows
    }
  }
  const appVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
  return createAdminServer({ cfg, root, configFile: join(root, 'config.json'), appVersion,
    startedAt: Date.now(), store, projects, enterprises, enterpriseMode: true, projectConfiguration,
    assistant, users: { list: () => [] }, apiClient: null, feishuReady: false,
    standalone: true, sharedMaterials: Boolean(sharedMaterialsDir), beforeRequest,
  })
}

async function main() {
  // Deliberately do not load .env: the local bot credentials and ports stay separate.
  loadEnvFile(resolve(ROOT, process.env.ADMIN_ENV_FILE || '.env.admin'))
  const cfg = standaloneConfig()
  const pool = new Pool({ connectionString: cfg.database.url, max: 5,
    connectionTimeoutMillis: 5000, statement_timeout: 15000, query_timeout: 17000,
    application_name: 'requirement-assistant-admin' })
  pool.on('error', () => console.error('[独立管理平台] 数据库连接异常'))
  try {
    const server = await createStandaloneAdmin({ cfg, pool,
      sharedMaterialsDir: process.env.ADMIN_SHARED_MATERIALS_DIR ? resolve(process.env.ADMIN_SHARED_MATERIALS_DIR) : '' })
    await new Promise((ok, fail) => { server.once('error', fail); server.listen(cfg.adminPort, cfg.adminHost, ok) })
    console.log('[独立管理平台] http://' + cfg.adminHost + ':' + cfg.adminPort + '/（未启动飞书或模型执行端）')
    let closing = false
    const shutdown = async () => {
      if (closing) return
      closing = true
      await new Promise(ok => server.close(ok))
      await pool.end()
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    process.on('message', msg => { if (msg?.type === 'shutdown') void shutdown() })
  } catch (error) { await pool.end(); throw error }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('[独立管理平台] 启动失败，请检查独立配置、端口及数据库迁移/连接。'); process.exitCode = 1 })
}
