import { Client } from 'pg'
import { loadEnvFile } from '../src/config.js'
loadEnvFile('.env')
const db=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000})
try {
  await db.connect()
  console.log(JSON.stringify((await db.query(`SELECT u.id,u.display_name,u.external_user_id,u.app_id,
    (SELECT count(*) FROM requirement_assistant.messages m WHERE m.user_id=u.id) messages,
    (SELECT count(*) FROM requirement_assistant.attachments a WHERE a.user_id=u.id) attachments
    FROM requirement_assistant.users u ORDER BY u.created_at`)).rows,null,2))
  console.log(JSON.stringify((await db.query(`SELECT p.id,p.name,count(c.id) conversations FROM requirement_assistant.projects p LEFT JOIN requirement_assistant.conversations c ON c.project_id=p.id GROUP BY p.id ORDER BY p.id`)).rows,null,2))
} finally {await db.end()}
