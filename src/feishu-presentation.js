import { lexer } from 'marked'

// The model writes a compact internal format; Feishu renders it, never raw Markdown text.
export const replyPresentationPrompt = `回复展示要求：用户在飞书中阅读已排版的卡片。先给结论，正文用短段落；重点用 **加粗**，少量列表，比较信息用表格（建议不超过6列）。不要把整篇回复放进代码块，不要输出 HTML 或 Markdown 使用说明。只有确有数值且图表有助理解时使用图表，不编造数据。图表使用内部代码块 feishu-chart，内容为 JSON：{"type":"bar","title":"标题","data":[{"label":"项目A","value":10},{"label":"项目B","value":20}]}。type 仅 bar 或 line；趋势用 line。系统会将该块转换成可视化图表，用户不会看到 JSON。图表后简短说明结论。没有数值时使用文字、列表或表格。`

const safe = s => String(s ?? '').replace(/<\/?(?:at|img|iframe|script|font|text_tag)\b[^>]*>/gi, '')
const plain = s => safe(s).replace(/\*\*([^*]+)\*\*/g,'$1').replace(/`([^`]+)`/g,'$1').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1')
const md = content => ({ tag:'markdown', content:safe(content) })
const wrap = elements => ({ schema:'2.0', config:{wide_screen_mode:true}, body:{elements} })
const bytes = x => Buffer.byteLength(JSON.stringify(x),'utf8')
const LIMIT = 24000

function textElements(raw) {
  // Split exceptionally long paragraphs by Unicode code point, below card byte limits.
  const out=[]; let chunk=''
  for (const line of raw.split(/(?<=\n)/)) {
    if (bytes(md(chunk+line)) <= 18000) { chunk+=line; continue }
    if(chunk){out.push(md(chunk));chunk=''}
    for(const ch of line){if(bytes(md(chunk+ch))>18000){out.push(md(chunk));chunk=''}chunk+=ch}
  }
  if(chunk.trim())out.push(md(chunk))
  return out
}

function chartElements(token) {
  let spec
  try { spec=JSON.parse(token.text) } catch { return [md('图表数据格式有误，未生成图表。')] }
  const values=spec?.data
  if (!['bar','line'].includes(spec?.type) || !Array.isArray(values) || !values.length || values.length>50
    || values.some(v=>typeof v.label!=='string'||v.label.length>100||!Number.isFinite(v.value))) {
    return [md('图表数据不完整，未生成图表。')]
  }
  return [md('**'+plain(spec.title || '数据比较').slice(0,100)+'**'),
    {tag:'chart',chart_spec:{type:spec.type,data:{values:values.map(v=>({label:plain(v.label),value:v.value}))},
      xField:'label',yField:'value',axes:[{orient:'bottom',type:'band'},{orient:'left',type:'linear'}]}}]
}

function tableElements(token) {
  const headers=token.header.map(c=>plain(c.text))
  // Wide tables are easier to read as labelled rows on phones.
  if(headers.length>6) return token.rows.flatMap(row=>textElements(row.map((c,i)=>'**'+headers[i]+'**：'+plain(c.text)).join('\n')+'\n'))
  const columns=headers.map((h,i)=>({name:'c'+i,display_name:h,data_type:'text',width:'auto'}))
  const out=[];let rows=[]
  const table=rs=>({tag:'table',page_size:10,columns,rows:rs})
  for(const row of token.rows){
    const value=Object.fromEntries(row.map((c,i)=>['c'+i,plain(c.text)]))
    if(rows.length && (rows.length>=10||bytes(table([...rows,value]))>18000)){out.push(table(rows));rows=[]}
    if(bytes(table([value]))>18000)out.push(...textElements(row.map((c,i)=>'**'+headers[i]+'**：'+plain(c.text)).join('\n')))
    else rows.push(value)
  }
  if(rows.length)out.push(table(rows))
  return out
}

export function buildReplyCards(text) {
  const tokens=lexer(String(text ?? ''),{gfm:true})
  const elements=[]
  for(const t of tokens){
    if(t.type==='space')continue
    if(t.type==='table')elements.push(...tableElements(t))
    else if(t.type==='code' && t.lang?.trim()==='feishu-chart')elements.push(...chartElements(t))
    else if(t.type==='heading')elements.push(md('**'+plain(t.text)+'**'))
    else if(t.type==='hr')elements.push({tag:'hr'})
    else elements.push(...textElements(t.raw))
  }
  const cards=[];let page=[]
  for(const element of elements){
    if(page.length && (page.length>=30 || bytes(wrap([...page,element]))>LIMIT)){cards.push(wrap(page));page=[]}
    page.push(element)
  }
  if(page.length)cards.push(wrap(page))
  return cards.length ? cards : [wrap([md('（暂无内容）')])]
}

// Only used after an explicit card-schema rejection, never after an uncertain send.
export function basicReplyCard(card) {
  return wrap(card.body.elements.flatMap(e=>{
    if(e.tag==='table')return e.rows.map(row=>md(e.columns.map(c=>'**'+c.display_name+'**：'+row[c.name]).join('\n')))
    if(e.tag==='chart')return [md(e.chart_spec.data.values.map(v=>'• '+v.label+'：'+v.value).join('\n'))]
    return [e]
  }))
}
