const DEFAULT_PORT = 20128;
// The live-WS sidecar (real-time dashboard WebSocket bridge) historically lived
// on `port + 1`. We preserve that pairing so single-port deployments keep the
// existing graceful-fallback behavior (the forwarder backs off after a few
// ECONNREFUSED when the sidecar isn't running — see telemetryHelpers.ts).
const DEFAULT_LIVE_WS_PORT_OFFSET = 1;

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) return fallback;
  return parsed;
}

export type RuntimePorts = {
  port: number;
  apiPort: number;
  dashboardPort: number;
  liveWsPort: number;
  apiPortExplicit: boolean;
  dashboardPortExplicit: boolean;
  liveWsPortExplicit: boolean;
};

export function getRuntimePorts(): RuntimePorts {
  // OMNIROUTE_PORT preserves the user's canonical PORT in wrapped runtimes
  // where Next.js requires process.env.PORT to be the dashboard listener port.
  const basePort = parsePort(process.env.OMNIROUTE_PORT || process.env.PORT, DEFAULT_PORT);
  const apiPortExplicit = !!process.env.API_PORT;
  const dashboardPortExplicit = !!process.env.DASHBOARD_PORT;
  const liveWsPortExplicit = !!process.env.LIVE_WS_PORT;

  return {
    port: basePort,
    apiPort: parsePort(process.env.API_PORT, basePort),
    dashboardPort: parsePort(process.env.DASHBOARD_PORT, basePort),
    liveWsPort: parsePort(process.env.LIVE_WS_PORT, basePort + DEFAULT_LIVE_WS_PORT_OFFSET),
    apiPortExplicit,
    dashboardPortExplicit,
    liveWsPortExplicit,
  };
}
