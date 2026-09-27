import { readFile, readdir, realpath, stat, mkdir, writeFile } from 'node:fs/promises'
import { join, relative, extname, basename, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { AtomicState } from './state.js'
import { detectImageMime } from './llm.js'
import iconv from 'iconv-lite'
import { Worker } from 'node:worker_threads'

const supported = /\.(md|txt|csv|tsv|json|sql|log|ya?ml|xml|html|docx|xlsx|pdf|png|jpe?g|webp|gif|img)$/i
const inside = (root, file) => { const rel = relative(root, file); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) }
const txt = value => ({ success: true, contentItems: [{ type: 'inputText', text: typeof value === 'string' ? value : JSON.stringify(value) }] })
const integer = (n, fallback, min, max) => { const x = n ?? fallback; if (!Number.isInteger(x) || x < min || x > max) throw new Error('页码或范围参数无效'); return x }

export class DocumentLibrary {
  constructor(dir, maxBytes = 30 * 1024 * 1024) { this.state = new AtomicState(join(dir, 'attachments.json'), {}); this.maxBytes = maxBytes; this.outputDir = join(dir, 'outputs') }
  async init() { await this.state.init(); return this }
  parseWorker(operation, entry, args, signal) {
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./document-worker.js', import.meta.url), {
        workerData: { operation, entry, args, dir: this.outputDir, maxBytes: entry?.maxBytes ?? this.maxBytes }, resourceLimits: { maxOldGenerationSizeMb: 256 },
      })
      let done = false
      const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); void worker.terminate(); error ? reject(error) : resolve(result) }
      const abort = () => finish(signal.reason || new Error('已取消'))
      const timer = setTimeout(() => finish(new Error('文件解析超过60秒，请拆分文件')), 60000)
      signal?.addEventListener('abort', abort, { once: true })
      worker.on('message', msg => finish(msg.error ? new Error(msg.error) : null, msg.result))
      worker.on('error', e => finish(e)); worker.on('exit', code => { if (!done) finish(new Error('解析进程退出：' + code)) })
    })
  }
  async register(scope, file, name) {
    const entry = { id: createHash('sha256').update(scope + file).digest('hex').slice(0,24), file: await realpath(file), name, scope }
    this.state.data[entry.id] = entry; await this.state.save(); return entry
  }
  async catalog(scope, root, options = {}) {
    const out = new Map()
    if (root) {
      let canonical
      try { canonical = await realpath(root) } catch (e) { if (e.code !== 'ENOENT') throw e }
      const walk = async (dir, depth = 0) => {
        if (depth > 12) throw new Error('项目资料目录超过 12 层，请整理目录')
        for (const ent of await readdir(dir, { withFileTypes: true })) {
          if (ent.isSymbolicLink() || ent.name.startsWith('.') || ['node_modules','data'].includes(ent.name)) continue
          if (!options.includeHistory && ['历史聊天','聊天记录','history'].includes(ent.name)) continue
          if (!options.includeHistory && /^(对话记录|聊天记录|历史聊天)\.(md|txt|json|jsonl)$/i.test(ent.name)) continue
          const file = join(dir, ent.name)
          if (ent.isDirectory()) await walk(file, depth + 1)
          else if (ent.isFile() && supported.test(ent.name)) {
            const canonicalFile = await realpath(file)
            if (!inside(canonical, canonicalFile)) continue
            const id = createHash('sha256').update(canonicalFile).digest('hex').slice(0,24)
            out.set(id, { id, file: canonicalFile, name: relative(canonical, canonicalFile), root: canonical })
            if (out.size > 3000) throw new Error('项目资料超过 3000 个文件，请分项目管理')
          }
        }
      }
      if (canonical) await walk(canonical)
    }
    for (const entry of Object.values(this.state.data)) if (entry.scope === scope) out.set(entry.id, entry)
    return out
  }
  async checked(entry) {
    if (!entry) throw new Error('文件不属于当前项目或会话，请先列出资料')
    const actual = await realpath(entry.file)
    if (actual !== entry.file || (entry.root && !inside(entry.root, actual))) throw new Error('资料路径已变化，拒绝读取')
    if ((await stat(actual)).size > this.maxBytes) throw new Error('文件超过解析大小上限，请拆分文件')
    return actual
  }
  async read(entry, args = {}) {
    const file = await this.checked(entry), ext = extname(entry.name).toLowerCase()
    const start = integer(args.start, 1, 1, 10000000), count = integer(args.count, 100, 1, 200)
    const buf = await readFile(file)
    if (ext === '.pdf') {
      const { getDocumentProxy } = await import('unpdf')
      const pdf = await getDocumentProxy(new Uint8Array(buf))
      try {
        if (start > pdf.numPages) throw new Error('页码超出范围')
        const pages = []
        for (let n = start; n <= Math.min(pdf.numPages, start + Math.min(count, 5) - 1); n++) {
          const page = await pdf.getPage(n), content = await page.getTextContent()
          const text = content.items.map(i => (i.str ?? '') + (i.hasEOL ? '\n' : ' ')).join('')
          pages.push({ page: n, text, needsVisual: !text.trim() })
        }
        return { name: entry.name, totalPages: pdf.numPages, pages, next: pages.at(-1).page < pdf.numPages ? pages.at(-1).page + 1 : null }
      } finally { await pdf.loadingTask.destroy() }
    }
    if (ext === '.xlsx') {
      const ExcelJS = (await import('exceljs')).default
      const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buf)
      const sheets = workbook.worksheets.map(s => ({ name: s.name, rows: s.rowCount, columns: s.columnCount }))
      if (!args.sheet) return { name: entry.name, sheets, note: '读取时指定 sheet；公式结果为文件缓存值，未重新计算。' }
      const sheet = workbook.getWorksheet(args.sheet)
      if (!sheet) throw new Error('工作表不存在')
      const rows = []
      for (let r = start; r <= Math.min(sheet.rowCount, start + count - 1); r++) {
        const cells = []; sheet.getRow(r).eachCell(cell => { cells.push({ address: cell.address, value: cell.value, numberFormat: cell.numFmt }) })
        rows.push({ row: r, cells })
      }
      return { name: entry.name, sheet: sheet.name, totalRows: sheet.rowCount, rows, next: start + count <= sheet.rowCount ? start + count : null }
    }
    let text
    if (ext === '.docx') {
      const mammoth = (await import('mammoth')).default
      const result = await mammoth.convertToHtml({ buffer: buf }, { externalFileAccess: false, convertImage: mammoth.images.imgElement(async () => ({ src: '' })) })
      text = result.value.replace(/(<\/(?:p|h[1-6]|tr|table)>)/g, '$1\n')
    } else {
      if (!supported.test(entry.name) || /\.(png|jpe?g|webp|gif|img)$/i.test(entry.name)) throw new Error('请用资料图片工具查看；旧版 doc/xls 请另存为 docx/xlsx')
      text = buf.toString('utf8'); if (text.includes('\uFFFD')) text = iconv.decode(buf, 'gbk')
    }
    const lines = text.split(/\r?\n/)
    return { name: entry.name, totalLines: lines.length, lines: lines.slice(start-1, start-1+count).map((text,i) => ({ line: start+i, text })), next: start+count <= lines.length ? start+count : null }
  }
  async image(entry, page = 1) {
    const file = await this.checked(entry), buf = await readFile(file)
    if (/\.pdf$/i.test(entry.name)) {
      integer(page, 1, 1, 100000)
      const { getDocumentProxy, renderPageAsImage } = await import('unpdf')
      const pdf = await getDocumentProxy(new Uint8Array(buf))
      try {
        if (page > pdf.numPages) throw new Error('页码超出范围')
        const viewport = (await pdf.getPage(page)).getViewport({ scale: 1 })
        const scale = Math.min(1600 / viewport.width, 2400 / viewport.height, 2)
        const url = await renderPageAsImage(pdf, page, { scale, toDataURL: true, canvasImport: () => import('@napi-rs/canvas') })
        return { success: true, contentItems: [{ type: 'inputText', text: entry.name + ' 第 ' + page + ' 页' }, { type: 'inputImage', imageUrl: url }] }
      } finally { await pdf.loadingTask.destroy() }
    }
    const mime = detectImageMime(buf)
    if (!mime) throw new Error('不支持的图片格式')
    return { success: true, contentItems: [{ type: 'inputText', text: entry.name }, { type: 'inputImage', imageUrl: 'data:' + mime + ';base64,' + buf.toString('base64') }] }
  }
  async tools(scope, root, taskId, options = {}) {
    const catalog = await this.catalog(scope, root, options), artifacts = []
    const spec = (name, description, properties, required = []) => ({ type: 'function', name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } })
    const string = { type: 'string' }, number = { type: 'integer' }
    return {
      artifacts,
      specs: [
        spec('materials_list', '列出当前项目资料及当前会话附件，返回文件编号；支持名称过滤和分页。', { query: string, start: number }),
        spec('materials_read', '按文件编号分段读取。PDF start/count 是页码，最多5页；Excel先不填sheet列工作表，再指定sheet按行读取；其他按行读取，Word保留标题和表格HTML。继续读取next直到null才读完。', { id: string, start: number, count: number, sheet: string }, ['id']),
        spec('materials_image', '查看图片或PDF指定页，扫描PDF和复杂表格需使用本工具识别。', { id: string, page: number }, ['id']),
        spec('deliver_document', '将本次用户要求的交付内容保存为新的Markdown文件，完成后由程序发回当前聊天，不覆盖原件。', { name: string, content: string }, ['name','content']),
      ],
      call: async (name, args, signal) => {
        signal?.throwIfAborted()
        if (!args || typeof args !== 'object') throw new Error('工具参数无效')
        const currentCatalog = new Map(catalog)
        if(options.projectFiles)for(const entry of await options.projectFiles())currentCatalog.set(entry.id,entry)
        if (name === 'materials_list') {
          const list = [...currentCatalog.values()].filter(e => e.name.toLowerCase().includes(String(args.query ?? '').toLowerCase()))
          const start = integer(args.start, 1, 1, 100000)
          return txt({ files: list.slice(start-1,start+99).map(({id,name}) => ({id,name})), total: list.length, next: start+100 <= list.length ? start+100 : null })
        }
        if (name === 'materials_read') {
          const result = await this.parseWorker('read', currentCatalog.get(args.id), args, signal)
          const text = JSON.stringify(result)
          if (text.length > 60000) throw new Error('读取结果过大，请缩小count；单行过大请先拆分源文件。')
          return txt(text)
        }
        if (name === 'materials_image') return this.parseWorker('image', currentCatalog.get(args.id), { page: args.page ?? 1 }, signal)
        if (name === 'deliver_document') {
          if (typeof args.content !== 'string' || args.content.length > 500000) throw new Error('交付内容为空或超过上限')
          if (artifacts.length >= 5) throw new Error('单任务最多交付5份文件')
          const name = basename(String(args.name)).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0,80).replace(/\.md$/i,'') + '.md'
          const dir = join(this.outputDir, taskId); await mkdir(dir, { recursive: true })
          const file = join(dir, (artifacts.length+1) + '-' + name)
          signal?.throwIfAborted(); await writeFile(file, args.content, { encoding: 'utf8', flag: 'wx' })
          artifacts.push({ file, name }); return txt({ saved: true, name, note: '仅已保存，任务完成后由应用发送。' })
        }
        throw new Error('未注册的资料工具')
      },
    }
  }
}
