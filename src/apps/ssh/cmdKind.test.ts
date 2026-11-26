import { describe, expect, it } from "vitest";
import { cmdKind } from "./cmdKind";

const cases: [string, ReturnType<typeof cmdKind>][] = [
  // đọc
  ["ls -la /var/log", "read"],
  ["tail -f /var/log/syslog", "read"],
  ["sudo cat /etc/nginx/nginx.conf", "read"],
  ["ps aux | grep java", "read"],
  ["docker ps -a", "read"],
  ["docker logs -f app --tail 100", "read"],
  ["kubectl get pods -n prod", "read"],
  ["git status", "read"],
  ["systemctl status nginx", "read"],
  ["journalctl -u nginx -n 200", "read"],
  ["SELECT * FROM users LIMIT 10;", "read"],
  ["df -h > /dev/null 2>&1", "read"],
  ["sed -n '1,20p' file.txt", "read"],
  // ghi
  ["mkdir -p /opt/app", "write"],
  ["echo hello > /tmp/a.txt", "write"],
  ["cat a.txt | grep x >> b.txt", "write"],
  ["docker run -d --name web nginx", "write"],
  ["INSERT INTO t VALUES (1)", "write"],
  ["git commit -m 'x'", "write"],
  ["kubectl apply -f deploy.yaml", "write"],
  // sửa
  ["vim /etc/hosts", "modify"],
  ["sudo sed -i 's/a/b/' conf.ini", "modify"],
  ["mv a.txt b.txt", "modify"],
  ["chmod 600 ~/.ssh/id_rsa", "modify"],
  ["UPDATE users SET name='a' WHERE id=1", "modify"],
  ["git push origin main", "modify"],
  ["kubectl scale deploy web --replicas=3", "modify"],
  // xoá
  ["rm -rf /tmp/build", "delete"],
  ["sudo -u www rm file", "delete"],
  ["docker rm -f web", "delete"],
  ["docker system prune -af", "delete"],
  ["kubectl delete pod web-1", "delete"],
  ["DROP TABLE logs;", "delete"],
  ["mysql -uroot -e \"DELETE FROM t WHERE id=3\"", "delete"],
  ["git branch -D feature/x", "delete"],
  ["apt remove nginx", "delete"],
  ["ls && rm a.txt", "delete"],
  ["redis-cli flushall", "delete"],
  // dịch vụ
  ["sudo systemctl restart nginx", "service"],
  ["service mysql stop", "service"],
  ["docker restart web", "service"],
  ["docker compose up -d", "service"],
  ["kill -9 1234", "service"],
  ["nginx -s reload", "service"],
  // cài đặt
  ["sudo apt-get install -y htop", "install"],
  ["pip install requests", "install"],
  ["npm i -g pm2", "install"],
  // mạng
  ["curl -s https://example.com", "network"],
  ["ping 8.8.8.8", "network"],
  ["scp a.txt user@host:/tmp", "network"],
  // không biết
  ["./deploy.sh prod", null],
  ["cd /var/www", null],
  ["", null],
];

describe("cmdKind", () => {
  it.each(cases)("%s → %s", (line, want) => {
    expect(cmdKind(line)).toBe(want);
  });
});
