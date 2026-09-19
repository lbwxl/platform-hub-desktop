import { writeFile } from 'node:fs/promises'

const { doudianHookScript } = await import('../dist/hook.js')
if (typeof doudianHookScript !== 'string' || !doudianHookScript.includes('__platformHub')) {
  throw new Error('Hook 脚本构建结果无效')
}

await writeFile(new URL('../dist/runtime.js', import.meta.url), `if (typeof window !== 'undefined') ${doudianHookScript.trim()}\n`, 'utf8')
