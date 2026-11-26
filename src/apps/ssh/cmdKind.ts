/**
 * Đoán loại tác vụ của một dòng lệnh shell / câu SQL để gắn nhãn trong Lịch sử lệnh: đọc, ghi, sửa, xoá, dịch vụ,
 * cài đặt, mạng. Thuần (không I/O) — chỉ dựa vào tên lệnh + lệnh con + vài cờ; script tự viết (./deploy.sh) → null.
 * Dòng có nhiều lệnh (`&&`, `||`, `;`, `|`) → lấy loại "nặng" nhất (xoá > sửa > ghi > dịch vụ > cài đặt > mạng > đọc).
 */
export type CmdKind = "read" | "write" | "modify" | "delete" | "service" | "install" | "network";

export const KIND_ORDER: CmdKind[] = ["read", "write", "modify", "delete", "service", "install", "network"];
const WEIGHT: Record<CmdKind, number> = { read: 1, network: 2, install: 3, service: 4, write: 5, modify: 6, delete: 7 };

const set = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const READ = set(`ls ll la l dir cat bat less more head tail grep egrep fgrep zgrep rg ag find fd locate which whereis type file stat du df
  free top htop btop atop ps pgrep pstree uptime w who whoami id groups uname hostname hostnamectl date timedatectl env printenv history pwd
  echo printf wc sort uniq cut tr column jq yq xmllint diff cmp comm md5sum sha1sum sha256sum journalctl dmesg lsof netstat ss ifconfig
  lsblk blkid findmnt vmstat iostat mpstat sar nproc lscpu lsmem lspci lsusb tree realpath readlink basename dirname man help whatis
  watch strings hexdump xxd od nvidia-smi getent last lastlog ulimit sysctl test true false clear`);
const WRITE = set(`touch mkdir cp tee ln tar zip unzip gzip gunzip bzip2 xz unxz 7z dd install mkfifo mktemp rsync split csplit
  useradd adduser groupadd ssh-keygen openssl htpasswd`);
const MODIFY = set(`vi vim nvim nano emacs pico mcedit mv chmod chown chgrp chattr setfacl usermod groupmod passwd chpasswd crontab
  visudo ln patch rename hostnamectl-set timedatectl-set`);
const DELETE = set(`rm rmdir shred unlink userdel groupdel wipefs`);
const SERVICE = set(`kill pkill killall reboot shutdown poweroff halt init telinit`);
const INSTALL = set(`apt apt-get aptitude dpkg yum dnf rpm apk zypper pacman snap flatpak brew pip pip3 pipx npm yarn pnpm gem cargo go composer`);
const NETWORK = set(`curl wget ssh scp sftp ping ping6 traceroute tracepath mtr dig nslookup host nc ncat netcat telnet ftp nmap iperf iperf3 http`);
/** Tiền tố bỏ qua để xét lệnh thật phía sau. */
const PREFIX = set(`sudo doas time nohup nice ionice env exec stdbuf unbuffer command builtin xargs timeout`);

/** SQL (trong mysql>/psql/cqlsh hoặc dán thẳng). */
function sqlKind(s: string): CmdKind | null {
  const m = /^\s*\(?\s*([a-z]+)/i.exec(s);
  if (!m) return null;
  const w = m[1].toLowerCase();
  if (/^(select|show|describe|desc|explain|with|use|help|status)$/.test(w)) return w === "use" ? null : "read";
  if (/^(insert|create|replace|load|copy|import)$/.test(w)) return "write";
  if (/^(update|alter|rename|grant|set|merge|upsert|comment)$/.test(w)) return "modify";
  if (/^(delete|drop|truncate|revoke|purge)$/.test(w)) return "delete";
  return null;
}

/** Tách tham số: bỏ nháy đơn giản, không cần chính xác như shell. */
function words(seg: string): string[] {
  return (seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ""));
}

