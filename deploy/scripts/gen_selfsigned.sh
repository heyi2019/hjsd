#!/usr/bin/env bash
# 生成生产自签证书（无域名阶段的过渡方案）。
#
# 背景：Let's Encrypt 不为纯 IP 签发证书，而 HTTPS 的首要目标是让登录口令
# 不再明文过网——自签证书已能满足这一点，代价是浏览器首次访问需要点「继续」。
#
# 用法：
#   bash deploy/scripts/gen_selfsigned.sh                 # 用默认 IP 8.155.132.208
#   bash deploy/scripts/gen_selfsigned.sh 1.2.3.4         # 指定公网 IP
#   bash deploy/scripts/gen_selfsigned.sh erp.example.com # 未来有域名时可直接用
#   bash deploy/scripts/gen_selfsigned.sh --force ...     # 覆盖已有证书
#
# 产物（写入 deploy/certs/，已被 .gitignore 排除，勿提交）：
#   server.key  私钥，权限 600
#   server.crt  证书，SAN 含目标 IP/域名
#
# 换正式证书时，只要把同名文件替换到 deploy/certs/ 并重启前端容器即可，
# nginx.conf 与 compose 配置都不需要改。
set -euo pipefail

DEFAULT_IP="8.155.132.208"
FORCE=0
TARGET=""

for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        -*) echo "未知参数：$arg" >&2; exit 2 ;;
        *) TARGET="$arg" ;;
    esac
done

TARGET="${TARGET:-$DEFAULT_IP}"

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="$DEPLOY_DIR/certs"
CRT="$CERT_DIR/server.crt"
KEY="$CERT_DIR/server.key"

mkdir -p "$CERT_DIR"

if [[ -f "$CRT" && -f "$KEY" && "$FORCE" -ne 1 ]]; then
    echo "证书已存在，跳过：$CRT"
    echo "如需重新生成，加 --force"
    openssl x509 -in "$CRT" -noout -subject -dates -ext subjectAltName 2>/dev/null || true
    exit 0
fi

# 判断目标是 IPv4 还是域名，决定 SAN 用 IP: 还是 DNS:
if [[ "$TARGET" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
    SAN="IP:$TARGET,DNS:localhost,IP:127.0.0.1"
else
    SAN="DNS:$TARGET,DNS:www.$TARGET"
fi

echo "生成自签证书：CN=$TARGET  SAN=$SAN  有效期 3650 天"

openssl req -x509 -nodes -newkey rsa:2048 -sha256 -days 3650 \
    -subj "/C=CN/ST=Zhejiang/L=Hangzhou/O=Yiyouxuan ERP/CN=$TARGET" \
    -addext "subjectAltName=$SAN" \
    -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
    -addext "extendedKeyUsage=serverAuth" \
    -keyout "$KEY" -out "$CRT" 2>/dev/null

chmod 600 "$KEY"
chmod 644 "$CRT"

echo
echo "已生成："
openssl x509 -in "$CRT" -noout -subject -issuer -dates -ext subjectAltName
echo
echo "下一步："
echo "  1) 同步到服务器：scp $CRT $KEY heijin-prod:/opt/heijin/deploy/certs/"
echo "  2) 重启前端：   ssh heijin-prod 'cd /opt/heijin/deploy && docker compose up -d frontend'"
echo "  3) 验证：       curl -kI https://$TARGET/"
