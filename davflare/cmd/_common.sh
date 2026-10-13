#!/bin/bash
#
# Davflare 飞牛 fnOS 生命周期脚本公共函数。
#
# 本文件不是生命周期脚本（fnOS 只会调用 cmd/ 下约定的那几个固定名字），
# 它只被 cmd/ 下的脚本 source，用来保证「配置读取 / 写入」只有一份实现，
# 避免安装、升级、配置三条路径写出不一致的运行时配置。
#
# 约定：
#   * 向导字段统一 wizard_ 前缀，通过环境变量传入，这里用 printenv 取值（避免 eval 注入）。
#   * 非敏感配置写入 ${TRIM_PKGVAR}/conf/davflare.env（可被 bash source）。
#   * WebDAV 密码单独存 ${TRIM_PKGVAR}/conf/password（权限 600），避免 shell 引号转义问题。
#

# ---------------------------------------------------------------------------
# 路径
# ---------------------------------------------------------------------------
DAVFLARE_APPDEST="${TRIM_APPDEST:-/var/apps/davflare/target}"
DAVFLARE_PKGVAR="${TRIM_PKGVAR:-/var/apps/davflare/var}"
DAVFLARE_PKGTMP="${TRIM_PKGTMP:-/var/apps/davflare/tmp}"
DAVFLARE_PKGETC="${TRIM_PKGETC:-/var/apps/davflare/etc}"
DAVFLARE_PKGHOME="${TRIM_PKGHOME:-/var/apps/davflare/home}"

DAVFLARE_CONF_DIR="${DAVFLARE_PKGVAR}/conf"
DAVFLARE_ENV_FILE="${DAVFLARE_CONF_DIR}/davflare.env"
DAVFLARE_PASSWORD_FILE="${DAVFLARE_CONF_DIR}/password"
DAVFLARE_PID_FILE="${DAVFLARE_PKGVAR}/davflare.pid"
DAVFLARE_LOG_FILE="${DAVFLARE_PKGVAR}/davflare.log"
DAVFLARE_SERVER_JS="${DAVFLARE_APPDEST}/server/server.cjs"
DAVFLARE_WWW_DIR="${DAVFLARE_APPDEST}/www"

DAVFLARE_DEFAULT_PORT=8087

# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------

davflare_log() {
    # 生命周期脚本直接写标准输出/标准错误，交给飞牛框架统一收集。
    printf '[davflare] %s\n' "$*" >&2
}

davflare_fail() {
    # 失败时把用户可见的错误写进 TRIM_TEMP_LOGFILE，再以非零码退出。
    if [ -n "${TRIM_TEMP_LOGFILE:-}" ]; then
        printf '[davflare] %s\n' "$*" >>"${TRIM_TEMP_LOGFILE}" 2>/dev/null || true
    fi
    davflare_log "错误：$*"
    return 1
}

# 读取向导字段（同时也是环境变量名）。缺失或为空时返回默认值。
davflare_wizard() {
    local name="$1"
    local def="${2:-}"
    local val=""
    val="$(printenv "${name}" 2>/dev/null || true)"
    if [ -z "${val}" ]; then
        val="${def}"
    fi
    printf '%s' "${val}"
}

# 把任意字符串安全地写成 bash 单引号字面量。
davflare_sq() {
    printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# 端口校验：必须是 1-65535 的十进制整数。
davflare_check_port() {
    local port="$1"
    case "${port}" in
        ''|*[!0-9]*) return 1 ;;
    esac
    [ "${port}" -ge 1 ] 2>/dev/null || return 1
    [ "${port}" -le 65535 ] 2>/dev/null || return 1
    return 0
}

# 布尔型向导字段归一化为 0/1。
davflare_bool01() {
    case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
        1|true|yes|y|on|开启|是) printf '1' ;;
        *) printf '0' ;;
    esac
}

# 回收站保留天数：空串表示不自动清理。
davflare_check_days() {
    case "${1:-}" in
        '') return 0 ;;
        *[!0-9]*) return 1 ;;
    esac
    return 0
}

# ---------------------------------------------------------------------------
# 定位 Node 运行时
# ---------------------------------------------------------------------------
# manifest 里通过 install_dep_apps = nodejs_v24 声明依赖，但不同系统版本的
# 运行时包目录名可能不同，这里按优先级探测，最后回落到 PATH 里的 node。
davflare_find_node() {
    local candidate
    if [ -n "${DAVFLARE_NODE:-}" ] && [ -x "${DAVFLARE_NODE}" ]; then
        printf '%s' "${DAVFLARE_NODE}"
        return 0
    fi
    for candidate in \
        /var/apps/nodejs_v24/target/bin/node \
        /var/apps/nodejs_v22/target/bin/node \
        /var/apps/nodejs_v20/target/bin/node \
        /var/apps/nodejs_v18/target/bin/node \
        /var/apps/nodejs/target/bin/node \
        /usr/local/bin/node \
        /usr/bin/node
    do
        if [ -x "${candidate}" ]; then
            printf '%s' "${candidate}"
            return 0
        fi
    done
    candidate="$(command -v node 2>/dev/null || true)"
    if [ -n "${candidate}" ]; then
        printf '%s' "${candidate}"
        return 0
    fi
    return 1
}

