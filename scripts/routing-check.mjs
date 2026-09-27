// Synthetic inference only: never sends Feishu messages or changes project memberships.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEnvFile, loadRuntimeConfig } from '../src/config.js'
import { ProjectRouter, validateRoute } from '../src/project-routing.js'
loadEnvFile(join(import.meta.dirname, '..', '.env'))
const cfg=loadRuntimeConfig({dataDir:await mkdtemp(join(tmpdir(),'route-live-check-'))})
const router=new ProjectRouter(cfg)
const projects=[{id:'health',name:'主动健康',description:'本院基于患者画像的主动健康管理平台，涉及一期建设、体检阳性转诊、随访及需求清单。'}]
try {
  await router.ready
  for(const [message,expected] of [['主动健康是什么意思？',false],['结合我们一医院主动健康平台的功能清单，一期先建设哪些功能？',true]]) {
    const response=await router.classify({message,currentProjectId:'',history:[],projects})
    const decision=validateRoute(response,projects)
    const ok=Boolean(decision)===expected
    console.log(JSON.stringify({message,recommend:Boolean(decision),reason:decision?.reason,ok}))
    if(!ok)process.exitCode=1
  }
}finally{await router.close()}
