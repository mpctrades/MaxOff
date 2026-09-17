#!/usr/bin/env bash
#
# Blue-green deploy for MaxOff. Runs on the VPS, as root:
#
#     sudo /opt/maxoff/deploy/deploy.sh            # deploy what is on disk
#     sudo /opt/maxoff/deploy/deploy.sh status     # which colour is live
#     sudo /opt/maxoff/deploy/deploy.sh rollback   # switch back to the other
#
# Push the source first, from a working copy:
#
#     rsync -az --delete --rsync-path="sudo rsync" \
#       --exclude '.git/' --exclude 'node_modules/' --exclude '.env' \
#       --exclude 'build/' --exclude '.shopify/' --exclude '.react-router/' \
#       ./ devteam01@<host>:/opt/maxoff/
#
# The shape of it: the live colour serves every request until the very last
# step. We build the *idle* colour, wait for Docker to call it healthy, prove
# it answers /healthz on its own port, then point nginx at it and reload.
# nginx's reload is graceful — in-flight requests finish on the old workers —
# so there is no window where nothing is listening. That window used to be
# 9.7 seconds of 502s on every deploy.
#
# The old colour is stopped, never removed, so `rollback` is one nginx reload
# away and does not need a rebuild.

set -euo pipefail

APP_DIR=/opt/maxoff
ACTIVE_FILE=/etc/nginx/maxoff/dev-active-upstream.conf
HEALTH_URL_HOST=127.0.0.1
BLUE_PORT=3010
GREEN_PORT=3011

port_for() { [[ $1 == blue ]] && echo "$BLUE_PORT" || echo "$GREEN_PORT"; }

die() { echo "deploy: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run me with sudo — this reloads nginx"
[[ -f $ACTIVE_FILE ]] || die "$ACTIVE_FILE is missing; see deploy/nginx/dev-active-upstream.conf"

# Which colour nginx is currently sending traffic to.
live_port=$(grep -oE '127\.0\.0\.1:[0-9]+' "$ACTIVE_FILE" | cut -d: -f2)
case "$live_port" in
  "$BLUE_PORT")  live=blue;  idle=green ;;
  "$GREEN_PORT") live=green; idle=blue  ;;
  *) die "cannot read a known port from $ACTIVE_FILE (got '${live_port:-nothing}')" ;;
esac
idle_port=$(port_for "$idle")

cd "$APP_DIR"

case "${1:-deploy}" in
  status)
    echo "live:  $live (127.0.0.1:$live_port)"
    echo "idle:  $idle (127.0.0.1:$idle_port)"
    COMPOSE_PROFILES=blue,green docker compose ps -a \
      --format "table {{.Service}}\t{{.Status}}"
    exit 0
    ;;

  rollback)
    # The other colour still exists, stopped, holding the previous build.
    docker compose start "app-$idle" >/dev/null 2>&1 \
      || die "no stopped app-$idle to roll back to"
    for _ in $(seq 1 30); do
      curl -fsS --max-time 3 "http://$HEALTH_URL_HOST:$idle_port/healthz" >/dev/null \
        && break
      sleep 1
    done
    curl -fsS --max-time 3 "http://$HEALTH_URL_HOST:$idle_port/healthz" >/dev/null \
      || die "app-$idle came up but will not serve /healthz"
    ;;

  deploy)
    echo "deploy: live is $live; building $idle on port $idle_port"
    # --wait blocks until the healthcheck passes, so nothing below runs
    # against a container that is still applying migrations.
    docker compose up -d --build --wait "app-$idle"

    # Docker says healthy; confirm it ourselves through the published port,
    # which is the path nginx will actually use.
    curl -fsS --max-time 5 "http://$HEALTH_URL_HOST:$idle_port/healthz" >/dev/null \
      || die "app-$idle is healthy to Docker but does not answer on $idle_port"
    ;;

  *) die "unknown command '${1}' — expected deploy, status or rollback" ;;
esac

# Point nginx at the new colour. Keep the old line so a bad config can be put
# back before anything is reloaded.
previous=$(cat "$ACTIVE_FILE")
printf 'server %s:%s;\n' "$HEALTH_URL_HOST" "$idle_port" > "$ACTIVE_FILE"

if ! nginx -t 2>/dev/null; then
  printf '%s\n' "$previous" > "$ACTIVE_FILE"
  nginx -t >&2 || true
  die "nginx rejected the new config; reverted, nothing was reloaded"
fi

systemctl reload nginx
echo "deploy: nginx now serves $idle (127.0.0.1:$idle_port)"

# Only now is the old colour idle. Stopped, not removed, so `rollback` is
# instant and the previous build stays on the box.
docker compose stop "app-$live" >/dev/null 2>&1 || true
echo "deploy: stopped app-$live (kept for rollback)"
