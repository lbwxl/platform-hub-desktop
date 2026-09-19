const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /im\.jinritemai\.com/i.test(item.url))
if (!target) throw new Error('未找到抖店 IM CDP 页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP evaluate 超时')), 10_000)
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== 1) return
    clearTimeout(timer)
    if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text))
    else resolve(message.result?.result?.value)
  })
})

socket.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: {
    returnByValue: true,
    expression: `(() => {
      const ctx = window.__mona_pigeon_event?.globalStore?.data?.initContextData
      const roots = {
        ctx,
        im: ctx?.im,
        pigeonIM: ctx?.im?.pigeonIM,
        coreIM: ctx?.im?.pigeonIM?._coreIM,
        mediaUploader: window.ss?._frontStore?.mediaUploader,
      }

      function describe(value) {
        const output = []
        let current = value
        const visited = new Set()
        for (let depth = 0; current && depth < 8 && !visited.has(current); depth += 1) {
          visited.add(current)
          const methods = []
          for (const name of Object.getOwnPropertyNames(current)) {
            let fn
            try { fn = value[name] } catch (_) { continue }
            if (typeof fn !== 'function' || !/^(send(Text|Message)|createMessage|sendFile|sendImage|upload|customRequestUpload|checkCanSendMessage|sendInConversationGuard|setFileList|addFileList|formateUploadType)/i.test(name)) continue
            methods.push({ name, arity: fn.length, source: String(fn).slice(0, 5000) })
          }
          if (methods.length) output.push({ depth, methods })
          current = Object.getPrototypeOf(current)
        }
        return output
      }

      return Object.fromEntries(Object.entries(roots).map(([name, value]) => [name, describe(value)]))
    })()`,
  },
}))

console.log(JSON.stringify(await answer, null, 2))
socket.close()
