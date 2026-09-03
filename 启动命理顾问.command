#!/bin/zsh
# 「双术互证命理顾问」一键启动：双击本文件即可
# - 服务没跑：启动服务并打开页面（关掉本 Terminal 窗口 = 停止服务）
# - 服务已在跑：直接打开页面

cd "$(dirname "$0")"

# 优先用受管 node，找不到再退回 PATH
NODE="node"
MANAGED="/Users/yanqiu/.workbuddy/binaries/node/versions/22.22.2-2/bin/node"
[[ -x "$MANAGED" ]] && NODE="$MANAGED"

# 本地探活必须绕过代理（系统代理开着时 curl 会拿到 502 假故障）
if curl -s --noproxy '*' -m 2 http://127.0.0.1:3766/ >/dev/null 2>&1; then
  echo "服务已在运行，直接打开页面..."
  open "http://127.0.0.1:3766"
  exit 0
fi

echo "启动命理顾问服务（http://127.0.0.1:3766，关掉本窗口即停止）..."
"$NODE" src/server.js &
SERVER_PID=$!

# 等服务就绪，最多 10 秒
for i in {1..20}; do
  curl -s --noproxy '*' -m 1 http://127.0.0.1:3766/ >/dev/null 2>&1 && break
  sleep 0.5
done

open "http://127.0.0.1:3766"

# 前台等住服务进程，窗口不关服务不停
wait $SERVER_PID
