import { Pool } from 'pg'
import { standaloneConfig, createStandaloneAdmin } from '../../src/admin-standalone.js'

let pool
try {
  const cfg = standaloneConfig()
  pool = new Pool({ connectionString: cfg.database.url, connectionTimeoutMillis: 5000,
    query_timeout: 10000, statement_timeout: 9000 })
  pool.on('error', () => {})
  await createStandaloneAdmin({ cfg, pool })
  console.log('配置、数据库连接及 App 企业绑定检查通过。')
} catch {
  console.error('部署预检失败：请检查 app.env 配置、数据库网络/白名单/证书、表结构和 App 企业绑定。未输出连接凭据。')
  process.exitCode = 1
} finally { await pool?.end() }
