import { Client } from 'pg'
import { mkdir,readFile,writeFile } from 'node:fs/promises'
import { resolve,join } from 'node:path'
import { createHash } from 'node:crypto'
import { loadEnvFile } from '../src/config.js'
loadEnvFile('.env')
const c=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000})
const dir=resolve('data/backups/project-config-'+new Date().toISOString().replace(/[:.]/g,'-'))
try{
  await c.connect();await mkdir(dir,{recursive:true})
  const rows=(await c.query('SELECT * FROM requirement_assistant.projects ORDER BY id')).rows
  await writeFile(join(dir,'projects-before.json'),JSON.stringify(rows,null,2),{flag:'wx'})
  const counts=async()=> (await c.query(`SELECT (SELECT count(*) FROM requirement_assistant.messages) AS messages,(SELECT count(*) FROM requirement_assistant.attachments) AS attachments,(SELECT count(*) FROM requirement_assistant.conversations) AS conversations`)).rows[0]
  const before=await counts()
  await c.query(await readFile('docs/db/postgresql-v6.sql','utf8'))
  const after=await counts()
  const evidence={backup:dir,before,after,projectBackupSha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')}
  await writeFile(join(dir,'verification.json'),JSON.stringify(evidence,null,2),{flag:'wx'})
  console.log(JSON.stringify(evidence))
}finally{await c.end()}
