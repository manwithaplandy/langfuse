import { randomUUID } from "crypto";
import { logger } from "../logger";
import { LangfuseOtelSpanAttributes } from "./attributes";

/**
 * Converts OpenTelemetry logs from Claude Code into OpenTelemetry traces
 * that can be processed by the existing Langfuse trace ingestion pipeline.
 *
 * Claude Code emits logs for events like:
 * - claude_code.user_prompt
 * - claude_code.tool_result
 * - claude_code.api_request
 * - claude_code.api_error
 * - claude_code.tool_decision
 *
 * This converter transforms those event logs into a hierarchical trace structure
 * where each event becomes a span with proper parent-child relationships.
 */

interface LogRecord {
  timeUnixNano: number | { low: number; high: number };
  observedTimeUnixNano?: number | { low: number; high: number };
  severityNumber?: number;
  severityText?: string;
  body?: any;
  attributes?: Array<{ key: string; value: any }>;
  droppedAttributesCount?: number;
  flags?: number;
  traceId?: Buffer | { data?: Buffer };
  spanId?: Buffer | { data?: Buffer };
  eventName?: string;
}

interface ScopeLogs {
  scope?: {
    name?: string;
    version?: string;
    attributes?: Array<{ key: string; value: any }>;
  };
  logRecords?: LogRecord[];
  schemaUrl?: string;
}

interface ResourceLogs {
  resource?: {
    attributes?: Array<{ key: string; value: any }>;
  };
  scopeLogs?: ScopeLogs[];
  schemaUrl?: string;
}

interface Span {
  traceId: Buffer;
  spanId: Buffer;
  parentSpanId?: Buffer;
  name: string;
  kind: number;
  startTimeUnixNano: number | { low: number; high: number };
  endTimeUnixNano: number | { low: number; high: number };
  attributes?: Array<{ key: string; value: any }>;
  events?: any[];
  status?: { code?: number; message?: string };
}

interface ResourceSpan {
  resource?: {
    attributes?: Array<{ key: string; value: any }>;
  };
  scopeSpans?: Array<{
    scope?: {
      name: string;
      version?: string;
      attributes?: Array<{ key: string; value: any }>;
    };
    spans?: Span[];
  }>;
}

// Claude Code event types
// eslint-disable-next-line no-unused-vars
enum ClaudeCodeEventType {
  // eslint-disable-next-line no-unused-vars
  USER_PROMPT = "claude_code.user_prompt",
  // eslint-disable-next-line no-unused-vars
  TOOL_RESULT = "claude_code.tool_result",
  // eslint-disable-next-line no-unused-vars
  API_REQUEST = "claude_code.api_request",
  // eslint-disable-next-line no-unused-vars
  API_ERROR = "claude_code.api_error",
  // eslint-disable-next-line no-unused-vars
  TOOL_DECISION = "claude_code.tool_decision",
}

// OpenTelemetry span kinds
// eslint-disable-next-line no-unused-vars
enum SpanKind {
  // eslint-disable-next-line no-unused-vars
  INTERNAL = 1,
  // eslint-disable-next-line no-unused-vars
  CLIENT = 3,
}

// Status codes
// eslint-disable-next-line no-unused-vars
enum StatusCode {
  // eslint-disable-next-line no-unused-vars
  OK = 1,
  // eslint-disable-next-line no-unused-vars
  ERROR = 2,
}

/**
 * Session-based trace builder that accumulates spans for a single trace
 */
class TraceBuilder {
  private traceId: Buffer;
  private spans: Span[] = [];
  private sessionAttributes: Record<string, any> = {};
  private startTime?: number;
  private endTime?: number;
  private rootSpanId?: Buffer;

  constructor(traceId: Buffer) {
    this.traceId = traceId;
  }

