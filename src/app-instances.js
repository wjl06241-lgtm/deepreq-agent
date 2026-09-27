import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const DEFAULT_CONFIG_NAME = '.feishu-apps.json'

function requiredText(value, label) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(label + ' 未配置')
  return text
}

function resolveFromRoot(root, value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  return isAbsolute(text) ? resolve(text) : resolve(root, text)
}

export function feishuAppsFile(root, env = process.env) {
  return resolveFromRoot(root, env.FEISHU_APPS_FILE || DEFAULT_CONFIG_NAME)
}

/**
 * 读取多飞书应用配置。配置文件不存在时退回原有单应用环境变量，保持向后兼容。
 * appId/appSecret 可以直接写在本机配置中，也可以通过 appIdEnv/appSecretEnv 引用 .env。
 */
export function loadFeishuAppInstances(root, env = process.env) {
  const file = feishuAppsFile(root, env)
  if (!existsSync(file)) {
    return {
      mode: 'legacy',
      file,
      instances: [{
        name: env.INSTANCE_NAME || '默认应用',
        appId: env.FEISHU_APP_ID || '',
        appSecret: env.FEISHU_APP_SECRET || '',
        dataDir: resolveFromRoot(root, env.DATA_DIR || './data'),
        adminPort: Number(env.ADMIN_PORT || 3800),
        alertChats: env.ALERT_CHATS,
      }],
    }
  }

  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error('多 App 配置读取失败：' + error.message)
  }
  if (!Array.isArray(parsed.apps)) throw new Error('多 App 配置必须包含 apps 数组')

  const enabled = parsed.apps.filter(item => item?.enabled !== false)
  if (enabled.length === 0) throw new Error('多 App 配置中没有启用的应用')
  const basePort = Number(parsed.adminBasePort || env.ADMIN_PORT || 3800)
  const instances = enabled.map((item, index) => {
    const name = requiredText(item.name, `apps[${index}].name`)
    const appId = item.appIdEnv
      ? requiredText(env[item.appIdEnv], `${name} 引用的环境变量 ${item.appIdEnv}`)
      : requiredText(item.appId, `${name}.appId`)
    const appSecret = item.appSecretEnv
      ? requiredText(env[item.appSecretEnv], `${name} 引用的环境变量 ${item.appSecretEnv}`)
      : requiredText(item.appSecret, `${name}.appSecret`)
    const dataDir = resolveFromRoot(root, item.dataDir || join('data', 'apps', appId))
    const adminPort = Number(item.adminPort ?? basePort + index)
    if (!Number.isInteger(adminPort) || adminPort < 1 || adminPort > 65535) {
      throw new Error(`${name}.adminPort 必须是 1-65535 的整数`)
    }
    return { name, appId, appSecret, dataDir, adminPort, alertChats: item.alertChats }
  })

  const unique = (field, label) => {
    const seen = new Set()
    for (const instance of instances) {
      const value = instance[field]
      if (seen.has(value)) throw new Error(`${label} 重复：${value}`)
      seen.add(value)
    }
  }
  unique('name', '应用名称')
  unique('appId', '飞书 App ID')
  unique('dataDir', '数据目录')
  unique('adminPort', '管理端口')
  return { mode: 'multi', file, instances }
}

export function instanceEnvironment(instance, env = process.env) {
  const next = {
    ...env,
    INSTANCE_NAME: instance.name,
    FEISHU_APP_ID: instance.appId,
    FEISHU_APP_SECRET: instance.appSecret,
    DATA_DIR: instance.dataDir,
    ADMIN_PORT: String(instance.adminPort),
  }
  if (instance.alertChats !== undefined) {
    next.ALERT_CHATS = Array.isArray(instance.alertChats)
      ? instance.alertChats.join(',')
      : String(instance.alertChats)
  }
  return next
}

export function supervisorDirectory(root, env = process.env) {
  if (env.SERVICE_LOG_DIR) return resolveFromRoot(root, env.SERVICE_LOG_DIR)
  if (existsSync(feishuAppsFile(root, env))) return join(root, 'data', 'service')
  return join(resolveFromRoot(root, env.DATA_DIR || './data'), 'service')
}
