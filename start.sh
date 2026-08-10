#!/usr/bin/env sh
# Copyright 2026 YAS Softwares LTDA
# SPDX-License-Identifier: Apache-2.0
#
# Start everything, and say what is wrong when it cannot.
#
# The rest of this repository assumes you are working *on* the harness: Node,
# npm, a database you manage. This script assumes you want to *use* it. It
# checks the machine, prepares what is missing, starts the stack and tells you
# where to go.
#
# Written for `sh`, not bash, and tested on macOS and Linux. macOS ships bash
# 3.2 — old enough that half the bash people write does not run there — so
# nothing here needs a version of anything.

set -eu

RED=''
GREEN=''
YELLOW=''
DIM=''
BOLD=''
OFF=''
if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  RED=$(printf '\033[31m')
  GREEN=$(printf '\033[32m')
  YELLOW=$(printf '\033[33m')
  DIM=$(printf '\033[2m')
  BOLD=$(printf '\033[1m')
  OFF=$(printf '\033[0m')
fi

ok() { printf '  %s✓%s %s\n' "$GREEN" "$OFF" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$OFF" "$1"; }
step() { printf '\n%s%s%s\n' "$BOLD" "$1" "$OFF"; }
hint() { printf '    %s%s%s\n' "$DIM" "$1" "$OFF"; }

fail() {
  printf '\n  %s✗%s %s\n' "$RED" "$OFF" "$1"
  shift
  for line in "$@"; do hint "$line"; done
  printf '\n'
  exit 1
}

cd "$(dirname "$0")"

CONSOLE_PORT_DEFAULT=4100
DB_PORT_DEFAULT=4000

printf '\n%syas-harness%s\n' "$BOLD" "$OFF"
hint "Starting Postgres, the schema, a tenant and the console."

# --- 1. What are we on? -----------------------------------------------------

step 'Checking this machine'

case "$(uname -s)" in
  Darwin) OS='macOS' ;;
  Linux) OS='Linux' ;;
  *) OS="$(uname -s)" ;;
esac
ok "$OS"

# --- 2. Docker --------------------------------------------------------------

if ! command -v docker >/dev/null 2>&1; then
  if [ "$OS" = 'macOS' ]; then
    fail 'Docker is not installed.' \
      'Install Docker Desktop:  https://docs.docker.com/desktop/install/mac-install/' \
      'Or with Homebrew:        brew install --cask docker' \
      'Then open Docker Desktop once, and run this script again.'
  else
    fail 'Docker is not installed.' \
      'Install Docker Engine:   https://docs.docker.com/engine/install/' \
      'On Debian or Ubuntu:     curl -fsSL https://get.docker.com | sh' \
      'Then add yourself to the docker group so it runs without sudo:' \
      '  sudo usermod -aG docker "$USER"  (log out and back in)'
  fi
fi
ok 'Docker is installed'

# `docker info` talks to the daemon. `docker --version` does not, which is why
# it is not the check: a stopped Docker Desktop answers the second happily.
if ! docker info >/dev/null 2>&1; then
  if [ "$OS" = 'macOS' ]; then
    fail 'Docker is installed but not running.' \
      'Open Docker Desktop and wait for the whale to stop animating.' \
      'Then run this script again.'
  else
    fail 'Docker is installed but not running, or you cannot reach it.' \
      'Start it:  sudo systemctl start docker' \
      'If it is running, you may not be in the docker group:' \
      '  sudo usermod -aG docker "$USER"  (log out and back in)'
  fi
fi
ok 'Docker is running'

if ! docker compose version >/dev/null 2>&1; then
  fail 'Docker Compose v2 is not available.' \
    'It ships with Docker Desktop and with recent Docker Engine.' \
    'If you have the old `docker-compose`, upgrade:' \
    '  https://docs.docker.com/compose/install/'
fi
ok 'Docker Compose is available'

# --- 3. Ports ---------------------------------------------------------------

port_taken() {
  # Whoever is listening, without needing lsof, ss or netstat to all exist.
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN
  else
    # No tool to ask with. Better to start and let Docker complain than to
    # refuse over something we could not check.
    return 1
  fi
}

# Ours already holding the port is not a conflict — it is the thing we are
# about to restart.
#
# `.Ports`, not `.Publishers`: the second prints `{0.0.0.0 5432 4000 tcp}`,
# where the published port is the *third* field, so the obvious grep for
# `:4000->` matches nothing and every restart looks like a conflict. `.Ports`
# prints `0.0.0.0:4000->5432/tcp`, which says what it means.
ours_on_port() {
  docker compose ps --format '{{.Ports}}' 2>/dev/null | grep -q ":$1->"
}

