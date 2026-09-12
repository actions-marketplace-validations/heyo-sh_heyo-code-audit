import { readFile } from "node:fs/promises";

const report = await readFile(
  new URL("../coverage/lcov.info", import.meta.url),
  "utf8",
);
const uncovered = [];
let source;
for (const line of report.split("\n")) {
  if (line.startsWith("SF:")) source = line.slice(3);
  if (!line.startsWith("DA:")) continue;
  const [number, hits] = line.slice(3).split(",");
  if (source?.includes("/src/") && Number(hits) === 0)
    uncovered.push(`${source}:${number}`);
}
if (uncovered.length > 0) {
  throw new Error(
    `Line coverage must stay at 100%. Uncovered: ${uncovered.join(", ")}`,
  );
}
