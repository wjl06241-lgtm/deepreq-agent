import assert from 'node:assert/strict'
import { hashPassword, verifyPassword, createSession, readSession, parseCookies, sessionCookie } from '../src/admin-auth.js'
import { dashboardHtml } from '../src/dashboard.js'

const encoded = hashPassword('correct-horse-battery')
assert.equal(verifyPassword('correct-horse-battery', encoded), true)
assert.equal(verifyPassword('wrong-password', encoded), false)
const secret = 'x'.repeat(48)
const token = createSession('admin', secret, 1)
const session = readSession(token, secret)
assert.equal(session.username, 'admin')
assert.ok(session.csrf.length >= 20)
assert.equal(readSession(token + 'x', secret), null)
const cookie = sessionCookie(token, 3600)
assert.equal(parseCookies(cookie).ra_admin, token)
const html = dashboardHtml()
assert.match(html, /管理后台/)
assert.match(html, /用户管理/)
assert.match(html, /聊天记录/)
assert.match(html, /文件管理/)
assert.match(html, /系统日志/)
assert.match(html, /更新日志/)
new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1])
console.log('ADMIN-OK: password hashing, signed session, cookies, login UI and management sections')