  addSpan(span: Span) {
    this.spans.push(span);

    // Track trace timing
    const spanStart = this.convertToNumber(span.startTimeUnixNano);
    const spanEnd = this.convertToNumber(span.endTimeUnixNano);

    if (!this.startTime || spanStart < this.startTime) {
      this.startTime = spanStart;
    }
    if (!this.endTime || spanEnd > this.endTime) {
      this.endTime = spanEnd;
    }
  }

  setSessionAttributes(attributes: Record<string, any>) {
    this.sessionAttributes = { ...this.sessionAttributes, ...attributes };
  }

  setRootSpanId(spanId: Buffer) {
    if (!this.rootSpanId) {
      this.rootSpanId = spanId;
    }
  }

  getSpans(): Span[] {
    return this.spans;
  }

  getTraceId(): Buffer {
    return this.traceId;
  }

  private convertToNumber(
    value: number | { low: number; high: number },
  ): number {
    if (typeof value === "number") {
      return value;
    }
    // Convert Long to number (may lose precision for very large values)
    return value.low + value.high * 4294967296;
  }
}

export class ClaudeCodeLogsToTracesConverter {
  // Map to track traces by session ID or trace ID
  private traceBuilders: Map<string, TraceBuilder> = new Map();

  /**
   * Converts OTel ResourceLogs to OTel ResourceSpans
   */
  convert(resourceLogs: ResourceLogs[]): ResourceSpan[] {
    try {
      // Process all logs and group by trace/session
      for (const resourceLog of resourceLogs) {
        this.processResourceLog(resourceLog);
      }

      // Convert accumulated traces to ResourceSpans
      const resourceSpans: ResourceSpan[] = [];

      for (const builder of Array.from(this.traceBuilders.values())) {
        const spans = builder.getSpans();
        if (spans.length > 0) {
          resourceSpans.push({
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: "claude-code" } },
                {
                  key: "telemetry.sdk.name",
                  value: { stringValue: "opentelemetry" },
                },
                {
                  key: "telemetry.sdk.language",
                  value: { stringValue: "nodejs" },
                },
              ],
            },
            scopeSpans: [
              {
                scope: {
                  name: "claude-code",
                  version: "1.0.0",
                },
                spans,
              },
            ],
          });
        }
      }

      // Clear builders for next batch
      this.traceBuilders.clear();

      return resourceSpans;
    } catch (error) {
      logger.error("Error converting Claude Code logs to traces", { error });
      return [];
    }
  }

  private processResourceLog(resourceLog: ResourceLogs) {
    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      for (const logRecord of scopeLog.logRecords ?? []) {
        this.processLogRecord(logRecord);
      }
    }
  }

  private processLogRecord(logRecord: LogRecord) {
    const attributes = this.extractAttributes(logRecord.attributes);
    const eventName = logRecord.eventName ?? attributes.event_name ?? "";

    // Get or create trace ID
    let traceId: Buffer;
    if (logRecord.traceId) {
      traceId = this.parseId(logRecord.traceId);
    } else {
      // Generate trace ID from session info or create new one
      const sessionId =
        attributes.session_id ?? attributes.conversation_id ?? randomUUID();
      traceId = this.stringToTraceId(String(sessionId));
    }

    const traceIdStr = traceId.toString("hex");

    // Get or create trace builder
    let builder = this.traceBuilders.get(traceIdStr);
    if (!builder) {
      builder = new TraceBuilder(traceId);
      this.traceBuilders.set(traceIdStr, builder);
    }

    // Convert log record to span based on event type
    const span = this.logRecordToSpan(
      logRecord,
      traceId,
      eventName,
      attributes,
    );

    if (span) {
      builder.addSpan(span);

      // Set root span for trace if this is a user prompt
      if (eventName === ClaudeCodeEventType.USER_PROMPT) {
        builder.setRootSpanId(span.spanId);
      }
    }
  }

  private logRecordToSpan(
    logRecord: LogRecord,
    traceId: Buffer,
    eventName: string,
    attributes: Record<string, any>,
  ): Span | null {
    const spanId = logRecord.spanId
      ? this.parseId(logRecord.spanId)
      : this.generateSpanId();

    const startTime = logRecord.timeUnixNano ?? logRecord.observedTimeUnixNano;
    if (!startTime) {
      logger.warn("Log record missing timestamp, skipping", { eventName });
      return null;
    }

    // Calculate end time (use start time + duration if available, or start time)
    let endTime = startTime;
    if (attributes.duration_ms) {
      const durationNanos = Number(attributes.duration_ms) * 1_000_000;
      const startNanos = this.convertToNumber(startTime);
      endTime = this.numberToLong(startNanos + durationNanos);
    }

    // Determine parent span ID (null for root spans)
    const parentSpanId = this.determineParentSpanId(
      eventName,
      attributes,
      logRecord,
    );

    // Build span based on event type
    switch (eventName) {
      case ClaudeCodeEventType.USER_PROMPT:
        return this.createUserPromptSpan(
          traceId,
          spanId,
          parentSpanId,
          startTime,
          endTime,
          attributes,
          logRecord,
        );

      case ClaudeCodeEventType.TOOL_RESULT:
        return this.createToolResultSpan(
          traceId,
          spanId,
          parentSpanId,
          startTime,
          endTime,
          attributes,
          logRecord,
        );

      case ClaudeCodeEventType.API_REQUEST:
        return this.createAPIRequestSpan(
          traceId,
          spanId,
          parentSpanId,
          startTime,
          endTime,
          attributes,
          logRecord,
        );

      case ClaudeCodeEventType.API_ERROR:
        return this.createAPIErrorSpan(
          traceId,
          spanId,
          parentSpanId,
          startTime,
          endTime,
          attributes,
          logRecord,
        );

      case ClaudeCodeEventType.TOOL_DECISION:
        return this.createToolDecisionSpan(
          traceId,
          spanId,
          parentSpanId,
          startTime,
          endTime,
          attributes,
        );

      default:
        // Generic span for unknown event types
        return this.createGenericSpan(
          traceId,
          spanId,
          parentSpanId,
          startTime,
          endTime,
          eventName,
          attributes,
          logRecord,
        );
    }
  }

  private createUserPromptSpan(
    traceId: Buffer,
    spanId: Buffer,
    parentSpanId: Buffer | null,
    startTime: number | { low: number; high: number },
    endTime: number | { low: number; high: number },
    attributes: Record<string, any>,
    logRecord: LogRecord,
  ): Span {
    const spanAttributes: Array<{ key: string; value: any }> = [
      { key: "event.name", value: { stringValue: "user_prompt" } },
      {
        key: LangfuseOtelSpanAttributes.OBSERVATION_TYPE,
        value: { stringValue: "SPAN" },
      },
    ];

    // Add prompt content if available
    if (attributes.prompt) {
      spanAttributes.push({
        key: LangfuseOtelSpanAttributes.OBSERVATION_INPUT,
        value: { stringValue: JSON.stringify({ prompt: attributes.prompt }) },
      });
    } else if (logRecord.body) {
      spanAttributes.push({
        key: LangfuseOtelSpanAttributes.OBSERVATION_INPUT,
        value: {
          stringValue: JSON.stringify({
            body: this.extractBody(logRecord.body),
          }),
        },
      });
    }

    // Add prompt length if available
    if (attributes.prompt_length) {
      spanAttributes.push({
        key: "prompt.length",
        value: { intValue: Number(attributes.prompt_length) },
      });
    }

    return {
      traceId,
      spanId,
      parentSpanId: parentSpanId ?? undefined,
      name: "User Prompt",
      kind: SpanKind.INTERNAL,
      startTimeUnixNano: startTime,
      endTimeUnixNano: endTime,
      attributes: spanAttributes,
      status: { code: StatusCode.OK },
    };
  }

  private createToolResultSpan(
    traceId: Buffer,
    spanId: Buffer,
    parentSpanId: Buffer | null,
    startTime: number | { low: number; high: number },
    endTime: number | { low: number; high: number },
    attributes: Record<string, any>,
    logRecord: LogRecord,
  ): Span {
    const toolName = attributes.tool_name ?? "Unknown Tool";
    const success = String(attributes.success) === "true";

    const spanAttributes: Array<{ key: string; value: any }> = [
      { key: "event.name", value: { stringValue: "tool_result" } },
      { key: "tool.name", value: { stringValue: toolName } },
      {
        key: LangfuseOtelSpanAttributes.OBSERVATION_TYPE,
        value: { stringValue: "SPAN" },
      },
    ];

    // Map common tool names to Langfuse observation types
    const toolTypeMapping: Record<string, string> = {
      Read: "SPAN",
      Write: "SPAN",
      Edit: "SPAN",
      Bash: "SPAN",
      Grep: "SPAN",
      Glob: "SPAN",
      Task: "AGENT",
      WebFetch: "SPAN",
      WebSearch: "SPAN",
    };

    const observationType = toolTypeMapping[toolName] ?? "SPAN";
    spanAttributes[2] = {
      key: LangfuseOtelSpanAttributes.OBSERVATION_TYPE,
      value: { stringValue: observationType },
    };

    // Add tool parameters as input
    if (attributes.tool_parameters) {
      try {
        const params =
          typeof attributes.tool_parameters === "string"
            ? JSON.parse(attributes.tool_parameters)
            : attributes.tool_parameters;
        spanAttributes.push({
          key: LangfuseOtelSpanAttributes.OBSERVATION_INPUT,
          value: { stringValue: JSON.stringify(params) },
        });
      } catch {
        spanAttributes.push({
          key: LangfuseOtelSpanAttributes.OBSERVATION_INPUT,
          value: { stringValue: String(attributes.tool_parameters) },
        });
      }
    }

    // Add output/result if available in body
    if (logRecord.body) {
      spanAttributes.push({
        key: LangfuseOtelSpanAttributes.OBSERVATION_OUTPUT,
        value: {
          stringValue: JSON.stringify({
            result: this.extractBody(logRecord.body),
          }),
        },
      });
    }

    // Add duration
    if (attributes.duration_ms) {
      spanAttributes.push({
        key: "duration.ms",
        value: { doubleValue: Number(attributes.duration_ms) },
      });
    }

    // Add decision info
    if (attributes.decision) {
      spanAttributes.push({
        key: "tool.decision",
        value: { stringValue: String(attributes.decision) },
      });
    }

    if (attributes.source) {
      spanAttributes.push({
        key: "tool.decision.source",
        value: { stringValue: String(attributes.source) },
      });
    }

    // Add error if failed
    if (!success && attributes.error) {
      spanAttributes.push({
        key: LangfuseOtelSpanAttributes.OBSERVATION_STATUS_MESSAGE,
        value: { stringValue: String(attributes.error) },
      });
      spanAttributes.push({
        key: LangfuseOtelSpanAttributes.OBSERVATION_LEVEL,
        value: { stringValue: "ERROR" },
      });
    }

    // Add metadata
    const metadata: Record<string, any> = {};
    if (attributes.bash_command)
      metadata.bash_command = attributes.bash_command;
    if (attributes.full_command)
      metadata.full_command = attributes.full_command;
    if (attributes.timeout) metadata.timeout = attributes.timeout;
    if (attributes.description) metadata.description = attributes.description;
    if (attributes.sandbox) metadata.sandbox = attributes.sandbox;

    if (Object.keys(metadata).length > 0) {
      spanAttributes.push({
        key: LangfuseOtelSpanAttributes.OBSERVATION_METADATA,
        value: { stringValue: JSON.stringify(metadata) },
      });
    }

    return {
      traceId,
      spanId,
      parentSpanId: parentSpanId ?? undefined,
      name: `Tool: ${toolName}`,
      kind: SpanKind.INTERNAL,
      startTimeUnixNano: startTime,
      endTimeUnixNano: endTime,
      attributes: spanAttributes,
      status: {
        code: success ? StatusCode.OK : StatusCode.ERROR,
        message: success
          ? undefined
          : String(attributes.error ?? "Tool execution failed"),
      },
    };
  }

  private createAPIRequestSpan(
    traceId: Buffer,
    spanId: Buffer,
    parentSpanId: Buffer | null,
    startTime: number | { low: number; high: number },
    endTime: number | { low: number; high: number },
    attributes: Record<string, any>,
    logRecord: LogRecord,
  ): Span {
    const spanAttributes: Array<{ key: string; value: any }> = [
      { key: "event.name", value: { stringValue: "api_request" } },
      {
        key: LangfuseOtelSpanAttributes.OBSERVATION_TYPE,
        value: { stringValue: "GENERATION" },
      },
    ];

    // Add model info if available
    if (attributes.model) {
      spanAttributes.push({
        key: LangfuseOtelSpanAttributes.OBSERVATION_MODEL,
        value: { stringValue: String(attributes.model) },
      });
    }

    // Extract and add token usage
    const usageDetails: Record<string, number> = {};

    if (attributes.input_tokens) {
      usageDetails.input = Number(attributes.input_tokens);
    }
    if (attributes.output_tokens) {
      usageDetails.output = Number(attributes.output_tokens);
    }
    if (attributes.cache_creation_tokens) {
      usageDetails.input_cache_creation = Number(
        attributes.cache_creation_tokens,
      );
    }
    if (attributes.cache_read_tokens) {
      usageDetails.input_cache_read = Number(attributes.cache_read_tokens);
    }
    if (attributes.total_tokens) {
      usageDetails.total = Number(attributes.total_tokens);
    }

    if (Object.keys(usageDetails).length > 0) {
      spanAttributes.push({
        key: LangfuseOtelSpanAttributes.OBSERVATION_USAGE_DETAILS,
        value: { stringValue: JSON.stringify(usageDetails) },
      });
    }

    // Add duration
    if (attributes.duration_ms) {
      spanAttributes.push({
        key: "duration.ms",
        value: { doubleValue: Number(attributes.duration_ms) },
      });
    }

    // Add cost if available
    if (attributes.cost) {
      spanAttributes.push({
        key: LangfuseOtelSpanAttributes.OBSERVATION_COST_DETAILS,
        value: {
          stringValue: JSON.stringify({ total: Number(attributes.cost) }),
        },
      });
    }

    // Add request/response if available in body
    if (logRecord.body) {
      const body = this.extractBody(logRecord.body);
      if (typeof body === "object" && body !== null) {
        if (body.request) {
          spanAttributes.push({
            key: LangfuseOtelSpanAttributes.OBSERVATION_INPUT,
            value: { stringValue: JSON.stringify(body.request) },
          });
        }
        if (body.response) {
          spanAttributes.push({
            key: LangfuseOtelSpanAttributes.OBSERVATION_OUTPUT,
            value: { stringValue: JSON.stringify(body.response) },
          });
        }
      }
    }

    return {
      traceId,
      spanId,
      parentSpanId: parentSpanId ?? undefined,
      name: "Claude API Request",
      kind: SpanKind.CLIENT,
      startTimeUnixNano: startTime,
      endTimeUnixNano: endTime,
      attributes: spanAttributes,
      status: { code: StatusCode.OK },
    };
  }

  private createAPIErrorSpan(
    traceId: Buffer,
    spanId: Buffer,
    parentSpanId: Buffer | null,
    startTime: number | { low: number; high: number },
    endTime: number | { low: number; high: number },
    attributes: Record<string, any>,
    logRecord: LogRecord,
  ): Span {
    const spanAttributes: Array<{ key: string; value: any }> = [
      { key: "event.name", value: { stringValue: "api_error" } },
      {
        key: LangfuseOtelSpanAttributes.OBSERVATION_TYPE,
        value: { stringValue: "GENERATION" },
      },
      {
        key: LangfuseOtelSpanAttributes.OBSERVATION_LEVEL,
        value: { stringValue: "ERROR" },
      },
    ];

    // Add error details
    if (attributes.error) {
      spanAttributes.push({
        key: LangfuseOtelSpanAttributes.OBSERVATION_STATUS_MESSAGE,
        value: { stringValue: String(attributes.error) },
      });
    }

    if (attributes.status_code) {
      spanAttributes.push({
        key: "http.status_code",
        value: { intValue: Number(attributes.status_code) },
      });
    }

    // Add error body if available
    if (logRecord.body) {
      spanAttributes.push({
        key: "error.details",
        value: {
          stringValue: JSON.stringify(this.extractBody(logRecord.body)),
        },
      });
    }

    return {
      traceId,
      spanId,
      parentSpanId: parentSpanId ?? undefined,
      name: "Claude API Error",
      kind: SpanKind.CLIENT,
      startTimeUnixNano: startTime,
      endTimeUnixNano: endTime,
      attributes: spanAttributes,
      status: {
        code: StatusCode.ERROR,
        message: String(attributes.error ?? "API request failed"),
      },
    };
  }

  private createToolDecisionSpan(
    traceId: Buffer,
    spanId: Buffer,
    parentSpanId: Buffer | null,
    startTime: number | { low: number; high: number },
    endTime: number | { low: number; high: number },
    attributes: Record<string, any>,
  ): Span {
    const spanAttributes: Array<{ key: string; value: any }> = [
      { key: "event.name", value: { stringValue: "tool_decision" } },
      {
        key: LangfuseOtelSpanAttributes.OBSERVATION_TYPE,
        value: { stringValue: "EVENT" },
      },
    ];

    if (attributes.tool_name) {
      spanAttributes.push({
        key: "tool.name",
        value: { stringValue: String(attributes.tool_name) },
      });
    }

    if (attributes.decision) {
      spanAttributes.push({
        key: "tool.decision",
        value: { stringValue: String(attributes.decision) },
      });
    }

    if (attributes.source) {
      spanAttributes.push({
        key: "tool.decision.source",
        value: { stringValue: String(attributes.source) },
      });
    }

    return {
      traceId,
      spanId,
      parentSpanId: parentSpanId ?? undefined,
      name: "Tool Decision",
      kind: SpanKind.INTERNAL,
      startTimeUnixNano: startTime,
      endTimeUnixNano: endTime,
      attributes: spanAttributes,
      status: { code: StatusCode.OK },
    };
  }

  private createGenericSpan(
    traceId: Buffer,
    spanId: Buffer,
    parentSpanId: Buffer | null,
    startTime: number | { low: number; high: number },
    endTime: number | { low: number; high: number },
    eventName: string,
    attributes: Record<string, any>,
    logRecord: LogRecord,
  ): Span {
    const spanAttributes: Array<{ key: string; value: any }> = [
      { key: "event.name", value: { stringValue: eventName } },
      {
        key: LangfuseOtelSpanAttributes.OBSERVATION_TYPE,
        value: { stringValue: "SPAN" },
      },
    ];

    // Add all attributes
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined && value !== null) {
        spanAttributes.push({
          key: `log.${key}`,
          value: this.toAnyValue(value),
        });
      }
    }

    // Add body if available
    if (logRecord.body) {
      spanAttributes.push({
        key: "log.body",
        value: {
          stringValue: JSON.stringify(this.extractBody(logRecord.body)),
        },
      });
    }

    return {
      traceId,
      spanId,
      parentSpanId: parentSpanId ?? undefined,
      name: eventName || "Claude Code Event",
      kind: SpanKind.INTERNAL,
      startTimeUnixNano: startTime,
      endTimeUnixNano: endTime,
      attributes: spanAttributes,
      status: { code: StatusCode.OK },
    };
  }

  private determineParentSpanId(
    eventName: string,
    attributes: Record<string, any>,
    logRecord: LogRecord,
  ): Buffer | null {
    // If log record has a spanId that indicates it's part of an existing span, use parent
    if (logRecord.spanId) {
      // This log is associated with an existing span, no parent needed
      return null;
    }

    // Tool results and API requests typically are children of user prompts
    // For now, we'll keep them at root level unless we have explicit parent info
    if (attributes.parent_span_id) {
      try {
        return Buffer.from(attributes.parent_span_id, "hex");
      } catch {
        return null;
      }
    }

    return null;
  }

  // Utility methods

  private extractAttributes(
    attributes?: Array<{ key: string; value: any }>,
  ): Record<string, any> {
    if (!attributes) return {};

    const result: Record<string, any> = {};
    for (const attr of attributes) {
      if (attr.value) {
        result[attr.key] = this.extractAnyValue(attr.value);
      }
    }
    return result;
  }

  private extractAnyValue(value: any): any {
    if (value.stringValue !== undefined) return value.stringValue;
    if (value.boolValue !== undefined) return value.boolValue;
    if (value.intValue !== undefined) return value.intValue;
    if (value.doubleValue !== undefined) return value.doubleValue;
    if (value.bytesValue !== undefined) return value.bytesValue;
    if (value.arrayValue) {
      return (
        value.arrayValue.values?.map((v: any) => this.extractAnyValue(v)) ?? []
      );
    }
    if (value.kvlistValue) {
      const obj: Record<string, any> = {};
      for (const kv of value.kvlistValue.values ?? []) {
        obj[kv.key] = this.extractAnyValue(kv.value);
      }
      return obj;
    }
    return value;
  }

  private extractBody(body: any): any {
    if (typeof body === "string") {
      return body;
    }
    return this.extractAnyValue(body);
  }

  private toAnyValue(value: any): any {
    if (typeof value === "string") {
      return { stringValue: value };
    }
    if (typeof value === "boolean") {
      return { boolValue: value };
    }
    if (typeof value === "number") {
      return Number.isInteger(value)
        ? { intValue: value }
        : { doubleValue: value };
    }
    if (Array.isArray(value)) {
      return {
        arrayValue: {
          values: value.map((v) => this.toAnyValue(v)),
        },
      };
    }
    if (typeof value === "object" && value !== null) {
      return {
        kvlistValue: {
          values: Object.entries(value).map(([k, v]) => ({
            key: k,
            value: this.toAnyValue(v),
          })),
        },
      };
    }
    return { stringValue: String(value) };
  }

  private parseId(id: Buffer | { data?: Buffer }): Buffer {
    if (Buffer.isBuffer(id)) {
      return id;
    }
    if (id.data && Buffer.isBuffer(id.data)) {
      return id.data;
    }
    throw new Error("Invalid ID format");
  }

  private generateSpanId(): Buffer {
    const id = randomUUID().replace(/-/g, "").substring(0, 16);
    return Buffer.from(id, "hex");
  }

  private stringToTraceId(str: string): Buffer {
    // Generate a deterministic 16-byte trace ID from a string
    const hash = require("crypto").createHash("md5").update(str).digest();
    return hash;
  }

  private convertToNumber(
    value: number | { low: number; high: number },
  ): number {
    if (typeof value === "number") {
      return value;
    }
    // Convert Long to number (may lose precision for very large values)
    return value.low + value.high * 4294967296;
  }

  private numberToLong(value: number): { low: number; high: number } {
    const high = Math.floor(value / 4294967296);
    const low = value >>> 0;
    return { low, high };
  }
}
