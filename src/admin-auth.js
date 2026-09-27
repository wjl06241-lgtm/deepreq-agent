import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const b64 = value => Buffer.from(value).toString('base64url')
const unb64 = value => Buffer.from(value, 'base64url').toString('utf8')

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  if (typeof password !== 'string' || password.length < 10) throw new Error('管理员密码至少需要 10 个字符')
  const digest = scryptSync(password, salt, 64).toString('hex')
  return `scrypt$${salt}$${digest}`
}

export function verifyPassword(password, encoded) {
  try {
    const [scheme, salt, expectedHex] = String(encoded).split('$')
    if (scheme !== 'scrypt' || !salt || !/^[a-f0-9]{128}$/i.test(expectedHex)) return false
    const actual = scryptSync(String(password), salt, 64)
    return timingSafeEqual(actual, Buffer.from(expectedHex, 'hex'))
  } catch {
    return false
  }
}

function signature(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

export function createSession(username, secret, hours = 12) {
  if (!secret || secret.length < 32) throw new Error('管理员会话密钥未配置')
  const payload = b64(JSON.stringify({
    username,
    csrf: randomBytes(18).toString('base64url'),
    exp: Date.now() + Math.max(1, Math.min(Number(hours) || 12, 168)) * 3600000,
  }))
  return `${payload}.${signature(payload, secret)}`
}

export function readSession(token, secret) {
  try {
    const [payload, provided] = String(token || '').split('.')
    if (!payload || !provided || !secret) return null
    const expected = signature(payload, secret)
    const a = Buffer.from(provided), b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    const session = JSON.parse(unb64(payload))
    if (!session.username || !session.csrf || !Number.isFinite(session.exp) || session.exp <= Date.now()) return null
    return session
  } catch {
    return null
  }
}

export function parseCookies(header = '') {
  const out = {}
  for (const item of String(header).split(';')) {
    const index = item.indexOf('=')
    if (index < 1) continue
    const key = item.slice(0, index).trim()
    try { out[key] = decodeURIComponent(item.slice(index + 1).trim()) } catch {}
  }
  return out
}

export function sessionCookie(token, maxAge, secure = false) {
  return `ra_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAge))}${secure ? '; Secure' : ''}`
}
