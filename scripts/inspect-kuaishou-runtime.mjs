const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /im\.kwaixiaodian\.com\/workbench/i.test(item.url))
if (!target) throw new Error('未找到快手小店 CDP 页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('快手 runtime 诊断超时')), 30_000)
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
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const hook = window.__platformHub
      const scopes = [{ value: window, path: 'window' }]
      try {
        for (let index = 0; index < Math.min(window.frames.length, 12); index += 1) {
          try { scopes.push({ value: window.frames[index], path: 'window.frames[' + index + ']' }) } catch (_) {}
        }
      } catch (_) {}
      const entries = []
      for (const scope of scopes) {
        let names = []
        try { names = Object.getOwnPropertyNames(scope.value) } catch (_) {}
        for (const name of names) {
          if (!/(chat|sdk|store|service|message|session|conversation|goods|product|order|shop|kwai|kuaishou|send|upload)/i.test(name)) continue
          let value
          try { value = scope.value[name] } catch (_) { continue }
          if (!value || !['object', 'function'].includes(typeof value)) continue
          let members = []
          try {
            members = Object.getOwnPropertyNames(value).slice(0, 300).map((key) => {
              let type = 'unknown'
              let arity
              try { type = typeof value[key]; if (type === 'function') arity = value[key].length } catch (_) {}
              return { key, type, arity }
            }).filter((item) => item.type === 'function' || /(message|session|conversation|send|upload|goods|product|order|user|shop|store|sdk|client|current)/i.test(item.key))
          } catch (_) {}
          entries.push({ path: scope.path + '.' + name, type: typeof value, members: members.slice(0, 120) })
        }
      }
      let auth = null
      let diagnosis = []
      let sessions = []
      try { auth = await hook?.getAuthState?.() } catch (error) { auth = { error: String(error?.message || error) } }
      try { diagnosis = await hook?.diagnose?.() || [] } catch (_) {}
      try { sessions = await hook?.listSessions?.() || [] } catch (_) {}
      return {
        url: location.href,
        title: String(window.name || ''),
        hookVersion: hook?.__version,
        auth,
        frameCount: scopes.length - 1,
        diagnosis: diagnosis.slice(0, 40),
        sessions: Array.isArray(sessions) ? sessions.slice(0, 20) : sessions,
        entries: entries.slice(0, 200),
      }
    })()`,
  },
}))

console.log(JSON.stringify(await answer, null, 2))
socket.close()