# ---------------------------------------------------------------------------
# 目录准备
# ---------------------------------------------------------------------------
davflare_prepare_dirs() {
    mkdir -p "${DAVFLARE_CONF_DIR}" 2>/dev/null || true
    mkdir -p "${DAVFLARE_PKGVAR}/meta" 2>/dev/null || true
    mkdir -p "${DAVFLARE_PKGVAR}/tmp" 2>/dev/null || true
    mkdir -p "${DAVFLARE_PKGTMP}" 2>/dev/null || true
    mkdir -p "${DAVFLARE_PKGHOME}" 2>/dev/null || true
    chmod 700 "${DAVFLARE_CONF_DIR}" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# 解析数据目录
# ---------------------------------------------------------------------------
# 优先级：
#   1. 向导里用户显式填写的 wizard_data_dir
#   2. config/resource 声明的共享目录（TRIM_DATA_SHARE_PATHS，冒号分隔，取第一个）
#   3. 用户在应用设置里授权给本应用的目录（TRIM_DATA_ACCESSIBLE_PATHS）
#   4. 兜底的 ${TRIM_PKGVAR}/data
davflare_resolve_data_dir() {
    local wizard_dir="$1"
    local resolved=""

    if [ -n "${wizard_dir}" ]; then
        printf '%s' "${wizard_dir}"
        return 0
    fi

    resolved="${TRIM_DATA_SHARE_PATHS:-}"
    resolved="${resolved%%:*}"
    if [ -z "${resolved}" ]; then
        resolved="${TRIM_DATA_ACCESSIBLE_PATHS:-}"
        resolved="${resolved%%:*}"
    fi
    if [ -z "${resolved}" ]; then
        resolved="${DAVFLARE_PKGVAR}/data"
    fi
    printf '%s' "${resolved}"
}

# ---------------------------------------------------------------------------
# 读写运行时配置
# ---------------------------------------------------------------------------

# 读取上一次安装/配置写入的密码（用于「配置页留空 = 保持原密码」）。
davflare_read_old_password() {
    if [ -r "${DAVFLARE_PASSWORD_FILE}" ]; then
        cat "${DAVFLARE_PASSWORD_FILE}" 2>/dev/null || true
    fi
}

# 读取上一次写入的向导值，作为配置向导留空时的回退。
davflare_read_old_env() {
    local key="$1"
    if [ ! -r "${DAVFLARE_ENV_FILE}" ]; then
        return 0
    fi
    # shellcheck disable=SC1090
    ( . "${DAVFLARE_ENV_FILE}" 2>/dev/null; eval "printf '%s' \"\${${key}:-}\"" )
}

# 主入口：按当前向导环境变量 + 旧配置，写出 davflare.env 与 password。
#
# 参数：$1 = "install" | "config"
#   安装时不保留旧值（全部以向导为准）；
#   配置时向导留空的字段保留旧值，避免只改一项就把其它配置清掉。
davflare_write_config() {
    local mode="${1:-config}"
    local keep="0"
    [ "${mode}" = "config" ] && keep="1"

    local port="" data_dir_input="" data_dir="" username="" password=""
    local public_read="" public_dir="" public_dir_on="" sites_host="" trash_days="" allow_iframe=""
    local log_req="" frame_ancestors=""
    local brand_name="" brand_logo=""

    # ---- 端口 ----
    port="$(davflare_wizard wizard_port "")"
    if ! davflare_check_port "${port}"; then
        if [ "${keep}" = "1" ]; then
            local old_port
            old_port="$(davflare_read_old_env DAVFLARE_PORT)"
            if davflare_check_port "${old_port}"; then
                port="${old_port}"
            else
                port="${DAVFLARE_DEFAULT_PORT}"
            fi
        else
            port="${DAVFLARE_DEFAULT_PORT}"
        fi
    fi

    # ---- 数据目录 ----
    data_dir_input="$(davflare_wizard wizard_data_dir "")"
    if [ -z "${data_dir_input}" ] && [ "${keep}" = "1" ]; then
        data_dir_input="$(davflare_read_old_env DAVFLARE_DATA_DIR)"
        # 旧值本身就是解析后的结果，直接沿用，避免二次解析到别的目录。
        data_dir="${data_dir_input}"
    fi
    if [ -z "${data_dir}" ]; then
        data_dir="$(davflare_resolve_data_dir "${data_dir_input}")"
    fi

    # ---- WebDAV 凭据 ----
    username="$(davflare_wizard wizard_username "")"
    password="$(davflare_wizard wizard_password "")"
    if [ -z "${username}" ]; then
        if [ "${keep}" = "1" ]; then
            username="$(davflare_read_old_env WEBDAV_USERNAME)"
        fi
        [ -z "${username}" ] && username="admin"
    fi
    if [ -z "${password}" ] && [ "${keep}" = "1" ]; then
        password="$(davflare_read_old_password)"
    fi

    # ---- 可选开关 ----
    public_read="$(davflare_bool01 "$(davflare_wizard wizard_public_read "")")"
    if [ "${keep}" = "1" ] && [ -z "$(davflare_wizard wizard_public_read "")" ]; then
        public_read="$(davflare_read_old_env WEBDAV_PUBLIC_READ)"
        [ -z "${public_read}" ] && public_read="0"
    fi

    # ---- 匿名只读 WebDAV 目录 ----
    # 归一化：去掉首尾斜杠与空白；填 0 / off / 关闭 表示显式关闭（配置页留空=保持不变）；
    # 多段路径 / 反斜杠 / 内部前缀一律视为未配置（fail closed）
    public_dir="$(davflare_wizard wizard_public_dir "")"
    public_dir="$(printf '%s' "${public_dir}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//;s#^/\+##;s#/\+##')"
    case "${public_dir}" in
        0|[Oo][Ff][Ff]|关闭|禁用) public_dir="" ;;
    esac
    case "${public_dir}" in
        ''|.*|*\/**|*\\*) public_dir="" ;;
    esac
    if [ -n "${public_dir}" ] && printf '%s' "${public_dir}" | grep -q '^_\$'; then
        public_dir=""
    fi
    if [ "${keep}" = "1" ] && [ -z "$(davflare_wizard wizard_public_dir "")" ]; then
        public_dir="$(davflare_read_old_env WEBDAV_PUBLIC_DIR)"
    fi

    # 匿名目录的生效开关：目录名与开关同时具备才生效（runtime 侧两级判断）。
    # 关掉开关只是停用，目录名配置保留，随时可再打开。
    public_dir_on="$(davflare_bool01 "$(davflare_wizard wizard_public_dir_on "")")"
    if [ "${keep}" = "1" ] && [ -z "$(davflare_wizard wizard_public_dir_on "")" ]; then
        public_dir_on="$(davflare_bool01 "$(davflare_read_old_env WEBDAV_PUBLIC_DIR_ON)")"
        # 开关是后加的：老配置里没有它。当时既然设了目录名，说明本来就是想启用，
        # 因此按「有目录名即启用」补齐，避免升级后匿名目录静默失效。
        if [ -z "$(davflare_read_old_env WEBDAV_PUBLIC_DIR_ON)" ]; then
            [ -n "${public_dir}" ] && public_dir_on="1"
        fi
    fi

    allow_iframe="$(davflare_bool01 "$(davflare_wizard wizard_allow_iframe "true")")"
    if [ "${keep}" = "1" ] && [ -z "$(davflare_wizard wizard_allow_iframe "")" ]; then
        allow_iframe="$(davflare_read_old_env DAVFLARE_ALLOW_IFRAME)"
        [ -z "${allow_iframe}" ] && allow_iframe="1"
    fi

    sites_host="$(davflare_wizard wizard_sites_host "")"
    if [ -z "${sites_host}" ] && [ "${keep}" = "1" ]; then
        sites_host="$(davflare_read_old_env SITES_HOST)"
    fi

    # ---- 品牌自定义（由服务端在数据目录首次初始化时落盘；这里只透传配置） ----
    brand_name="$(davflare_wizard wizard_brand_name "")"
    brand_name="$(printf '%s' "${brand_name}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    if [ -z "${brand_name}" ] && [ "${keep}" = "1" ]; then
        brand_name="$(davflare_read_old_env BRAND_NAME)"
    fi
    brand_logo="$(davflare_wizard wizard_brand_logo "")"
    brand_logo="$(printf '%s' "${brand_logo}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    if [ -z "${brand_logo}" ] && [ "${keep}" = "1" ]; then
        brand_logo="$(davflare_read_old_env BRAND_LOGO_PATH)"
    fi

    trash_days="$(davflare_wizard wizard_trash_days "")"
    if ! davflare_check_days "${trash_days}"; then
        trash_days=""
    fi
    if [ -z "${trash_days}" ] && [ "${keep}" = "1" ]; then
        trash_days="$(davflare_read_old_env TRASH_RETENTION_DAYS)"
        davflare_check_days "${trash_days}" || trash_days=""
    fi

    log_req="$(davflare_bool01 "$(davflare_wizard wizard_log_requests "")")"
    if [ "${keep}" = "1" ] && [ -z "$(davflare_wizard wizard_log_requests "")" ]; then
        log_req="$(davflare_read_old_env DAVFLARE_LOG)"
        [ -z "${log_req}" ] && log_req="0"
    fi

    frame_ancestors="$(davflare_wizard wizard_frame_ancestors "*")"
    if [ -z "${frame_ancestors}" ] && [ "${keep}" = "1" ]; then
        frame_ancestors="$(davflare_read_old_env DAVFLARE_FRAME_ANCESTORS)"
    fi
    [ -z "${frame_ancestors}" ] && frame_ancestors="*"

    # ---- 落盘 ----
    davflare_prepare_dirs
    mkdir -p "${data_dir}" 2>/dev/null || true

    {
        printf '# 由 Davflare 安装/配置向导自动生成，请勿手工修改。\n'
        printf '# 修改请重新进入 应用中心 -> Davflare -> 设置。\n'
        printf 'DAVFLARE_PORT=%s\n' "$(davflare_sq "${port}")"
        printf 'DAVFLARE_DATA_DIR=%s\n' "$(davflare_sq "${data_dir}")"
        printf 'DAVFLARE_META_DIR=%s\n' "$(davflare_sq "${DAVFLARE_PKGVAR}/meta")"
        printf 'DAVFLARE_TMP_DIR=%s\n' "$(davflare_sq "${DAVFLARE_PKGVAR}/tmp")"
        printf 'DAVFLARE_BUILD_DIR=%s\n' "$(davflare_sq "${DAVFLARE_WWW_DIR}")"
        printf 'WEBDAV_USERNAME=%s\n' "$(davflare_sq "${username}")"
        printf 'WEBDAV_PUBLIC_READ=%s\n' "$(davflare_sq "${public_read}")"
        printf 'WEBDAV_PUBLIC_DIR=%s\n' "$(davflare_sq "${public_dir}")"
        printf 'WEBDAV_PUBLIC_DIR_ON=%s\n' "$(davflare_sq "${public_dir_on}")"
        printf 'SITES_HOST=%s\n' "$(davflare_sq "${sites_host}")"
        printf 'BRAND_NAME=%s\n' "$(davflare_sq "${brand_name}")"
        printf 'BRAND_LOGO_PATH=%s\n' "$(davflare_sq "${brand_logo}")"
        printf 'TRASH_RETENTION_DAYS=%s\n' "$(davflare_sq "${trash_days}")"
        printf 'DAVFLARE_ALLOW_IFRAME=%s\n' "$(davflare_sq "${allow_iframe}")"
        printf 'DAVFLARE_FRAME_ANCESTORS=%s\n' "$(davflare_sq "${frame_ancestors}")"
        printf 'DAVFLARE_LOG=%s\n' "$(davflare_sq "${log_req}")"
    } >"${DAVFLARE_ENV_FILE}.new" && mv "${DAVFLARE_ENV_FILE}.new" "${DAVFLARE_ENV_FILE}"
    chmod 600 "${DAVFLARE_ENV_FILE}" 2>/dev/null || true

    if [ -n "${password}" ]; then
        printf '%s' "${password}" >"${DAVFLARE_PASSWORD_FILE}.new" \
            && mv "${DAVFLARE_PASSWORD_FILE}.new" "${DAVFLARE_PASSWORD_FILE}"
        chmod 600 "${DAVFLARE_PASSWORD_FILE}" 2>/dev/null || true
    fi

    # ---- 供调用方读取的结果 ----
    DAVFLARE_EFFECTIVE_PORT="${port}"
    DAVFLARE_EFFECTIVE_DATA_DIR="${data_dir}"
    DAVFLARE_HAS_PASSWORD="0"
    [ -n "${password}" ] && DAVFLARE_HAS_PASSWORD="1"

    davflare_log "配置已写入 ${DAVFLARE_ENV_FILE}（端口 ${port}，数据目录 ${data_dir}）"
    if [ -z "${password}" ] && [ ! -s "${DAVFLARE_PASSWORD_FILE}" ]; then
        davflare_log "警告：未设置 WebDAV 密码。Davflare 的鉴权是 fail-closed，未配置密码时受保护接口会一律拒绝访问。"
    fi
    return 0
}