function subKind(cmd: string, args: string[]): CmdKind | null | undefined {
  const sub = (args.find((a) => !a.startsWith("-")) ?? "").toLowerCase();
  const has = (...f: string[]) => args.some((a) => f.includes(a));
  switch (cmd) {
    case "docker": case "podman": case "nerdctl": {
      if (sub === "compose" || sub === "stack") {
        const c = (args.filter((a) => !a.startsWith("-"))[1] ?? "").toLowerCase();
        if (/^(ps|logs|config|ls|top|images|events)$/.test(c)) return "read";
        if (/^(down|rm)$/.test(c)) return "delete";
        if (/^(pull|build|create|cp)$/.test(c)) return "write";
        if (/^(up|start|stop|restart|kill|pause|unpause|deploy)$/.test(c)) return "service";
        return null;
      }
      if (/^(ps|logs|images|inspect|stats|top|events|version|info|history|port|diff|search|ls)$/.test(sub)) return "read";
      if (/^(rm|rmi|prune|kill)$/.test(sub) && sub !== "kill") return "delete";
      if (["system", "volume", "network", "image", "container", "builder"].includes(sub)) {
        const c = (args.filter((a) => !a.startsWith("-"))[1] ?? "").toLowerCase();
        if (/^(rm|prune|remove)$/.test(c)) return "delete";
        if (/^(ls|inspect|df|info)$/.test(c)) return "read";
        if (/^(create|build|pull|tag)$/.test(c)) return "write";
        return null;
      }
      if (/^(run|create|build|pull|cp|commit|tag|load|import|save|login)$/.test(sub)) return "write";
      if (/^(push)$/.test(sub)) return "network";
      if (/^(update|rename)$/.test(sub)) return "modify";
      if (/^(start|stop|restart|kill|pause|unpause)$/.test(sub)) return "service";
      return null;
    }
    case "kubectl": case "k": case "oc": {
      if (/^(get|describe|logs|top|explain|api-resources|version|cluster-info|config|auth|diff)$/.test(sub)) return "read";
      if (/^(apply|create|run|expose|cp)$/.test(sub)) return "write";
      if (/^(edit|patch|set|scale|label|annotate|rollout|replace|autoscale|cordon|uncordon|drain|taint)$/.test(sub)) return "modify";
      if (sub === "delete") return "delete";
      return null;
    }
    case "helm": {
      if (/^(list|ls|status|get|history|show|search|template|lint)$/.test(sub)) return "read";
      if (/^(install|upgrade|rollback)$/.test(sub)) return "modify";
      if (/^(uninstall|delete)$/.test(sub)) return "delete";
      if (/^(repo|pull|package)$/.test(sub)) return "install";
      return null;
    }
    case "git": {
      if (sub === "branch" && has("-d", "-D", "--delete")) return "delete";
      if (sub === "push" && has("--delete", "-d")) return "delete";
      if (/^(status|log|diff|show|blame|remote|fetch|describe|shortlog|reflog|ls-files|grep|config|branch|tag)$/.test(sub)) return "read";
      if (/^(add|commit|clone|init|stash|am|apply)$/.test(sub)) return "write";
      if (/^(push|pull|merge|rebase|reset|checkout|switch|cherry-pick|revert|restore|mv)$/.test(sub)) return "modify";
      if (/^(rm|clean)$/.test(sub)) return "delete";
      return null;
    }
    case "systemctl": case "service": case "supervisorctl": case "pm2": case "rc-service": {
      // `service nginx restart`: lệnh con đứng sau tên dịch vụ.
      const parts = args.filter((a) => !a.startsWith("-")).map((a) => a.toLowerCase());
      const verb = cmd === "service" || cmd === "rc-service" ? parts[1] ?? "" : parts[0] ?? "";
      if (/^(status|list|list-units|list-unit-files|is-active|is-enabled|is-failed|cat|show|logs|ls|monit|describe|info)$/.test(verb)) return "read";
      if (/^(delete|del|remove|mask)$/.test(verb)) return "delete";
      return verb ? "service" : "read";
    }
    case "nginx": case "apachectl": case "apache2ctl": case "httpd":
      return has("-t", "-T", "-v", "-V") || sub === "configtest" ? "read" : "service";
    case "sed": case "perl":
      return args.some((a) => /^-[a-z]*i/.test(a)) ? "modify" : "read";
    case "awk": case "gawk":
      return has("-i") ? "modify" : "read";
    case "truncate":
      return "delete";
    case "crontab":
      return has("-l") ? "read" : has("-r") ? "delete" : "modify";
    case "ip":
      return /^(add|del|delete|set|change|replace|flush)$/.test((args.filter((a) => !a.startsWith("-"))[1] ?? "").toLowerCase())
        ? "modify" : "read";
    case "mount": case "umount":
      return args.length ? "modify" : "read";
    case "ufw": case "iptables": case "firewall-cmd":
      return /^(status|-l|-L|--list-all|show)$/.test(sub) || has("-L", "-S", "--list-all") ? "read" : "modify";
    case "mysql": case "psql": case "mariadb": case "cqlsh": case "redis-cli": case "mongo": case "mongosh": {
      // mysql -e "DELETE …" / psql -c "…" → theo câu SQL; vào client tương tác thì không gắn nhãn.
      const i = args.findIndex((a) => a === "-e" || a === "-c" || a === "--execute" || a === "--command");
      if (i >= 0 && args[i + 1]) return sqlKind(args[i + 1]);
      if (cmd === "redis-cli") {
        const c = (args.filter((a) => !a.startsWith("-"))[0] ?? "").toLowerCase();
        if (/^(get|keys|scan|hget|hgetall|lrange|smembers|zrange|ttl|type|info|exists|mget|dbsize|ping)$/.test(c)) return "read";
        if (/^(set|hset|lpush|rpush|sadd|zadd|setex|mset|incr|decr|expire|rename)$/.test(c)) return "modify";
        if (/^(del|unlink|flushdb|flushall|hdel|srem|zrem|lrem)$/.test(c)) return "delete";
      }
      return null;
    }
  }
  if (INSTALL.has(cmd)) {
    if (/^(remove|purge|uninstall|autoremove|erase|rm|un)$/.test(sub)) return "delete";
    if (/^(list|search|show|info|ls|outdated|view|policy|freeze|query|-q[a-z]*|-l)$/.test(sub)) return "read";
    return "install";
  }
  return undefined; // không có luật riêng → tra bảng tên lệnh
}

