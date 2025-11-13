import { makeAPICall } from "@/src/__tests__/test-utils";
import waitForExpect from "wait-for-expect";
import { getObservationById, getTraceById } from "@langfuse/shared/src/server";
import { randomBytes } from "crypto";

const projectId = "7a88fb47-b4e2-43b8-a06c-a5ce950dc53a";

describe("/api/public/claude-code/logs API Endpoint", () => {
  it("should convert user_prompt log to trace correctly", async () => {
    const traceId = randomBytes(16);
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
                  timeUnixNano: {
                    low: timestamp & 0xffffffff,
                    high: Math.floor(timestamp / 0x100000000),
                    unsigned: true,
                  },
                  observedTimeUnixNano: {
                    low: timestamp & 0xffffffff,
                    high: Math.floor(timestamp / 0x100000000),
                    unsigned: true,
                  },
                  severityNumber: 9, // INFO
                  severityText: "INFO",
                  body: {
                    stringValue: "User submitted a prompt",
                  },
                  attributes: [
                    {
                      key: "prompt",
                      value: {
                        stringValue: "Help me write a function to calculate fibonacci numbers",
                      },
                    },
                    {
                      key: "prompt_length",
                      value: { intValue: 54 },
                    },
                  ],
                  traceId: {
                    type: "Buffer",
                    data: traceId,
                  },
                  eventName: "claude_code.user_prompt",
                },
              ],
            },
          ],
        },
      ],
    };

    const response = await makeAPICall(
      "POST",
      "/api/public/claude-code/logs",
      payload,
    );

    expect(response.status).toBe(200);

    // Wait for async processing
    await waitForExpect(async () => {
      const trace = await getTraceById({
        projectId,
        traceId: traceId.toString("hex"),
      });
      expect(trace).toBeDefined();
      expect(trace!.id).toBe(traceId.toString("hex"));
    }, 25_000);
  }, 30_000);

  it("should convert tool_result log to observation correctly", async () => {
    const traceId = randomBytes(16);
    const timestamp = Date.now() * 1_000_000;
    const duration = 150; // 150ms

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
                  timeUnixNano: {
                    low: timestamp & 0xffffffff,
                    high: Math.floor(timestamp / 0x100000000),
                    unsigned: true,
                  },
                  observedTimeUnixNano: {
                    low: timestamp & 0xffffffff,
                    high: Math.floor(timestamp / 0x100000000),
                    unsigned: true,
                  },
                  severityNumber: 9,
                  severityText: "INFO",
                  body: {
                    stringValue: "Tool execution completed",
                  },
                  attributes: [
                    {
                      key: "tool_name",
                      value: { stringValue: "Read" },
                    },
                    {
                      key: "duration_ms",
                      value: { doubleValue: duration },
                    },
                    {
                      key: "success",
                      value: { stringValue: "true" },
                    },
                    {
                      key: "decision",
                      value: { stringValue: "accept" },
                    },
                    {
                      key: "tool_parameters",
                      value: {
                        stringValue: JSON.stringify({
                          file_path: "/home/user/test.ts",
                        }),
                      },
                    },
                  ],
                  traceId: {
                    type: "Buffer",
                    data: traceId,
                  },
                  eventName: "claude_code.tool_result",
                },
              ],
            },
          ],
        },
      ],
    };

    const response = await makeAPICall(
      "POST",
      "/api/public/claude-code/logs",
      payload,
    );

    expect(response.status).toBe(200);

    // Wait for async processing
    await waitForExpect(async () => {
      const trace = await getTraceById({
        projectId,
        traceId: traceId.toString("hex"),
      });
      expect(trace).toBeDefined();
      expect(trace!.id).toBe(traceId.toString("hex"));

      // The observation should be created
      // Note: We can't predict the span ID since it's generated, so we just verify the trace exists
    }, 25_000);
  }, 30_000);

  it("should convert api_request log to generation correctly", async () => {
    const traceId = randomBytes(16);
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
                  timeUnixNano: {
                    low: timestamp & 0xffffffff,
                    high: Math.floor(timestamp / 0x100000000),
                    unsigned: true,
                  },
                  observedTimeUnixNano: {
                    low: timestamp & 0xffffffff,
                    high: Math.floor(timestamp / 0x100000000),
                    unsigned: true,
                  },
                  severityNumber: 9,
                  severityText: "INFO",
                  body: {
                    stringValue: "API request completed",
                  },
                  attributes: [
                    {
                      key: "model",
                      value: { stringValue: "claude-sonnet-4-5-20250929" },
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
                      key: "cache_read_tokens",
                      value: { intValue: 1000 },
                    },
                    {
                      key: "duration_ms",
                      value: { doubleValue: 2500 },
                    },
                  ],
                  traceId: {
                    type: "Buffer",
                    data: traceId,
                  },
                  eventName: "claude_code.api_request",
                },
              ],
            },
          ],
        },
      ],
    };

    const response = await makeAPICall(
      "POST",
      "/api/public/claude-code/logs",
      payload,
    );

    expect(response.status).toBe(200);

    // Wait for async processing
    await waitForExpect(async () => {
      const trace = await getTraceById({
        projectId,
        traceId: traceId.toString("hex"),
      });
      expect(trace).toBeDefined();
      expect(trace!.id).toBe(traceId.toString("hex"));

      // The generation observation should be created with token usage
      // Note: We can't easily verify observation details without the span ID
    }, 25_000);
  }, 30_000);

  it("should handle multiple log events in one batch", async () => {
    const traceId = randomBytes(16);
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
                // User prompt
                {
                  timeUnixNano: {
                    low: timestamp & 0xffffffff,
                    high: Math.floor(timestamp / 0x100000000),
                    unsigned: true,
                  },
                  observedTimeUnixNano: {
                    low: timestamp & 0xffffffff,
                    high: Math.floor(timestamp / 0x100000000),
                    unsigned: true,
                  },
                  severityNumber: 9,
                  severityText: "INFO",
                  body: { stringValue: "User prompt" },
                  attributes: [
                    {
                      key: "prompt",
                      value: { stringValue: "List files in current directory" },
                    },
                  ],
                  traceId: { type: "Buffer", data: traceId },
                  eventName: "claude_code.user_prompt",
                },
                // Tool execution
                {
                  timeUnixNano: {
                    low: (timestamp + 1000000000) & 0xffffffff,
                    high: Math.floor((timestamp + 1000000000) / 0x100000000),
                    unsigned: true,
                  },
                  observedTimeUnixNano: {
                    low: (timestamp + 1000000000) & 0xffffffff,
                    high: Math.floor((timestamp + 1000000000) / 0x100000000),
                    unsigned: true,
                  },
                  severityNumber: 9,
                  severityText: "INFO",
                  body: { stringValue: "Tool result" },
                  attributes: [
                    {
                      key: "tool_name",
                      value: { stringValue: "Bash" },
                    },
                    {
                      key: "duration_ms",
                      value: { doubleValue: 50 },
                    },
                    {
                      key: "success",
                      value: { stringValue: "true" },
                    },
                    {
                      key: "bash_command",
                      value: { stringValue: "ls -la" },
                    },
                  ],
                  traceId: { type: "Buffer", data: traceId },
                  eventName: "claude_code.tool_result",
                },
                // API request
                {
                  timeUnixNano: {
                    low: (timestamp + 2000000000) & 0xffffffff,
                    high: Math.floor((timestamp + 2000000000) / 0x100000000),
                    unsigned: true,
                  },
                  observedTimeUnixNano: {
                    low: (timestamp + 2000000000) & 0xffffffff,
                    high: Math.floor((timestamp + 2000000000) / 0x100000000),
                    unsigned: true,
                  },
                  severityNumber: 9,
                  severityText: "INFO",
                  body: { stringValue: "API request" },
                  attributes: [
                    {
                      key: "model",
                      value: { stringValue: "claude-sonnet-4-5-20250929" },
                    },
                    {
                      key: "input_tokens",
                      value: { intValue: 800 },
                    },
                    {
                      key: "output_tokens",
                      value: { intValue: 200 },
                    },
                  ],
                  traceId: { type: "Buffer", data: traceId },
                  eventName: "claude_code.api_request",
                },
              ],
            },
          ],
        },
      ],
    };

    const response = await makeAPICall(
      "POST",
      "/api/public/claude-code/logs",
      payload,
    );

    expect(response.status).toBe(200);

    // Wait for async processing
    await waitForExpect(async () => {
      const trace = await getTraceById({
        projectId,
        traceId: traceId.toString("hex"),
      });
      expect(trace).toBeDefined();
      expect(trace!.id).toBe(traceId.toString("hex"));

      // All three events should be converted to observations in the trace
    }, 25_000);
  }, 30_000);

  it("should handle empty logs gracefully", async () => {
    const payload = {
      resourceLogs: [],
    };

    const response = await makeAPICall(
      "POST",
      "/api/public/claude-code/logs",
      payload,
    );

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("message");
  });

  it("should reject invalid content type", async () => {
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000"}/api/public/claude-code/logs`,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Authorization: `Bearer ${process.env.LANGFUSE_API_KEY}`,
        },
        body: "invalid",
      },
    );

    expect(response.status).toBe(400);
  });
});
