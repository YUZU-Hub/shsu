#!/usr/bin/env node

import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

// ─────────────────────────────────────────────────────────────
// Configuration (package.json + environment variables)
// ─────────────────────────────────────────────────────────────
function loadConfig() {
  let pkgConfig = {};

  // Try to load from package.json
  const pkgPath = join(process.cwd(), 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      pkgConfig = pkg.shsu || {};
    } catch (e) {
      // Ignore parse errors
    }
  }

  // Env vars override package.json
  return {
    server: process.env.SHSU_SERVER || pkgConfig.server,
    remotePath: process.env.SHSU_REMOTE_PATH || pkgConfig.remotePath,
    localPath: process.env.SHSU_LOCAL_PATH || pkgConfig.localPath || './supabase/functions',
    migrationsPath: process.env.SHSU_MIGRATIONS_PATH || pkgConfig.migrationsPath || './supabase/migrations',
    url: process.env.SHSU_URL || pkgConfig.url,
    edgeContainer: process.env.SHSU_EDGE_CONTAINER || pkgConfig.edgeContainer || 'edge',
    dbContainer: process.env.SHSU_DB_CONTAINER || pkgConfig.dbContainer || 'postgres',
  };
}

const config = loadConfig();

// ─────────────────────────────────────────────────────────────
// Colors
// ─────────────────────────────────────────────────────────────
const c = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

const info = (msg) => console.log(`${c.blue('▸')} ${msg}`);
const success = (msg) => console.log(`${c.green('✓')} ${msg}`);
const error = (msg) => {
  console.error(`${c.red('✗')} ${msg}`);
  process.exit(1);
};

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function requireVar(name) {
  if (!config[name]) {
    error(`Missing required env var: SHSU_${name.toUpperCase()} (see 'shsu env')`);
  }
}

