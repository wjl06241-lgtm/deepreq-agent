try {
  const response = await fetch('http://127.0.0.1:3900/api/session', { signal: AbortSignal.timeout(3500) })
  const body = await response.json()
  process.exitCode = response.status === 401 && body.configured === true ? 0 : 1
} catch { process.exitCode = 1 }
