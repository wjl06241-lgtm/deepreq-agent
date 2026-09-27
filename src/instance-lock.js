import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export async function lockRuntime(dir) {
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'runtime.pid')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx')
      await handle.writeFile(String(process.pid)); await handle.close()
      return async () => { if (await readFile(file,'utf8').catch(()=>'') === String(process.pid)) await unlink(file).catch(()=>{}) }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const pid = Number(await readFile(file,'utf8'))
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('运行锁文件无效，需要人工核对：' + file)
      try { process.kill(pid,0) }
      catch (err) { if(err.code === 'ESRCH') { await unlink(file); continue }; throw err }
      throw new Error('该数据目录已有需求助手运行，请先停止后台服务，或为测试设置独立 DATA_DIR。')
    }
  }
  throw new Error('无法取得服务运行锁')
}
