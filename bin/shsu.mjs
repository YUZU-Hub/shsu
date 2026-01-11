#!/usr/bin/env node

import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ─────────────────────────────────────────────────────────────
// Configuration (via environment variables)
// ─────────────────────────────────────────────────────────────
const config = {
  server: process.env.SHSU_SERVER,
  remotePath: process.env.SHSU_REMOTE_PATH,
  localPath: process.env.SHSU_LOCAL_PATH || './supabase/functions',
  url: process.env.SHSU_URL,
};

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
  return runSync(`ssh ${config.server} "docker ps -q --filter 'name=edge'"`);
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
      `docker restart $(docker ps -q --filter 'name=edge')`,
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
    `docker logs -f $(docker ps -q --filter 'name=edge') --tail ${lines} 2>&1`,
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
    `docker restart $(docker ps -q --filter 'name=edge')`,
  ], { stdio: ['inherit', 'pipe', 'inherit'] });
  success('Restarted');
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
${c.yellow('Required environment variables:')}

  SHSU_SERVER        SSH host for your Coolify server
  SHSU_REMOTE_PATH   Remote path to functions directory
  SHSU_URL           Supabase URL (for invoke command)

${c.yellow('Optional:')}

  SHSU_LOCAL_PATH    Local functions path (default: ./supabase/functions)

${c.yellow('Example .env or shell config:')}

  export SHSU_SERVER="user@your-server.com"
  export SHSU_REMOTE_PATH="/data/coolify/services/abc123/volumes/functions"
  export SHSU_URL="https://your-supabase.example.com"

${c.yellow('Current values:')}

  SHSU_SERVER       = ${config.server || c.dim('(not set)')}
  SHSU_REMOTE_PATH  = ${config.remotePath || c.dim('(not set)')}
  SHSU_URL          = ${config.url || c.dim('(not set)')}
  SHSU_LOCAL_PATH   = ${config.localPath}
`);
}

function cmdHelp() {
  console.log(`
${c.blue('shsu')} - Self-Hosted Supabase Utilities

${c.yellow('Usage:')}
  shsu <command> [options]

${c.yellow('Commands:')}
  deploy [name]        Deploy function(s) to server
                       - No args: deploy all functions
                       - With name: deploy single function
                       Options: --no-restart

  logs [filter]        Stream edge-runtime logs
                       - Optional filter string

  list                 List functions (local and remote)

  invoke <n> [json]   Invoke a function

  restart              Restart edge-runtime container

  new <name>           Create new function from template

  env                  Show required environment variables

${c.yellow('Examples:')}
  shsu deploy
  shsu deploy hello-world
  shsu deploy hello-world --no-restart
  shsu logs
  shsu logs hello-world
  shsu invoke hello-world '{"name":"Stefan"}'
  shsu new my-function

${c.yellow('Setup:')}
  Run 'shsu env' to see required environment variables.
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
      case 'new':
      case 'create':
        await cmdNew(args[1]);
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
