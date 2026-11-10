#!/bin/sh
# Updates a running installation in /opt/pop3d to the latest commit and restarts it.
set -eu
cd /opt/pop3d
runuser -u pop3d -- git pull --ff-only
runuser -u pop3d -- env HOME=/var/lib/pop3d /usr/local/bin/bun install --frozen-lockfile
runuser -u pop3d -- env HOME=/var/lib/pop3d /usr/local/bin/bun run build
systemctl restart pop3d
sleep 2
systemctl --no-pager --lines=5 status pop3d
