import { writeFile } from 'node:fs/promises'

const { kuaishouHookScript } = await import('../dist/hook.js')
if (typeof kuaishouHookScript !== 'string' || !kuaishouHookScript.includes('__platformHub')) {
  throw new Error('快手 Hook 脚本构建结果无效')
}

await writeFile(new URL('../dist/runtime.js', import.meta.url), `if (typeof window !== 'undefined') ${kuaishouHookScript.trim()}\n`, 'utf8')
