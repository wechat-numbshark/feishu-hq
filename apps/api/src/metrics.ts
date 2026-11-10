// 轻量 Prometheus 指标：进程内计数，单实例可观测性起步（不引入依赖）。
let totalRequests = 0;
let errorRequests = 0;
let totalLatencyMs = 0;
const byStatus = new Map<string, number>();
const startedAt = Date.now();

export function recordRequest(method: string, status: number, ms: number): void {
  totalRequests++;
  totalLatencyMs += ms;
  if (status >= 500) errorRequests++;
  const key = `${method}_${Math.floor(status / 100)}xx`;
  byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
}

export function renderMetrics(database: string): string {
  const mem = process.memoryUsage();
  const lines = [
    "# HELP hq_uptime_seconds Process uptime in seconds",
    "# TYPE hq_uptime_seconds gauge",
    `hq_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`,
    "# HELP hq_requests_total Total HTTP requests",
    "# TYPE hq_requests_total counter",
    `hq_requests_total ${totalRequests}`,
    "# HELP hq_errors_total HTTP 5xx responses",
    "# TYPE hq_errors_total counter",
    `hq_errors_total ${errorRequests}`,
    "# HELP hq_request_latency_ms_total Cumulative request latency",
    "# TYPE hq_request_latency_ms_total counter",
    `hq_request_latency_ms_total ${Math.round(totalLatencyMs)}`,
    "# HELP hq_memory_bytes Resident memory by area",
    "# TYPE hq_memory_bytes gauge",
    `hq_memory_bytes{area="rss"} ${mem.rss}`,
    `hq_memory_bytes{area="heap_used"} ${mem.heapUsed}`,
    "# HELP hq_database_up Database connectivity (1=connected)",
    "# TYPE hq_database_up gauge",
    `hq_database_up ${database === "connected" ? 1 : 0}`,
  ];
  for (const [key, value] of byStatus) {
    lines.push(`hq_requests_by_status{method_status="${key}"} ${value}`);
  }
  return lines.join("\n") + "\n";
}
