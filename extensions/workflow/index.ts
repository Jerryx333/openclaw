import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { createWorkflowHttpHandler } from "./src/http.js";
import { registerWorkflowCli } from "./src/cli.js";
import { createWorkflowCommand } from "./src/command.js";
import { WORKFLOW_PROMPT_GUIDANCE } from "./src/prompt.js";
import { createWorkflowTool } from "./src/tool.js";

export default definePluginEntry({
  id: "workflow",
  name: "Workflow",
  description: "Task workflow orchestration MVP for planner/executor/reviewer/patrol loops.",
  register(api: OpenClawPluginApi) {
    api.registerTool((context) => createWorkflowTool({ api, context }), { name: "workflow" });
    api.registerCommand(createWorkflowCommand({ api }));
    api.registerHttpRoute({
      path: "/plugins/workflow",
      auth: "gateway",
      match: "prefix",
      handler: createWorkflowHttpHandler({ api }),
    });
    api.registerCli(
      ({ program }) => {
        registerWorkflowCli({
          program,
          pluginConfig: api.pluginConfig,
          logger: api.logger,
        });
      },
      { commands: ["workflow"] },
    );
    api.on("before_prompt_build", (_event, ctx) => {
      const guidance = WORKFLOW_PROMPT_GUIDANCE(ctx.agentId, api.pluginConfig);
      if (!guidance) {
        return;
      }
      return {
        prependSystemContext: guidance,
      };
    });
  },
});