function segKind(seg: string): CmdKind | null {
  const s = seg.trim();
  if (!s) return null;
  const sql = sqlKind(s);
  if (sql && /^\s*\(?\s*(select|insert|update|delete|create|drop|alter|truncate|replace|grant|revoke|merge|upsert|show|describe|explain|with)\b/i.test(s))
    return sql;
  let w = words(s);
  // Bỏ gán biến môi trường đầu dòng (FOO=1 cmd) và tiền tố (sudo -u x, time, nohup…).
  for (;;) {
    if (!w.length) return null;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) { w = w.slice(1); continue; }
    if (PREFIX.has(w[0])) {
      w = w.slice(1);
      while (w.length && w[0].startsWith("-")) w = w.slice(w[0] === "-u" || w[0] === "-g" || w[0] === "-n" ? 2 : 1);
      continue;
    }
    break;
  }
  const cmd = w[0].replace(/^.*\//, "").toLowerCase(); // /usr/bin/rm → rm
  const args = w.slice(1);
  // Ghi ra file (> hoặc >>), trừ /dev/null và 2>&1.
  const redirect = /(^|[^0-9&>])>{1,2}\s*(?!&|\/dev\/null)\S/.test(s);
  const sub = subKind(cmd, args);
  let k: CmdKind | null = sub !== undefined ? sub
    : DELETE.has(cmd) ? "delete" : MODIFY.has(cmd) ? "modify" : WRITE.has(cmd) ? "write" : SERVICE.has(cmd) ? "service"
    : NETWORK.has(cmd) ? "network" : READ.has(cmd) ? "read" : null;
  if (redirect && (!k || WEIGHT[k] < WEIGHT.write)) k = "write";
  return k;
}

/** Tách dòng theo toán tử nối lệnh (bỏ qua phần trong nháy). */
function segments(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { cur += c; if (c === q) q = ""; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === ";" || (c === "|" && line[i + 1] !== "|") || ((c === "&" || c === "|") && line[i + 1] === c)) {
      out.push(cur); cur = "";
      if (line[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

export function cmdKind(line: string): CmdKind | null {
  let best: CmdKind | null = null;
  for (const seg of segments(line)) {
    const k = segKind(seg);
    if (k && (!best || WEIGHT[k] > WEIGHT[best])) best = k;
  }
  return best;
}
