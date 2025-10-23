import { randomUUID } from "crypto";
import {
  type IngestionEventType,
  logger,
  getS3EventStorageClient,
  QueueJobs,
} from "../";
import { env } from "../../env";
import { OtelIngestionQueue } from "../redis/otelIngestionQueue";
import { ObservationLevel, ObservationTypeDomain } from "../../";

/**
 * Structure of an OpenTelemetry LogRecord
 */
interface OtelLogRecord {
  timeUnixNano: number | { low: number; high: number };
  observedTimeUnixNano?: number | { low: number; high: number };
  severityNumber?: number;
  severityText?: string;
  body?: {
    stringValue?: string;
    [key: string]: unknown;
  };
  attributes?: Array<{ key: string; value: any }>;
  droppedAttributesCount?: number;
  flags?: number;
  traceId?: { data?: Buffer } | Buffer;
  spanId?: { data?: Buffer } | Buffer;
}

interface OtelScopeLogs {
  scope?: {
    name: string;
    version?: string;
    attributes?: Array<{ key: string; value: any }>;
  };
  logRecords?: OtelLogRecord[];
}

interface OtelResourceLogs {
  resource?: {
    attributes?: Array<{ key: string; value: any }>;
  };
  scopeLogs?: OtelScopeLogs[];
}

export interface ClaudeCodeLogProcessorConfig {
  projectId: string;
  publicKey?: string;
}

/**
 * Processor for transforming Claude Code OpenTelemetry logs into Langfuse traces.
 *
 * Claude Code emits the following event types via OTel logs:
 * - claude_code.user_prompt: User submits a prompt
 * - claude_code.tool_result: Tool execution result
 * - claude_code.api_request: API call to Claude
 * - claude_code.api_error: API request failure
 * - claude_code.tool_decision: User accepts/rejects tool
 */
export class ClaudeCodeLogProcessor {
  private readonly projectId: string;
  private readonly publicKey?: string;

  constructor(config: ClaudeCodeLogProcessorConfig) {
    this.projectId = config.projectId;
    this.publicKey = config.publicKey;
  }

  /**
   * Returns the current time as yyyy/mm/dd/hh/mm.
   */
  private getCurrentTimePath(): string {
    const now = new Date();
    return `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}/${String(now.getHours()).padStart(2, "0")}/${String(now.getMinutes()).padStart(2, "0")}`;
  }

  /**
   * Converts a Unix nanosecond timestamp to ISO string.
   */
  private nanoToISO(nano: number | { low: number; high: number }): string {
    const nanoValue = typeof nano === "number" ? nano : this.longToNumber(nano);
    const milliseconds = Math.floor(nanoValue / 1_000_000);
    return new Date(milliseconds).toISOString();
  }

  /**
   * Converts a Long object to number.
   */
  private longToNumber(long: { low: number; high: number }): number {
    return long.high * 0x100000000 + long.low;
  }

  /**
   * Converts a buffer to hex string.
   */
  private bufferToHex(buffer: Buffer | { data?: Buffer } | undefined): string {
    if (!buffer) return randomUUID();
    const buf = Buffer.isBuffer(buffer) ? buffer : buffer.data;
    return buf ? buf.toString("hex") : randomUUID();
  }

  /**
   * Extracts attributes from an OTel attribute array.
   */
  private extractAttributes(
    attributes?: Array<{ key: string; value: any }>,
  ): Record<string, unknown> {
    if (!attributes) return {};

    const result: Record<string, unknown> = {};
    for (const attr of attributes) {
      result[attr.key] = this.extractAttributeValue(attr.value);
    }
    return result;
  }

  /**
   * Extracts the value from an OTel AnyValue.
   */
  private extractAttributeValue(value: any): unknown {
    if (!value) return null;

    if (value.stringValue !== undefined && value.stringValue !== null)
      return value.stringValue;
    if (value.boolValue !== undefined && value.boolValue !== null)
      return value.boolValue;
    if (value.intValue !== undefined && value.intValue !== null)
      return typeof value.intValue === "number"
        ? value.intValue
        : this.longToNumber(value.intValue);
    if (value.doubleValue !== undefined && value.doubleValue !== null)
      return value.doubleValue;
    if (value.arrayValue?.values) {
      return value.arrayValue.values.map((v: any) =>
        this.extractAttributeValue(v),
      );
    }
    if (value.kvlistValue?.values) {
      const obj: Record<string, unknown> = {};
      for (const kv of value.kvlistValue.values) {
        obj[kv.key] = this.extractAttributeValue(kv.value);
      }
      return obj;
    }
    if (value.bytesValue) return value.bytesValue.toString("base64");

    return null;
  }

