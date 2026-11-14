const startedAt = Date.now();
let messagesTotal = 0;
let wsConnections = 0;

export function recordMessageCreated(): void {
  messagesTotal += 1;
}

export function recordWsConnection(delta: 1 | -1): void {
  wsConnections = Math.max(0, wsConnections + delta);
}

export function renderMetrics(dbReady: boolean): string {
  const lines = [
    "# HELP onemoments_up Process is running",
    "# TYPE onemoments_up gauge",
    "onemoments_up 1",
    "# HELP onemoments_uptime_seconds Process uptime in seconds",
    "# TYPE onemoments_uptime_seconds gauge",
    `onemoments_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`,
    "# HELP onemoments_messages_total Messages stored since start",
    "# TYPE onemoments_messages_total counter",
    `onemoments_messages_total ${messagesTotal}`,
    "# HELP onemoments_ws_connections Active WebSocket connections",
    "# TYPE onemoments_ws_connections gauge",
    `onemoments_ws_connections ${wsConnections}`,
    "# HELP onemoments_db_ready Database reachability",
    "# TYPE onemoments_db_ready gauge",
    `onemoments_db_ready ${dbReady ? 1 : 0}`,
  ];
  return `${lines.join("\n")}\n`;
}
