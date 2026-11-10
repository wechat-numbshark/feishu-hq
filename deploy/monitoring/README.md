# 监控（可选）

API 已内置 `GET /metrics`（Prometheus 文本格式）：

- `hq_requests_total`、`hq_errors_total`、`hq_request_latency_ms_total`
- `hq_memory_bytes{area="rss|heap_used"}`
- `hq_database_up`
- `hq_uptime_seconds`

## 启动 Prometheus

在 `deploy/compose` 下（与 api 同一网络）：

```bash
docker run -d --name feishu-hq-prometheus \
  --network feishu-hq_default \
  -p 127.0.0.1:9090:9090 \
  -v "$PWD/../monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
  -v "$PWD/../monitoring/alerts.yml:/etc/prometheus/alerts.yml:ro" \
  prom/prometheus:v2.55.1
```

打开 `http://127.0.0.1:9090` 查看 Targets / Alerts。

## 告警

`alerts.yml` 内置：API 不可达、数据库断开、5xx 速率偏高。接入 Alertmanager 或 Grafana 时
把 `deploy/monitoring` 作为配置目录挂载即可。

## 备份

服务器上可用 cron 每日备份：

```cron
0 3 * * * /opt/feishu-hq/scripts/backup-postgres.sh >> /var/log/hq-backup.log 2>&1
```
