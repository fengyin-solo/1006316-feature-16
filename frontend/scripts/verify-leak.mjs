// 渗漏处置业务不变量验证：用 esbuild（devDependencies 已含）打包 TS 后用 node 运行，无需浏览器。
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(os.tmpdir(), 'verify-leak.mjs')

await build({
  entryPoints: [path.join(root, 'scripts', 'verify-leak.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  alias: { '@': path.join(root, 'src') },
})

execFileSync(process.execPath, [out], { stdio: 'inherit' })
fs.rmSync(out, { force: true })
