// Remove build output. Written as a script rather than `rm -rf dist` so the
// same command works on the Windows matrix cell.
import { rm } from "node:fs/promises";

for (const target of ["dist", "coverage"]) {
  await rm(target, { recursive: true, force: true });
}