CONSOLE_PORT="${CONSOLE_PORT:-$CONSOLE_PORT_DEFAULT}"
DB_PORT="${POSTGRES_PORT:-$DB_PORT_DEFAULT}"

for entry in "$DB_PORT:the database" "$CONSOLE_PORT:the console"; do
  port="${entry%%:*}"
  what="${entry#*:}"
  if port_taken "$port" && ! ours_on_port "$port"; then
    fail "Port $port is already in use, and $what needs it." \
      "Find what has it:  lsof -nP -iTCP:$port -sTCP:LISTEN" \
      'Then stop that, or choose another port in .env:' \
      "  POSTGRES_PORT=  and  CONSOLE_PORT=" \
      'and run this script again.'
  fi
done
ok "Ports $DB_PORT and $CONSOLE_PORT are free"

# --- 4. Configuration -------------------------------------------------------

step 'Preparing configuration'

if [ ! -f .env ]; then
  cp .env.example .env
  ok 'Created .env from .env.example'
else
  ok '.env is there'
fi

# Which vendor answers is yours, so the file that says so is yours: copied once
# and never versioned, the same as config/connectors.json. Editing the example
# instead would put your choice in everybody's fork.
if [ ! -f config/models.json ]; then
  cp config/models.example.json config/models.json
  ok 'Created config/models.json from the example'
  hint 'It is yours -- not in Git. Change providers, models and routes freely,'
  hint 'by hand or on the console Config page.'
else
  ok 'config/models.json is there'
fi

# The master key seals every credential. Generated rather than asked for: a key
# somebody has to invent is a key somebody will make short.
if ! grep -qE '^MASTER_ENCRYPTION_KEY=.+' .env; then
  if command -v openssl >/dev/null 2>&1; then
    KEY=$(openssl rand -base64 32)
  else
    KEY=$(head -c 32 /dev/urandom | base64)
  fi
  printf '\nMASTER_ENCRYPTION_KEY=%s\n' "$KEY" >>.env
  ok 'Generated a master encryption key'
  hint 'It seals every stored credential. Losing it means reconnecting everything.'
else
  ok 'Master encryption key is set'
fi

if grep -qE '^[A-Z][A-Z0-9_]*_API_KEY=.+' .env; then
  ok 'A model key is set in .env'
else
  warn 'No model key in .env — that is fine, and usually right'
  hint 'Paste your keys on the console Keys page instead: they are encrypted'
  hint 'there, never written to a file, and belong to you rather than to this'
  hint 'deployment. .env is for a key the whole deployment should share.'
fi

# --- 5. Start ---------------------------------------------------------------

step 'Starting'
hint 'The first run builds images; expect a few minutes.'

# --force-recreate because compose decides whether to recreate a container from
# the *service definition*, and the contents of `.env` are not part of it. Add a
# key to `.env`, run `docker compose up -d`, and the running container keeps the
# environment it started with — which looks exactly like the key not working.
# This script exists so that never happens; a recreate costs seconds.
if ! docker compose up -d --build --force-recreate; then
  fail 'Compose could not start everything.' \
    'The output above says which service failed.' \
    'To see more:  docker compose logs'
fi

# Compose returning does not mean the console is answering: it starts after the
# migrations and the tenant, and Next takes a moment more.
printf '\n'
i=0
until curl -fsS "http://127.0.0.1:$CONSOLE_PORT/" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    fail 'The console did not come up.' \
      'What it says:  docker compose logs console' \
      'What the database says:  docker compose logs postgres'
  fi
  printf '  %swaiting for the console… %ss%s\r' "$DIM" "$i" "$OFF"
  sleep 2
done
printf '                                        \r'
ok 'The console is up'

# --- 6. Where to go ---------------------------------------------------------

printf '\n%sOpen%s  http://localhost:%s\n' "$BOLD" "$OFF" "$CONSOLE_PORT"
printf '\n%sFrom there%s\n' "$BOLD" "$OFF"
hint 'Connections  connect a source over OAuth — start with GitHub'
hint 'Playground   talk to the agent and watch the trace beside it'
hint 'Traces       every step of every turn'
hint 'Cost         what it spent, by model, task, day and conversation'
printf '\n%sWhen you are done%s\n' "$BOLD" "$OFF"
hint 'docker compose down          stop it, keep the data'
hint 'docker compose down -v       stop it and erase everything'
printf '\n'