  /**
   * Gets the event name from log attributes or body.
   */
  private getEventName(
    logRecord: OtelLogRecord,
    attributes: Record<string, unknown>,
  ): string {
    // Check common attribute names for event type
    if (attributes["event.name"]) return String(attributes["event.name"]);
    if (attributes["event_name"]) return String(attributes["event_name"]);
    if (attributes["name"]) return String(attributes["name"]);

    // Check body for event name
    if (logRecord.body?.stringValue) {
      const bodyStr = logRecord.body.stringValue;
      // If body starts with "claude_code.", use it as event name
      if (bodyStr.startsWith("claude_code.")) {
        return bodyStr.split(" ")[0] || bodyStr;
      }
    }

    return "unknown";
  }

  /**
   * Processes Claude Code log records into Langfuse ingestion events.
   */
  async processToIngestionEvents(
    resourceLogs: OtelResourceLogs[],
  ): Promise<IngestionEventType[]> {
    const events: IngestionEventType[] = [];
    const traceMap = new Map<string, string>(); // Maps traceId to Langfuse trace ID

    for (const resourceLog of resourceLogs) {
      const resourceAttributes = this.extractAttributes(
        resourceLog.resource?.attributes,
      );

      for (const scopeLog of resourceLog.scopeLogs || []) {
        const scopeAttributes = this.extractAttributes(
          scopeLog.scope?.attributes,
        );

        for (const logRecord of scopeLog.logRecords || []) {
          const attributes = this.extractAttributes(logRecord.attributes);
          const eventName = this.getEventName(logRecord, attributes);
          const timestamp = this.nanoToISO(logRecord.timeUnixNano);

          // Get or create trace ID
          const otelTraceId = logRecord.traceId
            ? this.bufferToHex(logRecord.traceId)
            : null;
          const sessionId = (attributes["session.id"] ||
            attributes["session_id"]) as string | undefined;

          // Use trace ID from log, or create one based on session
          let traceId: string;
          if (otelTraceId && traceMap.has(otelTraceId)) {
            traceId = traceMap.get(otelTraceId)!;
          } else {
            traceId = otelTraceId || randomUUID();
            if (otelTraceId) {
              traceMap.set(otelTraceId, traceId);
            }
          }

          // Process based on event type
          if (eventName === "claude_code.user_prompt") {
            events.push(
              ...this.createUserPromptEvents(
                traceId,
                timestamp,
                attributes,
                resourceAttributes,
                scopeAttributes,
                sessionId,
              ),
            );
          } else if (eventName === "claude_code.tool_result") {
            events.push(
              ...this.createToolResultEvents(
                traceId,
                timestamp,
                attributes,
                resourceAttributes,
              ),
            );
          } else if (eventName === "claude_code.api_request") {
            events.push(
              ...this.createApiRequestEvents(
                traceId,
                timestamp,
                attributes,
                resourceAttributes,
              ),
            );
          } else if (eventName === "claude_code.api_error") {
            events.push(
              ...this.createApiErrorEvents(
                traceId,
                timestamp,
                attributes,
                resourceAttributes,
              ),
            );
          } else if (eventName === "claude_code.tool_decision") {
            events.push(
              ...this.createToolDecisionEvents(
                traceId,
                timestamp,
                attributes,
                resourceAttributes,
              ),
            );
          } else {
            // Generic event handling for unknown event types
            events.push(
              ...this.createGenericEvent(
                traceId,
                timestamp,
                eventName,
                attributes,
                resourceAttributes,
                logRecord,
              ),
            );
          }
        }
      }
    }

    return events;
  }

