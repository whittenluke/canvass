import fs from 'node:fs/promises'
import path from 'node:path'

const projectRoot = process.cwd()
const appFile = path.join(projectRoot, 'src', 'App.tsx')
const migrationsDir = path.join(projectRoot, 'supabase', 'migrations')

const RPC_CALL_RE = /\.rpc\(\s*['"]([a-zA-Z0-9_]+)['"]/g
const SQL_FN_RE = /create\s+(?:or\s+replace\s+)?function\s+public\.([a-zA-Z0-9_]+)/gi

const readRpcCallsFromApp = async () => {
  const source = await fs.readFile(appFile, 'utf8')
  const names = new Set()
  let match
  while ((match = RPC_CALL_RE.exec(source)) !== null) {
    names.add(match[1])
  }
  return names
}

const readDefinedSqlFunctions = async () => {
  const files = await fs.readdir(migrationsDir)
  const sqlFiles = files.filter((file) => file.endsWith('.sql')).sort()
  const names = new Set()

  for (const sqlFile of sqlFiles) {
    const fullPath = path.join(migrationsDir, sqlFile)
    const sql = await fs.readFile(fullPath, 'utf8')
    let match
    while ((match = SQL_FN_RE.exec(sql)) !== null) {
      names.add(match[1])
    }
  }

  return names
}

const toSortedArray = (values) => [...values].sort((a, b) => a.localeCompare(b))

const main = async () => {
  const rpcCalls = await readRpcCallsFromApp()
  const migrationFunctions = await readDefinedSqlFunctions()

  const missingInMigrations = toSortedArray(
    new Set([...rpcCalls].filter((name) => !migrationFunctions.has(name))),
  )
  const unusedInApp = toSortedArray(
    new Set([...migrationFunctions].filter((name) => !rpcCalls.has(name))),
  )

  console.log(`RPC calls in src/App.tsx: ${rpcCalls.size}`)
  console.log(`Functions defined in supabase/migrations: ${migrationFunctions.size}`)
  console.log('')

  if (missingInMigrations.length > 0) {
    console.log('Missing from migrations (called by app):')
    for (const fn of missingInMigrations) console.log(`- ${fn}`)
    console.log('')
  } else {
    console.log('No missing RPC functions. Migration coverage is complete for App.tsx.')
    console.log('')
  }

  if (unusedInApp.length > 0) {
    console.log('Defined in migrations but not called by App.tsx:')
    for (const fn of unusedInApp) console.log(`- ${fn}`)
    console.log('')
  }

  if (missingInMigrations.length > 0) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
