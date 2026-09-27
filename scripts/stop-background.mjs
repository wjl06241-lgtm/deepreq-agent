import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnvFile } from '../src/config.js'
import { supervisorDirectory } from '../src/app-instances.js'
const root=fileURLToPath(new URL('../',import.meta.url))
loadEnvFile(join(root,'.env'))
const dir=supervisorDirectory(root)
await mkdir(dir,{recursive:true});await writeFile(join(dir,'stop'),'stop')
console.log('已请求停止后台服务。')
