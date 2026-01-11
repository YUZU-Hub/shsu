# shsu

**S**elf-**H**osted **S**upabase **U**tilities

Deploy and manage Supabase Edge Functions on Coolify-hosted Supabase.

## Install

```bash
npm install -g shsu
# or use directly
npx shsu
```

## Setup

Set the required environment variables in your shell config (`~/.zshrc` or `~/.bashrc`):

```bash
export SHSU_SERVER="root@your-coolify-server"
export SHSU_REMOTE_PATH="/data/coolify/services/YOUR_SERVICE_ID/volumes/functions"
export SHSU_URL="https://your-supabase.example.com"
```

Find your `SHSU_REMOTE_PATH` by running on your server:

```bash
docker inspect $(docker ps -q --filter 'name=edge') | grep -A 5 "Mounts"
```

## Usage

```bash
# Show current configuration
shsu env

# Deploy all functions
shsu deploy

# Deploy single function
shsu deploy hello-world

# Deploy without restarting edge-runtime
shsu deploy hello-world --no-restart

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

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SHSU_SERVER` | Yes | SSH host (e.g., `root@your-server.com`) |
| `SHSU_REMOTE_PATH` | Yes | Remote path to functions directory |
| `SHSU_URL` | For `invoke` | Supabase URL |
| `SHSU_LOCAL_PATH` | No | Local functions path (default: `./supabase/functions`) |

## License

MIT
