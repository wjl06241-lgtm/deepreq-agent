import { randomUUID,createHash } from 'node:crypto'
import { mkdir,writeFile,readFile,unlink,realpath } from 'node:fs/promises'
import { join,resolve,extname,relative,isAbsolute } from 'node:path'
import { DocumentLibrary } from './documents.js'
export const MATERIAL_LIMIT=50*1024*1024
const S='requirement_assistant',allowed=new Set(['.md','.txt','.csv','.tsv','.json','.pdf','.docx','.xlsx'])
const bad=(message,status=400)=>{throw Object.assign(new Error(message),{status})}
const text=(value,max)=>{if(typeof value!=='string'||value.length>max)bad('配置必须是文本且不能超过 '+max+' 字符');return value}
const uuid=value=>/^[a-f0-9-]{36}$/.test(value)
export class ProjectConfiguration {
  async global(){
    return (await this.pool.query(`SELECT prompt,version,updated_at AS "updatedAt",updated_by AS "updatedBy" FROM ${S}.assistant_settings WHERE id=1`)).rows[0]
  }
  async saveGlobal(body,actor){
    const prompt=text(body.prompt,30000)
    if(!Number.isInteger(body.version))bad('缺少配置版本，请刷新')
    const c=await this.pool.connect()
    try{
      await c.query('BEGIN')
      const before=(await c.query(`SELECT * FROM ${S}.assistant_settings WHERE id=1 FOR UPDATE`)).rows[0]
      if(!before||before.version!==body.version)bad('全局配置已被更新，请重新打开后编辑',409)
      await c.query(`UPDATE ${S}.assistant_settings SET prompt=$1,version=version+1,updated_at=now(),updated_by=$2 WHERE id=1`,[prompt,actor])
      await c.query(`INSERT INTO ${S}.enterprise_audit(action,payload) VALUES('global-config',$1)`,[JSON.stringify({actor,before,after:{prompt,version:body.version+1}})])
      await c.query('COMMIT');return {ok:true,version:body.version+1}
    }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
  }
  constructor(pool,root){this.pool=pool;this.root=resolve(root);this.parser=new DocumentLibrary(root,MATERIAL_LIMIT)}
  async project(id){
    const p=(await this.pool.query(`SELECT id,name,enterprise_id AS "enterpriseId",soul,assistant_prompt AS prompt,boundaries,shared_notes AS "sharedNotes",config_version AS version,config_updated_at AS "updatedAt" FROM ${S}.projects WHERE id=$1 AND enterprise_id IS NOT NULL`,[id])).rows[0]
    if(!p)bad('项目不存在',404);return p
  }
  async save(id,body,actor){
    const fields=[text(body.soul,20000),text(body.prompt,20000),text(body.boundaries,20000),text(body.sharedNotes,30000)]
    if(!Number.isInteger(body.version))bad('缺少配置版本，请刷新')
    const c=await this.pool.connect()
    try{await c.query('BEGIN')
      const before=(await c.query(`SELECT * FROM ${S}.projects WHERE id=$1 AND enterprise_id IS NOT NULL FOR UPDATE`,[id])).rows[0]
      if(!before)bad('项目不存在',404)
      if(before.config_version!==body.version)bad('配置已被更新，请重新打开后编辑',409)
      await c.query(`UPDATE ${S}.projects SET soul=$2,assistant_prompt=$3,boundaries=$4,shared_notes=$5,config_version=config_version+1,config_updated_at=now() WHERE id=$1`,[id,...fields])
      await c.query(`INSERT INTO ${S}.enterprise_audit(action,payload) VALUES('project-config',$1)`,[JSON.stringify({actor,id,before:{soul:before.soul,prompt:before.assistant_prompt,boundaries:before.boundaries,sharedNotes:before.shared_notes,version:before.config_version},after:body})])
      await c.query('COMMIT');return {ok:true,version:body.version+1}
    }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
  }
  async list(projectId,enabledOnly=false){
    if(projectId!==null)await this.project(projectId)
    return (await this.pool.query(`SELECT id,name,extension,size_bytes AS "sizeBytes",sha256,enabled,replaces_id AS "replacesId",created_at AS "createdAt",updated_at AS "updatedAt",excerpt FROM ${S}.project_materials WHERE project_id IS NOT DISTINCT FROM $1 AND ($2=false OR enabled=true) ORDER BY created_at DESC,id`,[projectId,enabledOnly])).rows
  }
  async file(row){
    if(!uuid(row.id)||!allowed.has(row.extension))bad('无效文件标识')
    const root=await realpath(this.root),file=await realpath(join(root,row.id+row.extension)),rel=relative(root,file)
    if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+(process.platform==='win32'?'\\':'/')))bad('文件路径越界',403)
    const bytes=await readFile(file)
    if(createHash('sha256').update(bytes).digest('hex')!==row.sha256)bad('文件校验失败',409)
    return {file,bytes,root}
  }
  async entries(projectId){
    const rows=await this.list(projectId,true),out=[]
    for(const row of rows){const {file,root}=await this.file(row);out.push({id:row.id,file,root,name:(projectId===null?'[全局参考资料] ':'')+row.name,maxBytes:MATERIAL_LIMIT})}
    return out
  }
  async upload(projectId,name,bytes,replacesId,actor){
    if(projectId!==null)await this.project(projectId)
    if(typeof name!=='string'||!name.trim()||name.length>180||/[\\/\x00-\x1f]/.test(name))bad('文件名无效')
    const extension=extname(name).toLowerCase()
    if(!allowed.has(extension))bad('支持 TXT、MD、CSV、TSV、JSON、PDF、DOCX、XLSX')
    if(!bytes.length||bytes.length>MATERIAL_LIMIT)bad('文件须为 1 字节到 50 MB',413)
    if(replacesId&&!uuid(replacesId))bad('替换文件编号无效')
    const id=randomUUID(),sha256=createHash('sha256').update(bytes).digest('hex')
    await mkdir(this.root,{recursive:true})
    const root=await realpath(this.root),file=join(root,id+extension)
    await writeFile(file,bytes,{flag:'wx'})
    let committed=false,c
    try{
      const entry={id,name,file,root}
      const parsed=await this.parser.parseWorker('read',entry,{start:1,count:100})
      let excerpt=JSON.stringify(parsed)
      if(extension==='.xlsx'){
        const parts=[]
        for(const sheet of (parsed.sheets||[]).slice(0,3))parts.push(await this.parser.parseWorker('read',entry,{sheet:sheet.name,start:1,count:30}))
        excerpt=JSON.stringify({sheets:parsed.sheets,preview:parts})
      }
      excerpt=excerpt.slice(0,20000)
      c=await this.pool.connect();await c.query('BEGIN')
      if(projectId===null)await c.query(`SELECT id FROM ${S}.assistant_settings WHERE id=1 FOR UPDATE`)
      else await c.query(`SELECT id FROM ${S}.projects WHERE id=$1 FOR UPDATE`,[projectId])
      if(replacesId){
        const old=await c.query(`UPDATE ${S}.project_materials SET enabled=false,updated_at=now() WHERE id=$1 AND project_id IS NOT DISTINCT FROM $2 RETURNING id`,[replacesId,projectId])
        if(!old.rowCount)bad('被更新文件不属于此项目',404)
      }
      await c.query(`INSERT INTO ${S}.project_materials(id,project_id,name,extension,size_bytes,sha256,excerpt,replaces_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,projectId,name,extension,bytes.length,sha256,excerpt,replacesId||null])
      await c.query(`INSERT INTO ${S}.enterprise_audit(action,payload) VALUES($1,$2)`,[projectId===null?'global-material-upload':'project-material-upload',JSON.stringify({actor,projectId,id,name,sha256,replacesId})])
      await c.query('COMMIT');committed=true;return {ok:true,id}
    }catch(e){if(c)await c.query('ROLLBACK');if(!e.status)bad('文件上传或解析失败，请检查文件格式和内容',422);throw e}
    finally{c?.release();if(!committed)await unlink(file).catch(()=>{})}
  }
  async toggle(projectId,id,enabled,actor){
    if(!uuid(id)||typeof enabled!=='boolean')bad('文件参数无效')
    if(projectId!==null)await this.project(projectId)
    const c=await this.pool.connect()
    try{await c.query('BEGIN')
      const r=await c.query(`UPDATE ${S}.project_materials SET enabled=$3,updated_at=now() WHERE id=$1 AND project_id IS NOT DISTINCT FROM $2 RETURNING id`,[id,projectId,enabled])
      if(!r.rowCount)bad('文件不属于此项目',404)
      await c.query(`INSERT INTO ${S}.enterprise_audit(action,payload) VALUES($1,$2)`,[projectId===null?'global-material-toggle':'project-material-toggle',JSON.stringify({actor,projectId,id,enabled})])
      await c.query('COMMIT');return {ok:true}
    }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
  }
}
