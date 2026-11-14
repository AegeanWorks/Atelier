import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointPath, restoreCheckpoint } from "../server/checkpoints";

const home = mkdtempSync(join(tmpdir(), "atelier-checkpoint-bench-home-"));
const workspace = mkdtempSync(join(tmpdir(), "atelier-checkpoint-bench-ws-"));
try {
  const samples: number[] = [];
  const restores: number[] = [];
  let lastCommit = "";
  for (let run = 0; run < 20; run += 1) {
    writeFileSync(join(workspace, "bench.txt"), `version ${run} ${"x".repeat(20_000)}\n`);
    const started = performance.now();
    const checkpoint = checkpointPath(workspace, "bench.txt", "bench", home);
    samples.push(performance.now() - started);
    if (checkpoint !== null) lastCommit = checkpoint.commit;
  }
  for (let run = 0; run < 10; run += 1) {
    const started = performance.now();
    restoreCheckpoint(workspace, lastCommit, "bench.txt", home);
    restores.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  restores.sort((left, right) => left - right);
  console.log(JSON.stringify({
    checkpoints: samples.length,
    fileBytes: 20_000,
    checkpointP50Ms: Number(samples[Math.floor(samples.length / 2)]?.toFixed(1)),
    checkpointP95Ms: Number(samples[Math.floor(samples.length * 0.95)]?.toFixed(1)),
    restoreP50Ms: Number(restores[Math.floor(restores.length / 2)]?.toFixed(1)),
    restoreP95Ms: Number(restores[Math.floor(restores.length * 0.95)]?.toFixed(1)),
  }, null, 2));
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}
