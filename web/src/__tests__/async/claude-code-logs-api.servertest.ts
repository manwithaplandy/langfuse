import { makeAPICall } from "@/src/__tests__/test-utils";
import waitForExpect from "wait-for-expect";
import { getObservationById, getTraceById } from "@langfuse/shared/src/server";
import { randomUUID } from "crypto";

const projectId = "7a88fb47-b4e2-43b8-a06c-a5ce950dc53a";

describe("/api/public/otel/v1/logs API Endpoint (Claude Code)", () => {
  it("should process Claude Code user_prompt event correctly", async () => {
    const traceId = randomUUID();
    const sessionId = randomUUID();
    const timestamp = Date.now() * 1_000_000; // Convert to nanoseconds

    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                value: { stringValue: "claude-code" },
              },
              {
                key: "service.version",
                value: { stringValue: "1.0.0" },
              },
            ],
          },
          scopeLogs: [
            {
              scope: {
                name: "claude-code",
                version: "1.0.0",
              },
              logRecords: [
                {
                  timeUnixNano: timestamp,
                  severityNumber: 9, // INFO
                  severityText: "INFO",
                  body: {
                    stringValue:
                      "claude_code.user_prompt User submitted a prompt",
                  },
                  attributes: [
                    {
                      key: "event.name",
                      value: { stringValue: "claude_code.user_prompt" },
                    },
                    {
                      key: "session.id",
                      value: { stringValue: sessionId },
                    },
                    {
                      key: "user.id",
                      value: { stringValue: "test-user" },
                    },
                    {
                      key: "prompt",
                      value: {
                        stringValue:
                          "Help me write a function to calculate fibonacci",
                      },
                    },
                    {
                      key: "prompt_length",
                      value: { intValue: 45 },
                    },
                  ],
                  traceId: Buffer.from(traceId.replace(/-/g, ""), "hex"),
                },
              ],
            },
          ],
        },
      ],
    };

    const response = await makeAPICall(
      "POST",
      "/api/public/otel/v1/logs",
      payload,
    );

    expect(response.status).toBe(200);

    await waitForExpect(async () => {
      const trace = await getTraceById({
        projectId,
        traceId,
      });
      expect(trace).toBeDefined();
      expect(trace!.sessionId).toBe(sessionId);
      expect(trace!.userId).toBe("test-user");
      expect(trace!.name).toBe("Claude Code Session");
      expect(trace!.tags).toContain("claude-code");
      expect(trace!.tags).toContain("user-prompt");
    }, 25_000);
  }, 30_000);

  it("should process Claude Code tool_result event correctly", async () => {
    const traceId = randomUUID();
    const timestamp = Date.now() * 1_000_000;

    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                value: { stringValue: "claude-code" },
              },
            ],
          },
          scopeLogs: [
            {
              scope: {
                name: "claude-code",
                version: "1.0.0",
              },
              logRecords: [
                // First create a trace with user_prompt
                {
                  timeUnixNano: timestamp - 5_000_000_000,
                  severityNumber: 9,
                  severityText: "INFO",
                  body: {
                    stringValue:
                      "claude_code.user_prompt User submitted a prompt",
                  },
                  attributes: [
                    {
                      key: "event.name",
                      value: { stringValue: "claude_code.user_prompt" },
                    },
                    {
                      key: "prompt",
                      value: { stringValue: "Test prompt" },
                    },
                  ],
                  traceId: Buffer.from(traceId.replace(/-/g, ""), "hex"),
                },
                // Then add a tool result
                {
                  timeUnixNano: timestamp,
                  severityNumber: 9,
                  severityText: "INFO",
                  body: {
                    stringValue:
                      "claude_code.tool_result Tool execution completed",
                  },
                  attributes: [
                    {
                      key: "event.name",
                      value: { stringValue: "claude_code.tool_result" },
                    },
                    {
                      key: "tool.name",
                      value: { stringValue: "Read" },
                    },
                    {
                      key: "success",
                      value: { boolValue: true },
                    },
                    {
                      key: "execution_time",
                      value: { intValue: 150 },
                    },
                    {
                      key: "input",
                      value: { stringValue: "/path/to/file.ts" },
                    },
                    {
                      key: "output",
                      value: { stringValue: "File contents..." },
                    },
                  ],
                  traceId: Buffer.from(traceId.replace(/-/g, ""), "hex"),
                },
              ],
            },
          ],
        },
      ],
    };

    const response = await makeAPICall(
      "POST",
      "/api/public/otel/v1/logs",
      payload,
    );

    expect(response.status).toBe(200);

    await waitForExpect(async () => {
      const trace = await getTraceById({
        projectId,
        traceId,
      });
      expect(trace).toBeDefined();

      // Find observations for this trace
      // Note: We'd need to query observations by trace ID
      // For now, we just verify the trace was created
    }, 25_000);
  }, 30_000);

  it("should process Claude Code api_request event correctly", async () => {
    const traceId = randomUUID();
    const timestamp = Date.now() * 1_000_000;

    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                value: { stringValue: "claude-code" },
              },
            ],
          },
          scopeLogs: [
            {
              scope: {
                name: "claude-code",
                version: "1.0.0",
              },
              logRecords: [
                {
                  timeUnixNano: timestamp,
                  severityNumber: 9,
                  severityText: "INFO",
                  body: {
                    stringValue: "claude_code.api_request API call to Claude",
                  },
                  attributes: [
                    {
                      key: "event.name",
                      value: { stringValue: "claude_code.api_request" },
                    },
                    {
                      key: "model",
                      value: { stringValue: "claude-sonnet-4.5" },
                    },
                    {
                      key: "input_tokens",
                      value: { intValue: 1500 },
                    },
                    {
                      key: "output_tokens",
                      value: { intValue: 500 },
                    },
                    {
                      key: "prompt",
                      value: { stringValue: "User's prompt" },
                    },
                    {
                      key: "response",
                      value: { stringValue: "Claude's response" },
                    },
                  ],
                  traceId: Buffer.from(traceId.replace(/-/g, ""), "hex"),
                },
              ],
            },
          ],
        },
      ],
    };

    const response = await makeAPICall(
      "POST",
      "/api/public/otel/v1/logs",
      payload,
    );

    expect(response.status).toBe(200);

    await waitForExpect(async () => {
      const trace = await getTraceById({
        projectId,
        traceId,
      });
      expect(trace).toBeDefined();
    }, 25_000);
  }, 30_000);

  it("should process Claude Code api_error event correctly", async () => {
    const traceId = randomUUID();
    const timestamp = Date.now() * 1_000_000;

    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                value: { stringValue: "claude-code" },
              },
            ],
          },
          scopeLogs: [
            {
              scope: {
                name: "claude-code",
                version: "1.0.0",
              },
              logRecords: [
                {
                  timeUnixNano: timestamp,
                  severityNumber: 17, // ERROR
                  severityText: "ERROR",
                  body: {
                    stringValue: "claude_code.api_error API request failed",
                  },
                  attributes: [
                    {
                      key: "event.name",
                      value: { stringValue: "claude_code.api_error" },
                    },
                    {
                      key: "error.message",
                      value: { stringValue: "Rate limit exceeded" },
                    },
                    {
                      key: "error.type",
                      value: { stringValue: "RateLimitError" },
                    },
                  ],
                  traceId: Buffer.from(traceId.replace(/-/g, ""), "hex"),
                },
              ],
            },
          ],
        },
      ],
    };

    const response = await makeAPICall(
      "POST",
      "/api/public/otel/v1/logs",
      payload,
    );

    expect(response.status).toBe(200);

    await waitForExpect(async () => {
      const trace = await getTraceById({
        projectId,
        traceId,
      });
      expect(trace).toBeDefined();
    }, 25_000);
  }, 30_000);

  it("should process Claude Code tool_decision event correctly", async () => {
    const traceId = randomUUID();
    const timestamp = Date.now() * 1_000_000;

    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                value: { stringValue: "claude-code" },
              },
            ],
          },
          scopeLogs: [
            {
              scope: {
                name: "claude-code",
                version: "1.0.0",
              },
              logRecords: [
                {
                  timeUnixNano: timestamp,
                  severityNumber: 9,
                  severityText: "INFO",
                  body: {
                    stringValue: "claude_code.tool_decision User made decision",
                  },
                  attributes: [
                    {
                      key: "event.name",
                      value: { stringValue: "claude_code.tool_decision" },
                    },
                    {
                      key: "tool.name",
                      value: { stringValue: "Bash" },
                    },
                    {
                      key: "decision",
                      value: { stringValue: "accept" },
                    },
                    {
                      key: "accepted",
                      value: { boolValue: true },
                    },
                  ],
                  traceId: Buffer.from(traceId.replace(/-/g, ""), "hex"),
                },
              ],
            },
          ],
        },
      ],
    };

    const response = await makeAPICall(
      "POST",
      "/api/public/otel/v1/logs",
      payload,
    );

    expect(response.status).toBe(200);

    await waitForExpect(async () => {
      const trace = await getTraceById({
        projectId,
        traceId,
      });
      expect(trace).toBeDefined();
    }, 25_000);
  }, 30_000);

  it("should handle gzipped payloads", async () => {
    const traceId = randomUUID();
    const timestamp = Date.now() * 1_000_000;

    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [],
          },
          scopeLogs: [
            {
              scope: {
                name: "claude-code",
                version: "1.0.0",
              },
              logRecords: [
                {
                  timeUnixNano: timestamp,
                  severityNumber: 9,
                  severityText: "INFO",
                  body: {
                    stringValue: "claude_code.user_prompt Test",
                  },
                  attributes: [
                    {
                      key: "event.name",
                      value: { stringValue: "claude_code.user_prompt" },
                    },
                    {
                      key: "prompt",
                      value: { stringValue: "Test prompt" },
                    },
                  ],
                  traceId: Buffer.from(traceId.replace(/-/g, ""), "hex"),
                },
              ],
            },
          ],
        },
      ],
    };

    const { gzip } = await import("zlib");
    const compressed = await new Promise<Buffer>((resolve, reject) => {
      gzip(JSON.stringify(payload), (err, result) =>
        err ? reject(err) : resolve(result),
      );
    });

    const response = await fetch(
      `http://localhost:3000/api/public/otel/v1/logs`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          Authorization: "Bearer pk-lf-1234567890", // This is the test API key from seed data
        },
        body: compressed,
      },
    );

    expect(response.status).toBe(200);

    await waitForExpect(async () => {
      const trace = await getTraceById({
        projectId,
        traceId,
      });
      expect(trace).toBeDefined();
    }, 25_000);
  }, 30_000);

  it("should handle multiple log records in a single request", async () => {
    const traceId = randomUUID();
    const sessionId = randomUUID();
    const timestamp = Date.now() * 1_000_000;

    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                value: { stringValue: "claude-code" },
              },
            ],
          },
          scopeLogs: [
            {
              scope: {
                name: "claude-code",
                version: "1.0.0",
              },
              logRecords: [
                {
                  timeUnixNano: timestamp,
                  severityNumber: 9,
                  severityText: "INFO",
                  body: {
                    stringValue: "claude_code.user_prompt",
                  },
                  attributes: [
                    {
                      key: "event.name",
                      value: { stringValue: "claude_code.user_prompt" },
                    },
                    {
                      key: "session.id",
                      value: { stringValue: sessionId },
                    },
                    {
                      key: "prompt",
                      value: { stringValue: "First prompt" },
                    },
                  ],
                  traceId: Buffer.from(traceId.replace(/-/g, ""), "hex"),
                },
                {
                  timeUnixNano: timestamp + 1_000_000_000,
                  severityNumber: 9,
                  severityText: "INFO",
                  body: {
                    stringValue: "claude_code.api_request",
                  },
                  attributes: [
                    {
                      key: "event.name",
                      value: { stringValue: "claude_code.api_request" },
                    },
                    {
                      key: "model",
                      value: { stringValue: "claude-3.5-sonnet" },
                    },
                    {
                      key: "input_tokens",
                      value: { intValue: 100 },
                    },
                    {
                      key: "output_tokens",
                      value: { intValue: 50 },
                    },
                  ],
                  traceId: Buffer.from(traceId.replace(/-/g, ""), "hex"),
                },
                {
                  timeUnixNano: timestamp + 2_000_000_000,
                  severityNumber: 9,
                  severityText: "INFO",
                  body: {
                    stringValue: "claude_code.tool_result",
                  },
                  attributes: [
                    {
                      key: "event.name",
                      value: { stringValue: "claude_code.tool_result" },
                    },
                    {
                      key: "tool.name",
                      value: { stringValue: "Bash" },
                    },
                    {
                      key: "success",
                      value: { boolValue: true },
                    },
                  ],
                  traceId: Buffer.from(traceId.replace(/-/g, ""), "hex"),
                },
              ],
            },
          ],
        },
      ],
    };

    const response = await makeAPICall(
      "POST",
      "/api/public/otel/v1/logs",
      payload,
    );

    expect(response.status).toBe(200);

    await waitForExpect(async () => {
      const trace = await getTraceById({
        projectId,
        traceId,
      });
      expect(trace).toBeDefined();
      expect(trace!.sessionId).toBe(sessionId);
    }, 25_000);
  }, 30_000);
});
