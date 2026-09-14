#!/usr/bin/env bash
# pi-git-sync Bootstrap Script
#
# 在新机器上自动完成首次安装。
# 用法：
#   bash <(curl -s https://raw.githubusercontent.com/<user>/<repo>/main/scripts/bootstrap.sh)
#   或
#   ./scripts/bootstrap.sh <config-repo-url>
#
set -euo pipefail

REPO_URL="${1:-}"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info() { echo -e "${GREEN}[INFO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

echo ""
echo "============================================"
echo "  pi-git-sync Bootstrap"
echo "============================================"
echo ""

# 1. 检查 git
if ! command -v git &>/dev/null; then
	error "git is not installed. Please install git first."
	exit 1
fi
info "git: $(git --version)"

# 2. 检查 pi
if ! command -v pi &>/dev/null; then
	error "pi is not installed. Please install pi first."
	error "Visit: https://pi.dev"
	exit 1
fi
info "pi: $(pi --version 2>/dev/null || echo 'installed')"

# 3. 检查 SSH（如果使用 SSH URL）
if [[ "${REPO_URL}" == git@* ]] || [[ "${REPO_URL}" == ssh://* ]]; then
	if ! ssh -T git@github.com 2>&1 | grep -q "successfully authenticated"; then
		warn "SSH connection to GitHub could not be verified."
		warn "Please ensure your SSH key is configured: https://docs.github.com/en/authentication/connecting-to-github-with-ssh"
	else
		info "SSH: connected to GitHub"
	fi
fi

# 4. 确定配置仓库 URL
if [[ -z "${REPO_URL}" ]]; then
	warn "No config repo URL provided."
	warn "Usage: ./bootstrap.sh git@github.com:<user>/pi-config.git"
	echo ""
	read -r -p "Enter your config repo URL: " REPO_URL
	if [[ -z "${REPO_URL}" ]]; then
		error "No URL provided. Exiting."
		exit 1
	fi
fi

# 5. 安装 pi-git-sync 扩展
#
# 配置仓库是用户数据，不是 Pi package。把配置仓库安装成 package 会导致
# 仓库里的扩展被重复加载，也会让 bootstrap 在本地路径和分支上产生隐式假设。
# 始终安装未固定版本的唯一 package source。旧脚本安装固定版本，Pi 会将其
# 视为另一个 source，从而同时加载两个扩展并把重复的 /pisync 命名为
# /pisync1、/pisync2。先只移除带版本号的旧 source，再安装当前 source。
PI_GIT_SYNC_PACKAGE="npm:@xyzensun/pi-sync"
# 清理带版本号的旧 source：既包括本包的固定版本，也包括上游 @jachy/pi-git-sync
# 的任意安装（改名后它已是另一个扩展，留着会重复注册 /pisync）。
LEGACY_PACKAGES="$(pi list 2>/dev/null | awk '/^[[:space:]]+npm:@xyzensun\/pi-sync@[^[:space:]]+$/ || /^[[:space:]]+npm:@jachy\/pi-git-sync(@[^[:space:]]+)?$/ { print $1 }')"

if [[ -n "${LEGACY_PACKAGES}" ]]; then
	while IFS= read -r legacy_package; do
		[[ -z "${legacy_package}" ]] && continue
		info "Removing legacy ${legacy_package}..."
		if ! pi remove "${legacy_package}"; then
			error "Failed to remove legacy package ${legacy_package}."
			exit 1
		fi
	done <<<"${LEGACY_PACKAGES}"
fi

info "Config repository: ${REPO_URL}"
info "Installing ${PI_GIT_SYNC_PACKAGE}..."
if ! pi install "${PI_GIT_SYNC_PACKAGE}"; then
	error "Failed to install ${PI_GIT_SYNC_PACKAGE}."
	exit 1
fi

# 6. 配置仓库的 clone、分支选择和 state 初始化由 /pisync 负责。
# 这样它们会使用 pi-sync.json 中的 branch，而不是 bootstrap 的硬编码分支。
# 7. 提示下一步
echo ""
info "============================================"
info "  Bootstrap complete!"
info "============================================"
info ""
info "Next steps:"
info "  1. Start pi"
info "  2. Run /pisync and enter the repository URL when prompted"
info "  3. Run /pisync again on any other device to pull then push changes"
info ""
