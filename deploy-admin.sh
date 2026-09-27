#!/usr/bin/env bash
# Deploy the database-only admin. Never start/stop the local Feishu worker.
set -Eeuo pipefail
umask 077
trap 'printf "部署未完成（行 %s）。请检查上方错误；脚本不会删除数据库或旧配置。\n" "$LINENO" >&2' ERR

if [[ "${1:-}" == "--help" ]]; then
  printf '%s\n' '用法：bash deploy-admin.sh' \
    '要求：Linux、Docker Engine、Docker Compose >= 2.30（支持 raw env_file）。' \
    '首次交互填写数据库 URL 与 App ID；后续运行保留配置和密码。' \
    '默认仅发布 127.0.0.1:3900，请通过 HTTPS 反向代理访问。' \
    '可选首次环境变量：DEPLOY_DB_URL、DEPLOY_APP_ID、DEPLOY_ADMIN_USERNAME。' \
    '可选端口环境变量：ADMIN_PUBLISH_PORT（默认 3900）、ADMIN_BIND_IP（默认 127.0.0.1）。'
  exit 0
fi
[[ $# -eq 0 ]] || { printf '不支持的参数，请使用 --help。\n' >&2; exit 1; }
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$task_root"
command -v docker >/dev/null || { printf '请先安装 Docker Engine 和 Compose 插件。\n' >&2; exit 1; }
docker info >/dev/null 2>&1 || { printf '无法访问 Docker 引擎，请先启动 Docker 并确认当前账号有权限。\n' >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { printf '请先安装 Docker Compose 插件（>= 2.30）。\n' >&2; exit 1; }
task_compose_version="$(docker compose version --short)"
task_compose_version="${task_compose_version#v}"
IFS=. read -r task_major task_minor _ <<< "$task_compose_version"
if ! [[ "$task_major" =~ ^[0-9]+$ && "$task_minor" =~ ^[0-9]+$ ]] || (( task_major < 2 || (task_major == 2 && task_minor < 30) )); then
  printf '需要 Docker Compose >= 2.30，避免密码哈希中的 $ 被错误展开。\n' >&2
  exit 1
fi
task_state="$task_root/deploy/admin/state"
mkdir -p -- "$task_state"
chmod 700 -- "$task_state"
# Read only deployment settings saved on this host. Explicit environment values win.
if [[ -f "$task_state/deploy.env" ]]; then
  while IFS='=' read -r task_key task_value; do
    case "$task_key" in
      ADMIN_PUBLISH_PORT) [[ -n "${ADMIN_PUBLISH_PORT:-}" ]] || ADMIN_PUBLISH_PORT="$task_value" ;;
      ADMIN_BIND_IP) [[ -n "${ADMIN_BIND_IP:-}" ]] || ADMIN_BIND_IP="$task_value" ;;
    esac
  done < "$task_state/deploy.env"
fi
export ADMIN_PUBLISH_PORT="${ADMIN_PUBLISH_PORT:-3900}"
export ADMIN_BIND_IP="${ADMIN_BIND_IP:-127.0.0.1}"
[[ "$ADMIN_PUBLISH_PORT" =~ ^[1-9][0-9]{0,4}$ ]] && (( ADMIN_PUBLISH_PORT <= 65535 )) || { printf '发布端口无效。\n' >&2; exit 1; }
if [[ "$ADMIN_BIND_IP" != '127.0.0.1' ]]; then
  printf '注意：当前选择非回环监听。请配置 HTTPS 和访问限制，不要通过公网 HTTP 输入管理员密码。\n' >&2
fi
# Prevent Compose from loading the local bot .env or unrelated project overrides.
compose=(docker compose --env-file /dev/null --project-name requirement-assistant-admin -f "$task_root/compose.admin.yaml")

if [[ ! -f "$task_state/app.env" ]]; then
  if [[ -z "${DEPLOY_DB_URL:-}" ]]; then
    [[ -t 0 ]] || { printf '首次非交互部署需要 DEPLOY_DB_URL 和 DEPLOY_APP_ID。\n' >&2; exit 1; }
    read -r -s -p '请输入现有 PostgreSQL 连接 URL（输入隐藏）：' DEPLOY_DB_URL
    printf '\n'
  fi
  if [[ -z "${DEPLOY_APP_ID:-}" ]]; then
    [[ -t 0 ]] || { printf '请设置 DEPLOY_APP_ID。\n' >&2; exit 1; }
    read -r -p '请输入管理平台默认 App ID（cli_ 开头）：' DEPLOY_APP_ID
  fi
  export DEPLOY_DB_URL DEPLOY_APP_ID
  export DEPLOY_ADMIN_USERNAME="${DEPLOY_ADMIN_USERNAME:-admin}"
fi
printf '正在构建独立管理平台镜像……\n'
# Build directly because the initial runtime env_file does not exist yet.
docker build -f Dockerfile.admin -t requirement-assistant-admin:local .
if [[ ! -f "$task_state/app.env" ]]; then
  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --user "$(id -u):$(id -g)" --mount "type=bind,src=$task_state,dst=/setup" \
    -e DEPLOY_DB_URL -e DEPLOY_APP_ID -e DEPLOY_ADMIN_USERNAME \
    requirement-assistant-admin:local node deploy/admin/bootstrap.mjs
fi
unset DEPLOY_DB_URL DEPLOY_APP_ID DEPLOY_ADMIN_USERNAME
chmod 600 -- "$task_state/app.env"
"${compose[@]}" config --quiet
printf '正在检查数据库与企业绑定（不写业务数据）……\n'
"${compose[@]}" run --rm --no-deps admin node deploy/admin/preflight.mjs
printf '正在启动并等待健康检查……\n'
"${compose[@]}" up -d --wait --wait-timeout 120 admin
printf '\n部署成功。监听地址：%s:%s\n' "$ADMIN_BIND_IP" "$ADMIN_PUBLISH_PORT"
printf '配置文件：%s/app.env\n' "$task_state"
if [[ -f "$task_state/initial-password.txt" ]]; then
  printf '初始账号密码：%s/initial-password.txt（妥善保存后删除明文文件）\n' "$task_state"
fi
printf '仅管理服务已启动，飞书和模型处理仍在原本地电脑。公网访问请配置 HTTPS 反向代理。\n'
