import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AtomicState, replaceStateFile } from '../src/state.js'
let calls=0
await replaceStateFile('a','b',async()=>{if(++calls<3)throw Object.assign(new Error(),{code:'EPERM'})},async()=>{})
assert.equal(calls,3)
calls=0
await assert.rejects(replaceStateFile('a','b',async()=>{calls++;throw Object.assign(new Error(),{code:'EPERM'})},async()=>{}))
assert.equal(calls,9)
calls=0
await assert.rejects(replaceStateFile('a','b',async()=>{calls++;throw Object.assign(new Error(),{code:'ENOENT'})},async()=>{}))
assert.equal(calls,1)
const dir=await mkdtemp(join(tmpdir(),'state-retry-')), file=join(dir,'state.json')
const state=await new AtomicState(file,{}).init()
state.data={n:1};const first=state.save();state.data={n:2};await Promise.all([first,state.save()])
assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{n:2})
assert.deepEqual(await readdir(dir),['state.json'])
console.log('STATE-RETRY-OK')