  /**
   * Converts metadata to JSON-compatible format
   */
  private toJsonMetadata(
    metadata: Record<string, unknown>,
  ): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (value !== undefined && value !== null) {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Creates events for user prompt submissions.
   * Maps to: Trace creation with user input
   */
  private createUserPromptEvents(
    traceId: string,
    timestamp: string,
    attributes: Record<string, unknown>,
    resourceAttributes: Record<string, unknown>,
    scopeAttributes: Record<string, unknown>,
    sessionId?: string,
  ): IngestionEventType[] {
    const events: IngestionEventType[] = [];

    // Create trace event
    const traceEvent: IngestionEventType = {
      id: randomUUID(),
      type: "trace-create",
      timestamp,
      body: {
        id: traceId,
        timestamp,
        name: "Claude Code Session",
        sessionId:
          sessionId || (attributes["session.id"] as string) || undefined,
        userId: (attributes["user.id"] as string) || undefined,
        input: attributes["prompt"] || attributes["user_prompt"] || undefined,
        metadata: this.toJsonMetadata({
          ...resourceAttributes,
          ...scopeAttributes,
          event_type: "claude_code.user_prompt",
          prompt_length:
            typeof attributes["prompt_length"] === "number"
              ? attributes["prompt_length"]
              : undefined,
        }),
        tags: ["claude-code", "user-prompt"],
      },
    };
    events.push(traceEvent);

    // Create an observation for the prompt itself
    const observationEvent: IngestionEventType = {
      id: randomUUID(),
      type: "event-create",
      timestamp,
      body: {
        environment: "default",
        id: randomUUID(),
        traceId,
        name: "User Prompt",
        startTime: timestamp,
        input: attributes["prompt"] || attributes["user_prompt"] || undefined,
        metadata: this.toJsonMetadata({
          prompt_length:
            typeof attributes["prompt_length"] === "number"
              ? attributes["prompt_length"]
              : undefined,
          ...attributes,
        }),
        level: "DEFAULT",
      },
    };
    events.push(observationEvent);

    return events;
  }

  /**
   * Creates events for tool execution results.
   * Maps to: SPAN observation
   */
  private createToolResultEvents(
    traceId: string,
    timestamp: string,
    attributes: Record<string, unknown>,
    resourceAttributes: Record<string, unknown>,
  ): IngestionEventType[] {
    const toolName = (attributes["tool.name"] ||
      attributes["tool_name"]) as string;
    const success = attributes["success"] as boolean;
    const executionTime = attributes["execution_time"] as number;
    const error = attributes["error"] as string | undefined;

    const spanEvent: IngestionEventType = {
      id: randomUUID(),
      type: "span-create",
      timestamp,
      body: {
        environment: "default",
        id: randomUUID(),
        traceId,
        name: `Tool: ${toolName || "Unknown"}`,
        startTime: timestamp,
        endTime: executionTime
          ? new Date(
              new Date(timestamp).getTime() - executionTime,
            ).toISOString()
          : timestamp,
        input: attributes["input"] || undefined,
        output: attributes["output"] || (success ? "Success" : "Failed"),
        metadata: this.toJsonMetadata({
          tool_name: toolName,
          success,
          execution_time_ms: executionTime,
          error,
          decision: attributes["decision"],
          ...resourceAttributes,
        }),
        level: success ? "DEFAULT" : "ERROR",
        statusMessage: error || (success ? "Success" : "Failed"),
      },
    };

    return [spanEvent];
  }

  /**
   * Creates events for API requests to Claude.
   * Maps to: GENERATION observation
   */
  private createApiRequestEvents(
    traceId: string,
    timestamp: string,
    attributes: Record<string, unknown>,
    resourceAttributes: Record<string, unknown>,
  ): IngestionEventType[] {
    const model = (attributes["model"] || attributes["ai.model"]) as string;
    const inputTokens = attributes["input_tokens"] as number | undefined;
    const outputTokens = attributes["output_tokens"] as number | undefined;

    const generationEvent: IngestionEventType = {
      id: randomUUID(),
      type: "generation-create",
      timestamp,
      body: {
        environment: "default",
        id: randomUUID(),
        traceId,
        name: "Claude API Request",
        startTime: timestamp,
        endTime: timestamp,
        model: model || "claude",
        input: attributes["prompt"] || undefined,
        output: attributes["response"] || undefined,
        metadata: this.toJsonMetadata({
          ...attributes,
          ...resourceAttributes,
        }),
        usage:
          inputTokens || outputTokens
            ? {
                input: inputTokens,
                output: outputTokens,
                total: (inputTokens || 0) + (outputTokens || 0),
              }
            : undefined,
        level: "DEFAULT",
      },
    };

    return [generationEvent];
  }

  /**
   * Creates events for API errors.
   * Maps to: EVENT observation with ERROR level
   */
  private createApiErrorEvents(
    traceId: string,
    timestamp: string,
    attributes: Record<string, unknown>,
    resourceAttributes: Record<string, unknown>,
  ): IngestionEventType[] {
    const errorMessage = (attributes["error"] ||
      attributes["error.message"]) as string;
    const errorType = (attributes["error.type"] ||
      attributes["error_type"]) as string;

    const errorEvent: IngestionEventType = {
      id: randomUUID(),
      type: "event-create",
      timestamp,
      body: {
        environment: "default",
        id: randomUUID(),
        traceId,
        name: "API Error",
        startTime: timestamp,
        metadata: this.toJsonMetadata({
          error_type: errorType,
          error_message: errorMessage,
          ...attributes,
          ...resourceAttributes,
        }),
        level: "ERROR",
        statusMessage: errorMessage || "API request failed",
      },
    };

    return [errorEvent];
  }

  /**
   * Creates events for tool permission decisions.
   * Maps to: EVENT observation
   */
  private createToolDecisionEvents(
    traceId: string,
    timestamp: string,
    attributes: Record<string, unknown>,
    resourceAttributes: Record<string, unknown>,
  ): IngestionEventType[] {
    const toolName = (attributes["tool.name"] ||
      attributes["tool_name"]) as string;
    const decision = attributes["decision"] as string;
    const accepted = decision === "accept" || attributes["accepted"] === true;

    const decisionEvent: IngestionEventType = {
      id: randomUUID(),
      type: "event-create",
      timestamp,
      body: {
        environment: "default",
        id: randomUUID(),
        traceId,
        name: `Tool Decision: ${toolName || "Unknown"}`,
        startTime: timestamp,
        output: decision || (accepted ? "Accepted" : "Rejected"),
        metadata: this.toJsonMetadata({
          tool_name: toolName,
          decision,
          accepted,
          ...attributes,
          ...resourceAttributes,
        }),
        level: "DEFAULT",
      },
    };

    return [decisionEvent];
  }

  /**
   * Creates a generic event for unknown event types.
   */
  private createGenericEvent(
    traceId: string,
    timestamp: string,
    eventName: string,
    attributes: Record<string, unknown>,
    resourceAttributes: Record<string, unknown>,
    logRecord: OtelLogRecord,
  ): IngestionEventType[] {
    const genericEvent: IngestionEventType = {
      id: randomUUID(),
      type: "event-create",
      timestamp,
      body: {
        environment: "default",
        id: randomUUID(),
        traceId,
        name: eventName,
        startTime: timestamp,
        input: logRecord.body?.stringValue || undefined,
        metadata: this.toJsonMetadata({
          ...attributes,
          ...resourceAttributes,
          severity: logRecord.severityText,
          severity_number: logRecord.severityNumber,
        }),
        level: this.severityToLevel(logRecord.severityNumber),
      },
    };

    return [genericEvent];
  }

  /**
   * Converts OTel severity number to Langfuse observation level.
   */
  private severityToLevel(
    severityNumber?: number,
  ): "DEBUG" | "DEFAULT" | "WARNING" | "ERROR" {
    if (!severityNumber) return "DEFAULT";

    // OTel severity: 1-4=TRACE, 5-8=DEBUG, 9-12=INFO, 13-16=WARN, 17-20=ERROR, 21-24=FATAL
    if (severityNumber >= 17) return "ERROR";
    if (severityNumber >= 13) return "WARNING";
    if (severityNumber >= 5) return "DEBUG";
    return "DEFAULT";
  }

  /**
   * Uploads resource logs to S3 and queues for processing.
   */
  async publishToOtelIngestionQueue(resourceLogs: OtelResourceLogs[]) {
    const fileKey = `${env.LANGFUSE_S3_EVENT_UPLOAD_PREFIX}otel-logs/${this.projectId}/${this.getCurrentTimePath()}/${randomUUID()}.json`;

    // Upload to S3
    await getS3EventStorageClient(
      env.LANGFUSE_S3_EVENT_UPLOAD_BUCKET,
    ).uploadJson(fileKey, resourceLogs as Record<string, unknown>[]);

    // Add queue job
    const queue = OtelIngestionQueue.getInstance({});
    return queue
      ? queue.add(QueueJobs.OtelIngestionJob, {
          id: randomUUID(),
          timestamp: new Date(),
          name: QueueJobs.OtelIngestionJob as const,
          payload: {
            data: {
              fileKey,
              publicKey: this.publicKey,
              isClaudeCodeLogs: true, // Flag to identify Claude Code logs
            },
            authCheck: {
              validKey: true,
              scope: {
                projectId: this.projectId,
                accessLevel: "project" as const,
              },
            },
          },
        })
      : Promise.resolve();
  }
}
