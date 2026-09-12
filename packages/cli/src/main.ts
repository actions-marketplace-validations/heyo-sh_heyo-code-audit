import * as core from "@actions/core";
import { ConfigError } from "@heyo-sh/code-audit-core";
import { runAction } from "./action.js";

runAction().catch((error: unknown) => {
  const message =
    error instanceof ConfigError || error instanceof Error
      ? error.message
      : "Heyo Code Audit failed before it could run.";
  core.setFailed(message);
});
