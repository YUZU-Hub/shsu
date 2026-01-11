# shsu

**S**elf-**H**osted **S**upabase **U**tilities

Deploy and manage Supabase Edge Functions and migrations on Coolify-hosted Supabase.

## Install

```bash
npm install -g shsu
# or use directly
npx shsu
```

## Setup

Run the init command to configure your project:

```bash
npx shsu init
```

This adds config to your `package.json`:

```json
{
  "shsu": {
    "server": "root@your-coolify-server",
    "remotePath": "/data/coolify/services/YOUR_SERVICE_ID/volumes/functions",
    "url": "https://your-supabase.example.com",
    "edgeContainer": "edge",
    "dbContainer": "postgres"
  }
}
```

### Finding Configuration Values

**remotePath** - SSH to your server and run:
```bash
docker inspect $(docker ps -q --filter 'name=edge') | grep -A 5 "Mounts"
```

**Container names** - SSH to your server and run `docker ps` to list containers. Coolify names containers using the pattern `<service>-<uuid>` (e.g., `abc123-supabase-edge-functions-1`). The filter does substring matching, so `edge` matches any container with "edge" in its name.

## Usage

```bash
# Configure project
shsu init

# Show current configuration
shsu env

# Deploy all functions
shsu deploy

# Deploy single function
shsu deploy hello-world

# Deploy without restarting edge-runtime
shsu deploy hello-world --no-restart

# Run database migrations
shsu migrate

# Stream logs
shsu logs

# Stream logs filtered by function name
shsu logs hello-world

# List local and remote functions
shsu list

# Invoke a function
shsu invoke hello-world '{"name":"Stefan"}'

# Create new function from template
shsu new my-function

# Restart edge-runtime
shsu restart
```

## Migrations

Place SQL files in `./supabase/migrations/` (or your configured `migrationsPath`). Files are sorted alphabetically and executed in order.

```
supabase/migrations/
  001_create_users.sql
  002_add_email_index.sql
```

Run with:
```bash
shsu migrate
```

## Configuration

Config is read from `package.json` "shsu" key. Environment variables override package.json values.

| Key / Env Var | Required | Description |
|---------------|----------|-------------|
| `server` / `SHSU_SERVER` | Yes | SSH host (e.g., `root@your-server.com`) |
| `remotePath` / `SHSU_REMOTE_PATH` | Yes | Remote path to functions directory |
| `url` / `SHSU_URL` | For `invoke` | Supabase URL |
| `localPath` / `SHSU_LOCAL_PATH` | No | Local functions path (default: `./supabase/functions`) |
| `migrationsPath` / `SHSU_MIGRATIONS_PATH` | No | Local migrations path (default: `./supabase/migrations`) |
| `edgeContainer` / `SHSU_EDGE_CONTAINER` | No | Edge runtime container filter (default: `edge`) |
| `dbContainer` / `SHSU_DB_CONTAINER` | No | Database container filter (default: `postgres`) |

## MCP Server

shsu can run as an MCP server for AI assistants.

### Claude Code

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "shsu": {
      "command": "npx",
      "args": ["shsu", "mcp"]
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "shsu": {
      "command": "npx",
      "args": ["shsu", "mcp"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "shsu": {
      "command": "npx",
      "args": ["shsu", "mcp"]
    }
  }
}
```

### Available MCP Tools

- `deploy` - Deploy edge functions
- `migrate` - Run database migrations
- `list` - List local and remote functions
- `invoke` - Invoke a function
- `restart` - Restart edge-runtime
- `new` - Create new function from template
- `config` - Show current configuration

## Releasing

```bash
npm version patch   # or minor/major
git push --follow-tags
```

GitHub Actions will automatically publish to npm when the tag is pushed.

## License

MIT
