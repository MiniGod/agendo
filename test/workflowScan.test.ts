// Workflow refs collected from a transcript (src/workflows.ts). The e2e
// fixtures carry one launch and one finish per workflow session; what they
// never carry is a relaunch of the same run, a notification for a task that
// was not a workflow, a transcript that merely quotes a notification, or a
// launch record with its fields missing or of the wrong type.
import { describe, expect, test } from "bun:test";
import { notificationOf, WorkflowScan } from "../src/workflows.ts";

const launch = (runId: string, taskId: string, over: Record<string, unknown> = {}) => ({
  timestamp: "2026-09-01T10:00:00Z",
  toolUseResult: { taskType: "local_workflow", runId, taskId, workflowName: "review", summary: "look", ...over },
});
const notice = (taskId: string, status: string) =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n</task-notification>`;

describe("WorkflowScan", () => {
  test("a launch then its notification, through either content shape; nothing recorded is undefined", () => {
    expect(new WorkflowScan().finish()).toBeUndefined();
    const scan = new WorkflowScan();
    scan.record(launch("wf_1", "t1", { transcriptDir: "/d", scriptPath: "/s.js" }));
    scan.record({ message: { content: notice("t1", " completed ") } });
    expect(scan.finish()).toEqual([{
      runId: "wf_1", taskId: "t1", name: "review", summary: "look", transcriptDir: "/d", scriptPath: "/s.js",
      launchedAt: new Date("2026-09-01T10:00:00Z"), notifiedStatus: "completed",
    }]);
    const top = new WorkflowScan();
    top.record(launch("wf_2", "t2"));
    top.record({ content: notice("t2", "failed") });
    expect(top.finish()?.[0]?.notifiedStatus).toBe("failed");
  });

  test("a relaunch replaces the ref in place, and a stale notification for the old task no longer lands", () => {
    const scan = new WorkflowScan();
    scan.record(launch("wf_1", "t1"));
    scan.record(launch("wf_2", "t2"));
    scan.record(launch("wf_1", "t3", { summary: undefined }));
    scan.record({ content: notice("t1", "completed") });
    const refs = scan.finish()!;
    expect(refs.map((r) => [r.runId, r.taskId, r.notifiedStatus])).toEqual([["wf_1", "t3", undefined], ["wf_2", "t2", undefined]]);
    scan.record({ content: notice("t3", "killed") });
    expect(scan.finish()![0]!.notifiedStatus).toBe("killed");
  });

  test("a notification for a task that was not a workflow, or that only quotes one, is ignored", () => {
    const scan = new WorkflowScan();
    scan.record(launch("wf_1", "t1"));
    scan.record({ content: notice("agent-7", "completed") });
    scan.record({ content: "as I said earlier:\n" + notice("t1", "completed") });
    scan.record({ content: ["not", "a string"] });
    scan.record({ toolUseResult: { taskType: "local_workflow" } });
    scan.record({ toolUseResult: "local_workflow" });
    expect(scan.finish()![0]!.notifiedStatus).toBeUndefined();
  });

  test("missing or mistyped launch fields: the name falls back to the run id, the rest to absent", () => {
    const scan = new WorkflowScan();
    scan.record({ timestamp: "never", toolUseResult: { taskType: "local_workflow", runId: "wf_9", workflowName: "", taskId: 4 } });
    expect(scan.finish()).toEqual([{ runId: "wf_9", taskId: undefined, name: "wf_9", summary: undefined, transcriptDir: undefined, scriptPath: undefined, launchedAt: undefined }]);
  });
});

describe("notificationOf", () => {
  test("the tag first, then both fields, the status trimmed; anything less is nothing", () => {
    expect(notificationOf(null)).toBeNull();
    expect(notificationOf("  " + notice("t1", " done\n"))).toEqual({ taskId: "t1", status: "done" });
    expect(notificationOf("<task-notification><task-id>t1</task-id></task-notification>")).toBeNull();
    expect(notificationOf("<task-notification><status>done</status></task-notification>")).toBeNull();
    expect(notificationOf("<task-notification><task-id>t1</task-id><status>   </status></task-notification>")).toBeNull();
  });
});
