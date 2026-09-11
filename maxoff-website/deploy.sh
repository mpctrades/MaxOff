#!/usr/bin/env bash
# Deploy maxoff-website/index.html to the nginx host behind maxoff.mpctrades.com.
#
#   ./deploy.sh                        # user root, docroot auto-detected
#   SSH_USER=ubuntu ./deploy.sh        # different login
#   DOCROOT=/var/www/maxoff ./deploy.sh  # skip detection
#
# Backs up the live file on the server before overwriting, then verifies that
# what the site actually serves matches what was just uploaded.
set -euo pipefail

SSH_USER="${SSH_USER:-root}"
SSH_HOST="${SSH_HOST:-187.52.115.100}"
SITE_URL="${SITE_URL:-https://maxoff.mpctrades.com/}"
LOCAL="$(cd "$(dirname "$0")" && pwd)/index.html"
REMOTE="$SSH_USER@$SSH_HOST"

[ -f "$LOCAL" ] || { echo "!! no index.html next to this script"; exit 1; }

# 1. Where does nginx serve maxoff from?
TARGET="${DOCROOT:-}"
if [ -z "$TARGET" ]; then
  echo "-> detecting docroot on $SSH_HOST"
  TARGET=$(ssh "$REMOTE" "nginx -T 2>/dev/null | grep -A30 'server_name.*maxoff' \
    | grep -m1 -E '^[[:space:]]*root[[:space:]]'" | tr -d ' ;' | sed 's/^root//') || true
  if [ -z "$TARGET" ]; then
    echo "!! could not detect it. Look at the vhost yourself:"
    echo "   ssh $REMOTE \"grep -rl maxoff /etc/nginx/sites-enabled/ /etc/nginx/conf.d/\""
    echo "   ...or locate the file by its current size:"
    echo "   ssh $REMOTE \"find /var/www /srv /usr/share/nginx -name index.html -size -250k -ls 2>/dev/null\""
    echo "   then re-run: DOCROOT=/the/path $0"
    exit 1
  fi
fi
echo "-> docroot: $TARGET"

# 2. Back up the live file, then upload.
STAMP=$(date +%Y%m%d-%H%M%S)
ssh "$REMOTE" "cp -a '$TARGET/index.html' '$TARGET/index.html.bak-$STAMP' \
  && echo '-> backed up to index.html.bak-$STAMP'"
scp "$LOCAL" "$REMOTE:$TARGET/index.html"

# 3. Confirm the site really serves the new bytes.
LOCAL_MD5=$(md5 -q "$LOCAL")
echo "-> uploaded md5: $LOCAL_MD5"
sleep 2
SERVED_MD5=$(curl -s --max-time 900 --retry 2 "$SITE_URL" | md5 -q)
echo "-> served   md5: $SERVED_MD5"
if [ "$LOCAL_MD5" = "$SERVED_MD5" ]; then
  echo "== live and verified: $SITE_URL"
else
  echo "!! mismatch - the site is not serving the new file."
  echo "   Check that $TARGET is the right docroot, then hard-reload."
  exit 1
fi
