import { parentPort, workerData } from 'node:worker_threads'
import { DocumentLibrary } from './documents.js'
const lib = new DocumentLibrary(workerData.dir, workerData.maxBytes)
try {
  const result = workerData.operation === 'image' ? await lib.image(workerData.entry, workerData.args.page) : await lib.read(workerData.entry, workerData.args)
  parentPort.postMessage({ result })
} catch (e) { parentPort.postMessage({ error: e.message }) }
