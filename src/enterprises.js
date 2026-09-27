import { randomUUID } from 'node:crypto'
const S='requirement_assistant'
const fail=message=>{throw Object.assign(new Error(message),{status:400})}
const label=value=>{
  const s=String(value??'').trim()
  if(!s || s.length>60 || /[\x00-\x1f]/.test(s)) fail('名称须为 1–60 个字符')
  return s
}

// PostgreSQL is the shared authority across app processes. Membership is never inferred from a name.
export class Enterprises {
  constructor(pool,appId){this.pool=pool;this.appId=appId}
  async enabled(){return Boolean((await this.pool.query("SELECT to_regclass('requirement_assistant.enterprises') AS t")).rows[0].t)}
  async catalog(){
    const enterprises=(await this.pool.query(`SELECT e.id,e.name,coalesce(array_agg(a.app_id) FILTER(WHERE a.app_id IS NOT NULL),'{}') AS "appIds" FROM ${S}.enterprises e LEFT JOIN ${S}.enterprise_apps a ON a.enterprise_id=e.id GROUP BY e.id ORDER BY e.created_at`)).rows
    const projects=(await this.pool.query(`SELECT p.id,p.name,p.enterprise_id AS "enterpriseId",p.description,p.assistant_prompt AS prompt,p.shared_notes AS "sharedNotes",p.archived,p.created_at AS "createdAt",coalesce(array_agg(pm.user_id) FILTER(WHERE pm.user_id IS NOT NULL),'{}') AS "memberIds",
      (SELECT count(*)::int FROM ${S}.conversations c WHERE c.project_id=p.id OR EXISTS(SELECT 1 FROM ${S}.project_legacy_conversations l WHERE l.conversation_id=c.id AND l.project_id=p.id)) AS "conversationCount",
      (SELECT count(*)::int FROM ${S}.messages m JOIN ${S}.conversations c ON c.id=m.conversation_id WHERE c.project_id=p.id OR EXISTS(SELECT 1 FROM ${S}.project_legacy_conversations l WHERE l.conversation_id=c.id AND l.project_id=p.id)) AS "messageCount"
      FROM ${S}.projects p LEFT JOIN ${S}.project_members pm ON pm.project_id=p.id WHERE p.enterprise_id IS NOT NULL GROUP BY p.id ORDER BY p.created_at`)).rows
    const users=(await this.pool.query(`SELECT u.id,u.external_user_id AS "openId",u.app_id AS "appId",coalesce(nullif(u.display_name,''),u.registration->>'name','未获取姓名') AS name,a.enterprise_id AS "enterpriseId" FROM ${S}.users u LEFT JOIN ${S}.enterprise_apps a ON a.app_id=u.app_id WHERE u.platform='feishu' ORDER BY u.created_at`)).rows
    return {enterprises,projects,users,currentAppId:this.appId}
  }
  async refresh(registry){
    const enterprise=(await this.pool.query(`SELECT e.* FROM ${S}.enterprises e JOIN ${S}.enterprise_apps a ON a.enterprise_id=e.id WHERE a.app_id=$1`,[this.appId])).rows[0]
    registry.governed=true
    registry.enterprise=enterprise??null
    const rows=enterprise?(await this.pool.query(`SELECT p.id,p.name,p.description,p.soul,p.boundaries,p.config_version AS "configVersion",p.assistant_prompt AS prompt,p.shared_notes AS "sharedNotes",p.archived,p.enterprise_id AS "enterpriseId",p.created_at AS "createdAt",
      coalesce(array_agg(u.external_user_id) FILTER(WHERE u.app_id=$2),'{}') AS "memberOpenIds"
      FROM ${S}.projects p LEFT JOIN ${S}.project_members pm ON pm.project_id=p.id LEFT JOIN ${S}.users u ON u.id=pm.user_id WHERE p.enterprise_id=$1 GROUP BY p.id`,[enterprise.id,this.appId])).rows:[]
    // Retain active selections and all legacy files; replace only the in-memory catalog view.
    registry.catalog=Object.fromEntries(rows.map(p=>[p.id,{...p,createdAt:new Date(p.createdAt).getTime()}]))
  }
  async mutate(action,body,actor){
    const c=await this.pool.connect()
    try{
      await c.query('BEGIN')
      await c.query("SELECT pg_advisory_xact_lock(72746101)")
      let id=body.id
      if(action==='enterprise'){
        const name=label(body.name)
        if(!id){id='e'+randomUUID();await c.query(`INSERT INTO ${S}.enterprises(id,name) VALUES($1,$2)`,[id,name])}
        else if(!(await c.query(`UPDATE ${S}.enterprises SET name=$2 WHERE id=$1 RETURNING id`,[id,name])).rowCount)fail('企业不存在')
        if(body.appId){
          if(!/^cli_[a-zA-Z0-9]+$/.test(body.appId))fail('飞书 App ID 格式不正确')
          const old=(await c.query(`SELECT enterprise_id FROM ${S}.enterprise_apps WHERE app_id=$1`,[body.appId])).rows[0]
          if(old&&old.enterprise_id!==id)fail('该 App 已归属另一企业，不能直接转移已有数据')
          await c.query(`INSERT INTO ${S}.enterprise_apps(app_id,enterprise_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[body.appId,id])
        }
      }else if(action==='project'){
        const name=label(body.name)
        const enterprise=(await c.query(`SELECT id FROM ${S}.enterprises WHERE id=$1`,[body.enterpriseId])).rows[0]
        if(!enterprise)fail('请先选择企业')
        const description=String(body.description??'').slice(0,2000),prompt=body.prompt===undefined?null:String(body.prompt).slice(0,20000)
        if(!id){id='p'+randomUUID();await c.query(`INSERT INTO ${S}.projects(id,name,enterprise_id,description,assistant_prompt) VALUES($1,$2,$3,$4,$5)`,[id,name,enterprise.id,description,prompt||''])}
        else if(!(await c.query(`UPDATE ${S}.projects SET name=$2,description=$3,assistant_prompt=coalesce($4,assistant_prompt),archived=$5,config_version=config_version+1 WHERE id=$1 AND enterprise_id=$6 RETURNING id`,[id,name,description,prompt,body.archived===true,enterprise.id])).rowCount)fail('项目不存在或企业不匹配')
        if(body.sharedNotes!==undefined)await c.query(`UPDATE ${S}.projects SET shared_notes=$2 WHERE id=$1`,[id,String(body.sharedNotes).slice(0,30000)])
      }else if(action==='members'){
        const p=(await c.query(`SELECT enterprise_id FROM ${S}.projects WHERE id=$1`,[id])).rows[0]
        if(!p?.enterprise_id)fail('项目不存在')
        if(!Array.isArray(body.userIds)||body.userIds.length>1000)fail('成员列表格式错误')
        const ids=[...new Set(body.userIds)]
        const users=(await c.query(`SELECT u.id FROM ${S}.users u JOIN ${S}.enterprise_apps a ON a.app_id=u.app_id WHERE a.enterprise_id=$1 AND u.id::text=ANY($2::text[]) AND u.platform='feishu'`,[p.enterprise_id,ids])).rows
        if(users.length!==ids.length)fail('只能分配本企业的成员')
        await c.query(`DELETE FROM ${S}.project_members WHERE project_id=$1`,[id])
        for(const uid of ids)await c.query(`INSERT INTO ${S}.project_members(project_id,user_id) VALUES($1,$2)`,[id,uid])
      }else fail('不支持的操作')
      await c.query(`INSERT INTO ${S}.enterprise_audit(action,payload) VALUES($1,$2)`,[action,JSON.stringify({actor,id,...body})])
      await c.query('COMMIT');return {ok:true,id}
    }catch(e){await c.query('ROLLBACK');if(e.code==='23505')fail('名称或绑定已存在');throw e}
    finally{c.release()}
  }
}
