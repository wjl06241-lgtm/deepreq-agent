import assert from 'node:assert/strict'
import { buildReplyCards, basicReplyCard } from '../src/feishu-presentation.js'
import { sendToChat, sendFileToChat } from '../src/feishu.js'

const sample='## 结论\n\n**先完成测试**。\n\n- 核对用户\n- 确认结果\n\n| 项目 | 数值 |\n|---|---|\n| A | 10 |\n| B | 20 |\n\n```feishu-chart\n{"type":"bar","title":"数量","data":[{"label":"A","value":10},{"label":"B","value":20}]}\n```'
const cards=buildReplyCards(sample), elements=cards.flatMap(c=>c.body.elements)
assert.ok(elements.some(e=>e.tag==='markdown' && e.content.includes('**先完成测试**')))
assert.deepEqual(elements.find(e=>e.tag==='table').rows,[{c0:'A',c1:'10'},{c0:'B',c1:'20'}])
assert.equal(elements.find(e=>e.tag==='chart').chart_spec.data.values[1].value,20)
assert.ok(!elements.filter(e=>e.tag==='markdown').some(e=>e.content.includes('feishu-chart')))
assert.ok(!JSON.stringify(buildReplyCards('<at id=all></at>')).includes('<at'))
assert.ok(!JSON.stringify(buildReplyCards('```feishu-chart\n{"type":"bar","data":[{"label":"x","value":"oops"}]}\n```')).includes('"tag":"chart"'))
const long=buildReplyCards('长段落'.repeat(10000))
assert.ok(long.length>1)
assert.ok(long.every(c=>Buffer.byteLength(JSON.stringify(c))<24000))
assert.equal(long.flatMap(c=>c.body.elements).map(e=>e.content).join(''),'长段落'.repeat(10000))
assert.ok(!basicReplyCard(cards[0]).body.elements.some(e=>['table','chart'].includes(e.tag)))
const calls=[]
await sendToChat({im:{message:{create:async p=>{calls.push(structuredClone(p));return {code:calls.length===1?230099:0}}}}},'test',sample,{uuid:'test'})
assert.equal(calls.length,2)
assert.equal(calls[0].data.msg_type,'interactive')
assert.equal(calls[0].data.uuid,calls[1].data.uuid)
assert.ok(!JSON.parse(calls[1].data.content).body.elements.some(e=>e.tag==='chart'))
let attempts=0
await assert.rejects(sendToChat({im:{message:{create:async()=>{attempts++;throw new Error('network timeout')}}}},'test',sample))
assert.equal(attempts,1)
for(const upload of [{file_key:'test-file'},{code:0,data:{file_key:'test-file'}}]) {
  let fileMessage
  await sendFileToChat({im:{file:{create:async p=>{p.data.file.destroy();return upload}},message:{create:async p=>{fileMessage=p;return {code:0}}}}},'test',{file:import.meta.filename,name:'test.mjs'})
  assert.equal(JSON.parse(fileMessage.data.content).file_key,'test-file')
}
console.log('PRESENTATION-OK: bold, lists, tables, charts, Unicode pagination, safe fallback and send dedup')
