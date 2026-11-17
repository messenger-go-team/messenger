import http from "k6/http";
import { check, sleep } from "k6";

const expectedStatus = Number(__ENV.EXPECTED_STATUS || "200");
const baseUrl = __ENV.BASE_URL || "http://127.0.0.1:3100";
if (baseUrl !== "http://127.0.0.1:3100") throw new Error("T24 k6 fixture must be loopback:3100");
export const options = {
  vus: 1,
  duration: "3s",
  thresholds: { checks: ["rate==1"], http_req_failed: ["rate==0"] }
};

export default function () {
  const response = http.get(`${baseUrl}/health`, { timeout: "2s", redirects: 0 });
  check(response, {
    "HTTP status matches expectation": r => r.status === expectedStatus,
    "JSON status is ok": r => r.json("status") === "ok"
  });
  sleep(0.1);
}

export function handleSummary(data) {
  const result = {
    iterations: data.metrics.iterations.values.count,
    requests: data.metrics.http_reqs.values.count,
    check_rate: data.metrics.checks.values.rate,
    http_error_rate: data.metrics.http_req_failed.values.rate,
    p95_ms: data.metrics.http_req_duration.values["p(95)"]
  };
  const output = __ENV.SUMMARY_FILE || "reports/k6-pass.json";
  return { [output]: JSON.stringify({ ...data, trial: { base_url: baseUrl } }, null, 2), stdout: JSON.stringify(result, null, 2) + "\n" };
}