function requireServer() {
  requireVar('server');
  requireVar('remotePath');
}

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'inherit', ...options });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with code ${code}`));
    });
    proc.on('error', reject);
  });
}

function runSync(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return null;
  }
}

function getEdgeContainer() {
  return runSync(`ssh ${config.server} "docker ps -q --filter 'name=${config.edgeContainer}'"`);
}

// ─────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────

async function cmdDeploy(funcName, noRestart = false) {
  requireServer();

  if (!funcName) {
    info('Deploying all functions...');
    await run('rsync', [
      '-avz', '--delete',
      '--exclude=*.test.ts',
      '--exclude=*.spec.ts',
      `${config.localPath}/`,
      `${config.server}:${config.remotePath}/`,
    ]);
  } else {
    const funcPath = join(config.localPath, funcName);
    if (!existsSync(funcPath)) {
      error(`Function not found: ${funcPath}`);
    }
    info(`Deploying ${funcName}...`);
    await run('rsync', [
      '-avz',
      `${funcPath}/`,
      `${config.server}:${config.remotePath}/${funcName}/`,
    ]);
  }

  if (!noRestart) {
    info('Restarting edge-runtime...');
    await run('ssh', [
      config.server,
      `docker restart $(docker ps -q --filter 'name=${config.edgeContainer}')`,
    ], { stdio: ['inherit', 'pipe', 'inherit'] });
    success(`Deployed${funcName ? ` ${funcName}` : ''}`);
  } else {
    success(`Synced${funcName ? ` ${funcName}` : ''} (no restart)`);
  }
}

async function cmdLogs(filter, lines = 100) {
  requireServer();

  info(`Streaming logs${filter ? ` (filter: ${filter})` : ''}... (Ctrl+C to exit)`);

  const sshArgs = [
    config.server,
    `docker logs -f $(docker ps -q --filter 'name=${config.edgeContainer}') --tail ${lines} 2>&1`,
  ];

  if (filter) {
    const ssh = spawn('ssh', sshArgs, { stdio: ['inherit', 'pipe', 'inherit'] });
    const grep = spawn('grep', ['--line-buffered', '-i', filter], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    ssh.stdout.pipe(grep.stdin);
    
    await new Promise((resolve) => {
      ssh.on('close', resolve);
      grep.on('close', resolve);
    });
  } else {
    await run('ssh', sshArgs);
  }
}

async function cmdList() {
  requireServer();

  info('Remote functions:');
  const remote = runSync(`ssh ${config.server} "ls -1 ${config.remotePath} 2>/dev/null"`);
  if (remote) {
    remote.split('\n').filter(Boolean).forEach((f) => console.log(`  • ${f}`));
  }

  console.log('');
  info('Local functions:');
  if (existsSync(config.localPath)) {
    readdirSync(config.localPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .forEach((d) => console.log(`  • ${d.name}`));
  }
}

async function cmdInvoke(funcName, data = '{}') {
  requireVar('url');

  if (!funcName) {
    error('Usage: shsu invoke <function-name> [json-data]');
  }

  info(`Invoking ${funcName}...`);
  await run('curl', [
    '-s', '-X', 'POST',
    `${config.url}/functions/v1/${funcName}`,
    '-H', 'Content-Type: application/json',
    '-d', data,
  ]);
  console.log('');
}

async function cmdRestart() {
  requireServer();

  info('Restarting edge-runtime...');
  await run('ssh', [
    config.server,
    `docker restart $(docker ps -q --filter 'name=${config.edgeContainer}')`,
  ], { stdio: ['inherit', 'pipe', 'inherit'] });
  success('Restarted');
}

async function cmdMigrate() {
  requireServer();

  if (!existsSync(config.migrationsPath)) {
    error(`Migrations folder not found: ${config.migrationsPath}`);
  }

  // Get list of migration files
  const migrations = readdirSync(config.migrationsPath)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (migrations.length === 0) {
    info('No migration files found.');
    return;
  }

  info(`Found ${migrations.length} migration(s): ${migrations.join(', ')}`);

  // Copy migrations to server
  const remoteMigrationsPath = '/tmp/shsu-migrations';
  info('Syncing migrations to server...');
  await run('rsync', [
    '-avz', '--delete',
    `${config.migrationsPath}/`,
    `${config.server}:${remoteMigrationsPath}/`,
  ]);

  // Find the database container
  const dbContainer = runSync(`ssh ${config.server} "docker ps -q --filter 'name=${config.dbContainer}'"`);
  if (!dbContainer) {
    error(`Database container not found (filter: ${config.dbContainer})`);
  }

  // Run each migration
  for (const migration of migrations) {
    info(`Running ${migration}...`);
    try {
      await run('ssh', [
        config.server,
        `docker exec -i ${dbContainer} psql -U postgres -d postgres -f /tmp/shsu-migrations/${migration}`,
      ]);
      success(`Applied ${migration}`);
    } catch (e) {
      error(`Failed to apply ${migration}: ${e.message}`);
    }
  }

  success('All migrations applied');
}

async function cmdNew(funcName) {
  if (!funcName) {
    error('Usage: shsu new <function-name>');
  }

  const funcPath = join(config.localPath, funcName);
  if (existsSync(funcPath)) {
    error(`Function already exists: ${funcName}`);
  }

  mkdirSync(funcPath, { recursive: true });
  writeFileSync(
    join(funcPath, 'index.ts'),
    `Deno.serve(async (req) => {
  try {
    const { name } = await req.json()
    
    return new Response(
      JSON.stringify({ message: \`Hello \${name}!\` }),
      { headers: { "Content-Type": "application/json" } }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }
})
`
  );

  success(`Created ${funcPath}/index.ts`);
}

function cmdEnv() {
  console.log(`
${c.yellow('Configuration (package.json "shsu" key or environment variables):')}

  server          SSH host for your Coolify server
  remotePath      Remote path to functions directory
  url             Supabase URL (for invoke command)
  localPath       Local functions path (default: ./supabase/functions)
  migrationsPath  Local migrations path (default: ./supabase/migrations)
  edgeContainer   Edge runtime container filter (default: edge)
  dbContainer     Database container filter (default: postgres)

${c.yellow('Current values:')}

  server          = ${config.server || c.dim('(not set)')}
  remotePath      = ${config.remotePath || c.dim('(not set)')}
  url             = ${config.url || c.dim('(not set)')}
  localPath       = ${config.localPath}
  migrationsPath  = ${config.migrationsPath}
  edgeContainer   = ${config.edgeContainer}
  dbContainer     = ${config.dbContainer}

${c.dim('Run "shsu init" to configure via prompts.')}
${c.dim('Find container names in Coolify: Services → Your Service → look for container name prefix')}
`);
}

async function cmdInit() {
  const pkgPath = join(process.cwd(), 'package.json');

  if (!existsSync(pkgPath)) {
    error('No package.json found. Run "npm init" first.');
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (question, defaultVal) =>
    new Promise((resolve) => {
      const prompt = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
      rl.question(prompt, (answer) => {
        resolve(answer.trim() || defaultVal || '');
      });
    });

  console.log(`\n${c.blue('shsu init')} - Configure project\n`);

  const server = await ask('Server (e.g. root@server.com)', config.server);
  const remotePath = await ask('Remote path to functions', config.remotePath);
  const url = await ask('Supabase URL', config.url);
  const localPath = await ask('Local functions path', config.localPath || './supabase/functions');
  const edgeContainer = await ask('Edge container name filter', config.edgeContainer || 'edge');
  const dbContainer = await ask('Database container name filter', config.dbContainer || 'postgres');

  rl.close();

  // Read and update package.json
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  pkg.shsu = {
    server: server || undefined,
    remotePath: remotePath || undefined,
    url: url || undefined,
    localPath: localPath !== './supabase/functions' ? localPath : undefined,
    edgeContainer: edgeContainer !== 'edge' ? edgeContainer : undefined,
    dbContainer: dbContainer !== 'postgres' ? dbContainer : undefined,
  };

  // Remove undefined values
  Object.keys(pkg.shsu).forEach((key) => {
    if (pkg.shsu[key] === undefined) delete pkg.shsu[key];
  });

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  console.log('');
  success('Added shsu config to package.json');
}

// ─────────────────────────────────────────────────────────────
// MCP Server
// ─────────────────────────────────────────────────────────────
async function cmdMcp() {
  const tools = [
    {
      name: 'deploy',
      description: 'Deploy edge function(s) to the server. Syncs via rsync and restarts edge-runtime.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Function name to deploy. If omitted, deploys all functions.' },
          noRestart: { type: 'boolean', description: 'Skip restarting edge-runtime after deploy.' },
        },
      },
    },
    {
      name: 'list',
      description: 'List edge functions (both local and remote).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'invoke',
      description: 'Invoke an edge function with optional JSON data.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Function name to invoke.' },
          data: { type: 'string', description: 'JSON data to send (default: {}).' },
        },
        required: ['name'],
      },
    },
    {
      name: 'restart',
      description: 'Restart the edge-runtime container.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'new',
      description: 'Create a new edge function from template.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name for the new function.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'config',
      description: 'Get current shsu configuration.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'migrate',
      description: 'Run SQL migrations on the database. Syncs migration files via rsync and executes them via psql.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'docs',
      description: 'Get documentation on how to set up and use shsu for deploying Supabase Edge Functions.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];

  const serverInfo = {
    name: 'shsu',
    version: '0.0.1',
  };

  // Helper to write JSON-RPC response
  const respond = (id, result) => {
    const response = { jsonrpc: '2.0', id, result };
    process.stdout.write(JSON.stringify(response) + '\n');
  };

  const respondError = (id, code, message) => {
    const response = { jsonrpc: '2.0', id, error: { code, message } };
    process.stdout.write(JSON.stringify(response) + '\n');
  };

  // Capture output helper
  const captureExec = (cmd) => {
    try {
      return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch (e) {
      return e.message;
    }
  };

  // Tool handlers
  const handleTool = async (name, args = {}) => {
    switch (name) {
      case 'deploy': {
        if (!config.server || !config.remotePath) {
          return { content: [{ type: 'text', text: `Error: server and remotePath must be configured.

To fix, add to package.json:
{
  "shsu": {
    "server": "root@your-server.com",
    "remotePath": "/data/coolify/services/xxx/volumes/functions"
  }
}

Find remotePath by running on your server:
  docker inspect $(docker ps -q --filter 'name=edge') | grep -A 5 "Mounts"` }] };
        }
        const funcName = args.name;
        const noRestart = args.noRestart || false;
        let output = '';

        if (!funcName) {
          output = captureExec(`rsync -avz --delete --exclude='*.test.ts' --exclude='*.spec.ts' "${config.localPath}/" "${config.server}:${config.remotePath}/"`);
        } else {
          const funcPath = join(config.localPath, funcName);
          if (!existsSync(funcPath)) {
            return { content: [{ type: 'text', text: `Error: Function not found: ${funcPath}

To fix, create the function first using the 'new' tool with name: "${funcName}"` }] };
          }
          output = captureExec(`rsync -avz "${funcPath}/" "${config.server}:${config.remotePath}/${funcName}/"`);
        }

        if (!noRestart) {
          output += '\n' + captureExec(`ssh ${config.server} "docker restart \\$(docker ps -q --filter 'name=${config.edgeContainer}')"`);
        }

        return { content: [{ type: 'text', text: `Deployed${funcName ? ` ${funcName}` : ' all functions'}${noRestart ? ' (no restart)' : ''}\n\n${output}` }] };
      }

      case 'list': {
        if (!config.server || !config.remotePath) {
          return { content: [{ type: 'text', text: `Error: server and remotePath must be configured.

To fix, add to package.json:
{
  "shsu": {
    "server": "root@your-server.com",
    "remotePath": "/data/coolify/services/xxx/volumes/functions"
  }
}

Find remotePath by running on your server:
  docker inspect $(docker ps -q --filter 'name=edge') | grep -A 5 "Mounts"` }] };
        }
        const remote = captureExec(`ssh ${config.server} "ls -1 ${config.remotePath} 2>/dev/null"`) || '(none)';
        let local = '(none)';
        if (existsSync(config.localPath)) {
          const dirs = readdirSync(config.localPath, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
          local = dirs.length ? dirs.join('\n') : '(none)';
        }
        return { content: [{ type: 'text', text: `Remote functions:\n${remote}\n\nLocal functions:\n${local}` }] };
      }

      case 'invoke': {
        if (!config.url) {
          return { content: [{ type: 'text', text: `Error: url must be configured for invoke.

To fix, add to package.json:
{
  "shsu": {
    "url": "https://your-supabase.example.com"
  }
}` }] };
        }
        if (!args.name) {
          return { content: [{ type: 'text', text: `Error: function name is required.

Usage: invoke tool with { "name": "function-name", "data": "{\\"key\\": \\"value\\"}" }` }] };
        }
        const data = args.data || '{}';
        const output = captureExec(`curl -s -X POST "${config.url}/functions/v1/${args.name}" -H "Content-Type: application/json" -d '${data}'`);
        return { content: [{ type: 'text', text: output }] };
      }

      case 'restart': {
        if (!config.server) {
          return { content: [{ type: 'text', text: `Error: server must be configured.

To fix, add to package.json:
{
  "shsu": {
    "server": "root@your-server.com"
  }
}` }] };
        }
        const output = captureExec(`ssh ${config.server} "docker restart \\$(docker ps -q --filter 'name=${config.edgeContainer}')"`);
        return { content: [{ type: 'text', text: `Restarted edge-runtime\n\n${output}` }] };
      }

      case 'new': {
        if (!args.name) {
          return { content: [{ type: 'text', text: `Error: function name is required.

Usage: new tool with { "name": "my-function-name" }` }] };
        }
        const funcPath = join(config.localPath, args.name);
        if (existsSync(funcPath)) {
          return { content: [{ type: 'text', text: `Error: Function already exists: ${args.name}

The function already exists at ${funcPath}. To update it, edit the code and use the 'deploy' tool.` }] };
        }
        mkdirSync(funcPath, { recursive: true });
        writeFileSync(
          join(funcPath, 'index.ts'),
          `Deno.serve(async (req) => {
  try {
    const { name } = await req.json()

    return new Response(
      JSON.stringify({ message: \`Hello \${name}!\` }),
      { headers: { "Content-Type": "application/json" } }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }
})
`
        );
        return { content: [{ type: 'text', text: `Created ${funcPath}/index.ts` }] };
      }

      case 'config': {
        return {
          content: [{
            type: 'text',
            text: `Current configuration:\n  server: ${config.server || '(not set)'}\n  remotePath: ${config.remotePath || '(not set)'}\n  url: ${config.url || '(not set)'}\n  localPath: ${config.localPath}\n  migrationsPath: ${config.migrationsPath}\n  edgeContainer: ${config.edgeContainer}\n  dbContainer: ${config.dbContainer}`,
          }],
        };
      }

      case 'migrate': {
        if (!config.server) {
          return { content: [{ type: 'text', text: `Error: server must be configured.

To fix, add to package.json:
{
  "shsu": {
    "server": "root@your-server.com"
  }
}` }] };
        }
        if (!existsSync(config.migrationsPath)) {
          return { content: [{ type: 'text', text: `Error: Migrations folder not found: ${config.migrationsPath}

To fix, create the migrations directory and add .sql files:
  mkdir -p ${config.migrationsPath}

Then add migration files like:
  ${config.migrationsPath}/001_create_tables.sql
  ${config.migrationsPath}/002_add_indexes.sql` }] };
        }
        const migrations = readdirSync(config.migrationsPath)
          .filter((f) => f.endsWith('.sql'))
          .sort();
        if (migrations.length === 0) {
          return { content: [{ type: 'text', text: `No migration files found in ${config.migrationsPath}

Add .sql files to the migrations folder, e.g.:
  ${config.migrationsPath}/001_create_tables.sql

Files are executed alphabetically, so use numeric prefixes for ordering.` }] };
        }
        let output = `Found ${migrations.length} migration(s): ${migrations.join(', ')}\n\n`;
        // Sync migrations
        output += captureExec(`rsync -avz --delete "${config.migrationsPath}/" "${config.server}:/tmp/shsu-migrations/"`) + '\n';
        // Find db container
        const dbContainer = captureExec(`ssh ${config.server} "docker ps -q --filter 'name=${config.dbContainer}'"`);
        if (!dbContainer) {
          return { content: [{ type: 'text', text: `Error: Database container not found (filter: ${config.dbContainer})

To fix:
1. SSH to your server and run: docker ps
2. Find the postgres container name (e.g., abc123-supabase-db-1)
3. Update dbContainer in package.json to match a unique part of the name:
{
  "shsu": {
    "dbContainer": "supabase-db"
  }
}` }] };
        }
        // Run migrations
        for (const migration of migrations) {
          output += `\nRunning ${migration}...\n`;
          output += captureExec(`ssh ${config.server} "docker exec -i ${dbContainer} psql -U postgres -d postgres -f /tmp/shsu-migrations/${migration}"`) + '\n';
        }
        output += '\nAll migrations applied.';
        return { content: [{ type: 'text', text: output }] };
      }

      case 'docs': {
        return {
          content: [{
            type: 'text',
            text: `# shsu - Self-Hosted Supabase Utilities

Deploy and manage Supabase Edge Functions on Coolify-hosted Supabase.

## Project Setup

1. **Configure shsu** by adding to package.json:
\`\`\`json
{
  "shsu": {
    "server": "root@your-coolify-server",
    "remotePath": "/data/coolify/services/YOUR_SERVICE_ID/volumes/functions",
    "url": "https://your-supabase.example.com",
    "edgeContainer": "edge",
    "dbContainer": "postgres"
  }
}
\`\`\`

Or run \`npx shsu init\` for interactive setup.

2. **Find configuration values** by SSH'ing to your server:
   - Container names: \`docker ps\` (Coolify uses pattern \`<service>-<uuid>\`)
   - Remote path: \`docker inspect $(docker ps -q --filter 'name=edge') | grep -A 5 "Mounts"\`

## Directory Structure

\`\`\`
your-project/
├── package.json          # Contains shsu config
├── supabase/
│   ├── functions/        # Edge functions (default localPath)
│   │   ├── hello-world/
│   │   │   └── index.ts
│   │   └── another-func/
│   │       └── index.ts
│   └── migrations/       # SQL migrations (default migrationsPath)
│       ├── 001_create_users.sql
│       └── 002_add_indexes.sql
\`\`\`

## Configuration Options

| Key | Required | Default | Description |
|-----|----------|---------|-------------|
| server | Yes | - | SSH host (e.g., root@server.com) |
| remotePath | Yes | - | Remote path to functions directory |
| url | For invoke | - | Supabase URL |
| localPath | No | ./supabase/functions | Local functions path |
| migrationsPath | No | ./supabase/migrations | Local migrations path |
| edgeContainer | No | edge | Edge runtime container filter |
| dbContainer | No | postgres | Database container filter |

## Edge Function Template

Use \`new\` tool to create functions. Each function needs an index.ts:

\`\`\`typescript
Deno.serve(async (req) => {
  const { name } = await req.json()
  return new Response(
    JSON.stringify({ message: \`Hello \${name}!\` }),
    { headers: { "Content-Type": "application/json" } }
  )
})
\`\`\`

## Workflow

1. Create function: \`new\` tool with function name
2. Edit the function code in supabase/functions/<name>/index.ts
3. Deploy: \`deploy\` tool (syncs via rsync, restarts edge-runtime)
4. Test: \`invoke\` tool with JSON data
5. Debug: Check logs on the server

## Migrations

Place .sql files in supabase/migrations/. They execute alphabetically.
Use \`migrate\` tool to run all migrations via psql in the database container.`,
          }],
        };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  };

  // Process incoming messages
  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    const { id, method, params } = msg;

    switch (method) {
      case 'initialize':
        respond(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo,
        });
        break;

      case 'notifications/initialized':
        // No response needed for notifications
        break;

      case 'tools/list':
        respond(id, { tools });
        break;

      case 'tools/call':
        try {
          const result = await handleTool(params.name, params.arguments || {});
          respond(id, result);
        } catch (e) {
          respond(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
        }
        break;

      default:
        if (id !== undefined) {
          respondError(id, -32601, `Method not found: ${method}`);
        }
    }
  }
}

function cmdHelp() {
  console.log(`
${c.blue('shsu')} - Self-Hosted Supabase Utilities

${c.yellow('Usage:')}
  shsu <command> [options]

${c.yellow('Commands:')}
  init                 Configure shsu for this project

  deploy [name]        Deploy function(s) to server
                       - No args: deploy all functions
                       - With name: deploy single function
                       Options: --no-restart

  migrate              Run SQL migrations on database

  logs [filter]        Stream edge-runtime logs
                       - Optional filter string

  list                 List functions (local and remote)

  invoke <n> [json]    Invoke a function

  restart              Restart edge-runtime container

  new <name>           Create new function from template

  env                  Show current configuration

  mcp                  Start MCP server (for AI assistants)

${c.yellow('Examples:')}
  shsu init
  shsu deploy
  shsu deploy hello-world --no-restart
  shsu migrate
  shsu logs hello-world
  shsu invoke hello-world '{"name":"Stefan"}'
  shsu new my-function

${c.yellow('Setup:')}
  Run 'shsu init' to configure, or set values in package.json "shsu" key.
`);
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'help';

  try {
    switch (cmd) {
      case 'deploy': {
        const noRestart = args.includes('--no-restart');
        const funcName = args[1] === '--no-restart' ? args[2] : args[1];
        await cmdDeploy(funcName, noRestart);
        break;
      }
      case 'logs':
      case 'log':
        await cmdLogs(args[1], args[2] || 100);
        break;
      case 'list':
      case 'ls':
        await cmdList();
        break;
      case 'invoke':
      case 'call':
        await cmdInvoke(args[1], args[2]);
        break;
      case 'restart':
        await cmdRestart();
        break;
      case 'migrate':
      case 'migration':
      case 'migrations':
        await cmdMigrate();
        break;
      case 'new':
      case 'create':
        await cmdNew(args[1]);
        break;
      case 'init':
        await cmdInit();
        break;
      case 'mcp':
        await cmdMcp();
        break;
      case 'env':
      case 'config':
        cmdEnv();
        break;
      case 'help':
      case '-h':
      case '--help':
        cmdHelp();
        break;
      default:
        error(`Unknown command: ${cmd} (try 'shsu help')`);
    }
  } catch (e) {
    error(e.message);
  }
}

main();
