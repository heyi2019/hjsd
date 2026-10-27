#!/usr/bin/env sh
# Ubuntu host hardening for a temporary public-IP ERP release.
# Run as the normal SSH user, never as root: it refuses to proceed unless the
# current user already has a public-key login path, so a broken SSH config
# cannot strand the operator.
set -eu

if [ "$(id -u)" -eq 0 ]; then
  echo "请使用拥有 sudo 权限的普通 SSH 用户运行，不能直接用 root。" >&2
  exit 1
fi

if [ ! -s "$HOME/.ssh/authorized_keys" ]; then
  echo "未找到当前用户的 authorized_keys；先验证密钥登录后再运行，避免 SSH 被锁在门外。" >&2
  exit 1
fi

sudo apt update
sudo apt install -y fail2ban unattended-upgrades ufw

# Disable the two common Internet SSH attack paths. Test the complete sshd
# configuration before reloading it and preserve the previous drop-in.
ssh_dropin=/etc/ssh/sshd_config.d/99-heijin-hardening.conf
backup=/etc/ssh/sshd_config.d/99-heijin-hardening.conf.bak
sudo mkdir -p /etc/ssh/sshd_config.d
if sudo test -f "$ssh_dropin"; then
  sudo cp "$ssh_dropin" "$backup"
fi
printf '%s\n' \
  'PasswordAuthentication no' \
  'KbdInteractiveAuthentication no' \
  'PermitRootLogin no' \
  'MaxAuthTries 3' \
  'LoginGraceTime 30' | sudo tee "$ssh_dropin" >/dev/null

if ! sudo sshd -t; then
  echo "sshd 配置校验失败，正在恢复原配置。" >&2
  if sudo test -f "$backup"; then
    sudo mv "$backup" "$ssh_dropin"
  else
    sudo rm -f "$ssh_dropin"
  fi
  exit 1
fi
sudo systemctl reload ssh

# Public application access remains available; all unlisted host ports stay
# closed. The cloud security group must match these two ports.
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw --force enable

# Ban repeated SSH failures even though the administrator's public IP changes.
printf '%s\n' \
  '[sshd]' \
  'enabled = true' \
  'maxretry = 5' \
  'findtime = 10m' \
  'bantime = 1h' | sudo tee /etc/fail2ban/jail.d/heijin-sshd.local >/dev/null
sudo systemctl enable --now fail2ban
sudo systemctl restart fail2ban

# Security updates install automatically; application updates remain manual.
printf '%s\n' \
  'APT::Periodic::Update-Package-Lists "1";' \
  'APT::Periodic::Unattended-Upgrade "1";' | sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null
sudo systemctl enable --now unattended-upgrades

echo "主机加固完成。保持当前 SSH 会话不退出，另开一个终端确认密钥 SSH 登录成功后再关闭它。"
sudo ufw status verbose
sudo fail2ban-client status sshd
